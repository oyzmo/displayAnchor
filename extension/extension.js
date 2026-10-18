/* Display Anchor -- keep the desktop on the display you chose.
 * Copyright (C) 2026 oyzmo <http://oyzmo.no>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 */

/* Display Anchor -- stop GNOME moving the desktop to the TV when the TV powers on.
 *
 * The mechanism this fixes:
 *   Mutter stores a display configuration per *set of connected monitors*.
 *   Powering the TV on makes the HDMI connector appear, which is a different
 *   set, so Mutter loads a different stored config -- the one that was last
 *   applied while the TV was on, i.e. the gaming layout. Hence the jump.
 *
 * So on every hotplug we re-assert the mode the user actually chose. That is
 * done with method=1 (temporary), which applies silently; method=2 (persistent)
 * additionally rewrites the stored config and cures the jump at its root, but
 * GNOME then asks "Keep these display settings?" every time, so it lives behind
 * the `persist-changes` setting. A deliberate switch to the TV is never
 * persisted -- storing "TV on, monitor off" is what makes the next power-on
 * jump.
 *
 * A layout change that arrives *without* the connected set changing is a
 * deliberate one (Settings, or another extension), so it is adopted, not
 * fought. The one exception, behind `tv-only-by-toggle`, is a layout that puts
 * only the TV on: that is put back unless it came through our own toggle.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {
    Mode, parseState, planFor, inferMode, classify, connectedKey, enabledConnectors,
} from './lib/plan.js';
import {audioPlan, outputId, effectiveAudioMode, isTvOutput} from './lib/audio.js';
import {buildApplyArgs} from './lib/variant.js';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const IFACE = 'org.gnome.Mutter.DisplayConfig';

const STATE_TYPE = new GLib.VariantType(
    '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');

/* Verified on GNOME 50 with test/probe-confirm.js: a PERSISTENT apply raises
 * "Keep these display settings?" and reverts after ~20s if nobody confirms; a
 * TEMPORARY apply takes effect silently and stays. Persisting is what rewrites
 * Mutter's stored config and cures the jump at its root, so it is worth having
 * -- but not on every single change. */
const METHOD_TEMPORARY = 1;
const METHOD_PERSISTENT = 2;

const SETTLE_MS = 350;        // coalesce the burst of signals one hotplug makes
const SELF_APPLY_MS = 2500;   // window in which a *layout* change is ours
                              // (never a hotplug -- see _evaluate)
const RUNAWAY_COUNT = 6;      // applies within...
const RUNAWAY_MS = 20000;     // ...this window means something is fighting us

/* Moves the default sound output to follow the display mode.
 *
 * Two things make this more than one call. The HDMI audio sink does not exist
 * at the instant the display hotplug fires -- it appears a moment later -- and
 * the desktop may grab it on its own once it does. So the choice is re-asserted
 * every second for a short window rather than set once.
 */
