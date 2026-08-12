#!/usr/bin/env bash
# Samlar allt som behövs för att förstå varför tillägget inte syns i panelen.
#
#   ./tools/diagnose.sh
#
# Skriver ingen hemlig information: credentials-filen kontrolleras bara för
# existens och ändringstid, aldrig innehåll, och claude-usage skriver aldrig
# ut någon token.
#
# Avsiktligt utan `set -e` — varje kontroll ska köras även om en tidigare
# misslyckas, annars tappar vi just den information vi är här för att hämta.

UUID="claude-usage@hhammarstrand.github.io"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCRIPT="${HOME}/.local/bin/claude-usage"

section() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()     { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn()    { printf '  \033[33m!\033[0m %s\n' "$*"; }
info()    { printf '    %s\n' "$*"; }

PROBLEMS=0
problem() { bad "$*"; PROBLEMS=$((PROBLEMS + 1)); }

#: Sätts när allt är rätt installerat men sessionen är äldre än installationen.
#: Det är inte ett problem, bara ett steg som återstår.
PENDING_LOGOUT=0

printf '\033[1mClaude Usage — diagnos\033[0m\n'
printf 'Klistra in hela utskriften.\n'

# ---------------------------------------------------------------- 1. session

section "1. GNOME"

if command -v gnome-shell >/dev/null 2>&1; then
    VERSION_LINE="$(gnome-shell --version 2>&1)"
    MAJOR="$(printf '%s' "$VERSION_LINE" | grep -oE '[0-9]+' | head -1)"
    ok "$VERSION_LINE  (major $MAJOR)"
    if [ -n "$MAJOR" ] && [ "$MAJOR" -lt 45 ] 2>/dev/null; then
        problem "GNOME $MAJOR är för gammalt — tillägget kräver 45+ (ESM)."
    fi
else
    problem "gnome-shell finns inte i PATH. Kör detta på Fedora-maskinen."
    MAJOR=""
fi

info "Sessionstyp: ${XDG_SESSION_TYPE:-okänd}"
info "Skrivbord:   ${XDG_CURRENT_DESKTOP:-okänt}"

# Hur länge har den nuvarande gnome-shell-processen levt? Kortare tid än
# installationen betyder att utloggningen faktiskt skedde.
SHELL_PID="$(pgrep -u "$(id -u)" -x gnome-shell 2>/dev/null | head -1)"
SHELL_START_EPOCH=""
if [ -n "$SHELL_PID" ]; then
    STARTED="$(ps -o lstart= -p "$SHELL_PID" 2>/dev/null | sed 's/^ *//')"
    info "gnome-shell (pid $SHELL_PID) startad: ${STARTED:-okänt}"
    # etimes (sekunder sedan start) är locale-oberoende, till skillnad från
    # lstart — och det är den vi räknar på i avsnitt 5.
    ELAPSED="$(ps -o etimes= -p "$SHELL_PID" 2>/dev/null | tr -d ' ')"
    case "$ELAPSED" in
        ''|*[!0-9]*) ;;
        *) SHELL_START_EPOCH=$(( $(date +%s) - ELAPSED )) ;;
    esac
else
    warn "Hittar ingen körande gnome-shell-process."
fi

# ------------------------------------------------------------------ 2. filer

section "2. Filer på disk"

if [ -x "$SCRIPT" ]; then
    ok "$SCRIPT ($(stat -c '%A' "$SCRIPT" 2>/dev/null))"
else
    [ -e "$SCRIPT" ] \
        && problem "$SCRIPT finns men är inte körbar" \
        || problem "$SCRIPT saknas — har install.sh körts?"
fi

if [ -d "$EXT_DIR" ]; then
    ok "$EXT_DIR"
    for file in metadata.json extension.js stylesheet.css; do
        [ -f "$EXT_DIR/$file" ] \
            && info "  $file  $(stat -c '%s bytes, %A' "$EXT_DIR/$file" 2>/dev/null)" \
            || problem "  $file SAKNAS"
    done
