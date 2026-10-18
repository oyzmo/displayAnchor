/* Display Anchor -- keep the desktop on the display you chose.
 * Copyright (C) 2026 oyzmo <http://oyzmo.no>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 */

/* Pure display-configuration planning.
 *
 * Deliberately free of any `gi://` or `resource:///` import so it can be unit
 * tested with plain gjs (see ../../test/test-plan.js). Everything here works on
 * the *unpacked* form of org.gnome.Mutter.DisplayConfig.GetCurrentState, i.e.
 * what GLib.Variant.recursiveUnpack() produces.
 */

export const Mode = {
    DESKTOP: 'desktop', // work display on, TV off
    TV: 'tv',           // TV on, work display off
    CUSTOM: 'custom',   // anything else, arranged by the user themselves
};

/* GetCurrentState returns
 *   (u  serial,
 *    a((ssss)a(siiddada{sv})a{sv})  monitors,
 *    a(iiduba(ssss)a{sv})           logical monitors,
 *    a{sv}                          properties)
 */
export function parseState(raw) {
    const [serial, monitorsRaw, logicalRaw, properties] = raw;

    const monitors = monitorsRaw.map(([spec, modesRaw, props]) => {
        const [connector, vendor, product, monitorSerial] = spec;
        return {
            connector, vendor, product, serial: monitorSerial,
            displayName: props['display-name'] ?? connector,
            isBuiltin: props['is-builtin'] ?? false,
            // HDR. Unlike the refresh rate this is a *monitor* property rather
            // than part of the mode id, so nothing carries it across an apply
            // unless we name it. 0 = default (SDR), 1 = bt2100 (HDR),
            // 2 = sdr-native; Mutter writes it to monitors.xml as <colormode>.
            // null on a Mutter too old to report it, which is not the same as 0.
            colorMode: typeof props['color-mode'] === 'number' ? props['color-mode'] : null,
            supportedColorModes: props['supported-color-modes'] ?? [],
            modes: modesRaw.map(([id, width, height, refresh, preferredScale, supportedScales, mprops]) => ({
                id, width, height, refresh, preferredScale,
                supportedScales: supportedScales ?? [],
                isCurrent: mprops['is-current'] ?? false,
                isPreferred: mprops['is-preferred'] ?? false,
                // 'variable' on a VRR/FreeSync mode. Mutter stores this per
                // mode (meta_monitor_mode_get_refresh_rate_mode) and writes it
                // to monitors.xml as <ratemode>.
                refreshRateMode: mprops['refresh-rate-mode'] ?? null,
                properties: mprops,
            })),
        };
    });

    const logicalMonitors = logicalRaw.map(([x, y, scale, transform, primary, specs, props]) => ({
        x, y, scale, transform, primary,
        connectors: specs.map(s => s[0]),
        properties: props,
    }));

    return {serial, monitors, logicalMonitors, properties};
}

export function enabledConnectors(state) {
    const out = [];
    for (const lm of state.logicalMonitors) {
        for (const c of lm.connectors) {
            if (!out.includes(c))
                out.push(c);
        }
    }
    return out.sort();
}

/* Identity of the set of *physically connected* monitors. Mutter keys its
 * stored configuration on exactly this, which is why powering the TV on makes
 * it load a different config -- so this is also what we watch to tell a hotplug
 * apart from a deliberate reconfiguration. */
export function connectedKey(state) {
    return state.monitors
        .map(m => [m.connector, m.vendor, m.product, m.serial].join('|'))
        .sort()
        .join(';');
}

/* Which monitor is the work display and which is the TV.
 * An explicitly configured connector is authoritative: if it is configured but
 * not currently connected, the answer is null, never a guess. */
