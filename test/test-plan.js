#!/usr/bin/gjs -m
/* Unit tests for the pure planning logic. Run: ./test/run-tests.sh
 *
 * The payloads below are hand-built in the shape recursiveUnpack() produces for
 * org.gnome.Mutter.DisplayConfig.GetCurrentState, so the parser is exercised
 * too, not bypassed.
 */

import {
    Mode, parseState, planFor, inferMode, classify, connectedKey, enabledConnectors,
} from '../extension/lib/plan.js';

let failures = 0;
let checks = 0;

function ok(cond, what) {
    checks++;
    if (!cond) {
        failures++;
        print(`  FAIL  ${what}`);
    }
}

function eq(actual, expected, what) {
    ok(Object.is(actual, expected), `${what} -- expected ${expected}, got ${actual}`);
}

function suite(name, fn) {
    print(name);
    fn();
}

/* ---------------------------------------------------------------- fixtures */

const DP_MODES = [
    ['2560x1440@144', 2560, 1440, 144.0, 1.0, [1.0, 1.25, 1.5, 2.0], {'is-current': true, 'is-preferred': true}],
    ['1920x1080@60', 1920, 1080, 60.0, 1.0, [1.0, 2.0], {}],
];
const DP_MODES_OFF = [
    ['2560x1440@144', 2560, 1440, 144.0, 1.0, [1.0, 1.25, 1.5, 2.0], {'is-preferred': true}],
    ['1920x1080@60', 1920, 1080, 60.0, 1.0, [1.0, 2.0], {}],
];
const TV_MODES = [
    ['3840x2160@60', 3840, 2160, 60.0, 2.0, [1.0, 1.5, 2.0, 3.0], {'is-preferred': true}],
    ['1920x1080@60', 1920, 1080, 60.0, 1.0, [1.0, 2.0], {}],
];
const TV_MODES_ON = [
    ['3840x2160@60', 3840, 2160, 60.0, 2.0, [1.0, 1.5, 2.0, 3.0], {'is-current': true, 'is-preferred': true}],
    ['1920x1080@60', 1920, 1080, 60.0, 1.0, [1.0, 2.0], {}],
];

const DP_SPEC = ['DP-1', 'DEL', 'U2719D', 'ABC123'];
const TV_SPEC = ['HDMI-1', 'SNY', 'BRAVIA', 'XYZ789'];

const monitor = (spec, modes, name, extra = {}) =>
    [spec, modes, {'display-name': name, 'is-builtin': false, ...extra}];

/* Monitor-level colour properties, as Mutter reports them. 0 = default (SDR),
 * 1 = bt2100 (HDR), 2 = sdr-native. Most fixtures deliberately omit these, so
 * the "Mutter too old to report a colour mode" path is covered throughout. */
const colour = (mode, supported = [0, 1]) =>
    ({'color-mode': mode, 'supported-color-modes': supported});
const logical = (spec, scale = 1.0, primary = true) => [0, 0, scale, 0, primary, [spec], {}];

/* Main monitor alone -- the TV is powered off, so HDMI is not connected. */
const stateDesktopOnly = () => parseState([1,
    [monitor(DP_SPEC, DP_MODES, 'Dell U2719D')],
    [logical(DP_SPEC)],
    {'layout-mode': 1}]);

/* The moment the user complains about: the TV was switched on, Mutter loaded
 * the stored gaming config for the {DP, HDMI} set, and the desktop jumped. */
const stateHijackedByTv = () => parseState([2,
    [monitor(DP_SPEC, DP_MODES_OFF, 'Dell U2719D'), monitor(TV_SPEC, TV_MODES_ON, 'Sony BRAVIA')],
    [logical(TV_SPEC, 2.0)],
    {'layout-mode': 1}]);

/* Both connected, desktop correctly on the monitor. */
const stateBothTvIdle = () => parseState([3,
    [monitor(DP_SPEC, DP_MODES, 'Dell U2719D'), monitor(TV_SPEC, TV_MODES, 'Sony BRAVIA')],
    [logical(DP_SPEC)],
    {'layout-mode': 1}]);

/* Both connected and both enabled -- a deliberate extended desktop. */
const stateExtended = () => parseState([4,
    [monitor(DP_SPEC, DP_MODES, 'Dell U2719D'), monitor(TV_SPEC, TV_MODES_ON, 'Sony BRAVIA')],
    [logical(DP_SPEC), [2560, 0, 2.0, 0, false, [TV_SPEC], {}]],
    {'layout-mode': 1}]);