else
    problem "$EXT_DIR saknas — tillägget är inte installerat."
fi

# Katalognamnet MÅSTE vara exakt UUID:t, annars laddas inget.
if [ -d "$EXT_DIR" ] && [ -f "$EXT_DIR/metadata.json" ]; then
    META_UUID="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1]))['uuid'])
except Exception as e: print('LÄSFEL: %s' % e)
" "$EXT_DIR/metadata.json" 2>/dev/null)"
    if [ "$META_UUID" = "$UUID" ]; then
        ok "uuid i metadata.json matchar katalognamnet"
    else
        problem "uuid i metadata.json ('$META_UUID') matchar INTE katalognamnet"
    fi
fi

# -------------------------------------------------------------- 3. metadata

section "3. shell-version i installerad metadata.json"

if [ -f "$EXT_DIR/metadata.json" ]; then
    cat "$EXT_DIR/metadata.json"
    if [ -n "$MAJOR" ]; then
        python3 - "$EXT_DIR/metadata.json" "$MAJOR" <<'PY'
import json, sys
path, major = sys.argv[1], sys.argv[2]
try:
    versions = [str(v) for v in json.load(open(path)).get("shell-version") or []]
except Exception as exc:
    print("  \033[31m✗\033[0m Kunde inte läsa metadata.json: %s" % exc)
    sys.exit(0)
if major in versions:
    print("  \033[32m✓\033[0m Din version (%s) står i shell-version" % major)
else:
    print("  \033[31m✗\033[0m Din version (%s) SAKNAS i shell-version %s" % (major, versions))
    print("      Det gör att tillägget tyst inte laddas alls. Kör ./install.sh igen.")
PY
    fi
else
    problem "Ingen metadata.json att läsa."
fi

# ------------------------------------------------------------ 4. inställningar

section "4. GNOME-inställningar (dconf)"

if ! command -v gsettings >/dev/null 2>&1; then
    warn "gsettings saknas — kan inte läsa inställningarna."
elif ! DISABLE_ALL="$(gsettings get org.gnome.shell disable-user-extensions 2>&1)" \
     || [ -z "$DISABLE_ALL" ]; then
    # Utan schemat går ingen av kontrollerna att lita på — säg det i stället
    # för att rapportera falskt godkänt.
    warn "Kan inte läsa schemat org.gnome.shell — hoppar över dconf-kontrollerna."
    info "${DISABLE_ALL:-tomt svar från gsettings}"
else
    if [ "$DISABLE_ALL" = "true" ]; then
        problem "disable-user-extensions = true"
        info "ALLA användartillägg är avstängda, oavsett enabled-extensions."
        info "Slå på igen med:"
        info "  gsettings set org.gnome.shell disable-user-extensions false"
    else
        ok "disable-user-extensions = $DISABLE_ALL"
    fi

    ENABLED="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null)"
    if printf '%s' "$ENABLED" | grep -qF "$UUID"; then
        ok "$UUID står i enabled-extensions"
    else
        problem "$UUID står INTE i enabled-extensions"
        info "Aktivera med:  gnome-extensions enable $UUID"
    fi
    info "enabled-extensions = $ENABLED"
fi

# ------------------------------------------------------ 5. Shells egen syn

section "5. Vad GNOME Shell själv säger"

