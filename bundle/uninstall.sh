#!/usr/bin/env bash
# Display Anchor -- remove the copy installed by ./install.sh
#
#   ./uninstall.sh            remove the extension, keep your settings
#   ./uninstall.sh --purge    also erase its settings from dconf
set -euo pipefail

UUID=display-anchor@oyzmo.no
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
DCONF_PATH="/org/gnome/shell/extensions/display-anchor/"

purge=0
case "${1:-}" in
    --purge) purge=1 ;;
    "") ;;
    *) echo "usage: $0 [--purge]" >&2; exit 1 ;;
esac

# Disable first, so the shell drops it cleanly and unbinds the shortcut before
# the files disappear.
if gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    echo "disabled $UUID"
else
    echo "$UUID is not installed for this user"
fi

if [ -d "$DEST" ]; then
    rm -rf "$DEST"
    echo "removed $DEST"
fi

if [ "$purge" -eq 1 ]; then
    dconf reset -f "$DCONF_PATH"
    echo "erased settings under $DCONF_PATH"
else
    echo "kept settings under $DCONF_PATH (use --purge to erase them)"
fi

cat <<'TXT'

Note: removing the extension does not undo the display configuration it wrote.
Mutter keeps whatever layout was last applied, per set of connected monitors,
in ~/.config/monitors.xml. If you want the old auto-switching behaviour back,
that file is where it lives -- deleting it makes GNOME start over.

On Wayland, log out and back in to fully unload the extension.
TXT