/* ------------------------------------------------------------------- tests */

suite('parse + identity', () => {
    const s = stateBothTvIdle();
    eq(s.monitors.length, 2, 'two monitors parsed');
    eq(s.monitors[0].displayName, 'Dell U2719D', 'display-name unpacked');
    eq(s.monitors[1].modes[0].isPreferred, true, 'mode properties unpacked');
    eq(enabledConnectors(s).join(','), 'DP-1', 'only DP enabled');

    ok(connectedKey(stateDesktopOnly()) !== connectedKey(stateBothTvIdle()),
        'powering the TV on changes the connected-set key');
    eq(connectedKey(stateBothTvIdle()), connectedKey(stateExtended()),
        'relayouting the same monitors does not change the key');
});

suite('automatic classification', () => {
    const {work, tv} = classify(stateBothTvIdle(), {});
    eq(work?.connector, 'DP-1', 'DisplayPort is the work display');
    eq(tv?.connector, 'HDMI-1', 'HDMI is the TV');

    const single = classify(stateDesktopOnly(), {});
    eq(single.work?.connector, 'DP-1', 'work display found alone');
    eq(single.tv, null, 'no TV when HDMI is absent');
});

suite('explicit configuration is authoritative', () => {
    // A connector the user named but which is not plugged in must resolve to
    // null, not silently fall back to guessing another monitor.
    const {tv} = classify(stateBothTvIdle(), {tvConnector: 'HDMI-2'});
    eq(tv, null, 'configured but absent TV is not guessed at');

    const swapped = classify(stateBothTvIdle(), {workConnector: 'HDMI-1', tvConnector: 'DP-1'});
    eq(swapped.work?.connector, 'HDMI-1', 'roles can be inverted by configuration');
    eq(swapped.tv?.connector, 'DP-1', 'roles can be inverted by configuration');
});

suite('the reported bug: TV powers on and steals the desktop', () => {
    const s = stateHijackedByTv();
    const plan = planFor(s, {mode: Mode.DESKTOP});
    eq(plan.apply, true, 'a correction is planned');
    eq(plan.target.connector, 'DP-1', 'the desktop goes back to the monitor');
    eq(plan.fellBack, false, 'not a fallback, the monitor is present');
    eq(plan.logicalMonitors.length, 1, 'exactly one logical monitor');
    eq(plan.logicalMonitors[0].monitors.length, 1, 'exactly one physical monitor enabled');
    eq(plan.logicalMonitors[0].monitors[0].connector, 'DP-1', 'and it is the monitor');
    eq(plan.logicalMonitors[0].primary, true, 'it is primary');
    eq(plan.logicalMonitors[0].x, 0, 'placed at origin');
    eq(plan.logicalMonitors[0].y, 0, 'placed at origin');
});

suite('idempotence', () => {
    const plan = planFor(stateBothTvIdle(), {mode: Mode.DESKTOP});
    eq(plan.apply, false, 'nothing to do when already correct');
    eq(plan.reason, 'already-correct', 'and it says so');

    const alone = planFor(stateDesktopOnly(), {mode: Mode.DESKTOP});
    eq(alone.apply, false, 'nothing to do with the TV unplugged either');
});

suite('deliberate switch to the TV', () => {
    const plan = planFor(stateBothTvIdle(), {mode: Mode.TV});
    eq(plan.apply, true, 'switching to TV mode is planned');
    eq(plan.target.connector, 'HDMI-1', 'the TV is the target');
    eq(plan.logicalMonitors[0].monitors[0].modeId, '3840x2160@60', 'preferred mode chosen for a disabled monitor');
});

suite('fallback when the wanted display is absent', () => {
    const plan = planFor(stateDesktopOnly(), {mode: Mode.TV});
    eq(plan.apply, false, 'monitor is already the only thing enabled');
    eq(plan.fellBack, true, 'and it is flagged as a fallback');
    eq(plan.target.connector, 'DP-1', 'falls back to the monitor, never to a black screen');

    // Same situation but the layout is wrong, so it must actually act.
    const dark = parseState([9,
        [monitor(DP_SPEC, DP_MODES_OFF, 'Dell U2719D')],
        [],
        {'layout-mode': 1}]);
    const rescue = planFor(dark, {mode: Mode.TV});
    eq(rescue.apply, true, 'lights the monitor up when nothing is enabled');
    eq(rescue.target.connector, 'DP-1', 'using the only monitor there is');
});

