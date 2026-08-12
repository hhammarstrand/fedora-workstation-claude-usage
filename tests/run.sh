#!/usr/bin/env bash
# Kör hela testsviten. Inget av det rör nätverket utanför localhost.
#
#   Python-testerna kräver bara python3 (som Fedora har).
#   JS-testerna kräver node och är enbart ett utvecklingsberoende — tillägget
#   självt använder bara GNOME:s egna bibliotek.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }

FAILED=0

bold "Python: bin/claude-usage"
# Ingen -t: tests/ är ingen Python-paketkatalog, och testfilen hittar
# repo-roten själv.
python3 -m unittest discover -s tests "$@" || FAILED=1

if command -v node >/dev/null 2>&1; then
    # Två körningar: St.BoxLayout med 'orientation' (GNOME 48+) och med
    # 'vertical' (GNOME 45–47). Samma kod måste klara båda.
    for mode in 1 0; do
        label=$([ "$mode" = 1 ] && echo "GNOME 48+ (orientation)" \
                                || echo "GNOME 45–47 (vertical)")
        bold "JS: extension/extension.js — $label"
        STUB_BOX_ORIENTATION="$mode" node \
            --import ./tests/js/register.mjs \
            --test tests/js/test_extension.mjs || FAILED=1
    done
else
    bold "JS: hoppas över (node saknas)"
    echo "  Installera node för att köra testerna för extension.js."
fi

bold "Syntaxkontroll"
python3 -m py_compile bin/claude-usage && echo "  ✓ bin/claude-usage"
python3 -m py_compile bin/claude-usage-update && echo "  ✓ bin/claude-usage-update"
python3 -c "import json; json.load(open('extension/metadata.json')); print('  ✓ extension/metadata.json')"
bash -n install.sh && echo "  ✓ install.sh"
bash -n tools/diagnose.sh && echo "  ✓ tools/diagnose.sh"

# Ett trasigt schema gör att inställningsdialogen inte öppnas alls, och det
# märks inte förrän någon klickar. --strict fångar det här i stället.
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas --strict --dry-run extension/schemas \
        && echo "  ✓ extension/schemas" || FAILED=1
else
    echo "  – extension/schemas (glib-compile-schemas saknas)"
fi

# gjs finns på varje GNOME-maskin och är samma motor som Shell kör, så det är
# en bättre syntaxkontroll av tilläggsfilerna än node.
if command -v gjs >/dev/null 2>&1; then
    for file in extension/extension.js extension/prefs.js; do
        # Importerna går inte att lösa utanför Shell; allt annat än ett
        # ImportError betyder att filen inte ens går att tolka.
        output="$(gjs -m "$file" 2>&1 || true)"
        if printf '%s' "$output" | grep -q "SyntaxError"; then
            printf '  \033[31m✗\033[0m %s\n%s\n' "$file" "$output"
            FAILED=1
        else
            echo "  ✓ $file"
        fi
    done
fi

if [ "$FAILED" -ne 0 ]; then
    printf '\n\033[31mTester misslyckades\033[0m\n'
    exit 1
fi
printf '\n\033[32mAllt grönt\033[0m\n'
