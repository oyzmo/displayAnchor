/* Display Anchor -- keep the desktop on the display you chose.
 * Copyright (C) 2026 oyzmo <http://oyzmo.no>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 */

/* GVariant packing for ApplyMonitorsConfig.
 *
 * Imports GLib only -- no shell resources -- so the packing that the real
 * D-Bus call depends on can be exercised outside GNOME Shell.
 */

import GLib from 'gi://GLib';

/* Numbers are the one type that cannot be packed from the value alone: JS has
 * a single number type and Mutter wants a specific one, so each numeric
 * property has to be named here with the type it is documented to take.
 * `color-mode` is 'u' -- verified against GNOME's own gdctl, which builds the
 * same ApplyMonitorsConfig call and packs it as GLib.Variant("u", value). */
const NUMERIC_PROPS = {'color-mode': 'u'};

/* Properties arrive from recursiveUnpack() as plain JS and have to go back out
 * as variants. Only the scalar types plan.js is allowed to forward are handled;
 * anything else is dropped rather than guessed at, because a property carrying
 * the wrong type makes Mutter reject the entire configuration. */
export function packProperties(props = {}) {
    const out = {};
    for (const [key, value] of Object.entries(props)) {
        if (typeof value === 'string')
            out[key] = GLib.Variant.new_string(value);
        else if (typeof value === 'boolean')
            out[key] = GLib.Variant.new_boolean(value);
        else if (NUMERIC_PROPS[key] === 'u' && Number.isInteger(value) && value >= 0)
            out[key] = GLib.Variant.new_uint32(value);
    }
    return out;
}

/* The full (uua(iiduba(ssa{sv}))a{sv}) argument for ApplyMonitorsConfig. */
export function buildApplyArgs(serial, method, logicalMonitors, properties = {}) {
    const logical = logicalMonitors.map(lm => [
        lm.x, lm.y, lm.scale, lm.transform, lm.primary,
        lm.monitors.map(m => [m.connector, m.modeId, packProperties(m.properties)]),
    ]);
    return new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [serial, method, logical, packProperties(properties)]);
}