/* The user's actual LG ULTRAGEAR+, as reported by Mutter on their machine: each
 * geometry is offered twice, the variable-rate variant carrying a '+vrr' mode id
 * and refresh-rate-mode=variable. Re-enabling the display from a disabled state
 * is what would otherwise drop it to the fixed variant. */
const VRR_MODES_OFF = [
    ['3440x1440@240.085', 3440, 1440, 240.085, 1.0, [1.0, 1.25], {'is-preferred': true}],
    ['3440x1440@240.085+vrr', 3440, 1440, 240.085, 1.0, [1.0, 1.25], {'refresh-rate-mode': 'variable'}],
    ['1920x1080@60', 1920, 1080, 60.0, 1.0, [1.0], {}],
];
const VRR_MODES_ON = [
    ['3440x1440@240.085', 3440, 1440, 240.085, 1.0, [1.0, 1.25], {'is-preferred': true}],
    ['3440x1440@240.085+vrr', 3440, 1440, 240.085, 1.0, [1.0, 1.25],
        {'is-current': true, 'refresh-rate-mode': 'variable'}],
];
const LG_SPEC = ['DP-1', 'GSM', 'LG ULTRAGEAR+', '405NTNHBR799'];

suite('variable refresh rate survives being re-enabled', () => {
    // The TV hijacked the desktop, so the LG is disabled and has no current
    // mode. Re-enabling it must not drop it to the fixed-rate variant.
    const hijacked = parseState([10,
        [monitor(LG_SPEC, VRR_MODES_OFF, 'LG ULTRAGEAR+'),
            monitor(TV_SPEC, TV_MODES_ON, 'Philips FTV')],
        [logical(TV_SPEC, 1.0)],
        {'layout-mode': 1}]);

    const plan = planFor(hijacked, {mode: Mode.DESKTOP});
    eq(plan.apply, true, 'a correction is planned');
    const m = plan.logicalMonitors[0].monitors[0];
    eq(m.modeId, '3440x1440@240.085+vrr', 'the variable-rate mode is chosen over the preferred fixed one');
    eq(m.properties['refresh-rate-mode'], 'variable', 'and the rate mode is carried into the apply');

    // An enabled monitor keeps whatever it is already running, VRR included.
    const running = parseState([11,
        [monitor(LG_SPEC, VRR_MODES_ON, 'LG ULTRAGEAR+'),
            monitor(TV_SPEC, TV_MODES, 'Philips FTV')],
        [logical(LG_SPEC)],
        {'layout-mode': 1}]);
    eq(planFor(running, {mode: Mode.DESKTOP}).apply, false, 'nothing to do when already correct');

    const toTv = planFor(running, {mode: Mode.TV});
    eq(toTv.logicalMonitors[0].monitors[0].properties['refresh-rate-mode'], undefined,
        'a monitor with no rate mode carries no rate mode property');
});

/* The same monitor on its own, but running the fixed-rate variant: what Mutter
 * leaves behind when the configuration it loads for a monitor set predates
 * variable refresh. The layout is right, so nothing below this line would fire
 * without the remembered mode. */
const VRR_MODES_FIXED_ON = [
    ['3440x1440@240.085', 3440, 1440, 240.085, 1.0, [1.0, 1.25],
        {'is-current': true, 'is-preferred': true}],
    ['3440x1440@240.085+vrr', 3440, 1440, 240.085, 1.0, [1.0, 1.25], {'refresh-rate-mode': 'variable'}],
    ['3440x1440@144.050+vrr', 3440, 1440, 144.050, 1.0, [1.0, 1.25], {'refresh-rate-mode': 'variable'}],
];