class AudioSwitcher {
    constructor(ext) {
        this._ext = ext;
        this._control = null;
        this._timerId = 0;
        this._request = null;
        this._deadline = 0;
        this._quiet = false;
        this._captureDesk = false;
        this._deviceIds = new Set();
        this._ids = [];
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._control) {
            for (const id of this._ids)
                this._control.disconnect(id);
            this._ids = [];
            try {
                this._control.close();
            } catch (e) {
                // Closing a mixer that never connected is not worth reporting.
            }
            this._control = null;
        }
        this._deviceIds.clear();
        this._request = null;
    }

    _ensureControl() {
        if (this._control)
            return this._control;
        try {
            this._control = new Gvc.MixerControl({name: 'Display Anchor'});
            // GNOME's own output list is built the same way: there is no getter
            // for every UI device, only these signals, so track them from the
            // moment the control opens.
            this._deviceIds = new Set();
            this._ids = [
                this._control.connect('output-added', (_c, id) => {
                    this._deviceIds.add(id);
                    this._attempt();
                }),
                this._control.connect('output-removed', (_c, id) => this._deviceIds.delete(id)),
            ];
            this._control.open();
        } catch (e) {
            this._ext._log(`audio: cannot open the mixer (${e.message})`);
            this._control = null;
        }
        return this._control;
    }

    get _ready() {
        return this._control?.get_state() === Gvc.MixerControlState.READY;
    }

    _sinkNameOf(device) {
        const stream = this._control.lookup_stream_id(device.get_stream_id());
        return stream ? stream.get_name() : null;
    }

    /* The same things GNOME's Sound Output menu lists: one entry per port. */
    outputs() {
        if (!this._ready)
            return [];
        const out = [];
        for (const id of this._deviceIds) {
            const device = this._control.lookup_output_id(id);
            if (!device)
                continue;
            const sink = this._sinkNameOf(device);
            if (!sink)
                continue;
            const origin = device.get_origin();
            out.push({
                id: outputId(sink, device.get_port()),
                label: origin ? `${device.get_description()} \u2013 ${origin}` : device.get_description(),
                available: true,
                device,
            });
        }
        return out;
    }

    currentOutputId() {
        if (!this._ready)
            return null;
        const stream = this._control.get_default_sink();
        if (!stream)
            return null;
        const device = this._control.lookup_device_from_stream(stream);
        return outputId(stream.get_name(), device ? device.get_port() : null);
    }

    syncFor(mode, prefs, settleSeconds) {
        if (!this._ensureControl())
            return;
        // Only a request that *enters* TV mode may record the desk output (see
        // _attempt). A repeat TV request, or an output-added re-assert, finds
        // whatever PipeWire fell back to while HDMI was away -- which is how a
        // network speaker in another room was once remembered as the desk.
        if (mode !== Mode.TV)
            this._captureDesk = false;
        else if (this._request?.mode !== Mode.TV)
            this._captureDesk = true;
        this._request = {mode, prefs};
        this._quiet = false;
        this._deadline = GLib.get_monotonic_time() / 1000 + Math.max(1, settleSeconds) * 1000;
        this._attempt();
        this._startTimer();
    }

    _attempt() {
        if (!this._ready || !this._request)
            return;

        const {mode, prefs} = this._request;
        const outputs = this.outputs();
        const currentId = this.currentOutputId();
        const plan = audioPlan(outputs, mode, currentId, prefs);

        if (!plan.switch) {
            if (plan.reason === 'no-matching-output' && !this._quiet) {
                this._quiet = true;
                this._ext._log(`audio: no output matches mode=${mode}, leaving it alone`);
            }
            return;
        }

        // On the way to the TV, note what the desk was using. Coming back, the
        // "what are you listening on" hint is the TV itself and therefore
        // useless, so this is the only record of the user's actual choice.
        // Once per switch: the first move to the TV is the only one that
        // starts from the desk.
        if (isTvOutput(plan.target) && this._captureDesk) {
            this._captureDesk = false;
            const current = outputs.find(o => o.id === currentId);
            if (current && !isTvOutput(current))
                this._ext._rememberWorkOutput(current.id);
        }

        this._control.change_output(plan.target.device);
        // Re-arm the "nothing matches" line. In TV mode that message is now the
        // normal sound of the HDMI device being away for a moment, so silencing
        // it for the whole settle window would hide a device that keeps coming
        // and going -- which is exactly what a journal is read to find out.
        this._quiet = false;
        this._ext._log(`audio: output -> ${plan.target.label}`,
            plan.fellBack ? '[fallback, the configured output is gone]' : '');
    }

    /* Runs to the deadline even after a success: the desktop can still move the
     * output to the freshly-appeared HDMI sink a second later. */
    _startTimer() {
        if (this._timerId)
            return;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!this._request || GLib.get_monotonic_time() / 1000 > this._deadline) {
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._attempt();
            return GLib.SOURCE_CONTINUE;
        });
    }
}

const DisplayAnchorToggle = GObject.registerClass(
class DisplayAnchorToggle extends QuickSettings.QuickToggle {
    _init(ext) {
        super._init({
            title: 'TV Mode',
            iconName: 'video-display-symbolic',
            toggleMode: true,
        });
        this._ext = ext;
        this.connect('clicked', () => this._ext.toggleMode());
    }

    sync(mode, targetName) {
        this.checked = mode === Mode.TV;
        if ('subtitle' in this)
            this.subtitle = targetName ?? null;
    }
});