if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions list --user 2>/dev/null | grep -qF "$UUID"; then
        ok "Shell känner till tillägget"
    elif [ -n "$SHELL_START_EPOCH" ] && [ -f "$EXT_DIR/extension.js" ] \
         && [ "$(stat -c %Y "$EXT_DIR/extension.js" 2>/dev/null || echo 0)" \
              -gt "$SHELL_START_EPOCH" ]; then
        # Inte ett fel: GNOME Shell skannar tilläggskatalogen bara vid uppstart,
        # och den här sessionen startade före installationen. Att rapportera det
        # som ett problem skickar folk på jakt efter en bugg som inte finns.
        PENDING_LOGOUT=1
        warn "Shell känner inte till tillägget än — väntar på utloggning"
        info "Tillägget installerades EFTER att den här sessionen startade."
        info "GNOME Shell läser tilläggskatalogen bara när den startar, så det"
        info "syns först vid nästa inloggning. Inget är fel — logga ut:"
        info "  gnome-session-quit --logout"
    else
        problem "Shell känner INTE till tillägget"
        info "Sessionen startade efter installationen, så en utloggning till"
        info "hjälper inte. Kolla katalognamn/uuid i avsnitt 2 och fel i 6."
    fi
    echo
    gnome-extensions info "$UUID" 2>&1 | sed 's/^/    /'
    echo
    info "State ovan är nyckeln: ENABLED = laddat och aktivt."
    info "ERROR = undantag vid laddning (se avsnitt 6)."
    info "OUT_OF_DATE = shell-version stämmer inte (se avsnitt 3)."
    info "INITIALIZED/DISABLED = känt men inte aktivt."
else
    warn "gnome-extensions saknas."
fi

# ------------------------------------------------------------- 6. journalen

section "6. Fel i journalen"

if command -v journalctl >/dev/null 2>&1; then
    LOGS="$(journalctl --user -b --no-pager -o cat 2>/dev/null \
            | grep -iE "claude-usage|Claude Usage|${UUID}" | tail -40)"
    if [ -n "$LOGS" ]; then
        printf '%s\n' "$LOGS" | sed 's/^/    /'
    else
        info "Inga rader som nämner tillägget denna uppstart."
    fi

    echo
    info "Generella tilläggsfel denna uppstart:"
    EXT_LOGS="$(journalctl --user -b --no-pager -o cat 2>/dev/null \
                | grep -iE "extension.*(error|fail|exception)|Unhandled promise|JS ERROR" \
                | tail -25)"
    if [ -n "$EXT_LOGS" ]; then
        printf '%s\n' "$EXT_LOGS" | sed 's/^/    /'
    else
        info "  (inga)"
    fi
else
    warn "journalctl saknas."
fi

# ------------------------------------------------------------- 7. skriptet

section "7. Fungerar skriptet självt?"

if [ -f "${HOME}/.claude/.credentials.json" ]; then
    # Bara existens och tid — aldrig innehållet.
    ok "~/.claude/.credentials.json finns (ändrad $(stat -c '%y' "${HOME}/.claude/.credentials.json" 2>/dev/null | cut -d. -f1))"
else
    warn "~/.claude/.credentials.json saknas — logga in med Claude Code."
    info "Tillägget ska ändå SYNAS i panelen, med '!' och ett felmeddelande."
fi

if [ -x "$SCRIPT" ]; then
    echo
    # PIPESTATUS, inte $? — annars rapporteras sed:s exitkod.
    "$SCRIPT" --text 2>&1 | sed 's/^/    /'
    info "(exitkod ${PIPESTATUS[0]})"
else
    info "Hoppar över — skriptet är inte körbart."
fi

# -------------------------------------------------------------- 8. slutsats

section "8. Sammanfattning"

if [ "$PROBLEMS" -eq 0 ] && [ "$PENDING_LOGOUT" -eq 1 ]; then
    ok "Inget är fel — installationen är komplett."
    warn "Ett steg återstår: logga ut och in igen."
    info "  gnome-session-quit --logout"
    info "Den körande GNOME Shell startade före installationen och skannar"
    info "tilläggskatalogen bara vid uppstart. Kör inte install.sh igen — det"
    info "ändrar inget; bara en ny session laddar tillägget."
elif [ "$PROBLEMS" -eq 0 ]; then
    ok "Inga uppenbara fel hittade."
    info "Om panelen ändå är tom: kolla State i avsnitt 5 och journalen i 6."
else
    bad "$PROBLEMS problem hittade — se ✗ ovan."
    [ "$PENDING_LOGOUT" -eq 1 ] && info "Dessutom återstår en utloggning (avsnitt 5)."
fi
echo