suite('the remembered work mode outranks the layout looking correct', () => {
    const fixed = () => parseState([13,
        [monitor(LG_SPEC, VRR_MODES_FIXED_ON, 'LG ULTRAGEAR+'),
            monitor(TV_SPEC, TV_MODES, 'Philips FTV')],
        [logical(LG_SPEC)],
        {'layout-mode': 1}]);

    // Without a memory this is the old blind spot: right screen, wrong rate,
    // and the plan says there is nothing to do.
    eq(planFor(fixed(), {mode: Mode.DESKTOP}).reason, 'already-correct',
        'the layout alone cannot tell that the refresh rate was dropped');

    const restore = planFor(fixed(), {mode: Mode.DESKTOP, lastWorkMode: '3440x1440@240.085+vrr'});
    eq(restore.apply, true, 'a remembered variable-rate mode is put back');
    eq(restore.reason, 'restore-mode', 'and is reported as a mode restore, not a layout correction');
    const m = restore.logicalMonitors[0].monitors[0];
    eq(m.modeId, '3440x1440@240.085+vrr', 'the remembered mode id is what gets applied');
    eq(m.properties['refresh-rate-mode'], 'variable', 'carrying its rate mode');
    eq(restore.logicalMonitors[0].scale, 1.0, 'at a scale the mode actually supports');

    // A memory that agrees with reality must stay silent, or every state read
    // would re-apply the display configuration.
    eq(planFor(fixed(), {mode: Mode.DESKTOP, lastWorkMode: '3440x1440@240.085'}).apply, false,
        'a memory matching what is running changes nothing');

    // Never invent a mode: a memory from another monitor is simply ignored.
    eq(planFor(fixed(), {mode: Mode.DESKTOP, lastWorkMode: '5120x2160@60'}).apply, false,
        'a mode this monitor does not advertise is ignored, not applied');

    // The memory belongs to the work display and must not follow it to the TV.
    const toTv = planFor(fixed(), {mode: Mode.TV, lastWorkMode: '3440x1440@240.085+vrr'});
    eq(toTv.logicalMonitors[0].monitors[0].modeId, '3840x2160@60',
        'the TV is given its own mode, never the work display\'s remembered one');

    // It also outranks the preferred-mode guess when the display is off, which
    // is what carries a non-default refresh rate across a TV session.
    const hijacked = parseState([14,
        [monitor(LG_SPEC, VRR_MODES_OFF, 'LG ULTRAGEAR+'),
            monitor(TV_SPEC, TV_MODES_ON, 'Philips FTV')],
        [logical(TV_SPEC, 1.0)],
        {'layout-mode': 1}]);
    const back = planFor(hijacked, {mode: Mode.DESKTOP, lastWorkMode: '1920x1080@60'});
    eq(back.reason, 'enforce', 're-enabling a disabled display is still a layout correction');
    eq(back.logicalMonitors[0].monitors[0].modeId, '1920x1080@60',
        'the remembered mode wins over the preferred one when the display was off');

    // And the fallback case: TV mode with no TV lands on the work display, so
    // the memory applies there too.
    const noTv = parseState([15,
        [monitor(LG_SPEC, VRR_MODES_FIXED_ON, 'LG ULTRAGEAR+')],
        [logical(LG_SPEC)],
        {'layout-mode': 1}]);
    const fell = planFor(noTv, {mode: Mode.TV, lastWorkMode: '3440x1440@240.085+vrr'});
    eq(fell.fellBack, true, 'TV mode falls back to the work display');
    eq(fell.logicalMonitors[0].monitors[0].modeId, '3440x1440@240.085+vrr',
        'and the fallback still gets the remembered mode');
});

/* The second thing a stored configuration carries and a fresh apply does not:
 * HDR. It is a monitor property rather than part of the mode id, so unlike the
 * refresh rate nothing carries it at all unless the plan names it -- which is
 * why enforcement was switching HDR off every time the desktop came back. */
