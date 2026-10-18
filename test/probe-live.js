#!/usr/bin/gjs -m
/* Read-only smoke test against the running Mutter.
 *
 * Proves that parseState() matches what GetCurrentState actually returns on
 * this machine, and prints the plan that would be applied for each mode.
 * It never calls ApplyMonitorsConfig, so it cannot change anything.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Mode, parseState, planFor, inferMode, classify, connectedKey, enabledConnectors, pickMode,
    pickColorMode} from '../extension/lib/plan.js';

/* Mutter's MetaColorMode, for readability only -- the code never parses these. */
const COLOR_MODES = {0: 'default (SDR)', 1: 'bt2100 (HDR)', 2: 'sdr-native'};
const colourName = v => (v === null ? 'not reported by this Mutter' : COLOR_MODES[v] ?? `${v}`);

const STATE_TYPE = new GLib.VariantType(
    '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');

const reply = Gio.DBus.session.call_sync(
    'org.gnome.Mutter.DisplayConfig',
    '/org/gnome/Mutter/DisplayConfig',
    'org.gnome.Mutter.DisplayConfig',
    'GetCurrentState', null, STATE_TYPE,
    Gio.DBusCallFlags.NONE, -1, null);

const state = parseState(reply.recursiveUnpack());

print(`serial          ${state.serial}`);
print(`layout-mode     ${state.properties['layout-mode']}`);
print(`connected key   ${connectedKey(state)}`);
print(`enabled         ${enabledConnectors(state).join(', ') || '(none)'}`);
print('');

for (const m of state.monitors) {
    const cur = m.modes.find(x => x.isCurrent);
    const pref = m.modes.find(x => x.isPreferred);
    print(`${m.connector}  "${m.displayName}"  ${m.vendor}/${m.product}`);
    print(`    modes ${m.modes.length}, current ${cur ? cur.id : '(disabled)'}, preferred ${pref ? pref.id : '(none)'}`);
    if (pref)
        print(`    preferred scale ${pref.preferredScale}, supported ${pref.supportedScales.join(' ')}`);

    /* Every mode that matters to pickMode(): the one in use, the one it falls
     * back to, and every variable-rate mode it could upgrade to. The rest are
     * only a count, or a 34" monitor prints eighty lines. */
    const notable = m.modes.filter(x => x.isCurrent || x.isPreferred || x.refreshRateMode === 'variable');
    print(`    notable modes (${notable.length} of ${m.modes.length}):`);
    for (const x of notable) {
        const flags = [
            x.isCurrent ? 'current' : null,
            x.isPreferred ? 'preferred' : null,
            x.refreshRateMode ? `rate=${x.refreshRateMode}` : null,
        ].filter(Boolean).join(' ');
        print(`      ${x.id.padEnd(28)} ${x.width}x${x.height}@${x.refresh.toFixed(3)}  ${flags}`);
    }
    const chosen = pickMode(m);
    print(`    pickMode -> ${chosen ? chosen.id : '(none)'}` +
          `${chosen?.refreshRateMode ? ` [${chosen.refreshRateMode}]` : ' [fixed rate]'}`);

    /* HDR. A monitor property rather than part of the mode id, so it is the
     * one thing an apply drops unless the plan names it. */
    print(`    colour mode ${colourName(m.colorMode)}, supported ` +
          `${m.supportedColorModes.map(colourName).join(' / ') || '(none reported)'}`);
    print(`    pickColorMode -> ${colourName(pickColorMode(m))} (with no memory)`);
}

const {work, tv} = classify(state, {});
print('');
print(`auto work display  ${work ? work.connector : '(none found)'}`);
print(`auto TV            ${tv ? tv.connector : '(none found)'}`);
print(`inferred mode      ${inferMode(state, {})}`);
print('');

for (const mode of [Mode.DESKTOP, Mode.TV]) {
    const plan = planFor(state, {mode});
    if (!plan.apply) {
        print(`plan(${mode}): no change -- ${plan.reason}` +
              (plan.target ? ` (${plan.target.connector})` : ''));
        continue;
    }
    const lm = plan.logicalMonitors[0];
    const props = Object.entries(lm.monitors[0].properties ?? {})
        .map(([k, v]) => `${k}=${v}`).join(' ');
    print(`plan(${mode}): [${plan.reason}] enable ${lm.monitors[0].connector} ` +
          `mode ${lm.monitors[0].modeId} scale ${lm.scale}` +
          `${props ? ` [${props}]` : ''}${plan.fellBack ? ' [fallback]' : ''}`);
}
