#!/usr/bin/gjs -m
/* Read-only: shows exactly what the Sound choosers in preferences will list,
 * and what automatic detection would pick right now. Changes nothing.
 *
 * Run it with the TV off and again with it on -- the TV's HDMI output should
 * appear in both, marked "(not connected)" while the TV is off.
 */

import GLib from 'gi://GLib';

import {parsePactlSinks, classifyOutputs, outputForMode, isTvOutput}
    from '../extension/lib/audio.js';

let sinks;
try {
    const [, stdout, , status] = GLib.spawn_command_line_sync('pactl -f json list sinks');
    if (status !== 0)
        throw new Error(`pactl exited ${status}`);
    sinks = JSON.parse(new TextDecoder().decode(stdout));
} catch (e) {
    print(`could not list audio outputs: ${e.message}`);
    imports.system.exit(1);
}

const outputs = parsePactlSinks(sinks);

print(`${outputs.length} output(s) -- this is the chooser list:\n`);
for (const o of outputs) {
    print(`  ${o.label}`);
    print(`      id: ${o.id}${isTvOutput(o) ? '   [looks like a TV output]' : ''}`);
}

/* What the default sink is, so the "work = whatever you are listening on"
 * heuristic can be shown honestly rather than guessed at. */
let currentId = null;
try {
    const [, stdout] = GLib.spawn_command_line_sync('pactl get-default-sink');
    const name = new TextDecoder().decode(stdout).trim();
    const match = outputs.find(o => o.id === name || o.id.startsWith(`${name}|`));
    currentId = match ? match.id : name;
} catch (e) {
    // Not fatal; classification simply loses its hint.
}

print('');
print(`current default: ${currentId ?? '(unknown)'}`);

const {work, tv} = classifyOutputs(outputs, {currentId});
print('');
print(`automatic work output: ${work ? work.label : '(none found)'}`);
print(`automatic TV output:   ${tv ? tv.label : '(none found)'}`);

print('');
for (const mode of ['desktop', 'tv']) {
    const resolved = outputForMode(outputs, mode, {currentId});
    if (!resolved) {
        print(`mode=${mode}: nothing suitable, audio would be left alone`);
        continue;
    }
    const same = resolved.output.id === currentId;
    print(`mode=${mode}: ${same ? 'stay on' : 'move to'} ${resolved.output.label}` +
          `${resolved.fellBack ? '  [fallback]' : ''}`);
}
