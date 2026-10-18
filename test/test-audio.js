#!/usr/bin/gjs -m
/* Unit tests for the pure audio-output selection. */

import {
    classifyOutputs, outputForMode, audioPlan, outputId, outputSink, findOutput, isTvOutput,
    effectiveAudioMode, outputCard, isNetworkOutput,
} from '../extension/lib/audio.js';

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

/* Modelled on the user's actual setup: a GPU HDMI port, one DAC exposing both
 * an analog and an S/PDIF port on a single sink, and several AirPlay sinks that
 * have no ports at all. */
const out = (id, label, available = true) => ({id, label, available});

const HDMI = out(
    outputId('alsa_output.pci-0000_0d_00.1.hdmi-stereo', 'hdmi-output-0'),
    'HDMI / DisplayPort – Navi 48 HDMI Audio');
const DAC_ANALOG = out(
    outputId('alsa_output.usb-Cambridge_Audio_DacMagic-00.analog-stereo', 'analog-output'),
    'Analog Output – Azur DacMagic 100');
const DAC_SPDIF = out(
    outputId('alsa_output.usb-Cambridge_Audio_DacMagic-00.analog-stereo', 'iec958-stereo-output'),
    'Digital Output (S/PDIF) – Azur DacMagic 100');
const AIRPLAY = out('raop_sink.AudioPro_C5MkII', 'AudioPro_C5MkII');
const HEADSET = out(
    outputId('alsa_output.usb-Logitech_Headset-00.analog-stereo', 'analog-output'),
    'Headset – Logitech');

const ALL = [HDMI, DAC_ANALOG, DAC_SPDIF, AIRPLAY, HEADSET];

suite('output identity', () => {
    eq(outputId('sink', 'port'), 'sink|port', 'sink and port compose into an id');
    eq(outputId('sink', null), 'sink', 'a portless sink is its own id');
    eq(outputSink('sink|port'), 'sink', 'the sink can be recovered');
    eq(outputSink('sink'), 'sink', 'and from a portless id too');

    // The whole point of being port-aware: one sink, two distinguishable outputs.
    ok(DAC_ANALOG.id !== DAC_SPDIF.id, 'two ports on one sink are different outputs');
    eq(outputSink(DAC_ANALOG.id), outputSink(DAC_SPDIF.id), 'but they share a sink');

    ok(isTvOutput(HDMI), 'an HDMI output is recognised as the TV');
    ok(!isTvOutput(DAC_SPDIF), 'a digital DAC output is not mistaken for HDMI');
    ok(!isTvOutput(AIRPLAY), 'nor is an AirPlay speaker');
});

/* Verbatim from the user's machine, captured with the TV off and then on. The
 * GPU changes card profile when the TV appears, renaming both the sink and the
 * port; only the card `pci-0000_08_00.1` survives. */
const HDMI_TV_OFF = out('alsa_output.pci-0000_08_00.1.hdmi-stereo|hdmi-output-0',
    'HDMI / DisplayPort – Navi 48 HDMI/DP Audio Controller Digital Stereo (HDMI)');
const HDMI_TV_ON = out('alsa_output.pci-0000_08_00.1.hdmi-stereo-extra3|hdmi-output-3',
    'HDMI / DisplayPort 4 – Navi 48 HDMI/DP Audio Controller Digital Stereo (HDMI 4)');
const DAC_PRO = out(
    'alsa_output.usb-Cambridge_Audio_Cambridge_Audio_DAC100_USB_2_0000-00.pro-output-0',
    'Azur DacMagic 100 Pro');
const AIRPLAY_2 = out('raop_sink.Stue-235.local.192.168.1.102.7000', 'Stue (235)');