const DisplayAnchorIndicator = GObject.registerClass(
class DisplayAnchorIndicator extends QuickSettings.SystemIndicator {
    _init(ext) {
        super._init();
        this.toggle = new DisplayAnchorToggle(ext);
        this.quickSettingsItems.push(this.toggle);
    }
});

export default class DisplayAnchorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();

        this._lastKey = null;
        this._selfApplyUntil = 0;
        this._applyStamps = [];
        this._settleId = 0;
        this._graceId = 0;
        this._paused = false;
        this._busy = false;
        this._reenforcePending = false;
        this._evaluatePending = false;
        this._lastState = null;
        this._debug = this._settings.get_boolean('debug');
        this._audio = null;
        this._tvDisplayPresent = null;   // null until the first state read

        this._signalId = this._bus.signal_subscribe(
            BUS_NAME, IFACE, 'MonitorsChanged', OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE, () => this._scheduleEvaluate());

        this._indicator = new DisplayAnchorIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'debug') {
                this._debug = this._settings.get_boolean('debug');
                this._log('debug logging on');
            } else if (key === 'mode') {
                this._syncToggle();
                this._syncAudio();
            } else if (key === 'switch-audio' || key === 'work-audio-sink' || key === 'tv-audio-sink') {
                this._syncAudio();
            } else if (key === 'work-connector' || key === 'tv-connector' || key === 'enforce') {
                // Nothing was plugged in, so without this flag _evaluate would
                // read the unchanged monitor set as a deliberate relayout and
                // adopt whatever is on screen -- turning enforcement back on
                // would then keep the desktop on the TV instead of moving it.
                this._reenforcePending = true;
                this._scheduleEvaluate();
            }
        });

        this._keysBound = false;
        this._sessionModeId = Main.sessionMode.connect('updated', () => this._syncSessionMode());
        this._syncSessionMode();

        this._log(`enabled, mode=${this.mode}`);
        this._checkAllowed();

        // Read the world once, and correct it if the session already came up on
        // the wrong screen (logging in with the TV on does exactly that).
        this._evaluate({startup: true});
    }

    /* console.log rather than console.debug: G_MESSAGES_DEBUG suppresses debug
     * level by default, and this has to be readable with a plain journalctl. */
    _log(...parts) {
        if (this._debug)
            console.log(`[display-anchor] ${parts.filter(Boolean).join(' ')}`);
    }

    /* Why this extension runs in the unlock-dialog session mode:
     *
     * A monitor that goes to sleep behind the lock screen often drops off the
     * bus, and wakes up again later. Both are hotplugs, and on each one Mutter
     * loads whatever layout it has stored for the new set of monitors -- which
     * is exactly the jump this extension exists to stop. Disabled while locked,
     * nothing corrects it, so the unlock dialog appears on the TV and only
     * moves back once the password has been typed on the wrong screen.
     *
     * While locked, the keybinding is removed and the Quick Settings toggle is
     * hidden (see _syncSessionMode), so nothing can be switched without
     * unlocking. Only hotplug enforcement keeps running. */
    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }
        Main.wm.removeKeybinding('toggle-tv-mode');
        this._keysBound = false;

        if (this._signalId) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
        // Removed literally rather than through _clearTimer(), so that both the
        // reviewer and the static analyser can see every main loop source this
        // extension creates being removed here.
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }
        if (this._graceId) {
            GLib.Source.remove(this._graceId);
            this._graceId = 0;
        }

        this._audio?.destroy();
        this._audio = null;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(i => i.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
        this._bus = null;
    }

    /* On the lock screen only enforcement runs: no shortcut, no toggle. */
    _syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        if (locked && this._keysBound) {
            Main.wm.removeKeybinding('toggle-tv-mode');
            this._keysBound = false;
        } else if (!locked && !this._keysBound) {
            Main.wm.addKeybinding(
                'toggle-tv-mode', this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this.toggleMode());
            this._keysBound = true;
        }
        if (this._indicator)
            this._indicator.toggle.visible = !locked;
        this._log(`session mode ${Main.sessionMode.currentMode}${locked ? ', enforcement only' : ''}`);
    }

    /* ---------------------------------------------------------------- prefs */

    get _prefs() {
        // -1 is the schema's "nothing remembered"; plan.js only knows null.
        const colorMode = this._settings.get_int('last-work-color-mode');
        return {
            workConnector: this._settings.get_string('work-connector'),
            tvConnector: this._settings.get_string('tv-connector'),
            lastWorkMode: this._settings.get_string('last-work-mode'),
            lastWorkColorMode: colorMode >= 0 ? colorMode : null,
        };
    }

    get mode() {
        return this._settings.get_string('mode');
    }

    set mode(value) {
        if (this._settings.get_string('mode') !== value)
            this._settings.set_string('mode', value);
    }

    /* --------------------------------------------------------------- timers */

    _clearTimer(field) {
        if (this[field]) {
            GLib.Source.remove(this[field]);
            this[field] = 0;
        }
    }

    _scheduleEvaluate() {
        this._clearTimer('_settleId');
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._evaluate({});
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ------------------------------------------------------------- D-Bus IO */

    _checkAllowed() {
        this._bus.call(BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [IFACE, 'ApplyMonitorsConfigAllowed']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, res) => {
                try {
                    const [value] = bus.call_finish(res).deepUnpack();
                    if (!value.unpack())
                        console.warn('[display-anchor] Mutter refuses display configuration from this session; enforcement will not work.');
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[display-anchor] could not read ApplyMonitorsConfigAllowed: ${e.message}`);
                }
            });
    }

    _getCurrentState(callback) {
        this._bus.call(BUS_NAME, OBJECT_PATH, IFACE, 'GetCurrentState', null,
            STATE_TYPE, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, res) => {
                try {
                    callback(parseState(bus.call_finish(res).recursiveUnpack()));
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[display-anchor] GetCurrentState failed: ${e.message}`);
                }
            });
    }

    /* `deliberate` marks an apply the user asked for (the toggle), which must
     * not count towards the runaway guard: that guard is for something *else*
     * fighting us, and a user switching back and forth is not that. */
    _applyPlan(state, plan, {persist = false, retried = false, deliberate = false} = {}) {
        const method = persist ? METHOD_PERSISTENT : METHOD_TEMPORARY;
        const args = buildApplyArgs(state.serial, method, plan.logicalMonitors);

        this._busy = true;
        this._selfApplyUntil = GLib.get_monotonic_time() / 1000 + SELF_APPLY_MS;

        this._bus.call(BUS_NAME, OBJECT_PATH, IFACE, 'ApplyMonitorsConfig', args,
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, res) => {
                this._busy = false;
                try {
                    bus.call_finish(res);
                    this._log(`  -> applied ${persist ? 'persistently, GNOME will ask you to keep it' : 'silently'}`,
                        `(serial ${state.serial})`);
                    if (!deliberate)
                        this._noteApply();
                    this._announce(plan);
                    // Re-read once so _lastKey reflects reality even if a
                    // display appeared or vanished while the call was in
                    // flight. Lands inside the self-apply window, so a
                    // same-set read only refreshes state; a hotplug is acted on.
                    // This also covers any evaluation _busy turned away.
                    this._evaluatePending = false;
                    this._scheduleEvaluate();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // The layout moved under us between read and write; one
                    // fresh read is worth a retry, a loop of them is not.
                    if (!retried) {
                        this._log(`  -> apply rejected (${e.message}), retrying with a fresh read`);
                        this._getCurrentState(fresh => {
                            const again = planFor(fresh, {mode: this.mode, ...this._prefs});
                            if (again.apply)
                                this._applyPlan(fresh, again, {persist, retried: true, deliberate});
                            else
                                this._flushPendingEvaluate();
                        });
                        return;
                    }
                    console.warn(`[display-anchor] ApplyMonitorsConfig failed: ${e.message}`);
                    this._flushPendingEvaluate();
                }
            });
    }

    /* Run an evaluation that _busy turned away while an apply was in flight.
     * Only after a failure: a successful apply re-reads anyway. This cannot loop
     * against a Mutter that rejects every apply, because a rejected apply emits
     * no MonitorsChanged -- the flag is only set again by a real change. */
    _flushPendingEvaluate() {
        if (!this._evaluatePending)
            return;
        this._evaluatePending = false;
        this._log('  -> re-running an evaluation skipped during the failed apply');
        this._scheduleEvaluate();
    }

    /* ------------------------------------------------------------ the logic */

    _evaluate({startup = false} = {}) {
        if (!this._settings)
            return;
        if (this._busy) {
            // Remembered rather than dropped: if the apply in flight fails, the
            // change that triggered this would otherwise never be looked at.
            this._evaluatePending = true;
            return;
        }

        this._getCurrentState(state => {
            const key = connectedKey(state);
            const hotplug = this._lastKey !== null && key !== this._lastKey;
            const first = this._lastKey === null;
            this._lastKey = key;
            // A setting that changes what to enforce goes past the self-apply
            // and adopt branches exactly as a hotplug does, so it enforces
            // instead of adopting. It is not a hotplug, though, so it does not
            // re-assert the sound.
            const reenforce = this._reenforcePending;
            this._reenforcePending = false;
            const enforceNow = hotplug || reenforce;

            if (this._debug) {
                const {work, tv} = classify(state, this._prefs);
                this._log(`state: connected=[${state.monitors.map(m => m.connector).join(' ')}]`,
                    `enabled=[${enabledConnectors(state).join(' ')}]`,
                    `work=${work?.connector ?? '-'} tv=${tv?.connector ?? '-'}`,
                    `mode=${this.mode}`,
                    first ? 'first-read' : (hotplug ? 'HOTPLUG' : 'same-monitors'),
                    reenforce ? 'SETTINGS' : '');
            }

            const now = GLib.get_monotonic_time() / 1000;
            // Only a *layout* change can be ours. ApplyMonitorsConfig enables
            // and disables monitors; it never connects or disconnects one, so a
            // changed connectedKey() is always the world's doing. Swallowing a
            // hotplug here skipped enforcement *and* _trackTvPresence, which is
            // how a TV switched on within SELF_APPLY_MS of one of our own
            // applies kept the desktop and left _tvDisplayPresent stale.
            if (!enforceNow && now < this._selfApplyUntil) {
                this._log('  -> ignoring, this was our own change');
                this._rememberWorkDisplay(state);
                this._syncToggle(state);
                return;
            }

            // Same monitors, different layout: somebody meant that -- unless it
            // is a switch to the TV that did not come through us, which leaves
            // a black screen whenever the TV is off (and an HDMI TV in standby
            // still counts as connected). That is put back instead of adopted.
            const adopted = !enforceNow && !first ? inferMode(state, this._prefs) : null;
            if (adopted === Mode.TV && this.mode !== Mode.TV &&
                this._settings.get_boolean('tv-only-by-toggle') &&
                this._settings.get_boolean('enforce') && !this._paused) {
                this._log('  -> TV-only layout that was not switched to with the toggle, putting the desktop back');
                this.mode = Mode.DESKTOP;
            } else if (adopted) {
                this._rememberWorkDisplay(state);
                this._log(`  -> adopting layout somebody else chose, mode=${adopted}`);
                this.mode = adopted;
                this._paused = false;
                this._clearTimer('_graceId');
                this._syncToggle(state);
                return;
            }

            this._trackTvPresence(state);

            // The HDMI audio sink appears with the connector, and the desktop
            // may jump to it, so a hotplug needs the audio re-asserted even
            // when the display mode itself has not changed.
            if (hotplug)
                this._syncAudio();

            if (first && !startup) {
                this._log('  -> first read, nothing to enforce yet');
                this._syncToggle(state);
                return;
            }
            // The memories go stale whenever we are not running: a refresh
            // rate or HDR change made in Settings while the extension was off
            // or before login was never seen, and restoring the old value over
            // it is fighting the user. A work-only layout at startup is what
            // Mutter loaded from the stored config, so take it as chosen.
            // A layout on the wrong screen is not recorded and still enforced.
            if (first && startup) {
                this._log('  -> startup, taking the work display as it is running');
                this._rememberWorkDisplay(state);
            }
            if (first && startup && !this._settings.get_boolean('enforce-on-startup')) {
                this.mode = inferMode(state, this._prefs);
                this._log(`  -> startup enforcement off, adopted mode=${this.mode}`);
                this._syncToggle(state);
                return;
            }

            if (!this._settings.get_boolean('enforce') || this._paused) {
                this._log(`  -> not enforcing (${this._paused ? 'paused' : 'switched off'})`);
                this._syncToggle(state);
                return;
            }

            const plan = planFor(state, {mode: this.mode, ...this._prefs});
            if (plan.apply) {
                const m = plan.logicalMonitors[0].monitors[0];
                const props = Object.entries(m.properties ?? {})
                    .map(([k, v]) => `${k}=${v}`).join(' ');
                this._log(`  -> plan (${plan.reason}): enable ${m.connector} mode=${m.modeId}`,
                    `scale=${plan.logicalMonitors[0].scale}`,
                    props ? `[${props}]` : '[no mode properties carried over]',
                    plan.fellBack ? '[fallback]' : '');
            } else {
                this._log(`  -> no change needed (${plan.reason})`);
            }
            this._syncToggle(state);
            if (plan.apply)
                this._applyPlan(state, plan, {persist: this._settings.get_boolean('persist-changes')});
        });
    }

    /* When the TV goes away, drop back to desktop mode so that switching it on
     * again is inert. Debounced: an AVR input change or an HDR mode switch
     * drops HDMI for a few seconds mid-game, and that must not end TV mode. */
    _trackTvPresence(state) {
        const {tv} = classify(state, this._prefs);
        this._tvDisplayPresent = !!tv;
        if (tv) {
            if (this._graceId)
                this._log('  -> TV is back, cancelling the revert timer');
            this._clearTimer('_graceId');
            return;
        }
        if (this.mode !== Mode.TV || !this._settings.get_boolean('revert-on-tv-gone'))
            return;
        if (this._graceId)
            return;

        const grace = this._settings.get_int('tv-grace-seconds');
        this._log(`  -> TV gone while in TV mode, reverting to desktop in ${grace}s`);
        this._graceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, grace, () => {
            this._graceId = 0;
            if (this._settings) {
                this._log('grace expired, back to desktop mode');
                this.mode = Mode.DESKTOP;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Lazy: a user who leaves audio switching off never opens a mixer
     * connection at all. */
    _syncAudio() {
        if (!this._settings)
            return;
        if (!this._settings.get_boolean('switch-audio')) {
            // Tear the switcher down, not just skip it: its output-added
            // handler keeps re-asserting the last request, so leaving it alive
            // would keep moving the sound after the user switched this off.
            this._audio?.destroy();
            this._audio = null;
            return;
        }
        this._audio ??= new AudioSwitcher(this);

        // An HDMI audio port can look available while the TV is off, so trust
        // the display state rather than the port's own claim.
        const mode = effectiveAudioMode(this.mode, this._tvDisplayPresent);
        if (mode !== this.mode)
            this._log('audio: TV display is not connected, keeping the sound off it');

        this._audio.syncFor(mode, {
            workSink: this._settings.get_string('work-audio-sink'),
            tvSink: this._settings.get_string('tv-audio-sink'),
            rememberedWorkSink: this._settings.get_string('last-work-output'),
        }, this._settings.get_int('audio-settle-seconds'));
    }

    /* Written by the switcher, not by the user -- see the schema. */
    _rememberWorkOutput(id) {
        if (!this._settings || this._settings.get_string('last-work-output') === id)
            return;
        this._settings.set_string('last-work-output', id);
        this._log(`audio: remembering ${id} as the desk output`);
    }

    /* The display counterpart, and the timing is the whole trick: this may only
     * read a layout that somebody *chose* -- the user in Settings, or us right
     * after an apply. A hotplug must never write it, because the layout Mutter
     * loads on a hotplug is exactly the one that drops the refresh rate and the
     * colour mode, and recording it would overwrite the good values with the
     * bad ones moments before they are needed to undo it.
     *
     * Two memories, written independently: the mode can be right while the
     * colour mode is wrong and the other way round. */
    _rememberWorkDisplay(state) {
        if (!this._settings)
            return;
        const {work} = classify(state, this._prefs);
        if (!work)
            return;
        // Only a plain "work display on its own" layout says anything about
        // what the work display is meant to run.
        const enabled = enabledConnectors(state);
        if (enabled.length !== 1 || enabled[0] !== work.connector)
            return;

        const id = work.modes.find(m => m.isCurrent)?.id;
        if (id && this._settings.get_string('last-work-mode') !== id) {
            this._settings.set_string('last-work-mode', id);
            this._log(`remembering ${id} as the work display's mode`);
        }

        const colorMode = work.colorMode;
        if (typeof colorMode === 'number' &&
            this._settings.get_int('last-work-color-mode') !== colorMode) {
            this._settings.set_int('last-work-color-mode', colorMode);
            this._log(`remembering colour mode ${colorMode} as the work display's`);
        }
    }

    _noteApply() {
        const now = GLib.get_monotonic_time() / 1000;
        this._applyStamps = this._applyStamps.filter(t => now - t < RUNAWAY_MS);
        this._applyStamps.push(now);
        if (this._applyStamps.length >= RUNAWAY_COUNT) {
            this._paused = true;
            this._applyStamps = [];
            this._log(`${RUNAWAY_COUNT} applies within ${RUNAWAY_MS}ms, pausing enforcement`);
            // Same reasoning as _announce: nothing to act on behind the lock
            // screen. Still paused; "change the layout yourself" resumes it.
            if (!Main.sessionMode.isLocked)
                Main.notify('Display Anchor',
                    'Something else keeps changing the display layout, so enforcement is paused. Change the layout yourself to resume.');
        }
    }

    _announce(plan) {
        if (!this._settings?.get_boolean('notify'))
            return;
        // Behind the lock screen the result is visible on its own, and a
        // banner per wake would only pile up in the lock screen's list.
        if (Main.sessionMode.isLocked)
            return;
        // Nothing moved on screen -- only the refresh rate was put back.
        if (plan.reason === 'restore-mode')
            return;
        const name = plan.target.displayName || plan.target.connector;
        Main.notify('Display Anchor', plan.fellBack
            ? `${name} is the only display connected.`
            : `Display kept on ${name}.`);
    }

    _syncToggle(state = null) {
        if (!this._indicator)
            return;
        // A mode change arrives without a fresh state (the grace timer, a
        // dconf write); naming the target from the last one read beats
        // blanking the subtitle until the next display event.
        if (state)
            this._lastState = state;
        else
            state = this._lastState;
        let name = null;
        if (state) {
            const {work, tv} = classify(state, this._prefs);
            const target = this.mode === Mode.TV ? tv : work;
            name = target ? (target.displayName || target.connector) : null;
        }
        this._indicator.toggle.sync(this.mode, name);
    }

    /* --------------------------------------------------------------- action */

    toggleMode() {
        const next = this.mode === Mode.TV ? Mode.DESKTOP : Mode.TV;
        this._log(`user switched ${this.mode} -> ${next}`);
        this.mode = next;
        this._paused = false;
        this._clearTimer('_graceId');

        this._getCurrentState(state => {
            this._lastKey = connectedKey(state);
            // Reads the layout being left behind, so switching to the TV is
            // what captures the desk display's mode.
            this._rememberWorkDisplay(state);
            const plan = planFor(state, {mode: next, ...this._prefs});
            this._syncToggle(state);
            // Never persist a deliberate switch: writing "TV on, monitor off"
            // to the stored config is precisely what makes the next TV power-on
            // jump again.
            if (plan.apply)
                this._applyPlan(state, plan, {persist: false, deliberate: true});
            else if (plan.reason === 'already-correct')
                this._syncToggle(state);
        });
    }
}
