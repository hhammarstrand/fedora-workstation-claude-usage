# Claude Usage för GNOME Shell

Visar din Claude-prenumerations användningsgränser i GNOME:s toppanel — samma
siffror som Usage-vyn i Claude-appen: sessionsgränsen (5 h), veckogränsen för
alla modeller, eventuella modellspecifika veckogränser, och credits.

Indikatorn sitter i panelens mittbox, **direkt till höger om klockan**. Den visar
sessionsgränsens procent, en nedräkning till nästa återställning och en färgprick
(blå under 70 %, gul från 70 %, röd från 90 %):

```
 ● 42 % · 2h 5m
```

Vill du hellre se den högsta av alla gränser går det att byta i
[inställningarna](#inställningar) — liksom nedräkningen, placeringen och
hämtningsintervallet. Popupen ger alltid en rad per gräns med etikett, procent,
en stapel och nedräkning. Credits ligger sist.

```
┌─────────────────────────────────────┐
│ Uppdaterad 12 s sedan               │
│ ─────────────────────────────────── │
│ Session (5 h)                 42 %  │
│ ████████░░░░░░░░░░░░                │
│ återställs om 2 h 13 min            │
│                                     │
│ Vecka – alla modeller         67 %  │
│ █████████████░░░░░░░                │
│ återställs om 3 d 11 h              │
│                                     │
│ Vecka – Opus                93.5 %  │
│ ███████████████████░                │
│ återställs om 3 d 11 h              │
│                                     │
│ Credits                       0 %   │
│ 0,00 / 85,00 EUR                    │
│ ─────────────────────────────────── │
│ ⟳  Uppdatera nu                     │
│ ⬇  Sök efter uppdateringar          │
│ ⚙  Inställningar                    │
└─────────────────────────────────────┘
```

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

## Innehåll

- [Så fungerar det](#så-fungerar-det)
- [Krav](#krav)
- [Installation](#installation)
- [Discovery: kolla den råa JSON:en först](#discovery-kolla-den-råa-jsonen-först)
- [Generisk parsning och etiketter](#generisk-parsning-och-etiketter)
- [Inställningar](#inställningar)
- [Uppdatera tillägget](#uppdatera-tillägget)
- [Kommandoradsanvändning](#kommandoradsanvändning)
- [JSON-kontraktet mellan delarna](#json-kontraktet-mellan-delarna)
- [Tider, cache och rate limiting](#tider-cache-och-rate-limiting)
- [Säkerhet: token och cache](#säkerhet-token-och-cache)
- [Beteende vid fel](#beteende-vid-fel)
- [Grafiken](#grafiken)
- [GNOME-versioner](#gnome-versioner)
- [Felsökning](#felsökning)
- [Kända begränsningar](#kända-begränsningar)
- [Utveckling och tester](#utveckling-och-tester)

## Så fungerar det

Två delar, för att ingen tokenhantering ska hamna i GJS. Tillägget ser aldrig
någon token — bara normaliserad JSON på stdout.

```mermaid
flowchart LR
    CRED["~/.claude/.credentials.json<br/>läses, aldrig skrivs"]
    SCRIPT["~/.local/bin/claude-usage<br/>Python 3, endast stdlib"]
    API["claude.ai/api/oauth/usage<br/>odokumenterad"]
    CACHE["$XDG_RUNTIME_DIR/claude-usage/usage.json<br/>chmod 600"]
    EXT["extension.js<br/>GNOME Shell 45+, ESM"]
    PANEL["Panel intill klockan<br/>+ popup"]

    CRED -->|"accessToken"| SCRIPT
    SCRIPT -->|"GET, Bearer + anthropic-beta"| API
    API -->|"rå JSON"| SCRIPT
    SCRIPT <-->|"rå JSON + tidsstämplar"| CACHE
    SCRIPT -->|"--json på stdout, via Gio.Subprocess"| EXT
    EXT --> PANEL
```

Ansvarsfördelningen:

| Del | Ansvar |
| --- | --- |
| `bin/claude-usage` | Läsa token, hämta, tolka svaret generiskt, cacha, rate limita, formatera etiketter, producera stabil JSON |
| `bin/claude-usage-update` | Fråga GitHub om nyare versioner, hämta och köra install.sh |
| `extension/extension.js` | Köra skripten, rita panel och popup, hålla timers, städa i `disable()` |
| `extension/prefs.js` | Inställningsdialogen. Skriver bara GSettings; tillägget reagerar. |

All tolkning och alla etiketter ligger i Python-delen. Tillägget renderar den
`label` skriptet skickar och gör inga egna antaganden om nycklarna — vilket
betyder att en ändrad endpoint bara kräver ändringar på ett ställe.

### Filerna i repot

```
bin/claude-usage            CLI:t. Hämtning, cache, normalisering, etiketter.
bin/claude-usage-update     Versionskoll och självuppdatering från GitHub.
extension/
  extension.js              Indikatorn. ESM för GNOME 45+.
  prefs.js                  Inställningsdialogen. libadwaita.
  metadata.json             UUID, namn, shell-version, settings-schema.
  schemas/                  GSettings-schemat. Kompileras av install.sh.
  stylesheet.css            Adwaita-anpassad stil.
install.sh                  Versionskoll, kopiering, aktivering, rökprovning.
tools/
  diagnose.sh               Samlar allt om varför tillägget inte syns.
tests/
  run.sh                    Kör allt.
  test_claude_usage.py      62 tester mot CLI:t via en lokal stubbserver.
  test_claude_usage_update.py  19 tester mot uppdateraren, mot en GitHub-stubb.
  js/
    test_extension.mjs      47 tester mot extension.js.
    stubs.mjs               Stubbar för St, GLib, Gio, Clutter, PopupMenu m.fl.
    loader.mjs              ESM-loader som mappar gi:// och resource:// till stubbarna.
    register.mjs            Registrerar loadern.
```

## Krav

- Fedora Workstation med **GNOME Shell 45 eller senare** (tillägget använder
  ESM, som infördes i 45)
- `python3` och `glib-compile-schemas` (finns båda i Fedora Workstation;
  det senare ingår i `glib2`)
- Claude Code inloggat, så att `~/.claude/.credentials.json` finns

Inga andra beroenden — inga pip-paket, inga npm-paket, inget utanför
Python-stdlib och GNOME:s egna bibliotek. `node` behövs bara för att köra
JS-testerna.

## Installation

```bash
git clone https://github.com/hhammarstrand/fedora-workstation-claude-usage.git
cd fedora-workstation-claude-usage
./install.sh
```

`install.sh` gör sex saker, i ordning:

1. Kontrollerar `gnome-shell --version` och avbryter om major < 45.
2. Kopierar skriptet till `~/.local/bin/claude-usage` (läge 755).
3. Kopierar tillägget (inklusive `prefs.js` och `schemas/`) till
   `~/.local/share/gnome-shell/extensions/claude-usage@hhammarstrand.github.io/`,
   kompilerar GSettings-schemat och stämplar vilken commit som installerades.
4. **Lägger in din major-version i den installerade `metadata.json`** om den inte
   redan står där. Detta är viktigt: en Shell-version som inte listas i
   `shell-version` gör att tillägget tyst inte laddas alls, utan felmeddelande.
5. Aktiverar tillägget med `gnome-extensions enable`, med `gsettings` som
   reserv (Shell känner inte till tillägget förrän det startat om).
6. Provkör `claude-usage --text`, visar resultatet, och säger till om den
   körande GNOME-sessionen startade före installationen — då återstår en
   utloggning.

Steg 5 kollar också `disable-user-extensions` och återställer den om den är
`true` — den nyckeln slår annars ut alla användartillägg oavsett allt annat.

**Logga sedan ut och in igen:**

```bash
gnome-session-quit --logout
```

Det här steget går inte att hoppa över vid en förstagångsinstallation. GNOME
Shell skannar tilläggskatalogen bara när Shell startar, så ett tillägg som lagts
dit under en pågående session finns helt enkelt inte för den sessionen — och att
köra `install.sh` igen ändrar ingenting. `install.sh` säger själv till om den
körande sessionen är äldre än installationen. På Wayland finns dessutom ingen
`Alt+F2` → `r`.

Syns fortfarande inget i panelen efter utloggningen, kör `./tools/diagnose.sh` —
se [Felsökning](#felsökning).

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

### Uppdatera

```bash
git pull
./install.sh
```

Skriptet är idempotent. Logga ut och in igen för att ladda den nya
`extension.js` — Wayland kan inte byta ut den i en körande session.

### Avinstallera

```bash
gnome-extensions disable claude-usage@hhammarstrand.github.io
rm -rf ~/.local/share/gnome-shell/extensions/claude-usage@hhammarstrand.github.io
rm -f ~/.local/bin/claude-usage ~/.local/bin/claude-usage-update
rm -rf "$XDG_RUNTIME_DIR/claude-usage"
dconf reset -f /org/gnome/shell/extensions/claude-usage/
```

Logga ut och in igen. `~/.claude/.credentials.json` rörs inte.

## Discovery: kolla den råa JSON:en först

Formen på svaret varierar mellan planer och över tid, så det är värt att se vad
*ditt* konto faktiskt får tillbaka:

```bash
claude-usage --raw
```

Rå JSON går till stdout, all metadata till stderr — så `claude-usage --raw | jq`
fungerar. Jämför nycklarna med `KNOWN_LABELS` i `bin/claude-usage`.

Publikt rapporterad form är ett toppobjekt där varje gräns är en nyckel med
`{utilization, resets_at}`, plus `extra_usage` för credits:

```json
{
  "five_hour":      { "utilization": 42,   "resets_at": "2026-08-11T22:00:00Z" },
  "seven_day":      { "utilization": 67,   "resets_at": "2026-08-15T09:30:00Z" },
  "seven_day_opus": { "utilization": 93.5, "resets_at": "2026-08-15T09:30:00Z" },
  "extra_usage":    { "used_credits": 1.5, "credit_limit": 25, "enabled": true }
}
```

Men **ingenting av det är hårdkodat** — se nästa avsnitt.

## Generisk parsning och etiketter

### Vad som blir vad

Parsern itererar över alla toppnycklar och klassar varje värde:

| Villkor | Resultat |
| --- | --- |
| Objekt med ett `utilization`-fält | **Gräns** — egen rad med stapel |
| Nyckeln är `extra_usage` eller innehåller `credit` | **Credits** — renderas sist |
| Lista med objekt som har `utilization` | **Gränser** — en rad per post |
| Gräns utan tolkbart tidsfönster | **Övrigt** — visas separat, räknas inte i panelen |
| Objekt utan `utilization` | **Ej tolkad** — listas i popupen med sitt värde |
| Skalärt värde | **Ej tolkad** — listas i popupen med sitt värde |
| Värdet är `null` | **Utan värde** — alla samlas på en enda rad |

Sista raden finns för att riktiga svar innehåller ett tiotal toppnycklar som
bara är `null` (`tangelo`, `amber_ladder`, `seven_day_opus` …). De betyder i
praktiken "gäller inte det här kontot". De tappas inte — de får `reason`
`utan värde` i JSON:en — men de renderas som en rad, inte tio.

Som `utilization` accepteras, i den ordningen: `utilization`, `utilisation`,
`utilization_percent`, `percent_used`, `percent`. Värdet får vara heltal,
decimaltal eller sträng (`"42"`, `"42%"`, `"42,5"`).

Hittas inga gränser på toppnivån letar parsern **ett** steg djupare, så att ett
svar som `{"usage": {"five_hour": …}}` också fungerar.

### Gränser som ligger i en lista

Riktiga svar lägger inte de modellspecifika veckogränserna som toppnycklar. Där
är `seven_day_opus` och liknande **skalärer** (oftast `null`), och de faktiska
gränserna ligger i en lista. Så här ser ett verkligt svar ut:

```json
{
  "five_hour":      { "utilization": 83, "resets_at": "…", "used_dollars": … },
  "seven_day":      { "utilization": 29, "resets_at": "…" },
  "seven_day_opus": null,
  "limits": [
    { "kind": "session",       "percent": 83, "scope": null,  "resets_at": "…" },
    { "kind": "weekly_all",    "percent": 29, "scope": null,  "resets_at": "…" },
    { "kind": "weekly_scoped", "percent": 55, "resets_at": "…",
      "scope": { "model": { "display_name": "Fable", "id": null } } }
  ]
}
```

Därför gås listor igenom också. Varje post som har ett `utilization`-fält (eller
`percent`) blir en gräns, och nyckeln hämtas från första strängfältet som kan
namnge posten: `kind`, `type`, `limit_type`, `key`, `name`, `id`, `window`,
`group`, `scope`, `period`. Saknas alla blir nyckeln `listnamn_index`, så posten
renderas ändå.

**Kodnamnen översätts till toppnivåns nycklar.** `kind` är listans eget namn på
tidsfönstret, inte samma som toppnyckeln:

| `kind` | Blir nyckeln |
| --- | --- |
| `session`, `five_hour` | `five_hour` |
| `weekly`, `weekly_all`, `weekly_scoped` | `seven_day` |
| `daily` | `one_day` |
| `monthly` | `thirty_day` |

Utan den översättningen blir posterna `limits_0`, `limits_1`, `limits_2`: två
rena dubbletter av `five_hour` och `seven_day`, och en riktig veckogräns som
tappar sitt tidsfönster, hamnar under "Övrigt" och inte räknas i panelen.

**Scope ger namnet.** En `weekly_scoped`-post är begränsad till en modell, och
namnet ligger nästlat. Parsern letar `display_name`, `name`, `label`, `title`,
`id` — först direkt i `scope`, sedan ett par nivåer ned. Träffen ger både
nyckelns suffix och etiketten: `scope.model.display_name = "Fable"` blir
nyckeln `seven_day_fable` och etiketten **Vecka – Fable**. Eftersom namnet kommer
från servern och inte från en gissning märks raden *inte* med `*`.

Två poster med samma `kind` men olika scope får därmed skilda nycklar och
krockar inte.

Ordningen är avsiktlig: **toppnycklar först, listor sedan.** En gräns ur listan
får komplettera en toppnyckel som bara var en skalär, utan att det blir
dubbletter — skalären försvinner då ur "ej tolkade nycklar". En lista som inte
innehåller några gränser rapporteras som `lista utan gränser` i stället för att
tigande försvinna.

### Gränser kontra "Övrigt"

Ett riktigt svar innehåller objekt med `utilization` vars nycklar är interna
kodnamn — `nimbus_quill`, `spend`, `tangelo` — som inte motsvarar något i
Claude-appens Usage-vy. De får inte tappas, men de hör inte heller bland dina
faktiska gränser, och framför allt ska de **inte driva panelens procentsiffra**:
en okänd nyckel på 99 % får inte färga panelen röd.

Skiljelinjen är nyckelns *form*, inte en lista med namn:

| | Hamnar i | Driver panelen |
| --- | --- | --- |
| Tolkbart tidsfönster (`five_hour`, `seven_day_opus`, `thirty_day_x`) | `limits` | Ja |
| Inget tidsfönster (`nimbus_quill`, `spend`, `limits_0`) | `extras` | Nej |

Eftersom kriteriet är formen hanteras nya kodnamn automatiskt. I popupen ligger
`extras` under en egen rubrik, *"Övrigt — ingen känd tidsgräns, räknas inte i
panelen"*, efter credits.

### Ordning

Rader sorteras efter fönsterlängd, kortast först, med generella gränser före
modellspecifika:

1. `five_hour` (5 h)
2. `seven_day` (7 d, generell)
3. `seven_day_cowork`, `seven_day_opus`, … (7 d, modellspecifika, alfabetiskt)
4. Nycklar utan tolkningsbart tidsfönster, alfabetiskt
5. Credits, alltid sist

### Etiketter

Nycklar som inte står i `KNOWN_LABELS` **tappas inte bort** — de får ett
autogenererat namn och märks med `*` i popupen:

| Nyckel | Etikett |
| --- | --- |
| `five_hour` | Session (5 h) |
| `seven_day` | Vecka – alla modeller |
| `seven_day_opus` | Vecka – Opus |
| `seven_day_sonnet` | Vecka – Sonnet |
| `seven_day_haiku` | Vecka – Haiku |
| `seven_day_cowork` | Vecka – Cowork |
| `seven_day_oauth_apps` | Vecka – OAuth-appar |
| `extra_usage` | Credits *(renderas sist)* |
| listpost med `scope.model.display_name` | `Vecka – Fable` *(namnet från servern)* |
| `thirty_day_fable` | `30 dagar – Fable` *(autogenererad)* |
| `helt_okänd_nyckel` | `Helt okänd nyckel` *(autogenererad)* |

Autogenereringen förstår talord (`one`…`ninety`) och enheter (`second`,
`minute`, `hour`, `day`, `week`, `month`) samt modellnamn som suffix. Går nyckeln
inte att tolka alls blir den `Understreck_ersätts_med_mellanslag` med versal
begynnelsebokstav — aldrig tom.

Vill du byta en etikett räcker det att redigera `KNOWN_LABELS` i
`bin/claude-usage`. Etiketterna finns bara på ett ställe.

### Tidsstämplar

`resets_at` tolkas i följande format, i den ordningen:

- ISO 8601 med `Z` eller offset (`2026-08-15T09:30:00Z`, `…+02:00`)
- ISO 8601 utan zon — tolkas då som UTC
- Nanosekundsprecision trimmas till mikrosekunder
- Epoch i sekunder (`1786485600`) eller millisekunder (`1786485600000`) —
  avgörs på storleken
- Samma värden som sträng

Fältnamnet behöver inte vara `resets_at`: `reset_at`, `resets`, `reset`,
`next_reset_at` och alla nycklar som innehåller `reset` prövas också. Går tiden
inte att tolka står det *"ingen känd återställningstid"* i stället för en
felaktig nedräkning.

## Inställningar

```bash
gnome-extensions prefs claude-usage@hhammarstrand.github.io
```

Eller från popupen: **Inställningar**. Även Extensions-appen och GNOME Tweaks
hittar dialogen.

| Inställning | Standard | Vad den gör |
| --- | --- | --- |
| Panelens siffra | Sessionsgränsen | `session` följer gränsen med kortast tidsfönster (5 h). `max` följer den högsta procenten oavsett fönster. |
| Nedräkning i panelen | På | Lägger `· 2h 5m` efter procenten. Popupen har alltid nedräkningen. |
| Del av panelen | Mitten | `left`, `center` eller `right`. Mitten lägger indikatorn intill klockan. |
| Plats inom den delen | 1 | 0 = före klockan, 1 = efter. |
| Hämta var | 60 s | 30–900 s. Skriptets cache-TTL är 60 s, så tätare hämtning ger inte färskare siffror. |
| Leta efter nya versioner | På | Frågar GitHub en gång per dygn. Installerar aldrig något själv. |

**Allt slår igenom direkt** — ingen utloggning behövs för att byta inställning.
Tillägget lyssnar på `changed::`-signalerna: siffra och nedräkning ritas om på
plats, och byter du panelplacering byggs indikatorn om (den sitter i en
panelbox och kan inte flyttas levande).

Värdena ligger i GSettings och går att sätta från terminalen också:

```bash
SCHEMA=org.gnome.shell.extensions.claude-usage
DIR=~/.local/share/gnome-shell/extensions/claude-usage@hhammarstrand.github.io/schemas
gsettings --schemadir "$DIR" set $SCHEMA panel-source max
gsettings --schemadir "$DIR" list-recursively $SCHEMA
```

Schemat kompileras av `install.sh` med `glib-compile-schemas` (ingår i `glib2`,
finns alltid på Fedora Workstation). Saknas det kompilerade schemat laddar
tillägget ändå — med standardvärdena — men dialogen går inte att öppna.

## Uppdatera tillägget

Popupen har **Sök efter uppdateringar**. Hittas en nyare version byts posten mot
**Installera version `abc1234`**; ingenting hämtas eller installeras förrän du
klickar. Är automatisk kontroll påslagen görs en tyst koll som mest en gång per
dygn, när du öppnar popupen.

Samma sak från terminalen:

```bash
claude-usage-update --check     # finns det något nyare?
claude-usage-update --apply     # hämta och installera
claude-usage-update --version   # vad är installerat?
```

Alla lägen skriver JSON på stdout, även vid fel — det är så tillägget läser dem.

**Så fungerar det.** `--check` frågar GitHubs API efter senaste commiten på
`main` och jämför med `.installed-commit`, en stämpel som `install.sh` skriver i
tilläggskatalogen. `--apply` hämtar `codeload.github.com/.../tar.gz/<sha>`,
packar upp den i en temporär katalog och kör **repots egen `install.sh`**
därifrån, med commiten i miljön så att stämpeln blir rätt.

Skyddsräcken, eftersom det här hämtar och kör kod:

- Bara HTTPS, och bara det repo som står i `REPO` i skriptet.
- Nedladdningen är hårt begränsad i storlek (20 MB) och tid (20 s).
- Arkivet packas upp med `filter='data'`, och varje post kontrolleras först:
  **symlänkar och hårda länkar vägras**, och en post vars mål hamnar utanför
  målkatalogen avbryter hela uppackningen.
- Saknas `install.sh` i arkivet körs ingenting.
- Utan en stämpel påstår `--check` **aldrig** att en uppdatering finns — den
  säger `unknown_installed` i stället för att gissa.

**Utloggning krävs ändå.** Uppdateringen lägger nya filer på disk, men GNOME
Shell laddar tillägg bara vid uppstart — så `logout_required` är alltid `true`
och popupen säger till. Skriptet i `~/.local/bin/claude-usage` byts däremot ut
direkt och används vid nästa hämtning.

Föredrar du git går det förstås fortfarande lika bra:

```bash
git pull && ./install.sh
```

## Kommandoradsanvändning

```bash
claude-usage              # läsbar text (samma som --text)
claude-usage --text       # läsbar text
claude-usage --json       # normaliserad JSON, det tillägget läser
claude-usage --raw        # serverns svar ordagrant
claude-usage --force      # gå förbi cachen (kombineras med ovanstående)
claude-usage --help
```

Utdatalägena är ömsesidigt uteslutande.

```
$ claude-usage --text
Claude usage · uppdaterad just nu
  Session (5 h)          85 %  █████████████████░░░  återställs om 24 min
  Vecka – alla modeller  29 %  ██████░░░░░░░░░░░░░░  återställs om 6 d 8 h
  Vecka – Fable          55 %  ███████████░░░░░░░░░  återställs om 6 d 8 h
  Credits                 0 %  ░░░░░░░░░░░░░░░░░░░░  0,00 / 85,00 EUR
    Disabled reason: out_of_credits · Is enabled: nej
  Övrigt (ingen känd tidsgräns — räknas inte i panelen):
    Nimbus quill *          0 %  ░░░░░░░░░░░░░░░░░░░░
    Spend *                 0 %  ░░░░░░░░░░░░░░░░░░░░
  * okänd nyckel — etiketten är autogenererad
  Utan värde: amber_ladder, cinder_cove, seven_day_opus, tangelo, …
  Endpointen är odokumenterad och kan ändras utan förvarning.
```

### Exitkoder

| Kod | Betyder |
| --- | --- |
| `0` | Det finns siffror att visa (färska eller cachade) |
| `1` | Ingen data alls, eller internt fel |
| `2` | Felaktiga argument (från `argparse`) |

`--json` skriver **alltid** giltig JSON, även vid fel, så tillägget alltid har
något att tolka. Vid fel går textutdata till stderr i stället för stdout.

### Miljövariabler

Alla är valfria. De tre första finns främst för test och felsökning.

| Variabel | Standard | Effekt |
| --- | --- | --- |
| `CLAUDE_USAGE_ENDPOINT` | `https://claude.ai/api/oauth/usage` | Annan URL att hämta från |
| `CLAUDE_USAGE_CREDENTIALS` | `~/.claude/.credentials.json` | Annan credentials-fil |
| `CLAUDE_USAGE_USER_AGENT` | `claude-usage/1.0` | Annan User-Agent, om ett CDN svarar 403 |
| `XDG_RUNTIME_DIR` | satt av systemd | Var cachen läggs |

## JSON-kontraktet mellan delarna

Det här är vad `--json` skriver, och därmed gränssnittet mellan Python-delen och
tillägget. `schema` räknas upp om formen bryts.

### Toppnivå

| Fält | Typ | Betydelse |
| --- | --- | --- |
| `schema` | int | Versionen på det här formatet, just nu `2` |
| `ok` | bool | Om det finns siffror att visa, färska eller cachade |
| `stale` | bool | Sant vid fel, eller om datan är äldre än 300 s |
| `source` | `"network"` \| `"cache"` | Om ett riktigt anrop gjordes och lyckades |
| `now` | float | Epoch när utdatan skapades |
| `fetched_at` | float \| null | Epoch när datan senast hämtades |
| `age_seconds` | int \| null | Datans ålder |
| `error` | objekt \| null | Se nedan |
| `limits` | lista | En post per tidsfönstrad gräns, sorterad |
| `extras` | lista | Samma form, för nycklar utan tidsfönster. Räknas inte i `max_percent`. |
| `credits` | objekt \| null | Credits-raden |
| `unrecognized` | lista | `{key, reason, value}` för nycklar som inte tolkades |
| `max_percent` | float \| null | Högsta procenten bland `limits` — **inte** `extras` |
| `max_severity` | sträng | `ok`, `warn`, `crit` eller `unknown` |
| `endpoint_documented` | bool | Alltid `false`. En påminnelse. |

### En post i `limits`

| Fält | Typ | Betydelse |
| --- | --- | --- |
| `key` | sträng | Nyckeln från servern, ordagrant |
| `label` | sträng | Etikett att visa. Aldrig tom. |
| `known` | bool | `false` = autogenererad etikett, visas med `*` |
| `percent` | float \| null | Utnyttjandet |
| `severity` | sträng | `ok` (< 70), `warn` (70–89), `crit` (≥ 90), `unknown` |
| `utilization_field` | sträng | Vilket fältnamn procenten kom ifrån |
| `window_seconds` | int \| null | Tolkad fönsterlängd, för sortering |
| `scope` | sträng \| null | Modellsuffix, t.ex. `opus` |
| `resets_at` | valfri | Serverns värde, ordagrant |
| `resets_at_epoch` | float \| null | Tolkad epoch |
| `resets_in_seconds` | float \| null | Sekunder kvar när utdatan skapades |

Tillägget räknar nedräkningen från `resets_at_epoch` lokalt, inte från
`resets_in_seconds` — så den tickar korrekt även på cachad data.

### `credits`

Samma fält som en gräns, plus två listor av `{key, label, value}`:

| Fält | Innehåll |
| --- | --- |
| `amount_summary` | Beloppsrad, t.ex. `"0,00 / 85,00 EUR"`, eller `null` |
| `fields` | **Alla** skalära fält, med belopp formaterade |
| `display_fields` | Den kurerade delmängden som visas — högst 4 |

Riktiga svar har ett dussin fält (`currency`, `decimal_places`,
`disabled_reason`, `credits_ever_enabled`, `spend_limit_reached` …). Alla på en
rad blir en oläslig vägg, så `display_fields` väljer i prioritetsordning:
`used_credits`, `monthly_limit`, `currency`, `disabled_reason`, `is_enabled`.
`utilization` utesluts medvetet — den visas redan som procent i egen kolumn, och
fält som redan står i `amount_summary` upprepas inte. Allt finns kvar i `fields`
och i `--raw`.

**Belopp.** Är `currency` och `decimal_places` båda satta tolkas penningfält som
minsta valutaenhet: `monthly_limit: 8500` med `decimal_places: 2` blir
`85,00 EUR`. Det är bekräftat mot ett riktigt konto. Saknas metadatan lämnas
talet orört — hellre ett rått tal än en omräkning med faktor 100 fel.

### `error.kind`

Stabila strängar, avsedda att jämföras mot i kod:

| `kind` | Orsak |
| --- | --- |
| `no_credentials` | Credentials-filen saknas eller får inte läsas |
| `bad_credentials` | Filen finns men är inte giltig JSON |
| `no_token` | Ingen `claudeAiOauth.accessToken` i filen |
| `unauthorized` | HTTP 401 — token avvisad |
| `forbidden` | HTTP 403 med JSON-svar |
| `blocked` | HTTP 403 med HTML-svar — bot-skydd före API:et |
| `rate_limited` | HTTP 429. `retry_after` sätts om servern skickade det. |
| `server_error` | HTTP 5xx |
| `http_error` | Annan oväntad status |
| `network_error` | Uppkoppling, DNS eller tidsgräns |
| `bad_response` | Svaret var inte JSON, eller inte ett objekt |
| `internal_error` | Bugg i skriptet |

## Tider, cache och rate limiting

| Vad | Värde | Var |
| --- | --- | --- |
| Cache-TTL vid automatisk pollning | 60 s | `CACHE_TTL` |
| Golv även med `--force` | 15 s | `FORCE_MIN_INTERVAL` |
| Väntetid efter ett misslyckat anrop | 30 s | `ERROR_BACKOFF` |
| Ålder då datan markeras cachad | 300 s | `STALE_AFTER` |
| Tidsgräns för HTTP-anropet | 10 s | `HTTP_TIMEOUT` |
| Tillägget hämtar nytt | var 60 s | `REFRESH_INTERVAL` |
| Tillägget räknar om nedräkningar | var 15 s | `CLOCK_INTERVAL` |
| Nödbroms om skriptet hänger | 20 s | `SUBPROCESS_TIMEOUT` |

Tillägget hämtar också när popupen öppnas, men respekterar cachen — så att öppna
och stänga menyn upprepade gånger inte genererar trafik. **"Uppdatera nu"** går
förbi TTL:en, men golvet på 15 s står kvar så att knappen inte kan hamra
endpointen.

Nettoresultatet: som mest ett nätverksanrop per minut vid normal drift, och som
mest ett per 15 s om du sitter och klickar.

## Säkerhet: token och cache

- Token läses från `~/.claude/.credentials.json`
  (`claudeAiOauth.accessToken`). **Filen läses bara, aldrig skrivs** — Claude
  Code sköter förnyelsen själv.
- Bara `accessToken` läses. `refreshToken` rörs inte.
- **Token skrivs aldrig ut** — inte i loggar, inte i felmeddelanden. Alla
  felsträngar går genom en scrubber som maskar både den kända token och allt som
  ser ut som en hemlighet (`Bearer …`, `sk-…`).
- **Svarskroppar loggas aldrig.** Vid fel rapporteras bara HTTP-status och
  innehållstyp, så att varken token eller kontodata kan läcka via ett
  felmeddelande.
- Cachen ligger i `$XDG_RUNTIME_DIR/claude-usage/usage.json` med `chmod 600`
  (katalogen `700`), skriven atomiskt via `os.replace`. Saknas
  `XDG_RUNTIME_DIR` används en uid-specifik katalog under `TMPDIR`.
- **Cachen innehåller ingen token** — bara serverns svar och tidsstämplar.
- Tillägget ser aldrig någon token. Det får bara normaliserad JSON på stdout.

Testerna kontrollerar det sista uttryckligen: token får inte förekomma i stdout
eller stderr i något utdataläge, i något felläge, eller i cache-filen — inte ens
när servern skickar tillbaka token i sitt eget svar.

## Beteende vid fel

Inget av dessa lägen tömmer panelen eller kraschar tillägget.

| Situation | Vad som händer |
| --- | --- |
| 429 med cache | Cachade siffror visas, dimmade. Popupen säger 429 och `Retry-After`. |
| 429 utan cache | Panelen visar `!`, popupen förklarar. |
| Nätverksfel eller 5xx | Som 429: cachad data om den finns. |
| HTML-svar (CDN-skydd) | `bad_response` eller `blocked`. Svarskroppen loggas inte. |
| Token utgången | Anropet görs ändå — servern är sanningen. 401 ger `unauthorized`. |
| Credentials saknas | `no_credentials` med hänvisning till Claude Code. |
| Trasig credentials-fil | `bad_credentials`. Inget nätverksanrop görs. |
| Skriptet saknas | Popupen visar sökvägen som inte gick att köra. "Uppdatera nu" finns kvar. |
| Skriptet ger ogiltig JSON | Felet visas; senaste kända siffror behålls. |
| Skriptet hänger | Avbryts efter 20 s. Panelen låser sig inte. |
| Trasig cache-fil | Ignoreras, hämtas om. |
| Svar utan gränser | *"Svaret innehöll inga gränser."* |
| Okänd nyckel | Renderas med autogenererad etikett och `*`. |
| Nyckel utan `utilization` | Listas som ej tolkad. Tappas inte. |
| Procent över 100 | Stapeln kapas vid 100 %, siffran visas ändå. |
| `resets_at` otolkbar | *"ingen känd återställningstid"*. |

Ett fel efter en lyckad hämtning behåller de senaste siffrorna och märker dem
som gamla — panelen går inte från `94 %` till `!` bara för att ett anrop
missades.

## Grafiken

Stilen följer Adwaita, så att det inte ser ut som ett påklistrat tillägg:

- **Typsnitt och textfärg ärvs från temat.** Ingen `font-size` på panelknappen,
  så siffran matchar klockan exakt, och ingen `color` på primärtext.
- **Sekundärtext dimmas med actor-opacitet**, inte med en hårdkodad grå färg.
  En fast grå ser fel ut i antingen ljust eller mörkt tema; opacitet fungerar i
  båda. (St läser dessutom inte `opacity` från stilmallen.)
- **Popup-raderna behåller GNOME:s egna `popup-menu-item`-mått.** Klasserna i
  `stylesheet.css` läggs till, de ersätter inget.
- **Färger ur GNOME/libadwaitas palett:** accentblå `#3584e4` (Fedora
  Workstations standardaccent), varning `#e5a50a`, fel `#e01b24`. Alla tre är
  läsbara mot både ljus och mörk popup-bakgrund.
- **Procentsiffran är aldrig färgad.** Severiteten bärs av stapeln och
  panelprickens färg — mer återhållsamt, och utan kontrastrisk mot en bakgrund
  vi inte känner.
- **Cachad data uttrycks med opacitet**, inte med en annan prickstil. St lägger
  `border` utanför `width`/`height`, så en ihålig prick skulle byta storlek varje
  gång datan blev gammal och panelen hade hoppat.
- **"Uppdatera nu" är en ikonpost** (`view-refresh-symbolic`), som GNOME:s egna
  menyval.
- **Inga procentuella bredder.** St räknar dem inte tillförlitligt, så
  staplarnas bredd sätts i px från `BAR_WIDTH` i `extension.js`.

Har du ändrat accentfärg i GNOME-inställningarna och vill att staplarna följer
den, lägg till `background-color: -st-accent-color;` som en extra rad efter
`#3584e4` i `stylesheet.css`. Fallbacket ligger först, så en Shell-version som
inte känner igen egenskapen behåller blått.

### Flytta indikatorn

Högst upp i `extension/extension.js`:

```js
const PANEL_BOX = 'center';   // 'left' | 'center' | 'right'
const PANEL_POSITION = 1;     // 0 = före klockan, 1 = efter
```

Eftersom mittboxen är centrerad i panelen flyttar klockan sig något åt vänster
när indikatorn läggs till — hela klustret fortsätter vara centrerat. Det är
GNOME:s normala beteende för mittboxen.

## GNOME-versioner

Tillägget är skrivet för GNOME Shell 45 till 50 och undviker medvetet API:er
som ändrats i intervallet:

- **ESM genomgående.** `import … from 'gi://…'` och
  `export default class … extends Extension`, inte den gamla `imports.*`-stilen.
  GNOME 45 var brytpunkten.
- **`St.BoxLayout` orientering.** GNOME 48 deprekerade `vertical` till förmån
  för `orientation`. Koden känner av vilken property som finns och sätter den —
  att sätta den deprekerade på en ny Shell loggar varningar, och den nya finns
  inte på gamla. Testerna körs mot båda varianterna.
- **Inga `Clutter.Color`/`Cogl.Color`.** Färger sätts bara via CSS-klasser, så
  typbytet i GNOME 47/48 spelar ingen roll.
- **Bara centrala `resource://`-moduler** (`main.js`, `panelMenu.js`,
  `popupMenu.js`, `extension.js`). Ett misslyckat import gör att tillägget tyst
  inte laddas, så perifera moduler undviks.

## Felsökning

### Börja här

```bash
./tools/diagnose.sh
```

Skriptet går igenom allt som kan göra att tillägget inte syns — GNOME-version,
filer på disk, `shell-version`, dconf-nycklarna, vad Shell själv säger om
tillägget, relevanta rader ur journalen, och en provkörning av CLI:t — och
sammanfattar med hur många problem det hittade. Det skriver ingen hemlig
information: credentials-filen kontrolleras bara för existens och ändringstid.

För att följa loggen live:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Tillägget syns inte i panelen

Fyra orsaker står för nästan alla fall. `diagnose.sh` skiljer dem åt, men
i korthet:

**1. Du har inte loggat ut och in igen.** Det här är den överlägset vanligaste
orsaken, och den enda som `install.sh` inte kan åtgärda åt dig.

GNOME Shell läser tilläggskatalogen **en enda gång, när Shell startar**
(`_loadExtensions()` i `extensionSystem.js`). Det finns ingen katalogbevakning:
enda vägen in i en körande session är nedladdning från extensions.gnome.org, som
inte gäller ett lokalt installerat tillägg. Ett tillägg som lagts på plats under
en pågående session existerar därför helt enkelt inte för Shell — oavsett hur
rätt filer, `shell-version` och dconf-nycklar är.

Praktiska följder:

- Att köra `./install.sh` igen ändrar ingenting. Det är inte fel på
  installationen; sessionen är bara äldre än den.
- `gnome-extensions enable` misslyckas med *"Tillägget … finns inte"* före
  första utloggningen. Det är väntat — `install.sh` skriver då dconf-nyckeln
  direkt i stället, så tillägget är aktiverat när nästa session startar.
- På Wayland finns ingen `Alt+F2` → `r`. Utloggning är det som gäller.

```bash
gnome-session-quit --logout
```

Kontrollera efteråt att Shell känner till tillägget:

```bash
gnome-extensions list --user | grep claude-usage
```

`tools/diagnose.sh` skiljer det här fallet från ett riktigt fel: den jämför
gnome-shell-processens starttid med installationens tidsstämpel och
rapporterar "väntar på utloggning" i stället för ett problem.

**2. Alla användartillägg är avstängda.** En enda dconf-nyckel slår ut allt,
oavsett vad `enabled-extensions` säger:

```bash
gsettings get org.gnome.shell disable-user-extensions   # ska vara false
gsettings set org.gnome.shell disable-user-extensions false
```

Nyckeln sätts av "Extensions"-appen och GNOME Tweaks. `install.sh` kollar och
återställer den numera, men har du kört en äldre version kan den stå kvar.

**3. Versionsmiss.** Står inte din major-version i `shell-version` laddas
tillägget tyst inte alls, utan felmeddelande:

```bash
gnome-shell --version
cat ~/.local/share/gnome-shell/extensions/claude-usage@hhammarstrand.github.io/metadata.json
./install.sh          # lägger in din version
```

**4. Undantag vid laddning.** Då är tillstånd `ERROR`:

```bash
gnome-extensions info claude-usage@hhammarstrand.github.io
```

`State` är nyckeln i den utskriften:

| State | Betyder |
| --- | --- |
| `ENABLED` | Laddat och aktivt — då är problemet något annat |
| `ERROR` | Undantag vid laddning; felet står i utskriften och i journalen |
| `OUT_OF_DATE` | `shell-version` stämmer inte — orsak 3 ovan |
| `INITIALIZED` / `DISABLED` | Känt men inte aktivt — orsak 1 eller 2 |

Kör alltid `claude-usage --text` i terminalen också. Fungerar det men panelen är
tom, ligger felet i tillägget och inte i datahämtningen — och tvärtom.

**Panelen visar `!`.** Öppna popupen — där står orsaken. Vanliga fall:

| Popupen säger | Vad som hänt |
| --- | --- |
| `Hittade inte ~/.claude/.credentials.json` | Claude Code är inte inloggat |
| `Token avvisades (401)` | Kör ett Claude Code-kommando så förnyas token |
| `Rate limitad av servern (429)` | Övergående; cachade siffror visas |
| `Blockerad före API:et (403, HTML-svar)` | Bot-skydd framför API:et, inte din token — se nedan |
| `Kan inte köra …/claude-usage` | Skriptet är inte installerat eller inte körbart |
| `Servern svarade med text/html` | Samma sak: ett CDN svarade, inte API:et |

Kör alltid `claude-usage --text` i terminalen först — det skiljer på "skriptet
fungerar inte" och "tillägget fungerar inte".

**Panelen visar `–`.** Skriptet svarade, men svaret innehöll inga gränser. Kör
`claude-usage --raw` och se vad som faktiskt kom tillbaka.

**Siffrorna är dimmade.** Datan är cachad — antingen äldre än 300 s eller så
misslyckades senaste hämtningen. Popupen säger vilket.

**403 med HTML-svar.** Då är det ett CDN-skydd som svarar, inte API:et. Prova en
annan User-Agent:

```bash
CLAUDE_USAGE_USER_AGENT="Mozilla/5.0" claude-usage --force --raw
```

Sätt den permanent genom att exportera variabeln i din sessionsmiljö, eller
ändra `USER_AGENT` i `bin/claude-usage`.

**Rensa cachen och börja om:**

```bash
rm -rf "$XDG_RUNTIME_DIR/claude-usage"
claude-usage --force --text
```

## Kända begränsningar

Ärligt redovisat, inklusive det som inte gått att verifiera:

- **Skalärerna på toppnivån är fortfarande otolkade.** Ett riktigt svar har
  `seven_day_cowork`, `tangelo`, `amber_ladder` med flera som nakna värden — i
  praktiken alltid `null`. Vad de betyder är okänt. De som är `null` samlas på
  raden "Utan värde"; de som har ett faktiskt värde listas under "Ej tolkade
  nycklar" med värdet. Ingen av dem renderas som gräns, eftersom en naken siffra
  inte går att skilja från en flagga.
- **Interna kodnamn hamnar under "Övrigt".** `nimbus_quill` och `spend` har
  `utilization` men inget tidsfönster. Vad de mäter är okänt, så de visas men
  räknas inte i panelen. (`nimbus_quill` har till och med `resets_at` och samma
  dollar-fält som `five_hour`, men kriteriet är nyckelns form — ett okänt
  kodnamn ska inte kunna färga panelen röd.)
- **Dollar-fälten används inte.** `five_hour` och `seven_day` innehåller
  `used_dollars`, `limit_dollars` och `remaining_dollars`. Bara `utilization`
  visas; beloppen finns i `--raw`.
- **Grafiken är inte sedd på en körande GNOME.** Mått och färger är valda utifrån
  Adwaitas palett och St:s begränsningar, inte utifrån en skärmdump. API-anropen
  är däremot avstämda mot källkoden i GNOME Shell 50 (`panelMenu.js` använder
  fortfarande `_init`, `addToStatusArea(role, indicator, position, box)` är
  oförändrad, och `St.BoxLayout` har kvar både `orientation` och `vertical`).
- **`-st-accent-color` är inte verifierad** och därför inte påslagen. Standardblå
  `#3584e4` är Fedora Workstations standardaccent, så stock-utseendet stämmer.
- **Endpointen är blockerad från datacenter-IP:n.** Cloudflare svarar `403` med
  HTML. Skriptet fungerar från en vanlig hemmauppkoppling, men inte från en
  server eller container.
- **Inte allt går att ställa in.** Dialogen täcker panelen, hämtningsintervallet
  och uppdateringskollen. Etiketter och tidsgränser är fortfarande konstanter i
  källkoden: `KNOWN_LABELS`, `CACHE_TTL` med flera i `bin/claude-usage`,
  `BAR_WIDTH` med flera i `extension/extension.js`.
- **Uppdateringen kräver utloggning för att synas.** Nya filer hamnar på disk
  direkt, men Shell laddar tillägg bara vid uppstart. Det gäller alla vägar in —
  popupen, `install.sh` eller `git pull`.
- **Dialogen är testad utan att ha visats.** Sidorna byggs och kopplas mot ett
  riktigt kompilerat schema i testet, men ingen har sett dem på skärmen.
- **Bara svenska strängar.** Ingen gettext-uppsättning.
- **Endpointen kan sluta fungera utan förvarning.** Se varningen högst upp.

## Utveckling och tester

```bash
./tests/run.sh
```

**Python-testerna (81 st)** kör CLI:t som en riktig subprocess mot en lokal
`http.server`-stubb, så att det som testas är exakt det gränssnitt tillägget
anropar. De täcker generisk parsning av okända nycklar, sortering,
tidsstämpelformat, cache-rättigheter och TTL, samt att 429, nätverksfel,
HTML-svar, 401, utgången token och saknad credentials-fil alla ger cachad data
eller ett läsbart fel — och att token aldrig läcker i något utdataläge.

**JS-testerna (47 st)** kör `extension.js` mot stubbade GNOME-bibliotek via en
ESM-loader som mappar `gi://` och `resource://` till `tests/js/stubs.mjs`. De
verifierar panel, stapelbredder, nedräkningar, felläge, placering i mittboxen
och att `disable()` städar timers, vakthund och signalhandlers. Stubbarna är
avsiktligt strikta där GNOME är strikt: `GLib.Source.remove()` kastar på okända
id:n, precis som riktiga GLib loggar en critical — så dubbelborttagning av
timers fångas i test.

Hela JS-sviten körs **två gånger**, med `STUB_BOX_ORIENTATION=1` (GNOME 48+,
`orientation`) och `=0` (GNOME 45–47, `vertical`).

`node` krävs bara för JS-testerna. `tests/run.sh` hoppar över dem om `node`
saknas, och tillägget självt använder bara GNOME:s bibliotek.

### Köra delar av sviten

```bash
python3 -m unittest discover -s tests -v
python3 -m unittest tests.test_claude_usage.TestResilience -v

node --import ./tests/js/register.mjs --test tests/js/test_extension.mjs
node --import ./tests/js/register.mjs \
     --test-name-pattern "destroy" --test tests/js/test_extension.mjs
```

### Lägga till en etikett

Redigera `KNOWN_LABELS` i `bin/claude-usage`. Inget behöver ändras i tillägget —
det renderar den `label` skriptet skickar.

### Ändra utseendet

`extension/stylesheet.css` för färger och mått, `extension.js` för struktur.
Läs kommentarerna högst upp i stilmallen först: flera val där är avsiktliga och
har med St:s begränsningar att göra, inte med smak.
