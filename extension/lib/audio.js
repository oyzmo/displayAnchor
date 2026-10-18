/* Display Anchor -- keep the desktop on the display you chose.
 * Copyright (C) 2026 oyzmo <http://oyzmo.no>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 */

/* Pure audio-output selection.
 *
 * Like plan.js, free of any gi:// import so it can be unit tested outside GNOME
 * Shell. It works on "outputs" -- the same things GNOME's own Sound Output menu
 * lists, which are ports rather than sinks:
 *
 *   {id, sink, port, label, available}
 *
 * That distinction matters twice. One sink can carry several outputs (a DAC's
 * analog and S/PDIF ports are one sink), so a sink name alone cannot name what
 * the user picked. And a port exists even while nothing is plugged into it,
 * which is why the TV's HDMI output can be chosen while the TV is switched off.
 *
 * extension.js builds these from Gvc.MixerUIDevice; prefs.js builds the same
 * shape from `pactl -f json list sinks`.
 */

export const SEPARATOR = '|';

/* Turn `pactl -f json list sinks` into outputs, one per port -- the same things
 * GNOME's Sound Output menu lists. Pure, so prefs.js only has to do the spawn,
 * and test/probe-audio.js can show the user exactly what the chooser will say. */
export function parsePactlSinks(sinks) {
    const outputs = [];
    for (const sink of sinks ?? []) {
        const sinkLabel = sink.description || sink.name;
        const ports = sink.ports ?? [];

        if (!ports.length) {
            // Network sinks (AirPlay and friends) have no ports; the sink is
            // the output, and GNOME labels it with the description alone.
            outputs.push({id: outputId(sink.name, null), label: sinkLabel, available: true});
            continue;
        }

        for (const port of ports) {
            const available = port.availability !== 'not available';
            outputs.push({
                id: outputId(sink.name, port.name),
                label: `${port.description || port.name} \u2013 ${sinkLabel}` +
                    (available ? '' : ' (not connected)'),
                available,
            });
        }
    }
    return outputs;
}

export function outputId(sink, port) {
    return port ? `${sink}${SEPARATOR}${port}` : sink;
}

export function outputSink(id) {
    return String(id ?? '').split(SEPARATOR)[0];
}

/* An HDMI or DisplayPort output is exposed by the GPU, so the interface shows
 * up in the sink or port name. Far more stable than the human description,
 * which is localised and vendor-dependent. */
const TV_OUTPUT = /hdmi|displayport/i;

export function isTvOutput(output) {
    return !!output && TV_OUTPUT.test(output.id);
}

/* Network outputs -- AirPlay and friends. Legitimate to choose deliberately,
 * but never the right thing to *guess*: a speaker in another room is a worse
 * default than any local device. Bluetooth is not included; a headset is a
 * perfectly ordinary desk output. */
const NETWORK_OUTPUT = /^(raop_sink|airplay|chromecast)/i;

export function isNetworkOutput(output) {
    return !!output && NETWORK_OUTPUT.test(output.id);
}

/* The ALSA card an output belongs to, or null for anything that is not local
 * hardware. Sink names are `alsa_output.<card>.<profile>`, and the card itself
 * contains dots (`pci-0000_08_00.1`), so the profile is taken off the end
 * rather than the card parsed from the front. */
const ALSA_PREFIX = 'alsa_output.';

export function outputCard(id) {
    const sink = outputSink(id);
    if (!sink.startsWith(ALSA_PREFIX))
        return null;
    const rest = sink.slice(ALSA_PREFIX.length);
    const cut = rest.lastIndexOf('.');
    return cut > 0 ? rest.slice(0, cut) : null;
}

/* Resolve a stored setting against what exists now.
 *
 * Exact match, then the same sink (settings written before ports were
 * understood), then the same card.
 *
 * The card fallback is the important one. A card renames *both* its sink and
 * its ports when its profile changes, and the GPU changes profile the moment a
 * TV is switched on: an HDMI output chosen while the TV was off is
 * `hdmi-stereo|hdmi-output-0`, and the very same physical output is
 * `hdmi-stereo-extra3|hdmi-output-3` once the TV is on. Nothing but the card
 * survives that, so without this a TV output can only be chosen correctly while
 * the TV is already on -- which is not when people set things up. */
export function findOutput(outputs, stored) {
    if (!stored)
        return null;

    const exact = outputs.find(o => o.id === stored);
    if (exact)
        return exact;

    const sameSink = outputs.find(o => outputSink(o.id) === outputSink(stored));
    if (sameSink)
        return sameSink;

    const card = outputCard(stored);
    if (!card)
        return null;
    const onCard = outputs.filter(o => outputCard(o.id) === card);
    if (!onCard.length)
        return null;

    // Keep the role: an HDMI output must not resolve to the same card's analog
    // port just because the card matched.
    // The role is not negotiable. Matching the card but not the role would
    // resolve an HDMI setting to the same card's analog port, which is a
    // different physical socket entirely.
    const wantTv = TV_OUTPUT.test(stored);
    return onCard.find(o => isTvOutput(o) === wantTv && o.available !== false)
        ?? onCard.find(o => isTvOutput(o) === wantTv)
        ?? null;
}