suite('an HDMI output renamed by a card profile change', () => {
    eq(outputCard(HDMI_TV_OFF.id), 'pci-0000_08_00.1', 'card parsed off the sink name');
    eq(outputCard(HDMI_TV_ON.id), 'pci-0000_08_00.1', 'and it is the same card in both states');
    eq(outputCard(DAC_PRO.id),
        'usb-Cambridge_Audio_Cambridge_Audio_DAC100_USB_2_0000-00', 'USB cards parse too');
    eq(outputCard(AIRPLAY_2.id), null, 'network sinks have no card');

    // The reported bug: chosen with the TV off, then the TV comes on.
    const withTvOn = [DAC_PRO, HDMI_TV_ON, AIRPLAY_2];
    const resolved = findOutput(withTvOn, HDMI_TV_OFF.id);
    eq(resolved?.id, HDMI_TV_ON.id, 'the stale HDMI id resolves to the live one');

    const {tv} = classifyOutputs(withTvOn, {tvSink: HDMI_TV_OFF.id});
    eq(tv?.id, HDMI_TV_ON.id, 'so the configured TV output is found');
    const plan = audioPlan(withTvOn, 'tv', DAC_PRO.id, {tvSink: HDMI_TV_OFF.id});
    eq(plan.target.id, HDMI_TV_ON.id, 'and TV mode actually reaches the TV');
    eq(plan.fellBack, false, 'without being treated as a fallback');

    // And the reverse, so a setting made with the TV on still works with it off.
    eq(findOutput([DAC_PRO, HDMI_TV_OFF], HDMI_TV_ON.id)?.id, HDMI_TV_OFF.id,
        'resolution works in both directions');

    // The card fallback must keep the role: HDMI must not land on an analog
    // port that happens to share the card.
    const analogOnSameCard = out('alsa_output.pci-0000_08_00.1.analog-stereo|analog-output',
        'Analog – same card');
    eq(findOutput([analogOnSameCard], HDMI_TV_OFF.id), null,
        'an HDMI setting does not resolve to an analog port on the same card');
});

suite('automatic never guesses a speaker in another room', () => {
    ok(isNetworkOutput(AIRPLAY), 'AirPlay sinks are recognised as network outputs');
    ok(!isNetworkOutput(DAC_PRO), 'a USB DAC is not');
    ok(!isNetworkOutput(HDMI_TV_ON), 'nor is HDMI');

    // Exactly the user's situation: currently on the TV, so there is no hint,
    // and the first non-TV output in the list is an AirPlay speaker.
    const outputs = [AIRPLAY, AIRPLAY_2, DAC_PRO, HDMI_TV_ON];
    const {work} = classifyOutputs(outputs, {currentId: HDMI_TV_ON.id});
    eq(work?.id, DAC_PRO.id, 'local hardware wins over AirPlay');

    const back = audioPlan(outputs, 'desktop', HDMI_TV_ON.id, {});
    eq(back.target.id, DAC_PRO.id, 'so returning to the desk lands on the DAC');

    // Deliberately choosing a network output still works.
    const chosen = classifyOutputs(outputs, {workSink: AIRPLAY.id, currentId: HDMI_TV_ON.id});
    eq(chosen.work?.id, AIRPLAY.id, 'an explicitly chosen AirPlay output is respected');

    // With nothing local available, a network output is better than nothing.
    const noLocal = classifyOutputs([AIRPLAY, HDMI_TV_ON], {currentId: HDMI_TV_ON.id});
    eq(noLocal.work?.id, AIRPLAY.id, 'falls to network when there is no local output');
});

