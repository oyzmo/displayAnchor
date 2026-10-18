#!/usr/bin/env bash
# Installs the extension into the current user's GNOME Shell.
# Run this yourself -- it touches the live session.
set -euo pipefail
cd "$(dirname "$0")"

UUID=$(node -p 'require("./extension/metadata.json").uuid')
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

./test/run-tests.sh

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r extension/. "$DEST/"
glib-compile-schemas "$DEST/schemas/"

echo
echo "Installed $UUID to $DEST"

# ---------------------------------------------------------------------------
# Up to 0.2.4 this extension installed as gnome-screen-fix@oyzmo.no. The rename
# in 0.3.0 means that copy is NOT replaced by this one -- it is a different
# extension as far as GNOME is concerned, and two copies both enforcing a
# display layout will fight each other.
LEGACY_UUID=gnome-screen-fix@oyzmo.no
LEGACY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$LEGACY_UUID"
if [ -d "$LEGACY_DIR" ]; then
    cat <<EOF

WARNING: the old "Screen Fix" copy is still installed at
  $LEGACY_DIR

Remove it, or both extensions will try to enforce a layout. To keep your
settings, copy them across first:

  dconf dump /org/gnome/shell/extensions/gnome-screen-fix/ \\
      | dconf load /org/gnome/shell/extensions/display-anchor/

  gnome-extensions disable $LEGACY_UUID
  rm -rf "$LEGACY_DIR"
  dconf reset -f /org/gnome/shell/extensions/gnome-screen-fix/

EOF
fi
echo
echo "On Wayland a new extension is only picked up by a fresh session, so:"
echo "  1. log out and back in"
echo "  2. gnome-extensions enable $UUID"
echo "  3. gnome-extensions prefs $UUID"
echo
cat <<'EOF'
To watch it work, turn on decision logging (takes effect immediately, no reload):

  dconf write /org/gnome/shell/extensions/display-anchor/debug true
  journalctl --user -f SYSLOG_IDENTIFIER=gnome-shell | grep display-anchor

Then power the TV on. A correction looks like:

  [display-anchor] state: connected=[DP-1 HDMI-1] enabled=[HDMI-1] ... mode=desktop HOTPLUG
  [display-anchor]   -> plan: enable DP-1 mode=... scale=...
  [display-anchor]   -> applied persistently (serial N)
EOF