export function classify(state, prefs = {}) {
    const byConnector = c => state.monitors.find(m => m.connector === c) ?? null;

    let work = prefs.workConnector ? byConnector(prefs.workConnector) : null;
    let tv = prefs.tvConnector ? byConnector(prefs.tvConnector) : null;

    if (!tv && !prefs.tvConnector)
        tv = state.monitors.find(m => m !== work && /^HDMI/i.test(m.connector)) ?? null;

    if (!work && !prefs.workConnector) {
        work = state.monitors.find(m => m !== tv && /^(DP|DisplayPort|eDP|LVDS)/i.test(m.connector))
            ?? state.monitors.find(m => m !== tv)
            ?? null;
    }

    return {work, tv};
}

/* Properties forwarded from the chosen mode into ApplyMonitorsConfig.
 * Deliberately an allowlist: Mutter ignores property names it does not know,
 * but a known name carrying the wrong type makes it reject the whole config.
 * The colour mode is not in here because it belongs to the monitor, not to the
 * mode -- see monitorProperties(). */
const FORWARDED_MODE_PROPS = ['refresh-rate-mode'];

/* META_COLOR_MODE_DEFAULT, i.e. plain SDR: what Mutter uses for a monitor whose
 * configuration does not mention a colour mode. */
const COLOR_MODE_DEFAULT = 0;

/* Which mode to put the target into. Three sources, in order of authority:
 *
 * 1. `remembered` -- the mode this display was last seen running in a plain
 *    desktop layout, carried across in `last-work-mode`. It outranks even the
 *    mode the display is running *right now*, because the thing that loses VRR
 *    is Mutter's own stored configuration: the config block it loads when the
 *    TV appears or disappears sets the mode too, and a block written before
 *    variable refresh existed brings the monitor back at a fixed rate while
 *    leaving the desktop on the right screen. Only ever consulted for the work
 *    display, and only if it still advertises that exact mode -- never invent
 *    a mode Mutter would reject.
 * 2. Otherwise a monitor that is already on keeps what it is running.
 * 3. Otherwise -- the display is off, which is exactly what the TV hijack does
 *    -- the preferred mode may be the fixed-rate variant, so prefer a
 *    variable-rate mode of the same geometry if the monitor advertises one. */
export function pickMode(monitor, remembered = null) {
    if (remembered) {
        const match = monitor.modes.find(m => m.id === remembered);
        if (match)
            return match;
    }

    const current = monitor.modes.find(m => m.isCurrent);
    if (current)
        return current;

    const preferred = monitor.modes.find(m => m.isPreferred) ?? monitor.modes[0] ?? null;
    if (!preferred || preferred.refreshRateMode === 'variable')
        return preferred;

    const sameGeometry = m =>
        m.width === preferred.width &&
        m.height === preferred.height &&
        Math.abs(m.refresh - preferred.refresh) < 0.01;

    return monitor.modes.find(m => m !== preferred && sameGeometry(m) && m.refreshRateMode === 'variable')
        ?? preferred;
}

/* Which colour mode to put the target into -- the same three sources as
 * pickMode, for the same reason.
 *
 * A configuration handed to ApplyMonitorsConfig is a complete description of
 * the monitor, so one that does not name a colour mode puts the monitor into
 * the default: our own enforcement was switching HDR off every time the desktop
 * came back from the TV. Carrying the current one across fixes that whenever
 * the display is already on, but coming back from the TV it is not -- and a
 * disabled monitor's reported colour mode is whatever the layout that disabled
 * it happened to store. Hence `remembered`, which outranks it.
 *
 * Never invent one: a value the monitor does not advertise is ignored, exactly
 * as an unadvertised mode is. */
export function pickColorMode(monitor, remembered = null) {
    const advertised = value =>
        monitor.supportedColorModes.includes(value) || value === monitor.colorMode;

    if (remembered !== null && advertised(remembered))
        return remembered;

    return monitor.colorMode;
}

function forwardedProperties(mode) {
    const out = {};
    for (const key of FORWARDED_MODE_PROPS) {
        const value = mode.properties?.[key];
        if (typeof value === 'string' || typeof value === 'boolean')
            out[key] = value;
    }
    return out;
}

/* Everything handed to ApplyMonitorsConfig for the target monitor: the
 * allowlisted properties of the chosen mode, plus the colour mode.
 *
 * `color-mode` is named only when it is not the default, which is how GNOME's
 * own gdctl builds the same call. Omitting it and sending 0 mean the same thing
 * to Mutter, so a machine that never touches HDR keeps sending exactly what it
 * sent before this existed. */