suite('coming back from the TV restores what you were using', () => {
    // Exactly what the user reported: listening on AudioPro at the desk, switch
    // to the TV, switch back -- and land on the DacMagic instead, because the
    // only hint ("what are you listening on") is the TV by then.
    const outputs = [AIRPLAY, AIRPLAY_2, DAC_PRO, HDMI_TV_ON];

    const withoutMemory = classifyOutputs(outputs, {currentId: HDMI_TV_ON.id});
    eq(withoutMemory.work?.id, DAC_PRO.id, 'with nothing remembered it still guesses local hardware');

    const withMemory = classifyOutputs(outputs,
        {currentId: HDMI_TV_ON.id, rememberedWorkSink: AIRPLAY.id});
    eq(withMemory.work?.id, AIRPLAY.id, 'a remembered choice beats the guess');

    const plan = audioPlan(outputs, 'desktop', HDMI_TV_ON.id, {rememberedWorkSink: AIRPLAY.id});
    eq(plan.target.id, AIRPLAY.id, 'so switching back returns to AudioPro');
    eq(plan.fellBack, false, 'and that is a real answer, not a fallback');

    // Gone since: fall through to the guess rather than to silence.
    const gone = classifyOutputs([DAC_PRO, HDMI_TV_ON, AIRPLAY_2],
        {currentId: HDMI_TV_ON.id, rememberedWorkSink: AIRPLAY.id});
    eq(gone.work?.id, DAC_PRO.id, 'a remembered output that vanished falls back to local hardware');

    // Renamed by a profile change still counts as present, via the card.
    const renamed = classifyOutputs([DAC_PRO, HDMI_TV_ON],
        {currentId: HDMI_TV_ON.id,
            rememberedWorkSink: 'alsa_output.usb-Cambridge_Audio_Cambridge_Audio_DAC100_USB_2_0000-00.analog-stereo|analog-output'});
    eq(renamed.work?.id, DAC_PRO.id, 'a renamed remembered output is still found');

    // An explicit setting outranks the memory.
    const explicit = classifyOutputs(outputs,
        {workSink: DAC_PRO.id, currentId: HDMI_TV_ON.id, rememberedWorkSink: AIRPLAY.id});
    eq(explicit.work?.id, DAC_PRO.id, 'an explicitly chosen output is not overridden by memory');

    // What you are listening on right now still wins over the memory.
    const atDesk = classifyOutputs(outputs,
        {currentId: DAC_PRO.id, rememberedWorkSink: AIRPLAY.id});
    eq(atDesk.work?.id, DAC_PRO.id, 'the live output outranks a stale memory');

    // The memory must never drag audio onto the TV.
    const poisoned = classifyOutputs(outputs,
        {currentId: HDMI_TV_ON.id, rememberedWorkSink: HDMI_TV_ON.id});
    ok(!isTvOutput(poisoned.work), 'a TV output remembered by mistake is ignored');
    eq(poisoned.work?.id, DAC_PRO.id, 'and the guess takes over');
});

suite('settings stored before ports were understood still resolve', () => {
    const bareSink = 'alsa_output.usb-Cambridge_Audio_DacMagic-00.analog-stereo';
    const found = findOutput(ALL, bareSink);
    ok(found !== null, 'a stored bare sink name still finds an output');
    eq(outputSink(found.id), bareSink, 'and it is on the right sink');
    eq(findOutput(ALL, 'alsa_output.nothing-like-this'), null, 'an unknown id finds nothing');
    eq(findOutput(ALL, ''), null, 'an empty setting finds nothing');
});

suite('automatic classification', () => {
    // Work must not become an AirPlay speaker in another room just because it
    // happens to sort before the DAC.
    const listening = classifyOutputs(ALL, {currentId: DAC_SPDIF.id});
    eq(listening.tv?.id, HDMI.id, 'HDMI is the TV');
    eq(listening.work?.id, DAC_SPDIF.id, 'work is whatever is actually in use');

    // Coming back from the TV, the current output is the TV, so it must pick
    // something else rather than calling the TV the work output.
    const fromTv = classifyOutputs(ALL, {currentId: HDMI.id});
    eq(fromTv.work?.id, DAC_ANALOG.id, 'falls to the first non-TV output');
    ok(!isTvOutput(fromTv.work), 'and never to the TV itself');

    const unavailableTv = classifyOutputs(
        [out(HDMI.id, HDMI.label, false), DAC_ANALOG], {currentId: DAC_ANALOG.id});
    eq(unavailableTv.tv?.id, HDMI.id, 'the TV output is found even while not connected');
});

