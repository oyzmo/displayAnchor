# Display Anchor

A GNOME Shell extension that keeps your desktop on the display you chose, instead
of letting it jump to the TV whenever the TV is switched on.

Installed as `display-anchor@oyzmo.no`, with its settings under
`/org/gnome/shell/extensions/display-anchor/`.

> **Upgrading from 0.2.x?** It was called *Screen Fix* then, and everything —
> the UUID, the schema and the dconf path — was still named after it. Those are
> renamed as of 0.3.0, so the new version installs alongside the old one rather
> than over it. Remove the old copy, or the two will both try to enforce a
> layout:
>
> ```sh
> # keep your settings: copy them across first
> dconf dump /org/gnome/shell/extensions/gnome-screen-fix/ \
>     | dconf load /org/gnome/shell/extensions/display-anchor/
>
> gnome-extensions disable gnome-screen-fix@oyzmo.no
> rm -rf ~/.local/share/gnome-shell/extensions/gnome-screen-fix@oyzmo.no
> dconf reset -f /org/gnome/shell/extensions/gnome-screen-fix/
> ```

## Why it happens

Mutter stores a display configuration **per set of connected monitors**, keyed on
the connector, vendor, product and serial of every monitor it can see.

When the TV is off, most TVs drop the HDMI hot-plug signal, so GNOME sees one
monitor: `{DisplayPort}`. Power the TV on and the set becomes
`{DisplayPort, HDMI}` — a *different* key, so Mutter loads a *different* stored
configuration: whichever one was last applied while the TV was on, i.e. the
gaming layout with the monitor disabled. The desktop moves.

Disabling the TV in Settings does not help, because that only edits the
configuration that was current at the time.

## What it does

On every hotplug the extension re-asserts the mode you chose, silently.

There are two ways to apply a display configuration, and they behave very
differently:

| method | GNOME asks "Keep these display settings?" | stored configuration |
| --- | --- | --- |
| temporary | no | untouched |
| persistent | **yes, every time**, and reverts if unanswered | rewritten |

Corrections use **temporary** by default, so nothing interrupts you, and a
deliberate switch to the TV is *never* persisted — storing "TV on, monitor off"
is exactly what makes the next power-on jump again.

Turning on **Write corrections to the system configuration** cures the jump at
its root: it rewrites Mutter's stored configuration for the
`{DisplayPort, HDMI}` set, so the TV powering on causes no switch at all, not
even a corrected one. The cost is that GNOME asks you to keep the change each
time. Worth switching on once to heal a bad stored configuration, then off
again.

Two rules keep it from becoming a nuisance:

- **A layout change with no change to the connected monitors is adopted, not
  fought.** Reconfiguring in Settings — or with Display Configuration Switcher,
  which keeps working alongside this — updates the extension's idea of the
  current mode instead of being reverted. An arrangement that is neither
  "monitor only" nor "TV only" (an extended desktop, say) becomes `custom`, and
  custom is never enforced.
- **Except a switch to the TV that did not come from the extension.** A layout
  that turns the monitor off and leaves only the TV on is put back, unless you
  made it with the *TV Mode* toggle or the shortcut. An HDMI TV in standby still
  counts as connected, so without this anything that switched to the TV behind
  your back would leave a black screen. It is the setting *Only switch to the
  TV with the toggle*, on by default; the cost is that "TV only" chosen in
  Settings is undone too.
- **When the TV disconnects, it returns to the work display** after a grace
  period, so powering the TV on later is inert until you ask for TV mode again.
  The grace period (30s by default) exists because receivers and HDR mode
  changes drop the HDMI link for a few seconds mid-game, and that must not end
  TV mode.

If the display a mode wants is not connected, it lights up the other one. It
never plans a configuration with zero displays enabled.

**It keeps working behind the lock screen.** A monitor that sleeps after
<kbd>Super</kbd>+<kbd>L</kbd> often disconnects and reconnects, and without
enforcement Mutter would put the unlock dialog on the TV. So the extension stays
running while locked — but only the enforcement: the shortcut is removed and
the Quick Settings toggle is hidden until you unlock.

**Variable refresh rate is preserved.** Re-enabling a display that Mutter had
disabled would otherwise drop it to the fixed-rate variant of its mode, silently
turning FreeSync/VRR off. The plan prefers a variable-rate mode of the same
geometry and carries `refresh-rate-mode` through to the apply.

That is not the only way VRR goes missing, though. Mutter stores a display
*mode* alongside each layout, so a stored configuration written before you
turned FreeSync on will put the desktop back on the right screen at a fixed
refresh rate — nothing moved, so there is nothing obvious to correct. Display
Anchor therefore remembers the mode your work display was last seen running on
its own, and puts that mode back when it finds the display running something
else. The memory is only taken from a layout somebody chose deliberately, so
switching variable refresh *off* in Settings is remembered rather than fought,
and it is never applied to the TV.

**HDR is preserved the same way.** A display configuration is a complete
description of the monitor, so one that does not name a colour mode puts the
monitor back to plain SDR — which meant that coming back from the TV switched
HDR off every time, whether Mutter's stored configuration did it or Display
Anchor's own correction did. The colour mode the work display was last seen
using on its own is remembered and put back with it, under exactly the same
rules as the refresh rate: only ever taken from a layout somebody chose, never
applied to the TV, and never a value the monitor does not advertise. A display
that is already on simply keeps the colour mode it is running, TV included.

## Sound

Optional, **off by default** — turn on *Move the sound output too* under
**Sound** in preferences.

