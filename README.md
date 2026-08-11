# Claude Usage för GNOME Shell

Visar din Claude-prenumerations användningsgränser i GNOME:s toppanel — samma
siffror som Usage-vyn i Claude-appen: sessionsgränsen (5 h), veckogränsen för
alla modeller, eventuella modellspecifika veckogränser, och credits.

Panelknappen visar den högsta aktuella procenten och en färgprick (blå under
70 %, gul från 70 %, röd från 90 %). Popupen ger en rad per gräns med etikett,
procent, en stapel och nedräkning till nästa återställning. Credits ligger sist.

> [!WARNING]
> **Datakällan är odokumenterad.** Siffrorna hämtas från
> `GET https://claude.ai/api/oauth/usage`, den endpoint som
> `claude.ai/settings/usage` och Claude Code använder internt. Den är inte en
> publik, stödd eller versionerad del av något API. Den kan ändra form, byta
> fältnamn eller **sluta fungera helt utan förvarning**, och det finns ingen
> garanti för att den fortsätter finnas. Tillägget är byggt för att degradera
> snyggt när det händer — okända nycklar renderas ändå, och fel visas i popupen
> i stället för att tömma panelen — men räkna med att det en dag bara slutar
> visa siffror.

## Två delar

| Del | Roll |
| --- | --- |
| `~/.local/bin/claude-usage` | Python 3, endast stdlib. Läser token, hämtar, normaliserar, cachar. |
| GNOME-tillägget | Kör skriptet via `Gio.Subprocess`, parsar `--json`, ritar panelen. |

Uppdelningen finns för att slippa tokenhantering i GJS. Tillägget ser aldrig
någon token — bara normaliserad JSON.

## Krav

- Fedora Workstation med **GNOME Shell 45 eller senare** (tillägget använder
  ESM, som infördes i 45)
- `python3` (finns i Fedora Workstation)
- Claude Code inloggat, så att `~/.claude/.credentials.json` finns

Inga andra beroenden — inga pip-paket, inga npm-paket, inget utanför
Python-stdlib och GNOME:s egna bibliotek.

## Installation

```bash
git clone https://github.com/hhammarstrand/fedora-workstation-claude-usage.git
cd fedora-workstation-claude-usage
./install.sh
```

`install.sh` kontrollerar `gnome-shell --version` **först** och lägger in din
major-version i den installerade `metadata.json` om den inte redan står där —
en Shell-version som inte listas gör att tillägget tyst inte laddas alls. Sedan
kopieras filerna, tillägget aktiveras, och skriptet provkörs.

**Logga sedan ut och in igen.** Wayland kan inte ladda om GNOME Shell live, så
`Alt+F2` → `r` finns inte som genväg där. Utloggning är det som gäller.

<details>
<summary>Manuellt, om du inte vill köra skriptet</summary>

```bash
UUID=claude-usage@hhammarstrand.github.io

gnome-shell --version                     # kolla att major >= 45

install -Dm755 bin/claude-usage ~/.local/bin/claude-usage
mkdir -p ~/.local/share/gnome-shell/extensions/$UUID
cp extension/{extension.js,stylesheet.css,metadata.json} \
   ~/.local/share/gnome-shell/extensions/$UUID/

# Lägg till din version i shell-version om den saknas:
$EDITOR ~/.local/share/gnome-shell/extensions/$UUID/metadata.json

gnome-extensions enable $UUID
# logga ut och in igen
```
</details>

## Discovery: kolla den råa JSON:en först

Eftersom formen på svaret varierar mellan planer och över tid är parsern helt
generisk — den itererar över alla toppnycklar vars värde har ett
`utilization`-fält och renderar dem, oavsett om nyckeln är känd. Men det är
värt att se vad *ditt* konto faktiskt får tillbaka:

```bash
claude-usage --raw
```

Det skriver serverns svar ordagrant till stdout (metadata går till stderr, så
`claude-usage --raw | jq` fungerar). Jämför gärna nycklarna med etiketterna i
`KNOWN_LABELS` i `bin/claude-usage`.

Nycklar som inte står i `KNOWN_LABELS` **tappas inte bort** — de får ett
autogenererat namn och märks med `*` i popupen:

| Nyckel | Etikett |
| --- | --- |
| `five_hour` | Session (5 h) |
| `seven_day` | Vecka – alla modeller |
| `seven_day_opus` | Vecka – Opus |
| `seven_day_sonnet` | Vecka – Sonnet |
| `seven_day_cowork` | Vecka – Cowork |
| `extra_usage` | Credits (renderas sist) |
| `thirty_day_something` | `30 dagar – Something` *(autogenererad)* |
| `helt_okänd_nyckel` | `Helt okänd nyckel` *(autogenererad)* |

Vill du byta en etikett räcker det att redigera `KNOWN_LABELS` i
`bin/claude-usage` — etiketterna finns bara på ett ställe, och tillägget renderar
den `label` skriptet skickar.

## Kommandoradsanvändning