suite('explicit configuration is authoritative', () => {
    const chosen = classifyOutputs(ALL, {workSink: DAC_SPDIF.id, tvSink: HDMI.id});
    eq(chosen.work?.id, DAC_SPDIF.id, 'the S/PDIF port specifically, not just the sink');
    eq(chosen.tv?.id, HDMI.id, 'and the configured TV output');

    const absent = classifyOutputs([DAC_ANALOG], {tvSink: HDMI.id});
    eq(absent.tv, null, 'a configured but absent output is not guessed at');
});

suite('planning a switch', () => {
    const toTv = audioPlan(ALL, 'tv', DAC_ANALOG.id, {});
    eq(toTv.switch, true, 'switches to the TV output in TV mode');
    eq(toTv.target.id, HDMI.id, 'targeting HDMI');
    eq(toTv.fellBack, false, 'not a fallback');

    const already = audioPlan(ALL, 'tv', HDMI.id, {});
    eq(already.switch, false, 'no switch when already on the TV output');
    eq(already.reason, 'already-correct', 'and it says so');

    const back = audioPlan(ALL, 'desktop', HDMI.id, {workSink: DAC_SPDIF.id});
    eq(back.switch, true, 'switches back for desktop mode');
    eq(back.target.id, DAC_SPDIF.id, 'to the exact port configured');
});

suite('the configured output is gone', () => {
    // Coming back from the TV with the usual headset unplugged.
    const present = [HDMI, DAC_ANALOG, AIRPLAY];
    const gone = audioPlan(present, 'desktop', HDMI.id, {workSink: HEADSET.id});
    eq(gone.switch, true, 'it does not just give up');
    eq(gone.fellBack, true, 'and reports that it fell back');
    eq(gone.reason, 'fallback', 'with a distinguishable reason');
    ok(!isTvOutput(gone.target), 'landing somewhere that is not the TV');
    eq(gone.target.id, DAC_ANALOG.id, 'namely the first usable non-TV output');

    // Never fall back onto the TV, even as the only alternative.
    const onlyTv = audioPlan([HDMI], 'desktop', HDMI.id, {workSink: HEADSET.id});
    eq(onlyTv.switch, false, 'nothing to move to when only the TV output exists');
    eq(onlyTv.reason, 'no-matching-output', 'so the audio is left alone');
    eq(outputForMode([HDMI], 'desktop', {}), null, 'automatic will not fall back onto the TV either');

    // Reconnecting within the settle window picks it up again.
    const backAgain = audioPlan(ALL, 'desktop', DAC_ANALOG.id, {workSink: HEADSET.id});
    eq(backAgain.target.id, HEADSET.id, 'moves back once the headset returns');
    eq(backAgain.fellBack, false, 'and it is no longer a fallback');
});

suite('TV audio that has not appeared yet', () => {
    // HDMI audio lags the display hotplug, so TV mode may resolve before it
    // exists. Nothing stands in for it -- the sound stays where it is and the
    // settle loop moves over.
    const notYet = audioPlan([DAC_ANALOG], 'tv', DAC_ANALOG.id, {});
    eq(notYet.switch, false, 'nothing to move to, so nothing to do');
    eq(notYet.reason, 'no-matching-output', 'and it says so rather than falling back');

    const appeared = audioPlan([DAC_ANALOG, HDMI], 'tv', DAC_ANALOG.id, {});
    eq(appeared.target.id, HDMI.id, 'and moves over once HDMI shows up');
});

