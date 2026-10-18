#!/usr/bin/env bash
# Display Anchor -- installer for the copy downloaded from https://oyzmo.no/apps/
#
# Everything this script does, in full:
#   1. copies display-anchor@oyzmo.no/ (next to this script) into
#      ~/.local/share/gnome-shell/extensions/
#   2. runs glib-compile-schemas on that directory's schemas/ folder
#   3. prints how to enable it
#
# It does not need root, touches nothing outside that one directory, downloads
# nothing, and changes no settings. Read it before you run it -- that is the
# point of shipping it as a readable script.
set -euo pipefail
cd "$(dirname "$0")"

UUID=display-anchor@oyzmo.no
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ ! -d "$UUID" ]; then
    echo "error: $UUID/ is not next to this script." >&2
    echo "       Unpack the whole zip and run ./install.sh from inside it." >&2
    exit 1
fi

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "error: glib-compile-schemas not found. It ships with glib2, which" >&2
    echo "       every GNOME system has -- something is unusual here." >&2
    exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$UUID/." "$DEST/"
glib-compile-schemas "$DEST/schemas/"

echo
echo "Installed $UUID"
echo "  -> $DEST"

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
cat <<'TXT'

GNOME Shell only loads new extension code in a fresh session, so:

  1. log out and back in
  2. gnome-extensions enable display-anchor@oyzmo.no
  3. gnome-extensions prefs  display-anchor@oyzmo.no

Step 3 opens the settings, where you pick which display is your work display
and which is the TV. Then use the "TV Mode" tile in Quick Settings, or the
keyboard shortcut you set there, to switch between them.

To remove it again, run ./uninstall.sh from this same folder.
TXT