```bash
claude-usage              # läsbar text (samma som --text)
claude-usage --json       # normaliserad JSON, det tillägget läser
claude-usage --raw        # serverns svar ordagrant
claude-usage --force      # gå förbi cachen
```

```
$ claude-usage --text
Claude usage · uppdaterad 12 s sedan
  Session (5 h)            42 %  ████████░░░░░░░░░░░░  återställs om 2 h 13 min
  Vecka – alla modeller    67 %  █████████████░░░░░░░  återställs om 3 d 11 h
  Vecka – Cowork            0 %  ░░░░░░░░░░░░░░░░░░░░  återställs om 3 d 11 h
  Vecka – Opus           93.5 %  ███████████████████░  återställs om 3 d 11 h
  Credits                Used credits: 1.5 · Credit limit: 25 · Enabled: ja
  Endpointen är odokumenterad och kan ändras utan förvarning.
```

Exitkod är `0` när det finns siffror att visa (även cachade) och `1` när det
inte finns någon data alls. `--json` skriver alltid giltig JSON, även vid fel,
så tillägget alltid har något att tolka.

## Token, cache och rate limiting

- Token läses från `~/.claude/.credentials.json`
  (`claudeAiOauth.accessToken`). **Filen läses bara, aldrig skrivs** — Claude
  Code sköter förnyelsen själv.
- Token skrivs aldrig ut, inte i loggar och inte i felmeddelanden. Alla
  felsträngar går genom en scrubber, och svarskroppar loggas aldrig — bara
  HTTP-status och innehållstyp.
- Cachen ligger i `$XDG_RUNTIME_DIR/claude-usage/usage.json` med `chmod 600`
  (katalogen `700`), skriven atomiskt. Saknas `XDG_RUNTIME_DIR` används en
  uid-specifik katalog under `TMPDIR`.
- Minst **60 sekunder** mellan riktiga nätverksanrop vid automatisk pollning.
  "Uppdatera nu" går förbi den gränsen men har ett golv på 15 sekunder, så att
  knappen inte kan hamra endpointen.
- Vid **429, nätverksfel eller serverfel serveras cachad data** med en
  `stale`-flagga i stället för ett tomt fel. Panelen dimmas, popupen säger
  varför, och nedräkningarna tickar vidare lokalt.
- Efter ett misslyckat anrop väntar skriptet 30 sekunder innan nästa försök.

## Felsökning

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

**Tillägget syns inte i panelen.** Nästan alltid en versionsmiss: kolla att
`gnome-shell --version` finns i `shell-version` i
`~/.local/share/gnome-shell/extensions/claude-usage@hhammarstrand.github.io/metadata.json`.
Kolla också att det är aktiverat:

```bash
gnome-extensions info claude-usage@hhammarstrand.github.io
```

**Panelen visar `!`.** Öppna popupen — där står orsaken. Vanliga fall:

| Popupen säger | Vad som hänt |
| --- | --- |
| `Hittade inte ~/.claude/.credentials.json` | Claude Code är inte inloggat |
| `Token avvisades (401)` | Kör ett Claude Code-kommando så förnyas token |
| `Rate limitad av servern (429)` | Övergående; cachade siffror visas |
| `Blockerad före API:et (403, HTML-svar)` | Bot-skydd framför API:et, inte din token — se nedan |
| `Kan inte köra …/claude-usage` | Skriptet är inte installerat eller inte körbart |

**403 med HTML-svar.** Då är det ett CDN-skydd som svarar, inte API:et. Prova en
annan User-Agent:

```bash
CLAUDE_USAGE_USER_AGENT="Mozilla/5.0" claude-usage --force --raw
```

Sätt den permanent i tillägget genom att exportera variabeln i din
sessionsmiljö, eller ändra `USER_AGENT` i `bin/claude-usage`.

## Tester

```bash
./tests/run.sh
```

Python-testerna (44 st) kör CLI:t som en riktig subprocess mot en lokal
stubbserver och täcker generisk parsning av okända nycklar, cache-rättigheter
och TTL, samt att 429, nätverksfel, HTML-svar, utgången token och saknad
credentials-fil alla ger cachad data eller ett läsbart fel — och att token
aldrig läcker i något utdataläge.

JS-testerna (34 st) kör `extension.js` mot stubbade GNOME-bibliotek och
verifierar panel, staplar, nedräkningar, felläge och att `disable()` städar
timers och signalhandlers. De körs två gånger: en gång med `St.BoxLayout`
som har `orientation` (GNOME 48+) och en gång med `vertical` (GNOME 45–47).

JS-testerna kräver `node`. Det är enbart ett utvecklingsberoende — tillägget
självt använder bara GNOME:s bibliotek, och `tests/run.sh` hoppar över dem om
`node` saknas.

## Avinstallation

```bash
gnome-extensions disable claude-usage@hhammarstrand.github.io
rm -rf ~/.local/share/gnome-shell/extensions/claude-usage@hhammarstrand.github.io
rm -f ~/.local/bin/claude-usage
rm -rf "$XDG_RUNTIME_DIR/claude-usage"
```

Logga ut och in igen. `~/.claude/.credentials.json` rörs inte.
