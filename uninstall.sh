#!/usr/bin/env bash
# Removes the extension from the current user's GNOME Shell.
# Run this yourself -- it touches the live session.
#
#   ./uninstall.sh            remove the extension, keep your settings
#   ./uninstall.sh --purge    also erase its dconf settings
set -euo pipefail
cd "$(dirname "$0")"

UUID=$(node -p 'require("./extension/metadata.json").uuid')
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
# Derived from the schema id rather than written out again, so a rename cannot
# leave this pointing at the previous dconf path.
DCONF_PATH="/$(node -p 'require("./extension/metadata.json")["settings-schema"].replace(/\./g, "/")')/"

purge=0
case "${1:-}" in
    --purge) purge=1 ;;
    "") ;;
    *) echo "usage: $0 [--purge]" >&2; exit 1 ;;
esac

# Disable first so the shell drops it cleanly and unbinds the shortcut; on a
# live session this takes effect immediately, before the files disappear.
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

cat <<'EOF'

Note: removing the extension does not undo the display configuration it wrote.
Mutter keeps whatever layout was last applied, per set of connected monitors,
in ~/.config/monitors.xml. If you want the old auto-switching behaviour back,
that file is where it lives -- deleting it makes GNOME start over from scratch.

On Wayland, log out and back in to fully unload the extension.
EOF
