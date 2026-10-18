#!/usr/bin/gjs -m
/* Which per-monitor properties does this Mutter accept in ApplyMonitorsConfig?
 *
 * Uses method 0 (VERIFY), which validates a configuration without applying it,
 * so this cannot change the display. Mutter distinguishes an unknown property
 * name from a known-but-unsupported one in the error text, which is what tells
 * us the spelling to use for VRR.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseState} from '../extension/lib/plan.js';

const STATE_TYPE = new GLib.VariantType(
    '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');
const METHOD_VERIFY = 0;

const bus = Gio.DBus.session;
const call = (name, args, type) => bus.call_sync(
    'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
    'org.gnome.Mutter.DisplayConfig', name, args, type,
    Gio.DBusCallFlags.NONE, -1, null);

const raw = call('GetCurrentState', null, STATE_TYPE).recursiveUnpack();
const state = parseState(raw);

/* Every distinct property key Mutter actually reports, so a real VRR-capable
 * monitor shows its own vocabulary when this is run on the target machine. */
const modeKeys = new Set();
const monitorKeys = new Set();
for (const [, modes, props] of raw[1]) {
    Object.keys(props).forEach(k => monitorKeys.add(k));
    for (const m of modes)
        Object.keys(m[6]).forEach(k => modeKeys.add(k));
}
print(`monitor property keys reported: ${[...monitorKeys].join(', ') || '(none)'}`);
print(`mode property keys reported:    ${[...modeKeys].join(', ') || '(none)'}`);
print('');

for (const m of state.monitors) {
    const cur = m.modes.find(x => x.isCurrent);
    if (!cur)
        continue;
    const rawMode = raw[1].find(x => x[0][0] === m.connector)[1].find(x => x[0] === cur.id);
    print(`${m.connector} current mode ${cur.id} properties: ` +
          `${JSON.stringify(rawMode[6])}`);
}
print('');

const target = state.monitors.find(m => m.modes.some(x => x.isCurrent));
if (!target) {
    print('no enabled monitor to test against');
} else {
    const mode = target.modes.find(x => x.isCurrent);
    const lm = state.logicalMonitors.find(l => l.connectors.includes(target.connector));

    const candidates = [
        ['(none)', {}],
        ['refresh-rate-mode=variable', {'refresh-rate-mode': GLib.Variant.new_string('variable')}],
        ['refresh_rate_mode=variable', {'refresh_rate_mode': GLib.Variant.new_string('variable')}],
        ['enable_underscanning=false', {'enable_underscanning': GLib.Variant.new_boolean(false)}],
        ['color-mode=0', {'color-mode': GLib.Variant.new_uint32(0)}],
        ['color_mode=0', {'color_mode': GLib.Variant.new_uint32(0)}],
        ['nonsense-key=1', {'definitely-not-a-real-property': GLib.Variant.new_boolean(true)}],
    ];

    print(`verifying against ${target.connector} @ ${mode.id} (nothing is applied):`);
    for (const [label, props] of candidates) {
        const args = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
            state.serial, METHOD_VERIFY,
            [[lm?.x ?? 0, lm?.y ?? 0, lm?.scale ?? 1, lm?.transform ?? 0, true,
                [[target.connector, mode.id, props]]]],
            {},
        ]);
        try {
            call('ApplyMonitorsConfig', args, null);
            print(`  ACCEPTED  ${label}`);
        } catch (e) {
            print(`  rejected  ${label}  -- ${e.message.replace(/^.*?: /, '')}`);
        }
    }
}