suite('HDR survives the trip to the TV and back', () => {
    // At the desk with HDR on, the TV idle: the plan must carry it.
    const desk = colourMode => parseState([20,
        [monitor(LG_SPEC, VRR_MODES_ON, 'LG ULTRAGEAR+', colour(colourMode)),
            monitor(TV_SPEC, TV_MODES, 'Philips FTV')],
        [logical(LG_SPEC)],
        {'layout-mode': 1}]);

    eq(desk(1).monitors[0].colorMode, 1, 'the colour mode is parsed off the monitor');
    eq(desk(1).monitors[0].supportedColorModes.join(','), '0,1', 'so is the supported list');

    // The reported bug in miniature: right screen, right mode, HDR switched
    // off, and without the memory nothing notices.
    eq(planFor(desk(0), {mode: Mode.DESKTOP}).reason, 'already-correct',
        'the layout alone cannot tell that HDR was dropped');

    const restore = planFor(desk(0), {mode: Mode.DESKTOP, lastWorkColorMode: 1});
    eq(restore.apply, true, 'a remembered colour mode is put back');
    eq(restore.reason, 'restore-mode', 'reported as a restore, so nothing is announced');
    eq(restore.logicalMonitors[0].monitors[0].properties['color-mode'], 1,
        'and bt2100 reaches the apply');

    // A memory agreeing with reality must stay silent, or every state read
    // re-applies the display configuration.
    eq(planFor(desk(1), {mode: Mode.DESKTOP, lastWorkColorMode: 1}).apply, false,
        'a memory matching what is running changes nothing');

    // Turning HDR off deliberately is remembered, not fought. The default is
    // expressed by omitting the property, exactly as gdctl does it.
    const off = planFor(desk(1), {mode: Mode.DESKTOP, lastWorkColorMode: 0});
    eq(off.apply, true, 'going back to SDR is a change worth making');
    eq(off.logicalMonitors[0].monitors[0].properties['color-mode'], undefined,
        'and the default colour mode is sent by leaving the property out');

    // Never invent one: sdr-native is not in this monitor's supported list.
    eq(planFor(desk(1), {mode: Mode.DESKTOP, lastWorkColorMode: 2}).apply, false,
        'a colour mode the monitor does not advertise is ignored, not applied');

    // Coming back from the TV, the LG is disabled: its reported colour mode is
    // whatever the layout that disabled it stored, so the memory has to win.
    const hijacked = parseState([21,
        [monitor(LG_SPEC, VRR_MODES_OFF, 'LG ULTRAGEAR+', colour(0)),
            monitor(TV_SPEC, TV_MODES_ON, 'Philips FTV', colour(1))],
        [logical(TV_SPEC, 1.0)],
        {'layout-mode': 1}]);
    const back = planFor(hijacked, {mode: Mode.DESKTOP, lastWorkColorMode: 1});
    eq(back.reason, 'enforce', 're-enabling a disabled display is still a layout correction');
    const m = back.logicalMonitors[0].monitors[0];
    eq(m.properties['color-mode'], 1, 'the remembered colour mode comes back with it');
    eq(m.modeId, '3440x1440@240.085+vrr', 'alongside the remembered-mode machinery, not instead of it');

    // The memory belongs to the work display and must never follow it to the TV.
    const toTv = planFor(desk(1), {mode: Mode.TV, lastWorkColorMode: 1});
    eq(toTv.logicalMonitors[0].monitors[0].properties['color-mode'], undefined,
        'the TV is not given the work display\'s remembered colour mode');

    // It keeps its own, though: a TV already running HDR must not be knocked
    // back to SDR by our enforcement either.
    const tvHdr = parseState([22,
        [monitor(LG_SPEC, VRR_MODES_ON, 'LG ULTRAGEAR+', colour(1)),
            monitor(TV_SPEC, TV_MODES_ON, 'Philips FTV', colour(1))],
        [logical(LG_SPEC), [3440, 0, 1.0, 0, false, [TV_SPEC], {}]],
        {'layout-mode': 1}]);
    eq(planFor(tvHdr, {mode: Mode.TV}).logicalMonitors[0].monitors[0].properties['color-mode'], 1,
        'the TV keeps the colour mode it is already running');

    // And the fallback case: TV mode with no TV lands on the work display, so
    // the memory applies there too.
    const noTv = parseState([23,
        [monitor(LG_SPEC, VRR_MODES_ON, 'LG ULTRAGEAR+', colour(0))],
        [logical(LG_SPEC)],
        {'layout-mode': 1}]);
    const fell = planFor(noTv, {mode: Mode.TV, lastWorkColorMode: 1});
    eq(fell.fellBack, true, 'TV mode falls back to the work display');
    eq(fell.logicalMonitors[0].monitors[0].properties['color-mode'], 1,
        'and the fallback still gets the remembered colour mode');
});

