/* Display Anchor -- keep the desktop on the display you chose.
 * Copyright (C) 2026 oyzmo <http://oyzmo.no>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 */

/* ---------------------------------------------------------------------------
 * Note for extensions.gnome.org reviewers
 *
 * This file spawns exactly one external command -- `pactl -f json list sinks`,
 * in readOutputs() below. It is a fixed string with no user input, run only
 * while the preferences window builds its two audio-output dropdowns, and its
 * output is parsed by a pure function (lib/audio.js). If pactl is missing the
 * list is simply empty and the rest of the window still works.
 *
 * It is not done with Gvc, which is what the shell process uses for the same
 * job, because Gvc's typelib lives in gnome-shell's private directory: that
 * path is on the GI search path inside gnome-shell, but not in the separate
 * preferences process, so `import Gvc from 'gi://Gvc'` fails here.
 *
 * extension.js spawns nothing at all, and neither process reads or writes any
 * file outside GSettings.
 *
 * Extension page: https://oyzmo.no/apps/
 * Sources:        https://oyzmo.no/apps/files/sources/displayanchorsource.zip
 * -------------------------------------------------------------------------*/

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseState} from './lib/plan.js';
import {parsePactlSinks} from './lib/audio.js';

const STATE_TYPE = new GLib.VariantType(
    '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');

/* Prefs runs in its own process, so a synchronous call to Mutter is safe here
 * (inside gnome-shell it would deadlock -- see extension.js). */
function readMonitors() {
    try {
        const reply = Gio.DBus.session.call_sync(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'GetCurrentState', null, STATE_TYPE,
            Gio.DBusCallFlags.NONE, -1, null);
        return parseState(reply.recursiveUnpack()).monitors;
    } catch (e) {
        console.warn(`[display-anchor] could not list monitors: ${e.message}`);
        return [];
    }
}

/* Outputs via pactl rather than Gvc -- see the reviewer note at the top of the
 * file for why Gvc is not available in this process.
 *
 * Enumerates *ports*, not sinks, to match what GNOME's own Sound Output menu
 * shows -- so a DAC's analog and S/PDIF outputs are separable, and the TV's
 * HDMI output can be picked while the TV is switched off. */
function readOutputs() {
    try {
        const [, stdout, , status] = GLib.spawn_command_line_sync('pactl -f json list sinks');
        if (status !== 0)
            return [];
        return parsePactlSinks(JSON.parse(new TextDecoder().decode(stdout)));
    } catch (e) {
        console.warn(`[display-anchor] could not list audio outputs: ${e.message}`);
        return [];
    }
}

/* A row that captures a real key combination, rather than making the user type
 * an accelerator string by hand. */
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, params = {}) {
        super._init({activatable: true, ...params});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Clear shortcut',
            css_classes: ['flat'],
        });
        clear.connect('clicked', () => this._store(''));
        this.add_suffix(clear);

        this._changedId = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('activated', () => this._capture());
        this.connect('destroy', () => settings.disconnect(this._changedId));
        this._sync();
    }

    _sync() {
        const [accel] = this._settings.get_strv(this._key);
        this._label.accelerator = accel ?? '';
    }

    _store(accel) {
        this._settings.set_strv(this._key, accel ? [accel] : []);
    }

    _capture() {
        const root = this.get_root();
        const dialog = new Adw.Window({
            modal: true,
            transient_for: root,
            default_width: 360,
            default_height: 160,
            resizable: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            spacing: 8,
            margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24,
        });
        box.append(new Gtk.Label({
            label: '<b>Press the shortcut</b>',
            use_markup: true,
        }));
        box.append(new Gtk.Label({
            label: 'Escape cancels, Backspace clears.',
            css_classes: ['dim-label'],
        }));
        dialog.set_content(box);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;

            if (keyval === Gdk.KEY_Escape && !mask) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && !mask) {
                this._store('');
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // A global shortcut with no modifier would swallow a plain letter
            // system-wide, so refuse to record one.
            if (!mask || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            if (accel) {
                this._store(accel);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }
});

/* Chooser backed by a string setting: "Automatic" plus whatever is present,
 * keeping a configured-but-currently-absent value visible so it is not silently
 * dropped when the TV happens to be off. */
const ChoiceRow = GObject.registerClass(
class ChoiceRow extends Adw.ComboRow {
    _init(settings, key, items, params = {}) {
        const stored = settings.get_string(key);
        const values = [''];
        const labels = ['Automatic'];

        for (const item of items) {
            values.push(item.value);
            labels.push(item.label);
        }
        if (stored && !values.includes(stored)) {
            values.push(stored);
            labels.push(`${stored} (not present)`);
        }

        super._init({model: Gtk.StringList.new(labels), ...params});
        this._values = values;
        this.selected = Math.max(0, values.indexOf(stored));
        this.connect('notify::selected', () => {
            settings.set_string(key, this._values[this.selected] ?? '');
        });
    }
});