When on, the default audio output follows the display mode: the TV's HDMI sink
in TV mode, your normal output otherwise. Two details make it more than one
call, and both are handled — the HDMI audio sink does not exist at the instant
the display hotplug fires, and the desktop may grab it on its own once it
appears, so the choice is re-asserted once a second for a settle window
(10s by default) rather than set once.

**The sound follows the display, not the port.** An HDMI audio port can report
itself available while the TV is switched off, so TV mode would otherwise move
your sound to a dark TV and leave you in silence — while the display half,
seeing no TV connector, had already fallen back to the monitor. If the TV
display is not connected, the sound does not go to it either.

If the output a mode wants has gone — an unplugged USB or Bluetooth headset,
say — it falls back rather than doing nothing, because leaving the sound on the
TV after you have switched back to the desk is the audio equivalent of leaving
you on a black screen. The fallback never chooses the TV itself, and when
nothing but the TV sink exists it leaves your audio alone. Reconnect the headset
within the settle window and it moves back to it.

The choosers list **outputs, not sinks** — the same entries as GNOME's own Sound
Output menu, labelled the same way ("Analog Output – Azur DacMagic 100"). That
matters twice: one sink can carry several outputs (a DAC's analog and S/PDIF
ports are a single sink), and a port exists even while nothing is plugged into
it, so the TV's HDMI output can be chosen while the TV is switched off — it is
listed as "(not connected)".

Automatic sends TV mode to the first HDMI or DisplayPort output. For work mode it
prefers, in order: whatever you are listening on at the time; **the output you
were using just before the sound moved to the TV**; then local hardware before
anything on the network, so it never guesses a speaker in another room.

The middle rule matters on the way back from the TV, where the first rule is no
help — what you are "listening on" is the TV itself. Without it, a deliberate
choice of, say, an AirPlay speaker would be quietly replaced by whichever local
device looked most likely. If the remembered output has since disappeared, it
falls through to the guess rather than to silence.

A chosen output survives its card changing profile. A GPU renames both its sink
and its ports the moment a TV is switched on — the HDMI output you pick with the
TV off is `hdmi-stereo|hdmi-output-0`, and the very same socket is
`hdmi-stereo-extra3|hdmi-output-3` once the TV is on — so settings are resolved
by card, not just by name. Without that, the TV output could only be chosen
correctly while the TV was already on.

Preview what the choosers will show, without installing anything:

```sh
gjs -m test/probe-audio.js
```

Note that changing the default output does not move audio that is *already*
playing — an app keeps its stream on the old sink until restarted.

## Using it

- **Quick Settings** has a *TV Mode* toggle, with the active display as its
  subtitle.
- **<kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>** switches between the work
  display and the TV. Rebindable in preferences.
- Preferences let you name the two displays explicitly rather than relying on
  detection (which assumes the first HDMI output is the TV and a DisplayPort or
  built-in panel is the work display), turn enforcement off, adjust the grace
  period, silence the notifications, and turn on sound switching.

## Install

```sh
./install.sh                # runs the tests, then installs for this user
# log out and back in  (Wayland only loads new extensions in a fresh session)
gnome-extensions enable display-anchor@oyzmo.no
gnome-extensions prefs  display-anchor@oyzmo.no
```

```sh
./uninstall.sh              # remove, keeping settings
./uninstall.sh --purge      # remove and erase its dconf settings
```

Removing the extension does not undo the display configuration it wrote —
Mutter keeps that in `~/.config/monitors.xml`.

## Watching it work

Turn on *Log every decision* under **Diagnostics** in preferences, or from a
terminal — note that an extension's schema is not on the default schema path, so
plain `gsettings set` will not find it:

```sh
dconf write /org/gnome/shell/extensions/display-anchor/debug true
```

Either takes effect immediately, no reload. Then:

```sh
journalctl --user -f SYSLOG_IDENTIFIER=gnome-shell | grep display-anchor
```

Powering the TV on then looks like this:

```
[display-anchor] state: connected=[DP-1 HDMI-1] enabled=[HDMI-1] work=DP-1 tv=HDMI-1 mode=desktop HOTPLUG
[display-anchor]   -> plan: enable DP-1 mode=2560x1440@144 scale=1
[display-anchor]   -> applied persistently (serial 7)
[display-anchor] state: connected=[DP-1 HDMI-1] enabled=[DP-1] work=DP-1 tv=HDMI-1 mode=desktop same-monitors
[display-anchor]   -> ignoring, this was our own change
```

Every branch of the state machine announces itself: `HOTPLUG` vs
`same-monitors`, `adopting layout somebody else chose`, `no change needed
(already-correct)`, the grace timer starting and being cancelled, and the
runaway pause. It is off by default because it logs on every display change.

Two things worth checking independently of the extension:

```sh
busctl --user monitor org.gnome.Mutter.DisplayConfig   # the hotplug events themselves
gjs -m test/probe-live.js                              # read-only state + plan dump
```

The proof that the *permanent* part worked is `~/.config/monitors.xml` being
rewritten the first time the TV powers on with the extension active. After that
the switch should stop happening at all.

## Development

```sh
./test/run-tests.sh         # schema, syntax, metadata, settings keys, 194 unit checks
gjs -m test/probe-live.js   # read-only: dump live monitor state and the plan
gjs -m test/probe-properties.js  # which monitor properties this Mutter accepts
gjs -m test/probe-audio.js       # read-only: what the Sound choosers will list
./pack.sh                   # build dist/*.shell-extension.zip
./bump.sh [patch|minor|major]
```

Version 0.2.2.
