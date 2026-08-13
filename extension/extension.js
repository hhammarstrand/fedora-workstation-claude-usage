/* extension.js — Claude Usage för GNOME Shell 45+ (ESM)
 *
 * Tillägget hanterar aldrig token själv. All autentisering och cachning ligger
 * i ~/.local/bin/claude-usage; här körs bara skriptet via Gio.Subprocess och
 * dess --json-utdata ritas upp.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/** Sekunder mellan omräkningar av nedräkningarna (utan nätverksanrop). */
const CLOCK_INTERVAL = 15;
/** Automatisk versionskoll görs som mest en gång per dygn. */
const UPDATE_CHECK_INTERVAL = 86400;
/** Nödbroms för uppdateraren. --apply hämtar och kör install.sh, så den
 *  är rundligare än SUBPROCESS_TIMEOUT — men inte obegränsad. */
const UPDATER_TIMEOUT = 240;
/** Nödbroms om skriptet hänger — då blir panelen aldrig låst. */
const SUBPROCESS_TIMEOUT = 20;
/** Stapelbredd i px. Enda sanningen: CSS sätter ingen bredd. */
const BAR_WIDTH = 220;
const MENU_MAX_WIDTH = BAR_WIDTH + 110;

/* Standardvärden.
 *
 * panel-source styr vad panelens siffra visar:
 *   'session' — gränsen med kortast tidsfönster, alltså sessionsgränsen (5 h).
 *               Skriptet sorterar limits kortast först, så det är limits[0];
 *               ingen nyckel är hårdkodad här.
 *   'max'     — högsta procenten bland gränserna, oavsett fönster.
 * Skillnaden märks när veckogränsen ligger högre än sessionen. Popupen visar
 * alltid alla gränser, oavsett valet.
 *
 * panel-box/panel-position: mittboxen innehåller klockan (dateMenu), så
 * position 1 lägger indikatorn direkt till höger om den.
 *
 * Värdena här är bara reserv. Normalt kommer de från GSettings och ställs in i
 * dialogen (prefs.js); DEFAULTS används när en nyckel inte går att läsa — och
 * av testerna, som kör indikatorn utan GSettings. */
const DEFAULTS = {
    'panel-source': 'session',
    'show-countdown': true,
    'notify-threshold': 90,
    'notify-on-reset': true,
    'refresh-interval': 60,
    'panel-box': 'center',
    'panel-position': 1,
};

/* Adwaita dimmar sekundärtext till drygt halv opacitet. Vi sätter den på
 * actorn i stället för i CSS: St läser inte opacity från stilmallen, och en
 * hårdkodad grå färg skulle se fel ut i antingen ljust eller mörkt tema. */
const DIM_OPACITY = 145;

/** Måste matcha EMPTY_REASON i bin/claude-usage — nyckel utan värde i svaret. */
const EMPTY_REASON = 'utan värde';

const SEVERITY_CLASS = {
    ok: 'claude-usage-ok',
    warn: 'claude-usage-warn',
    crit: 'claude-usage-crit',
    unknown: 'claude-usage-unknown',
};

/**
 * St.BoxLayout bytte från 'vertical' till 'orientation' i GNOME 48. Att sätta
 * den gamla propertyn loggar en deprecation-varning på nya versioner, och den
 * nya finns inte på gamla — så vi väljer den som faktiskt är installerad.
 */
const BOX_HAS_ORIENTATION = 'orientation' in St.BoxLayout.prototype;

function newBox(vertical, props = {}) {
    const box = new St.BoxLayout(props);
    if (!vertical)
        return box;
    if (BOX_HAS_ORIENTATION)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function clampPercent(percent) {
    if (typeof percent !== 'number' || !isFinite(percent))
        return null;
    return Math.max(0, Math.min(100, percent));
}

function formatPercent(percent) {
    if (typeof percent !== 'number' || !isFinite(percent))
        return '–';
    if (Math.abs(percent - Math.round(percent)) < 0.05)
        return `${Math.round(percent)} %`;
    return `${percent.toFixed(1)} %`;
}

function formatDelta(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds))
        return null;
    if (seconds <= 0)
        return 'nu';
    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0)
        return `${days} d ${hours} h`;
    if (hours > 0)
        return `${hours} h ${minutes} min`;
    if (minutes > 0)
        return `${minutes} min`;
    return '< 1 min';
}

