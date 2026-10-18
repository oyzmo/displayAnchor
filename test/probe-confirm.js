#!/usr/bin/gjs -m
/* Does ApplyMonitorsConfig prompt "Keep these display settings?" ?
 *
 *   gjs -m test/probe-confirm.js <method>      1 = TEMPORARY, 2 = PERSISTENT
 *
 * The dialog cannot be seen from a terminal, but its consequence can: when
 * Mutter asks for confirmation and nobody confirms, it reverts after ~20s. So
 * apply a different mode, look immediately, then look again after the timeout.
 * Reverted means the change was gated on confirmation.
 *
 * This DOES change the display for up to a minute, and restores it afterwards.
 * Run it on a machine you can afford to blink, not mid-presentation.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseState} from '../extension/lib/plan.js';
import {buildApplyArgs} from '../extension/lib/variant.js';

const STATE_TYPE = new GLib.VariantType(
    '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');

const method = parseInt(ARGV[0] ?? '2', 10);
const WAIT_SECONDS = 30;

const bus = Gio.DBus.session;

function readState() {
    const reply = bus.call_sync(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, STATE_TYPE,
        Gio.DBusCallFlags.NONE, -1, null);
    return parseState(reply.recursiveUnpack());
}

function currentModeOf(state, connector) {
    const monitor = state.monitors.find(m => m.connector === connector);
    return monitor?.modes.find(m => m.isCurrent)?.id ?? '(disabled)';
}

function apply(state, connector, modeId, howe) {
    const logical = [{
        x: 0, y: 0, scale: 1.0, transform: 0, primary: true,
        monitors: [{connector, modeId, properties: {}}],
    }];
    bus.call_sync(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig',
        buildApplyArgs(state.serial, howe, logical), null,
        Gio.DBusCallFlags.NONE, -1, null);
}

const before = readState();
const target = before.monitors.find(m => m.modes.some(x => x.isCurrent));
if (!target) {
    print('no enabled monitor to test with');
    imports.system.exit(1);
}

const original = currentModeOf(before, target.connector);
const alternative = target.modes.find(m => m.id !== original && !m.isCurrent);
if (!alternative) {
    print('monitor offers only one mode; nothing to switch between');
    imports.system.exit(1);
}

print(`monitor  ${target.connector}`);
print(`original ${original}`);
print(`applying ${alternative.id} with method ${method} ` +
      `(${method === 1 ? 'TEMPORARY' : method === 2 ? 'PERSISTENT' : '?'})`);

try {
    apply(before, target.connector, alternative.id, method);
} catch (e) {
    print(`apply failed: ${e.message}`);
    imports.system.exit(1);
}

print(`immediately after: ${currentModeOf(readState(), target.connector)}`);
print(`waiting ${WAIT_SECONDS}s for a confirmation timeout...`);

const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WAIT_SECONDS, () => {
    const after = readState();
    const now = currentModeOf(after, target.connector);
    print(`after ${WAIT_SECONDS}s:      ${now}`);
    print('');
    if (now === original) {
        print(`VERDICT: method ${method} REVERTED on its own.`);
        print('         Mutter gated it on the "Keep these display settings?" dialog.');
    } else {
        print(`VERDICT: method ${method} stuck without confirmation.`);
        print('         No dialog gates this method.');
        try {
            apply(after, target.connector, original, method);
            print(`         restored ${original}`);
        } catch (e) {
            print(`         could not restore: ${e.message}`);
        }
    }
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