export default class DisplayAnchorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const monitors = readMonitors();

        const page = new Adw.PreferencesPage({
            title: 'Display Anchor',
            icon_name: 'video-display-symbolic',
        });
        window.add(page);

        const displays = new Adw.PreferencesGroup({
            title: 'Displays',
            description: monitors.length
                ? 'Automatic treats the first HDMI output as the TV and a DisplayPort or built-in panel as the work display.'
                : 'No monitors could be read from Mutter. Automatic detection still applies at runtime.',
        });
        page.add(displays);
        const monitorItems = monitors.map(m => ({
            value: m.connector,
            label: `${m.displayName} (${m.connector})`,
        }));
        displays.add(new ChoiceRow(settings, 'work-connector', monitorItems, {
            title: 'Work display',
            subtitle: 'The one to keep the desktop on',
        }));
        displays.add(new ChoiceRow(settings, 'tv-connector', monitorItems, {
            title: 'TV',
            subtitle: 'The one that must not steal the desktop',
        }));

        const behaviour = new Adw.PreferencesGroup({
            title: 'Behaviour',
            description: 'A layout you change yourself in Settings is adopted, never overridden — '
                + 'except a TV-only one while the setting below is on.',
        });
        page.add(behaviour);

        const enforce = new Adw.SwitchRow({
            title: 'Hold the chosen display',
            subtitle: 'Re-apply your choice whenever a display is connected or powered on',
        });
        behaviour.add(enforce);

        const startup = new Adw.SwitchRow({
            title: 'Also correct at login',
            subtitle: 'Fixes a session that started on the wrong screen',
        });
        behaviour.add(startup);

        const tvByToggle = new Adw.SwitchRow({
            title: 'Only switch to the TV with the toggle',
            subtitle: 'Anything else that turns the monitor off and leaves only the TV on is '
                + 'put back, so a TV in standby cannot black the screen. Also undoes '
                + '"TV only" chosen in Settings.',
        });
        behaviour.add(tvByToggle);

        const revert = new Adw.SwitchRow({
            title: 'Return to the work display when the TV disconnects',
            subtitle: 'So powering the TV on again does nothing until you ask for it',
        });
        behaviour.add(revert);

        const grace = new Adw.SpinRow({
            title: 'Grace period',
            subtitle: 'Seconds the TV may drop out before TV mode ends',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 600, step_increment: 5, page_increment: 30}),
        });
        behaviour.add(grace);

        const persist = new Adw.SwitchRow({
            title: 'Write corrections to the system configuration',
            subtitle: 'Cures the jump at its root, but GNOME asks "Keep these display '
                + 'settings?" each time. Turn on once to heal a bad configuration, then off.',
        });
        behaviour.add(persist);

        const notify = new Adw.SwitchRow({
            title: 'Notify when the layout is corrected',
        });
        behaviour.add(notify);

        const outputs = readOutputs();
        const audio = new Adw.PreferencesGroup({
            title: 'Sound',
            description: outputs.length
                ? 'Automatic sends TV mode to the first HDMI or DisplayPort output, and ' +
                  'work mode to whatever you are listening on at the time. Outputs marked ' +
                  '"not connected" can still be chosen — the TV\'s HDMI output is listed ' +
                  'even while the TV is off.'
                : 'No audio outputs could be listed. Automatic detection still applies at runtime.',
        });
        page.add(audio);

        const switchAudio = new Adw.SwitchRow({
            title: 'Move the sound output too',
            subtitle: 'Follow the display when switching between work and TV',
        });
        audio.add(switchAudio);

        const outputItems = outputs.map(o => ({value: o.id, label: o.label}));
        const workSink = new ChoiceRow(settings, 'work-audio-sink', outputItems, {
            title: 'Work display sound',
        });
        audio.add(workSink);
        const tvSink = new ChoiceRow(settings, 'tv-audio-sink', outputItems, {
            title: 'TV sound',
        });
        audio.add(tvSink);

        const settle = new Adw.SpinRow({
            title: 'Keep asserting for',
            subtitle: 'Seconds, because HDMI audio appears after the display does',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        audio.add(settle);

        const shortcuts = new Adw.PreferencesGroup({title: 'Shortcut'});
        page.add(shortcuts);
        shortcuts.add(new ShortcutRow(settings, 'toggle-tv-mode', {
            title: 'Switch between work display and TV',
        }));

        const diagnostics = new Adw.PreferencesGroup({
            title: 'Diagnostics',
            description: 'journalctl --user -f SYSLOG_IDENTIFIER=gnome-shell | grep display-anchor',
        });
        page.add(diagnostics);

        const debug = new Adw.SwitchRow({
            title: 'Log every decision',
            subtitle: 'Each hotplug, adopted layout and applied plan, tagged [display-anchor]',
        });
        diagnostics.add(debug);

        const about = new Adw.PreferencesGroup({title: 'About'});
        page.add(about);
        about.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? String(this.metadata.version),
        }));

        settings.bind('enforce', enforce, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('enforce-on-startup', startup, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('revert-on-tv-gone', revert, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('notify', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('persist-changes', persist, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('tv-grace-seconds', grace, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('debug', debug, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('switch-audio', switchAudio, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('audio-settle-seconds', settle, 'value', Gio.SettingsBindFlags.DEFAULT);

        for (const row of [workSink, tvSink, settle])
            settings.bind('switch-audio', row, 'sensitive', Gio.SettingsBindFlags.GET);

        settings.bind('tv-only-by-toggle', tvByToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('enforce', startup, 'sensitive', Gio.SettingsBindFlags.GET);
        settings.bind('enforce', tvByToggle, 'sensitive', Gio.SettingsBindFlags.GET);
        settings.bind('enforce', persist, 'sensitive', Gio.SettingsBindFlags.GET);
        settings.bind('revert-on-tv-gone', grace, 'sensitive', Gio.SettingsBindFlags.GET);
    }
}