/**
 * Kompakt nedräkning för panelen: '2h 5m', '11m', '6d 8h'. Panelen står intill
 * klockan och varje tecken skjuter den i sidled, så formatet är kortare än
 * formatDelta() som används i popupen.
 */
function formatCountdown(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds))
        return null;
    if (seconds <= 0)
        return 'nu';
    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m`;
    return '<1m';
}

function formatAge(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds))
        return 'aldrig';
    if (seconds < 5)
        return 'just nu';
    if (seconds < 60)
        return `${Math.floor(seconds)} s sedan`;
    return `${formatDelta(seconds)} sedan`;
}

function severityClass(severity) {
    return SEVERITY_CLASS[severity] ?? SEVERITY_CLASS.unknown;
}

/** Leta upp skriptet. Returnerar en väg även när den inte finns, för felmeddelandet. */
function resolveScriptPath() {
    const preferred = GLib.build_filenamev([
        GLib.get_home_dir(), '.local', 'bin', 'claude-usage',
    ]);
    const candidates = [preferred];
    const fromPath = GLib.find_program_in_path('claude-usage');
    if (fromPath)
        candidates.push(fromPath);
    for (const candidate of candidates) {
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
            return candidate;
    }
    return preferred;
}

/** Samma logik som resolveScriptPath, för uppdateringsskriptet. */
function resolveUpdaterPath() {
    const preferred = GLib.build_filenamev([
        GLib.get_home_dir(), '.local', 'bin', 'claude-usage-update',
    ]);
    if (GLib.file_test(preferred, GLib.FileTest.IS_EXECUTABLE))
        return preferred;
    return GLib.find_program_in_path('claude-usage-update') ?? preferred;
}

function wrappingLabel(text, styleClass) {
    const label = new St.Label({text, style_class: styleClass});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

/** Sekundärtext: temats färg, nedtonad — som Adwaitas dim-label. */
function dimLabel(text, styleClass, wrap = false) {
    const label = wrap
        ? wrappingLabel(text, styleClass)
        : new St.Label({text, style_class: styleClass});
    label.opacity = DIM_OPACITY;
    return label;
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(scriptPath, settings = null, openPreferences = null) {
        super._init(0.0, 'Claude Usage', false);

        this._scriptPath = scriptPath;
        this._updaterPath = resolveUpdaterPath();
        // Anropas av menyposten "Inställningar". Null i testerna.
        this._openPreferences = openPreferences;
        this._updateStatus = null;
        this._updateAvailable = false;
        this._updateSha = null;
        this._updateBusy = false;
        this._updateCancellable = null;
        this._updateWatchdogId = 0;
        this._statusIdleId = 0;
        // Föregående fönster, för att kunna se när det byts ut.
        this._seenWindowEpoch = null;
        this._seenWindowPercent = null;
        // Får vara null: testerna kör utan GSettings, och en trasig
        // schemainstallation ska ge standardvärden i stället för ett undantag.
        this._settings = settings;
        this._settingsIds = [];
        this._payload = null;
        this._panelPercentText = '…';
        this._panelEpoch = null;
        this._spawnError = null;
        this._cancellable = null;
        this._busy = false;
        this._clockRows = [];
        this._refreshTimerId = 0;
        this._clockTimerId = 0;
        this._watchdogTimerId = 0;
        this._menuSignalId = 0;
        this._disposed = false;

        // panel-status-menu-box ger GNOME:s egna mått; vår klass bara mellanrummet.
        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box claude-usage-panel-box',
        });
        this._dot = new St.Widget({
            style_class: 'claude-usage-dot claude-usage-unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelLabel = new St.Label({
            text: '…',
            style_class: 'claude-usage-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._dot);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._menuSignalId = this.menu.connect(
            'open-state-changed', (_menu, isOpen) => {
                if (!isOpen || this._disposed)
                    return;
                // Visa aktuella nedräkningar direkt, hämta nya siffror i bakgrunden.
                this._updateClocks();
                this._refresh(false);
                this._maybeAutoCheck();
            });

        this.connect('destroy', () => this._onDestroy());

        this._startRefreshTimer();
        this._clockTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE, CLOCK_INTERVAL, () => {
                this._updateClocks();
                return GLib.SOURCE_CONTINUE;
            });

        this._watchSettings();
        this._rebuildMenu();
        this._refresh(false);
    }

    /**
     * Läs en inställning, med konstanten som reserv. Typen avgörs av
     * standardvärdet, så en nyckel bara behöver läggas till i DEFAULTS.
     */
    _setting(key) {
        const fallback = DEFAULTS[key];
        if (!this._settings)
            return fallback;
        try {
            if (typeof fallback === 'boolean')
                return this._settings.get_boolean(key);
            if (typeof fallback === 'number')
                return this._settings.get_int(key);
            return this._settings.get_string(key);
        } catch {
            // Hellre standardvärdet än ett undantag mitt i panelritningen.
            return fallback;
        }
    }

    _watchSettings() {
        if (!this._settings)
            return;
        // Panelen ritas om direkt; ingen utloggning för att byta inställning.
        // Bara panelen beror på de här; popupens rader är desamma oavsett.
        // Att rita om hela menyn skulle förstöra poster i onödan.
        for (const key of ['panel-source', 'show-countdown']) {
            this._settingsIds.push(this._settings.connect(
                `changed::${key}`, () => this._updatePanel()));
        }
        this._settingsIds.push(this._settings.connect(
            'changed::refresh-interval', () => this._startRefreshTimer()));
    }

    _startRefreshTimer() {
        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        this._refreshTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE, this._setting('refresh-interval'), () => {
                this._refresh(false);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _onDestroy() {
        this._disposed = true;

        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        if (this._clockTimerId) {
            GLib.Source.remove(this._clockTimerId);
            this._clockTimerId = 0;
        }
        // En subprocess kan vara i luften; dess vakthund måste bort med.
        if (this._watchdogTimerId) {
            GLib.Source.remove(this._watchdogTimerId);
            this._watchdogTimerId = 0;
        }
        if (this._updateWatchdogId) {
            GLib.Source.remove(this._updateWatchdogId);
            this._updateWatchdogId = 0;
        }
        if (this._statusIdleId) {
            GLib.Source.remove(this._statusIdleId);
            this._statusIdleId = 0;
        }
        if (this._updateCancellable) {
            // Annars lever en nedladdning kvar efter att panelen är borta.
            this._updateCancellable.cancel();
            this._updateCancellable = null;
        }
        if (this._menuSignalId) {
            this.menu.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }
        for (const id of this._settingsIds)
            this._settings?.disconnect(id);
        this._settingsIds = [];
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._clockRows = [];
        this._payload = null;
    }

    // ---------------------------------------------------------------- data

    /** Kör skriptet. Löser med stdout så snart det finns JSON att tolka. */
    _runScript(force) {
        return new Promise((resolve, reject) => {
            const argv = [this._scriptPath, '--json'];
            if (force)
                argv.push('--force');

            let proc;
            try {
                proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (error) {
                // Vanligaste fallet: skriptet är inte installerat.
                reject(new Error(
                    `Kan inte köra ${this._scriptPath}: ${error.message}`));
                return;
            }

            const cancellable = new Gio.Cancellable();
            this._cancellable = cancellable;

            // Bara ett anrop är i luften i taget (_busy garanterar det), så en
            // enda vakthund per instans räcker — och kan städas i _onDestroy.
            let timedOut = false;
            this._watchdogTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, SUBPROCESS_TIMEOUT, () => {
                    timedOut = true;
                    this._watchdogTimerId = 0;
                    cancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });

            proc.communicate_utf8_async(null, cancellable, (subprocess, result) => {
                if (this._watchdogTimerId) {
                    GLib.Source.remove(this._watchdogTimerId);
                    this._watchdogTimerId = 0;
                }
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                    if (stdout && stdout.trim()) {
                        // Skriptet skriver giltig JSON även när det gått fel,
                        // så exitkoden avgör inte om svaret är användbart.
                        resolve(stdout);
                        return;
                    }
                    const detail = (stderr || '').trim();
                    reject(new Error(detail ||
                        `claude-usage gav inget svar (kod ${subprocess.get_exit_status()})`));
                } catch (error) {
                    reject(new Error(timedOut
                        ? `claude-usage svarade inte inom ${SUBPROCESS_TIMEOUT} s`
                        : error.message));
                }
            });
        });
    }

    async _refresh(force) {
        if (this._disposed || this._busy)
            return;
        this._busy = true;
        try {
            const stdout = await this._runScript(force);
            if (this._disposed)
                return;
            const payload = JSON.parse(stdout);
            if (!payload || typeof payload !== 'object')
                throw new Error('claude-usage gav oväntad JSON');
            this._payload = payload;
            this._spawnError = null;
            this._checkNotifications();
        } catch (error) {
            if (this._disposed)
                return;
            // Behåll senaste kända siffror; visa felet ovanför dem.
            this._spawnError = error.message ?? String(error);
            console.debug(`claude-usage: ${this._spawnError}`);
        } finally {
            this._busy = false;
        }
        if (this._disposed)
            return;
        try {
            this._rebuildMenu();
        } catch (error) {
            // _refresh anropas som fire-and-forget; en rejection här skulle bli
            // en ohanterad promise och panelen skulle frysa i gammalt läge.
            console.error(`claude-usage: kunde inte rita om menyn: ${error}`);
        }
    }

    // ------------------------------------------------------------------ UI

    /** Gränsen som panelens siffra ska följa. Se PANEL_SOURCE. */
    _primaryLimit(limits) {
        if (!limits.length)
            return null;
        if (this._setting('panel-source') === 'max') {
            return limits.reduce((best, item) => {
                if (typeof item.percent !== 'number')
                    return best;
                return !best || item.percent > best.percent ? item : best;
            }, null);
        }
        // Skriptet sorterar kortast tidsfönster först — det är sessionen.
        return limits[0];
    }

    /** Sätter panelens text ur senast kända siffra plus en färsk nedräkning. */
    _applyPanelText() {
        let text = this._panelPercentText ?? '–';
        if (this._setting('show-countdown') &&
            typeof this._panelEpoch === 'number') {
            const delta = formatCountdown(this._panelEpoch - Date.now() / 1000);
            if (delta)
                text += ` · ${delta}`;
        }
        this._panelLabel.text = text;
    }

    _updatePanel() {
        const payload = this._payload;
        const limits = payload?.limits ?? [];
        const hasData = payload?.ok && limits.length > 0;

        let dotClass = 'claude-usage-unknown';
        this._panelPercentText = '–';
        this._panelEpoch = null;

        const primary = hasData ? this._primaryLimit(limits) : null;
        if (primary && typeof primary.percent === 'number') {
            // 100 % betyder att nästa kommando faktiskt nekas. Att visa det
            // som ännu en röd siffra döljer skillnaden mellan "snart slut"
            // och "slut" — och det är nedräkningen man vill ha då.
            const spent = primary.percent >= 100;
            this._panelPercentText = spent
                ? 'slut'
                : `${Math.round(primary.percent)} %`;
            dotClass = spent ? 'claude-usage-full' : severityClass(primary.severity);
            if (typeof primary.resets_at_epoch === 'number')
                this._panelEpoch = primary.resets_at_epoch;
        } else if (this._spawnError || payload?.error) {
            this._panelPercentText = '!';
        }

        // Ett misslyckat skriptanrop gör siffrorna gamla även om senaste
        // lyckade svaret sa stale: false.
        const showingStale = hasData && (payload.stale || !!this._spawnError);

        if ((this._spawnError && !hasData) || (payload && !payload.ok))
            dotClass = 'claude-usage-error';
        else if (showingStale)
            dotClass += ' claude-usage-dot-stale';

        this._applyPanelText();
        this._dot.style_class = `claude-usage-dot ${dotClass}`;
        // Dimma prick och siffra när datan inte är färsk. Opacitet i stället för
        // en annan prickstil, så att inget hoppar i storlek i panelen.
        const opacity = showingStale ? DIM_OPACITY : 255;
        this._panelLabel.opacity = opacity;
        this._dot.opacity = opacity;
    }

    _statusLines() {
        const payload = this._payload;
        const lines = [];

        if (this._spawnError)
            lines.push(this._spawnError);

        if (payload?.error?.message) {
            let message = payload.error.message;
            if (payload.ok)
                message += ' Visar cachad data.';
            if (payload.error.retry_after)
                message += ` (Retry-After: ${payload.error.retry_after})`;
            lines.push(message);
        }

        if (payload?.ok) {
            let line = `Uppdaterad ${formatAge(payload.age_seconds)}`;
            if (payload.stale)
                line += ' · cachad';
            lines.push(line);
        } else if (!lines.length) {
            lines.push('Läser…');
        }

        return lines;
    }

    _makeInfoItem(text, styleClass) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'claude-usage-info-item',
        });
        const label = dimLabel(text, styleClass, true);
        label.style = `max-width: ${MENU_MAX_WIDTH}px;`;
        item.add_child(label);
        return item;
    }

    _makeLimitItem(limit) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'claude-usage-row-item',
        });
        const column = newBox(true, {x_expand: true, style_class: 'claude-usage-row'});

        const heading = newBox(false, {x_expand: true});
        const name = new St.Label({
            text: limit.known === false ? `${limit.label} *` : limit.label,
            x_expand: true,
            style_class: 'claude-usage-row-label',
        });
        // Procentsiffran behåller temats textfärg. Severiteten bärs av stapeln
        // och panelprickens färg, vilket både är mer Adwaita-återhållsamt och
        // undviker kontrastproblem mot okänd popup-bakgrund.
        const percent = new St.Label({
            text: formatPercent(limit.percent),
            style_class: 'claude-usage-row-percent',
        });
        heading.add_child(name);
        heading.add_child(percent);

        const fraction = clampPercent(limit.percent);
        const track = new St.BoxLayout({
            style_class: 'claude-usage-bar-track',
            style: `width: ${BAR_WIDTH}px;`,
        });
        const fill = new St.Widget({
            style_class: `claude-usage-bar-fill ${severityClass(limit.severity)}`,
            style: `width: ${fraction ? Math.max(2, Math.round(BAR_WIDTH * fraction / 100)) : 0}px;`,
            y_expand: true,
        });
        track.add_child(fill);

        // Beloppet först när det finns: procenten säger hur mycket, beloppet
        // säger av vad. Ofta null i svaret — då blir raden inte tommare.
        if (limit.amount_summary) {
            heading.add_child(new St.Label({
                text: limit.amount_summary,
                style_class: 'claude-usage-row-percent',
            }));
        }

        const footer = dimLabel(
            this._resetText(limit.resets_at_epoch), 'claude-usage-row-reset');

        column.add_child(heading);
        column.add_child(track);
        column.add_child(footer);
        item.add_child(column);

        // Nedräkningen tickar lokalt så att den stämmer även på cachad data.
        if (typeof limit.resets_at_epoch === 'number')
            this._clockRows.push({label: footer, epoch: limit.resets_at_epoch});

        return item;
    }

    _resetText(epoch) {
        if (typeof epoch !== 'number' || !isFinite(epoch))
            return 'ingen känd återställningstid';
        const remaining = epoch - Date.now() / 1000;
        const delta = formatDelta(remaining);
        return delta === 'nu' ? 'återställs nu' : `återställs om ${delta}`;
    }

    _updateClocks() {
        if (this._disposed)
            return;
        // Panelens nedräkning tickar med samma klocka som popupens rader, och
        // räknas lokalt ur epoch — så den stämmer även på cachad data.
        this._applyPanelText();
        for (const row of this._clockRows) {
            if (row.label)
                row.label.text = this._resetText(row.epoch);
        }
    }

    _makeCreditsItem(credits) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'claude-usage-row-item',
        });
        const column = newBox(true, {x_expand: true, style_class: 'claude-usage-row'});

        const heading = newBox(false, {x_expand: true});
        heading.add_child(new St.Label({
            text: credits.label ?? 'Credits',
            x_expand: true,
            style_class: 'claude-usage-row-label',
        }));
        if (typeof credits.percent === 'number') {
            heading.add_child(new St.Label({
                text: formatPercent(credits.percent),
                style_class: 'claude-usage-row-percent',
            }));
        }
        // Beloppen först: "0,00 / 85,00 EUR" säger mer än råa 8500.
        if (credits.amount_summary) {
            heading.add_child(new St.Label({
                text: credits.amount_summary,
                style_class: 'claude-usage-row-percent',
            }));
        }
        column.add_child(heading);

        // display_fields är den kurerade delmängden; riktiga svar har ett dussin
        // fält och alla på en rad blir en oläslig vägg.
        const summary = (credits.display_fields ?? credits.fields ?? [])
            .map(field => `${field.label}: ${field.value}`)
            .join(' · ');
        if (summary) {
            const label = dimLabel(summary, 'claude-usage-row-reset', true);
            label.style = `max-width: ${MENU_MAX_WIDTH}px;`;
            column.add_child(label);
        }

        item.add_child(column);
        return item;
    }

    _rebuildMenu() {
        if (this._disposed)
            return;

        this._updatePanel();

        // removeAll() förstör posterna, vilket också släpper deras signaler.
        this._clockRows = [];
        this.menu.removeAll();

        for (const line of this._statusLines())
            this.menu.addMenuItem(this._makeInfoItem(line, 'claude-usage-status'));

        const payload = this._payload;
        const limits = payload?.limits ?? [];
        const extras = payload?.extras ?? [];
        const credits = payload?.credits ?? null;

        if (payload?.ok) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (!limits.length && !extras.length && !credits) {
                this.menu.addMenuItem(this._makeInfoItem(
                    'Svaret innehöll inga gränser.', 'claude-usage-status'));
            }
            for (const limit of limits)
                this.menu.addMenuItem(this._makeLimitItem(limit));
            if (credits)
                this.menu.addMenuItem(this._makeCreditsItem(credits));

            // Nycklar utan känt tidsfönster — visas, men driver inte panelen.
            if (extras.length) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this.menu.addMenuItem(this._makeInfoItem(
                    'Övrigt — ingen känd tidsgräns, räknas inte i panelen',
                    'claude-usage-note'));
                for (const extra of extras)
                    this.menu.addMenuItem(this._makeLimitItem(extra));
            }

            const notes = [];
            if ([...limits, ...extras].some(item => item.known === false))
                notes.push('* okänd nyckel — etiketten är autogenererad');
            const unrecognized = payload.unrecognized ?? [];
            // Tomma nycklar betyder "gäller inte det här kontot". Ett riktigt
            // svar har ett tiotal; de samlas på en rad i stället för att fylla
            // popupen med brus.
            const empty = unrecognized.filter(
                entry => entry.reason === EMPTY_REASON);
            const unparsed = unrecognized.filter(
                entry => entry.reason !== EMPTY_REASON);
            if (empty.length) {
                notes.push(`Utan värde: ${
                    empty.map(entry => entry.key).join(', ')}`);
            }
            if (unparsed.length) {
                notes.push(`Ej tolkade nycklar: ${
                    unparsed.map(entry => entry.key).join(', ')}`);
            }
            for (const note of notes)
                this.menu.addMenuItem(this._makeInfoItem(note, 'claude-usage-note'));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Resultatet av senaste versionskoll, om det finns något att säga.
        if (this._updateStatus) {
            this.menu.addMenuItem(
                this._makeInfoItem(this._updateStatus, 'claude-usage-note'));
        }

        // Ikonposter, som GNOME:s egna menyval.
        const refreshItem = new PopupMenu.PopupImageMenuItem(
            'Uppdatera nu', 'view-refresh-symbolic');
        refreshItem.connect('activate', () => this._refresh(true));
        this.menu.addMenuItem(refreshItem);

        if (this._updateAvailable) {
            const installItem = new PopupMenu.PopupImageMenuItem(
                `Installera version ${this._updateSha.slice(0, 7)}`,
                'software-update-available-symbolic');
            installItem.connect('activate', () => this._applyUpdate());
            this.menu.addMenuItem(installItem);
        }
        // Finns kvar även när en uppdatering hittats: går installationen fel
        // ska man kunna söka om utan att starta om Shell.
        const checkItem = new PopupMenu.PopupImageMenuItem(
            'Sök efter uppdateringar', 'software-update-available-symbolic');
        checkItem.connect('activate', () => this._checkForUpdate(true));
        this.menu.addMenuItem(checkItem);

        if (this._openPreferences) {
            const prefsItem = new PopupMenu.PopupImageMenuItem(
                'Inställningar', 'preferences-system-symbolic');
            prefsItem.connect('activate', () => this._openPreferences());
            this.menu.addMenuItem(prefsItem);
        }
    }

    // ------------------------------------------------------- uppdateringar

    /** Kör updater-skriptet och lämna tillbaka dess JSON. */
    _runUpdater(mode) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = Gio.Subprocess.new(
                    [this._updaterPath, mode],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (error) {
                reject(new Error(`Kan inte köra ${this._updaterPath}: ${error.message}`));
                return;
            }

            // --apply hämtar och kör install.sh och får ta tid, men aldrig
            // obegränsat: utan vakthund fastnar _updateBusy för alltid och
            // menyposten går inte att använda igen.
            const cancellable = new Gio.Cancellable();
            this._updateCancellable = cancellable;
            let timedOut = false;
            this._updateWatchdogId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, UPDATER_TIMEOUT, () => {
                    timedOut = true;
                    this._updateWatchdogId = 0;
                    cancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });

            proc.communicate_utf8_async(null, cancellable, (subprocess, result) => {
                if (this._updateWatchdogId) {
                    GLib.Source.remove(this._updateWatchdogId);
                    this._updateWatchdogId = 0;
                }
                this._updateCancellable = null;
                try {
                    const [, stdout] = subprocess.communicate_utf8_finish(result);
                    resolve(JSON.parse(stdout));
                } catch (error) {
                    reject(new Error(timedOut
                        ? `claude-usage-update svarade inte inom ${UPDATER_TIMEOUT} s`
                        : error.message));
                }
            });
        });
    }

    /** @param {boolean} announce - visa även "ingen uppdatering", inte bara fynd. */
    async _checkForUpdate(announce) {
        if (this._disposed || this._updateBusy)
            return;
        this._updateBusy = true;
        if (announce)
            this._setUpdateStatus('Söker efter uppdateringar…');
        try {
            // Stämpla försöket direkt. Stämplas bara lyckade kontroller
            // görs ett nytt anrop varje gång popupen öppnas så länge felet
            // står kvar — och GitHub tål 60 anrop i timmen oautentiserat.
            this._stampCheck();
            const result = await this._runUpdater('--check');
            if (this._disposed)
                return;
            if (!result?.ok) {
                if (announce) {
                    this._setUpdateStatus(
                        `Kunde inte söka: ${result?.error?.message ?? 'okänt fel'}`);
                }
                return;
            }
            if (result.update_available) {
                this._updateAvailable = true;
                this._updateSha = result.latest_commit;
                this._setUpdateStatus(
                    `Ny version finns: ${result.latest_summary || result.latest_commit.slice(0, 7)}`);
            } else if (result.unknown_installed) {
                if (announce) {
                    this._setUpdateStatus(
                        'Vet inte vilken version som är installerad — kör install.sh en gång.');
                }
            } else if (announce) {
                this._setUpdateStatus('Redan senaste versionen.');
            }
        } catch (error) {
            if (!this._disposed && announce)
                this._setUpdateStatus(`Kunde inte söka: ${error.message}`);
        } finally {
            this._updateBusy = false;
        }
    }

    async _applyUpdate() {
        if (this._disposed || this._updateBusy)
            return;
        this._updateBusy = true;
        this._setUpdateStatus('Hämtar och installerar…');
        try {
            const result = await this._runUpdater('--apply');
            if (this._disposed)
                return;
            if (!result?.ok) {
                this._setUpdateStatus(
                    `Uppdateringen misslyckades: ${result?.error?.message ?? 'okänt fel'}`);
                return;
            }
            this._updateAvailable = false;
            this._updateSha = null;
            this._setUpdateStatus(result.message ??
                'Uppdaterat. Logga ut och in igen för att ladda den nya versionen.');
        } catch (error) {
            if (!this._disposed)
                this._setUpdateStatus(`Uppdateringen misslyckades: ${error.message}`);
        } finally {
            this._updateBusy = false;
        }
    }

    /**
      * Menyn får INTE ritas om synkront härifrån. Shell kopplar sin egen
      * activate-hanterare med ConnectFlags.AFTER, så när den här körs pågår
      * fortfarande postens signalemission — och removeAll() skulle förstöra
      * just den posten mitt i den. Vi skjuter till nästa idle i stället.
      */
    _setUpdateStatus(text) {
        this._updateStatus = text;
        if (this._statusIdleId)
            return;
        this._statusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._statusIdleId = 0;
            if (!this._disposed)
                this._rebuildMenu();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------- notifieringar

    /** Läs/skriv en epoch-nyckel utan att fälla hämtningen om schemat saknas. */
    _readEpoch(key) {
        try {
            return this._settings?.get_int64(key) ?? 0;
        } catch {
            return 0;
        }
    }

    _writeEpoch(key, value) {
        try {
            this._settings?.set_int64(key, Math.floor(value));
        } catch {
            // Utan schema blir notifieringen bara oregelbunden, inte trasig.
        }
    }

    /**
     * Två notifieringar, båda av data vi redan har.
     *
     * Tröskeln säger till innan du blir avbruten. Återställningen säger till
     * när du kan fortsätta — det är den som är värd något, för den vet du
     * annars inte utan att sitta och titta på panelen.
     *
     * Avstämningen sker mot fönstrets resets_at, inte mot en tidsstämpel: ett
     * fönster ger exakt en notifiering, oavsett hur många gånger vi hämtar,
     * och det överlever både skärmlås och utloggning eftersom nyckeln ligger
     * i GSettings.
     */
    _checkNotifications() {
        const limits = this._payload?.limits ?? [];
        const primary = this._primaryLimit(limits);
        const epoch = primary?.resets_at_epoch;
        const percent = primary?.percent;
        if (typeof epoch !== 'number' || typeof percent !== 'number')
            return;

        const threshold = this._setting('notify-threshold');
        const previousEpoch = this._seenWindowEpoch;
        const previousPercent = this._seenWindowPercent;
        this._seenWindowEpoch = epoch;
        this._seenWindowPercent = percent;

        // Fönstret har bytts ut sedan förra hämtningen, och du låg över
        // tröskeln i det gamla — alltså blev du sannolikt begränsad.
        if (this._setting('notify-on-reset') &&
            previousEpoch !== null && epoch > previousEpoch &&
            threshold > 0 && previousPercent >= threshold &&
            this._readEpoch('last-notified-reset') !== epoch) {
            this._writeEpoch('last-notified-reset', epoch);
            Main.notify(
                `${primary.label} är återställd`,
                'Du kan köra Claude igen.');
        }

        if (threshold > 0 && percent >= threshold &&
            this._readEpoch('last-notified-window') !== epoch) {
            this._writeEpoch('last-notified-window', epoch);
            const delta = formatDelta(epoch - Date.now() / 1000);
            Main.notify(
                `${primary.label}: ${formatPercent(percent)} använt`,
                delta ? `Återställs om ${delta}.` : null);
        }
    }

    _stampCheck() {
        try {
            this._settings?.set_int64(
                'last-update-check', Math.floor(Date.now() / 1000));
        } catch {
            // Saknad nyckel ska inte fälla versionskollen.
        }
    }

    /** Automatisk kontroll: högst en per dygn, och bara om den är påslagen. */
    _maybeAutoCheck() {
        if (!this._settings || !this._setting('check-for-updates'))
            return;
        let last = 0;
        try {
            last = this._settings.get_int64('last-update-check');
        } catch {
            return;
        }
        if (Date.now() / 1000 - last < UPDATE_CHECK_INTERVAL)
            return;
        this._checkForUpdate(false);
    }
});

/* Namngivna exporter finns bara för testerna i tests/js/. GNOME Shell läser
 * enbart default-exporten, så de påverkar inte tillägget i drift. */
export {
    ClaudeUsageIndicator,
    BAR_WIDTH,
    clampPercent,
    formatAge,
    formatCountdown,
    formatDelta,
    formatPercent,
    newBox,
    severityClass,
};

export default class ClaudeUsageExtension extends Extension {
    /** Signal-id:n för de inställningar som kräver att indikatorn byggs om. */
    _placementIds = [];

    enable() {
        // Saknas schemat (ofullständig installation) ska tillägget ändå ladda,
        // med standardvärdena — hellre en fungerande panel än ett undantag.
        try {
            this._settings = this.getSettings();
        } catch (error) {
            console.warn(`claude-usage: inga inställningar (${error.message})`);
            this._settings = null;
        }

        this._addIndicator();

        // Placeringen går inte att ändra på en levande indikator: den sitter i
        // en panelbox. Att bygga om den är billigt och slipper specialfall.
        for (const key of ['panel-box', 'panel-position']) {
            this._placementIds.push(this._settings?.connect(
                `changed::${key}`, () => {
                    this._removeIndicator();
                    this._addIndicator();
                }));
        }
    }

    _addIndicator() {
        const indicator = new ClaudeUsageIndicator(
            resolveScriptPath(), this._settings, () => this.openPreferences());
        const box = this._settings?.get_string('panel-box') ?? DEFAULTS['panel-box'];
        const position =
            this._settings?.get_int('panel-position') ?? DEFAULTS['panel-position'];
        try {
            Main.panel.addToStatusArea(this.uuid, indicator, position, box);
        } catch (error) {
            // Lämna inte en indikator med levande timers bakom oss om rollen
            // redan är tagen (kan hända vid snabb disable/enable).
            indicator.destroy();
            throw error;
        }
        this._indicator = indicator;
    }

    _removeIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    disable() {
        // Wayland kan inte ladda om Shell live, men lock screen anropar
        // disable() — allt måste bort, timers och signaler inkluderade.
        for (const id of this._placementIds) {
            if (id)
                this._settings?.disconnect(id);
        }
        this._placementIds = [];
        this._removeIndicator();
        this._settings = null;
    }
}