suite('a Mutter that never mentions colour modes is left alone', () => {
    // Every other fixture in this file omits the property, which is what an
    // older Mutter looks like. Nothing may be invented from that silence.
    const s = stateHijackedByTv();
    eq(s.monitors[0].colorMode, null, 'an unreported colour mode parses as null, not 0');
    const plan = planFor(s, {mode: Mode.DESKTOP, lastWorkColorMode: 1});
    eq(plan.apply, true, 'the layout is still corrected');
    eq(plan.logicalMonitors[0].monitors[0].properties['color-mode'], undefined,
        'but no colour mode is sent to a monitor that advertises none');
    eq(planFor(stateBothTvIdle(), {mode: Mode.DESKTOP, lastWorkColorMode: 1}).apply, false,
        'and an unusable memory cannot provoke an apply');
});

suite('forwarded properties are an allowlist', () => {
    // Mutter ignores unknown property names but rejects a known one with the
    // wrong type, so nothing outside the allowlist may be passed through.
    const noisy = [
        ['1920x1080@60', 1920, 1080, 60.0, 1.0, [1.0],
            {'is-current': true, 'is-preferred': true, 'is-interlaced': false,
                'refresh-rate-mode': 'variable', 'some-future-key': 'surprise'}],
    ];
    const state = parseState([12,
        [monitor(DP_SPEC, noisy, 'Whatever'), monitor(TV_SPEC, TV_MODES, 'TV')],
        [logical(TV_SPEC)],
        {'layout-mode': 1}]);

    const props = planFor(state, {mode: Mode.DESKTOP}).logicalMonitors[0].monitors[0].properties;
    eq(props['refresh-rate-mode'], 'variable', 'the allowlisted property is forwarded');
    eq(props['some-future-key'], undefined, 'an unknown property is not');
    eq(props['is-current'], undefined, 'read-only status is not forwarded');
    eq(props['is-preferred'], undefined, 'read-only status is not forwarded');
});

suite('mode and scale selection stay inside what Mutter offers', () => {
    // Enabled monitor: keep the mode it is already running.
    const keep = planFor(stateExtended(), {mode: Mode.TV});
    eq(keep.logicalMonitors[0].monitors[0].modeId, '3840x2160@60', 'current mode kept for an enabled monitor');
    eq(keep.logicalMonitors[0].scale, 2.0, 'existing scale kept for an enabled monitor');

    // Disabled monitor: fall to preferred scale, and only to a supported one.
    const fresh = planFor(stateBothTvIdle(), {mode: Mode.TV});
    const chosen = fresh.logicalMonitors[0];
    const supported = [1.0, 1.5, 2.0, 3.0];
    ok(supported.includes(chosen.scale), `scale ${chosen.scale} is one Mutter offers`);
    eq(chosen.scale, 2.0, 'preferred scale used for a monitor being enabled');
    eq(chosen.transform, 0, 'no rotation applied');
});

suite('adopting a layout somebody else chose', () => {
    eq(inferMode(stateBothTvIdle(), {}), Mode.DESKTOP, 'monitor only reads as desktop mode');
    eq(inferMode(stateHijackedByTv(), {}), Mode.TV, 'TV only reads as TV mode');
    eq(inferMode(stateExtended(), {}), Mode.CUSTOM, 'an extended desktop is custom');
    eq(inferMode(stateDesktopOnly(), {}), Mode.DESKTOP, 'single monitor reads as desktop mode');

    // Custom must never be enforced -- that is what keeps a hand-made layout.
    eq(planFor(stateExtended(), {mode: Mode.CUSTOM}).apply, false, 'custom mode is never enforced');
});

suite('a plan is never destructive', () => {
    for (const [name, state] of Object.entries({
        stateDesktopOnly: stateDesktopOnly(),
        stateHijackedByTv: stateHijackedByTv(),
        stateBothTvIdle: stateBothTvIdle(),
        stateExtended: stateExtended(),
    })) {
        for (const mode of [Mode.DESKTOP, Mode.TV]) {
            const plan = planFor(state, {mode});
            if (!plan.apply)
                continue;
            const enabled = plan.logicalMonitors.flatMap(lm => lm.monitors.map(m => m.connector));
            ok(enabled.length >= 1, `${name}/${mode}: at least one display stays on`);
            ok(plan.logicalMonitors.some(lm => lm.primary), `${name}/${mode}: a primary is set`);
            for (const c of enabled) {
                ok(state.monitors.some(m => m.connector === c),
                    `${name}/${mode}: ${c} is actually connected`);
            }
        }
    }
});

print('');
if (failures) {
    print(`${failures} failed out of ${checks} checks`);
    imports.system.exit(1);
} else {
    print(`all ${checks} checks passed`);
}
