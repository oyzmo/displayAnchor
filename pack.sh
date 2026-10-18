#!/usr/bin/env bash
# Builds the distributable zips in dist/. Does not install or upload anything.
# Both names carry the version from VERSION, so builds of different releases
# sit side by side; rebuilding the same version overwrites it.
#
#   dist/display-anchor@oyzmo.no-<version>.shell-extension.zip
#       the extensions.gnome.org upload, built by `gnome-extensions pack`
#   dist/displayanchor-install-<version>.zip
#       the same extension for the website: unpacked UUID directory plus a
#       readable install.sh/uninstall.sh and README.txt from bundle/
#   dist/displayanchorsource-<version>.zip
#       the source download linked from oyzmo.no and from prefs.js's reviewer
#       note
set -euo pipefail
cd "$(dirname "$0")"

./test/run-tests.sh

UUID=$(node -p 'require("./extension/metadata.json").uuid')
VERSION=$(tr -d '[:space:]' < VERSION)
EGO_ZIP="dist/$UUID-$VERSION.shell-extension.zip"
SITE_ZIP="dist/displayanchor-install-$VERSION.zip"
SOURCE_ZIP="dist/displayanchorsource-$VERSION.zip"

mkdir -p dist
# Pre-versioning names, so a stale unversioned zip cannot be uploaded by mistake.
rm -f "dist/$UUID.shell-extension.zip" dist/displayanchor-install.zip \
    dist/displayanchorsource.zip

cp LICENSE extension/LICENSE

# `gnome-extensions pack` always names its output after the UUID alone, so it
# is renamed afterwards.
gnome-extensions pack extension \
    --extra-source=lib \
    --extra-source=LICENSE \
    --schema=schemas/org.gnome.shell.extensions.display-anchor.gschema.xml \
    --force --out-dir=dist
mv -f "dist/$UUID.shell-extension.zip" "$EGO_ZIP"

rm -f extension/LICENSE

# ---------------------------------------------------------------- website zip
# Self-hosted copies get an installer, because `gnome-extensions install` is not
# something a person who just wants their TV to stop stealing the desktop should
# have to know about. The scripts live in bundle/ as real files rather than
# heredocs in here, so they can be read and syntax-checked on their own.
STAGE=dist/.bundle

rm -rf "$STAGE"
mkdir -p "$STAGE/$UUID"
cp -r extension/. "$STAGE/$UUID/"
rm -f "$STAGE/$UUID/schemas/gschemas.compiled"
cp LICENSE "$STAGE/$UUID/LICENSE"
cp bundle/install.sh bundle/uninstall.sh "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
sed "s/@VERSION@/$VERSION/" bundle/README.txt > "$STAGE/README.txt"

rm -f "$SITE_ZIP"
(cd "$STAGE" && zip -qr "../$(basename "$SITE_ZIP")" .)
rm -rf "$STAGE"

# ----------------------------------------------------------------- source zip
# The developer tree minus dev/ and dist/, for the source link on oyzmo.no.
rm -f "$SOURCE_ZIP"
zip -qr "$SOURCE_ZIP" extension test assets bundle LICENSE \
    README.md VERSION bump.sh pack.sh install.sh uninstall.sh \
    -x '*/gschemas.compiled'

ls -l dist/
