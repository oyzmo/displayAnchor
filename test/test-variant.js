#!/usr/bin/gjs -m
/* Tests for the GVariant packing, plus a live dry-run.
 *
 * The packing is where a type mistake would make Mutter reject the whole
 * configuration, and it is invisible to the pure planning tests because it
 * needs GLib. The final section builds a plan from this machine's real display
 * state and hands it to ApplyMonitorsConfig with method 0 (VERIFY), which
 * validates without applying -- so the entire call path is exercised for real.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {packProperties, buildApplyArgs} from '../extension/lib/variant.js';
import {parseState, planFor, Mode} from '../extension/lib/plan.js';

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

suite('property packing', () => {
    const packed = packProperties({'refresh-rate-mode': 'variable', flag: true});
    eq(packed['refresh-rate-mode'].get_type_string(), 's', 'a string packs as s');
    eq(packed['refresh-rate-mode'].unpack(), 'variable', 'and keeps its value');
    eq(packed.flag.get_type_string(), 'b', 'a boolean packs as b');

    // A number carries no type of its own, so only the named numeric
    // properties are packed, and only as the type Mutter documents for them.
    const colour = packProperties({'color-mode': 1});
    eq(colour['color-mode'].get_type_string(), 'u', 'color-mode packs as uint32');
    eq(colour['color-mode'].unpack(), 1, 'and keeps its value');

    // Anything not a scalar plan.js forwards must be dropped, not guessed at.
    const dropped = packProperties({n: 3, list: [1, 2], obj: {}, nothing: null});
    eq(Object.keys(dropped).length, 0, 'an unnamed numeric property is dropped');
    eq(Object.keys(packProperties({'color-mode': 1.5})).length, 0,
        'a non-integer colour mode is dropped rather than truncated');
    eq(Object.keys(packProperties({'color-mode': -1})).length, 0,
        'and so is one that would not fit an unsigned integer');
    eq(Object.keys(packProperties()).length, 0, 'undefined input is fine');
});

suite('apply argument construction', () => {
    const args = buildApplyArgs(7, 2, [{
        x: 0, y: 0, scale: 1.0, transform: 0, primary: true,
        monitors: [{connector: 'DP-1', modeId: '3440x1440@240.085',
            properties: {'refresh-rate-mode': 'variable', 'color-mode': 1}}],
    }]);
    eq(args.get_type_string(), '(uua(iiduba(ssa{sv}))a{sv})', 'signature matches the interface');

    const [serial, method, logical] = args.recursiveUnpack();
    eq(serial, 7, 'serial survives');
    eq(method, 2, 'method survives');
    eq(logical[0][4], true, 'primary survives');
    const monitor = logical[0][5][0];
    eq(monitor[0], 'DP-1', 'connector survives');
    eq(monitor[1], '3440x1440@240.085', 'mode id survives');
    eq(monitor[2]['refresh-rate-mode'], 'variable', 'the rate mode reaches the wire');
    eq(monitor[2]['color-mode'], 1, 'so does the colour mode');

    // A monitor with no properties at all must still pack.
    const bare = buildApplyArgs(1, 2, [{
        x: 0, y: 0, scale: 1.0, transform: 0, primary: true,
        monitors: [{connector: 'DP-1', modeId: 'x'}],
    }]);
    ok(bare instanceof GLib.Variant, 'missing properties do not throw');
});

suite('live dry-run against Mutter (method 0, applies nothing)', () => {
    const STATE_TYPE = new GLib.VariantType(
        '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');
    let state;
    try {
        const reply = Gio.DBus.session.call_sync(
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, STATE_TYPE,
            Gio.DBusCallFlags.NONE, -1, null);
        state = parseState(reply.recursiveUnpack());
    } catch (e) {
        print(`  skipped -- no session Mutter here (${e.message})`);
        return;
    }

    // Build a config for whichever monitor is enabled, exactly as the extension
    // would, and ask Mutter whether it is valid.
    const target = state.monitors[0];
    const mode = target.modes.find(m => m.isCurrent) ?? target.modes[0];
    const args = buildApplyArgs(state.serial, 0, [{
        x: 0, y: 0, scale: 1.0, transform: 0, primary: true,
        monitors: [{connector: target.connector, modeId: mode.id,
            properties: {'refresh-rate-mode': 'variable'}}],
    }]);

    try {
        Gio.DBus.session.call_sync(
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig', args, null,
            Gio.DBusCallFlags.NONE, -1, null);
        ok(true, `Mutter accepts a config built by buildApplyArgs (${target.connector} @ ${mode.id})`);
    } catch (e) {
        ok(false, `Mutter rejected the built config: ${e.message}`);
    }

    // And the same for a real plan, so planFor's output shape is validated too.
    const plan = planFor(state, {mode: Mode.DESKTOP});
    if (!plan.apply) {
        print(`  (planFor says "${plan.reason}" on this machine, nothing further to verify)`);
        return;
    }
    try {
        Gio.DBus.session.call_sync(
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig',
            buildApplyArgs(state.serial, 0, plan.logicalMonitors), null,
            Gio.DBusCallFlags.NONE, -1, null);
        ok(true, 'Mutter accepts a real planFor() configuration');
    } catch (e) {
        ok(false, `Mutter rejected a real plan: ${e.message}`);
    }
});

print('');
if (failures) {
    print(`${failures} failed out of ${checks} checks`);
    imports.system.exit(1);
} else {
    print(`all ${checks} checks passed`);
}
