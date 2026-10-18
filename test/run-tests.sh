#!/usr/bin/env bash
# Verifies everything that can be checked without a live GNOME session:
# schema validity, JS syntax, metadata sanity, and the planning unit tests.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
fail=0
step() { printf '\n== %s ==\n' "$1"; }

step "GSettings schema"
if glib-compile-schemas --strict --dry-run extension/schemas/; then
    echo "schema ok"
else
    fail=1
fi

step "JavaScript syntax"
for f in extension/extension.js extension/prefs.js extension/lib/plan.js extension/lib/audio.js extension/lib/variant.js test/test-plan.js test/test-audio.js test/test-variant.js; do
    tmp=$(mktemp --suffix=.mjs)
    tail -n +2 "$f" > "$tmp"   # drop a possible shebang; node rejects it in .mjs
    head -n 1 "$f" | grep -q '^#!' || cp "$f" "$tmp"
    if node --check "$tmp" 2>&1 | sed "s|$tmp|$f|"; then
        echo "ok   $f"
    else
        echo "FAIL $f"
        fail=1
    fi
    rm -f "$tmp"
done

step "metadata.json"
if node -e '
const m = require("./extension/metadata.json");
const need = ["uuid", "name", "description", "shell-version", "version"];
const missing = need.filter(k => !(k in m));
if (missing.length) throw new Error("missing keys: " + missing.join(", "));
if (!/^[-A-Za-z0-9_]+@[-A-Za-z0-9_.]+$/.test(m.uuid)) throw new Error("bad uuid: " + m.uuid);
if (!Number.isInteger(m.version)) throw new Error("version must be an integer for extensions.gnome.org");
const v = require("fs").readFileSync("VERSION", "utf8").trim();
if (m["version-name"] !== v) throw new Error(`version-name ${m["version-name"]} != VERSION ${v}`);
console.log(`ok   ${m.uuid} ${m["version-name"]} (rev ${m.version}) for GNOME ${m["shell-version"].join(", ")}`);
'; then :; else fail=1; fi

step "settings keys"
if node test/check-settings.js; then :; else fail=1; fi

step "planning logic"
if gjs -m test/test-plan.js; then :; else fail=1; fi

step "audio selection logic"
if gjs -m test/test-audio.js; then :; else fail=1; fi

step "variant packing + live dry-run"
if gjs -m test/test-variant.js; then :; else fail=1; fi

printf '\n'
if [ "$fail" -eq 0 ]; then
    echo "PASS"
else
    echo "FAILURES ABOVE"
fi
exit "$fail"