suite('TV audio that vanishes mid-switch', () => {
    // Applying the TV layout retrains the HDMI link, which takes the HDMI audio
    // device out of the list for a second or two. The sound is already on the
    // TV at that point, and the old desk fallback dragged it back off -- so if
    // the settle window expired before HDMI returned, the user was left at the
    // desk with the TV showing. This is the regression test for that.
    const midTransient = audioPlan([DAC_ANALOG], 'tv', HDMI.id, {tvSink: HDMI.id});
    eq(midTransient.switch, false, 'the sound is not dragged back to the desk');
    eq(midTransient.reason, 'no-matching-output', 'it is simply left alone');

    // Same again with the desk output explicitly configured: an explicit work
    // output is not a licence to use it as a stand-in for the TV either.
    const configured = audioPlan([DAC_ANALOG], 'tv', HDMI.id,
        {tvSink: HDMI.id, workSink: DAC_ANALOG.id});
    eq(configured.switch, false, 'even with a work output configured');

    // And it goes back to the TV the moment the device returns.
    const returned = audioPlan([DAC_ANALOG, HDMI], 'tv', DAC_ANALOG.id, {tvSink: HDMI.id});
    eq(returned.target.id, HDMI.id, 'and returns to the TV when HDMI comes back');
    eq(returned.switch, true, 'moving the sound back');
});

suite('the sound follows the display, not the port', () => {
    // An HDMI audio port can report itself available while the TV is switched
    // off. Trusting it would move the sound to a TV that is not there, while
    // the display half had already fallen back to the monitor.
    eq(effectiveAudioMode('tv', false), 'desktop', 'no TV display means no TV sound');
    eq(effectiveAudioMode('tv', true), 'tv', 'with the TV connected, TV mode stands');
    eq(effectiveAudioMode('tv', null), 'tv', 'an unknown display state overrides nothing');
    eq(effectiveAudioMode('desktop', false), 'desktop', 'desktop mode is never touched');
    eq(effectiveAudioMode('desktop', true), 'desktop', 'nor when the TV is present');
    eq(effectiveAudioMode('custom', false), 'custom', 'custom mode is left alone');

    // End to end: the TV is off but its HDMI port still lists as available.
    const tvOffButPortListed = [DAC_ANALOG, HDMI];
    const naive = audioPlan(tvOffButPortListed, 'tv', DAC_ANALOG.id, {});
    eq(naive.target.id, HDMI.id, 'the naive answer would move sound to the dark TV');

    const corrected = audioPlan(
        tvOffButPortListed, effectiveAudioMode('tv', false), DAC_ANALOG.id, {});
    eq(corrected.switch, false, 'the corrected answer leaves the sound where it is');
    eq(corrected.target.id, DAC_ANALOG.id, 'on the desk output');
});

suite('never leave the user in silence', () => {
    eq(outputForMode([], 'desktop', {}), null, 'no outputs at all means no target');
    eq(outputForMode([], 'tv', {}), null, 'likewise in TV mode');
    eq(outputForMode(ALL, 'custom', {}), null, 'custom mode never moves audio');

    // Whatever gets chosen must be an output that actually exists.
    for (const mode of ['desktop', 'tv']) {
        for (const outputs of [[DAC_ANALOG], [HDMI], [HDMI, DAC_ANALOG], ALL]) {
            for (const prefs of [{}, {workSink: HEADSET.id}, {tvSink: 'gone'},
                {currentId: HDMI.id}, {currentId: 'stale|port'}]) {
                const resolved = outputForMode(outputs, mode, prefs);
                if (resolved)
                    ok(outputs.includes(resolved.output), `${mode}: chosen output exists`);
                // TV mode substitutes nothing: it either names the TV or says
                // nothing at all, so the sound is never moved off the TV while
                // the HDMI audio device is away being retrained.
                if (mode === 'tv')
                    ok(!resolved?.fellBack, 'tv: never falls back to another output');
            }
        }
    }
});

print('');
if (failures) {
    print(`${failures} failed out of ${checks} checks`);
    imports.system.exit(1);
} else {
    print(`all ${checks} checks passed`);
}
