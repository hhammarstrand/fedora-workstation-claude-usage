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
python3 -c "import json; json.load(open('extension/metadata.json')); print('  ✓ extension/metadata.json')"
bash -n install.sh && echo "  ✓ install.sh"

if [ "$FAILED" -ne 0 ]; then
    printf '\n\033[31mTester misslyckades\033[0m\n'
    exit 1
fi
printf '\n\033[32mAllt grönt\033[0m\n'
