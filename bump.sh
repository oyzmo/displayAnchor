#!/usr/bin/env bash
# Single source of truth for the version: the VERSION file.
# Usage: ./bump.sh [patch|minor|major]   (default: patch)
#
# extensions.gnome.org needs metadata.json "version" to be a plain increasing
# integer, so that is bumped as a revision counter alongside the semver string
# in "version-name". Nothing else in the tree carries a version string.
set -euo pipefail
cd "$(dirname "$0")"

part="${1:-patch}"
current=$(tr -d '[:space:]' < VERSION)

IFS=. read -r major minor patch <<< "$current"
case "$part" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) echo "usage: $0 [patch|minor|major]" >&2; exit 1 ;;
esac

next="${major}.${minor}.${patch}"
echo "$next" > VERSION

node -e '
const fs = require("fs");
const path = "extension/metadata.json";
const m = JSON.parse(fs.readFileSync(path, "utf8"));
m["version-name"] = process.argv[1];
m.version = (m.version || 0) + 1;
fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
' "$next"

echo "$current -> $next (metadata revision $(node -p 'require("./extension/metadata.json").version'))"