export function classifyOutputs(outputs, prefs = {}) {
    let work = prefs.workSink ? findOutput(outputs, prefs.workSink) : null;
    let tv = prefs.tvSink ? findOutput(outputs, prefs.tvSink) : null;

    if (!tv && !prefs.tvSink) {
        const candidates = outputs.filter(o => o !== work && isTvOutput(o));
        tv = candidates.find(o => o.available !== false) ?? candidates[0] ?? null;
    }

    if (!work && !prefs.workSink) {
        // Prefer whatever the user is actually listening on. Picking "the first
        // output that is not the TV" would happily choose an AirPlay speaker in
        // another room.
        const current = findOutput(outputs, prefs.currentId);
        work = current && current !== tv && !isTvOutput(current) ? current : null;

        // Then what the desk was using before the sound moved to the TV. A
        // choice the user actually made beats every heuristic below, and on the
        // way back from the TV the "current output" hint is useless because the
        // current output *is* the TV.
        if (!work) {
            const remembered = findOutput(outputs, prefs.rememberedWorkSink);
            if (remembered && remembered !== tv && !isTvOutput(remembered))
                work = remembered;
        }

        // Local hardware before anything on the network: with no hint at all,
        // picking the first non-TV output would happily choose an AirPlay
        // speaker in another room.
        work ??= outputs.find(o => o !== tv && !isTvOutput(o) && !isNetworkOutput(o))
            ?? outputs.find(o => o !== tv && !isTvOutput(o))
            ?? outputs.find(o => o !== tv)
            ?? null;
    }

    return {work, tv};
}

/* The display and the sound must not decide separately.
 *
 * An HDMI audio port can report itself available while the TV is switched off,
 * so TV mode would happily move the sound to a TV that is not there and leave
 * the user in silence -- while the display half, seeing no TV connector, has
 * already fallen back to the monitor. Tie the two together: no TV display, no
 * TV sound.
 *
 * `tvDisplayConnected` is null when the display state is not known yet, in
 * which case nothing is overridden. */
export function effectiveAudioMode(mode, tvDisplayConnected) {
    if (mode === 'tv' && tvDisplayConnected === false)
        return 'desktop';
    return mode;
}

/* Which output the given display mode should be using, as {output, fellBack},
 * or null when there is genuinely nothing to pick.
 *
 * Mirrors planFor() on the display side: classifyOutputs() answers null for a
 * configured-but-absent output, and the fallback lives here. Leaving the sound
 * on the TV after switching back to the desk is the audio equivalent of leaving
 * the user on a black screen.
 *
 * The fallback is deliberately one-directional -- desktop mode only. TV mode
 * never substitutes another output for a missing TV; see the comment below. */
export function outputForMode(outputs, mode, prefs = {}) {
    if (mode !== 'desktop' && mode !== 'tv')
        return null;

    const {work, tv} = classifyOutputs(outputs, prefs);
    const wanted = mode === 'tv' ? tv : work;
    if (wanted)
        return {output: wanted, fellBack: false};

    // TV mode with no TV output: leave the sound exactly where it is.
    //
    // Two situations are indistinguishable from here and both want that answer.
    // The TV's audio may not have appeared *yet* -- it lags the display hotplug
    // -- in which case the sound is still on the desk output, which is where it
    // should stay until HDMI shows up. Or it has just *gone*, because applying
    // the TV layout retrained the HDMI link and took the audio device with it
    // for a second or two.
    //
    // Naming the desk output here used to cover the first case and break the
    // second: it actively dragged the sound off the TV mid-transient, and if
    // the settle window expired before HDMI came back the user was left at the
    // desk with the TV showing. Doing nothing is right both ways round -- the
    // settle loop and `output-added` both move over the moment HDMI returns.
    //
    // Note this cannot leave anyone in silence: whatever the sound is on now is
    // by definition a working output. The dangerous fallback is the other one.
    if (mode === 'tv')
        return null;

    // Back at the desk with the usual output gone -- an unplugged headset, say.
    // Anything beats leaving the sound on the TV, but never fall back onto the
    // TV itself.
    const candidate = outputs.find(o => o !== tv && !isTvOutput(o) && !isNetworkOutput(o))
        ?? outputs.find(o => o !== tv && !isTvOutput(o))
        ?? outputs.find(o => o !== tv)
        ?? null;

    return candidate ? {output: candidate, fellBack: true} : null;
}

/* Whether a switch is needed, given what is currently in use. */
export function audioPlan(outputs, mode, currentId, prefs = {}) {
    const resolved = outputForMode(outputs, mode, {...prefs, currentId});
    if (!resolved)
        return {switch: false, reason: 'no-matching-output'};

    const {output, fellBack} = resolved;
    if (output.id === currentId)
        return {switch: false, reason: 'already-correct', target: output, fellBack};
    return {switch: true, reason: fellBack ? 'fallback' : 'switch', target: output, fellBack};
}
