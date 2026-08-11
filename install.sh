#!/usr/bin/env bash
# Installerar claude-usage (skriptet) och Claude Usage (GNOME-tillägget).
#
# Kollar gnome-shell-versionen FÖRST och ser till att den står i
# metadata.json — en version som inte listas gör att tillägget tyst
# inte laddas alls.

set -euo pipefail

UUID="claude-usage@hhammarstrand.github.io"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. version

bold "1. Kontrollerar GNOME Shell"

command -v gnome-shell >/dev/null 2>&1 \
    || die "gnome-shell hittades inte. Kör detta på din Fedora Workstation-maskin."

VERSION_LINE="$(gnome-shell --version 2>/dev/null || true)"
MAJOR="$(printf '%s' "$VERSION_LINE" | grep -oE '[0-9]+' | head -1 || true)"

[ -n "$MAJOR" ] || die "Kunde inte tolka '$VERSION_LINE'."
info "$VERSION_LINE (major $MAJOR)"

if [ "$MAJOR" -lt 45 ]; then
    die "Tillägget kräver GNOME Shell 45 eller senare (ESM-tillägg). Du har $MAJOR."
fi
ok "Versionen stöds"

command -v python3 >/dev/null 2>&1 || die "python3 hittades inte."

# ---------------------------------------------------------------- 2. skriptet

bold "2. Installerar ~/.local/bin/claude-usage"

install -d -m 755 "$BIN_DIR"
install -m 755 "$SRC_DIR/bin/claude-usage" "$BIN_DIR/claude-usage"
ok "$BIN_DIR/claude-usage"

case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) warn "$BIN_DIR ligger inte i PATH. Tillägget bryr sig inte (det använder"
       warn "absolut sökväg), men lägg till det för att köra claude-usage i skalet." ;;
esac

# --------------------------------------------------------------- 3. tillägget

bold "3. Installerar tillägget"

install -d -m 755 "$EXT_DIR"
install -m 644 "$SRC_DIR/extension/extension.js"   "$EXT_DIR/extension.js"
install -m 644 "$SRC_DIR/extension/stylesheet.css" "$EXT_DIR/stylesheet.css"
install -m 644 "$SRC_DIR/extension/metadata.json"  "$EXT_DIR/metadata.json"
ok "$EXT_DIR"

# Se till att den körande versionen står i shell-version, annars laddas
# tillägget tyst inte alls.
PATCHED="$(python3 - "$EXT_DIR/metadata.json" "$MAJOR" <<'PY'
import json, sys

path, major = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

versions = [str(v) for v in (data.get("shell-version") or [])]
if major in versions:
    print("redan")
else:
    versions.append(major)
    versions.sort(key=lambda v: [int(p) for p in v.split(".") if p.isdigit()] or [0])
    data["shell-version"] = versions
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print("tillagd")
PY
)"

if [ "$PATCHED" = "tillagd" ]; then
    ok "shell-version utökad med \"$MAJOR\" i den installerade metadata.json"
else
    ok "shell-version innehåller redan \"$MAJOR\""
fi

# --------------------------------------------------------------- 4. aktivering

bold "4. Aktiverar"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    ok "gnome-extensions enable $UUID"
else
    # Shell känner inte till tillägget förrän det startat om, så skriv nyckeln
    # direkt i stället. Nästa inloggning aktiverar det.
    CURRENT="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "@as []")"
    if printf '%s' "$CURRENT" | grep -qF "$UUID"; then
        ok "Redan aktiverat i inställningarna"
    else
        NEW="$(python3 - "$CURRENT" "$UUID" <<'PY'
import ast, sys

current, uuid = sys.argv[1], sys.argv[2]
current = current.strip()
if current.startswith("@as "):          # tom lista skrivs som "@as []"
    current = current[4:].strip()
try:
    items = list(ast.literal_eval(current))
except (ValueError, SyntaxError):
    items = []
if uuid not in items:
    items.append(uuid)
print("[" + ", ".join("'%s'" % item for item in items) + "]")
PY
)"
        gsettings set org.gnome.shell enabled-extensions "$NEW"
        ok "Aktiverat via gsettings (Shell kände inte till tillägget än)"
    fi
fi

# ------------------------------------------------------------- 5. rökprovning

bold "5. Provkör skriptet"

set +e
OUTPUT="$("$BIN_DIR/claude-usage" --text 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$OUTPUT" | sed 's/^/  │ /'
if [ $STATUS -eq 0 ]; then
    ok "claude-usage svarade"
else
    warn "claude-usage kunde inte hämta data (se ovan). Tillägget visar felet i"
    warn "popupen och fungerar så snart orsaken är åtgärdad."
fi

# ----------------------------------------------------------------- 6. nästa steg

bold "6. Sista steget"
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    info "Du kör Wayland, som inte kan ladda om GNOME Shell live."
    info "Logga ut och in igen för att få upp tillägget i panelen."
else
    info "Logga ut och in igen för att få upp tillägget i panelen."
    info "(På X11 räcker Alt+F2, 'r', Enter — men logga ut om du är osäker.)"
fi
echo
info "Felsökning:  journalctl -f -o cat /usr/bin/gnome-shell"
info "Rå JSON:     claude-usage --raw"