function monitorProperties(mode, colorMode) {
    const out = forwardedProperties(mode);
    if (typeof colorMode === 'number' && colorMode !== COLOR_MODE_DEFAULT)
        out['color-mode'] = colorMode;
    return out;
}

/* Never invent a scale Mutter would reject: choose from the mode's own
 * supported list, closest to what the monitor already uses (or to its preferred
 * scale when it is currently disabled). */
function pickScale(state, monitor, mode) {
    const current = state.logicalMonitors.find(lm => lm.connectors.includes(monitor.connector));
    const wanted = current ? current.scale : (mode.preferredScale || 1);
    const scales = mode.supportedScales ?? [];
    if (!scales.length)
        return wanted;
    let best = scales[0];
    for (const s of scales) {
        if (Math.abs(s - wanted) < Math.abs(best - wanted))
            best = s;
    }
    return best;
}

/* What, if anything, to hand to ApplyMonitorsConfig to realise `mode`. */
export function planFor(state, opts) {
    const mode = opts.mode;
    if (mode !== Mode.DESKTOP && mode !== Mode.TV)
        return {apply: false, reason: 'mode-not-enforced'};

    const {work, tv} = classify(state, opts);

    let target = mode === Mode.TV ? tv : work;
    let fellBack = false;
    if (!target) {
        // The monitor this mode wants is not plugged in. Light up the other one
        // rather than leaving the user staring at a black screen.
        target = mode === Mode.TV ? work : tv;
        fellBack = true;
    }
    if (!target)
        return {apply: false, reason: 'no-monitors'};

    // Both memories belong to the work display, so they are only an authority
    // when the work display is what we are lighting up -- which includes TV
    // mode falling back to it.
    const onWork = target === work;
    const remembered = onWork ? (opts.lastWorkMode || null) : null;
    const rememberedColor = onWork && opts.lastWorkColorMode != null
        ? opts.lastWorkColorMode : null;

    const modeInfo = pickMode(target, remembered);
    if (!modeInfo)
        return {apply: false, reason: 'no-usable-mode', target, fellBack};

    const colorMode = pickColorMode(target, rememberedColor);

    // Being the only display switched on is not enough: Mutter can put the
    // desktop back on the right screen and still drop the refresh rate or the
    // colour mode on the way, so both have to match too before there is nothing
    // to do. `restore-mode` is that case -- the layout is right, how the
    // display is being driven is not -- and it is deliberately not announced,
    // because to the user nothing moved.
    const enabled = enabledConnectors(state);
    const layoutCorrect = enabled.length === 1 && enabled[0] === target.connector;
    const currentId = target.modes.find(m => m.isCurrent)?.id ?? null;
    if (layoutCorrect && currentId === modeInfo.id && colorMode === target.colorMode)
        return {apply: false, reason: 'already-correct', target, fellBack};

    return {
        apply: true,
        reason: layoutCorrect ? 'restore-mode' : 'enforce',
        target,
        fellBack,
        logicalMonitors: [{
            x: 0,
            y: 0,
            scale: pickScale(state, target, modeInfo),
            transform: 0,
            primary: true,
            monitors: [{
                connector: target.connector,
                modeId: modeInfo.id,
                properties: monitorProperties(modeInfo, colorMode),
            }],
        }],
    };
}

/* Read the mode back out of a layout somebody else applied, so a deliberate
 * change in Settings (or in Display Configuration Switcher) is adopted instead
 * of fought. */
export function inferMode(state, prefs = {}) {
    const {work, tv} = classify(state, prefs);
    const enabled = enabledConnectors(state);
    if (enabled.length !== 1)
        return Mode.CUSTOM;
    if (tv && enabled[0] === tv.connector)
        return Mode.TV;
    if (work && enabled[0] === work.connector)
        return Mode.DESKTOP;
    return Mode.CUSTOM;
}
