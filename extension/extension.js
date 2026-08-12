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

/** Sekunder mellan automatiska uppdateringar. Skriptets cache-TTL är densamma. */
const REFRESH_INTERVAL = 60;
/** Sekunder mellan omräkningar av nedräkningarna (utan nätverksanrop). */
const CLOCK_INTERVAL = 15;
/** Nödbroms om skriptet hänger — då blir panelen aldrig låst. */
const SUBPROCESS_TIMEOUT = 20;
/** Stapelbredd i px. Enda sanningen: CSS sätter ingen bredd. */
const BAR_WIDTH = 220;
const MENU_MAX_WIDTH = BAR_WIDTH + 110;

/* Panelens mittbox innehåller klockan (dateMenu). Position 1 lägger oss
 * direkt till höger om den; 0 skulle lägga oss till vänster. Hela klustret
 * fortsätter vara centrerat i panelen, så klockan flyttar sig något åt vänster.
 * Byt till 'right' för statusområdet längst till höger. */
const PANEL_BOX = 'center';
const PANEL_POSITION = 1;

/* Adwaita dimmar sekundärtext till drygt halv opacitet. Vi sätter den på
 * actorn i stället för i CSS: St läser inte opacity från stilmallen, och en
 * hårdkodad grå färg skulle se fel ut i antingen ljust eller mörkt tema. */
const DIM_OPACITY = 145;

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
    _init(scriptPath) {
        super._init(0.0, 'Claude Usage', false);

        this._scriptPath = scriptPath;
        this._payload = null;
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
            });

        this.connect('destroy', () => this._onDestroy());

        this._refreshTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE, REFRESH_INTERVAL, () => {
                this._refresh(false);
                return GLib.SOURCE_CONTINUE;
            });
        this._clockTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE, CLOCK_INTERVAL, () => {
                this._updateClocks();
                return GLib.SOURCE_CONTINUE;
            });

        this._rebuildMenu();
        this._refresh(false);
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
        if (this._menuSignalId) {
            this.menu.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }
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

    _updatePanel() {
        const payload = this._payload;
        const hasData = payload?.ok && (payload.limits?.length ?? 0) > 0;

        let text = '–';
        let dotClass = 'claude-usage-unknown';

        if (hasData && typeof payload.max_percent === 'number') {
            text = `${Math.round(payload.max_percent)} %`;
            dotClass = severityClass(payload.max_severity);
        } else if (this._spawnError || payload?.error) {
            text = '!';
        }

        // Ett misslyckat skriptanrop gör siffrorna gamla även om senaste
        // lyckade svaret sa stale: false.
        const showingStale = hasData && (payload.stale || !!this._spawnError);

        if ((this._spawnError && !hasData) || (payload && !payload.ok))
            dotClass = 'claude-usage-error';
        else if (showingStale)
            dotClass += ' claude-usage-dot-stale';

        this._panelLabel.text = text;
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
        const credits = payload?.credits ?? null;

        if (payload?.ok) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (!limits.length && !credits) {
                this.menu.addMenuItem(this._makeInfoItem(
                    'Svaret innehöll inga gränser.', 'claude-usage-status'));
            }
            for (const limit of limits)
                this.menu.addMenuItem(this._makeLimitItem(limit));
            if (credits)
                this.menu.addMenuItem(this._makeCreditsItem(credits));

            const notes = [];
            if (limits.some(limit => limit.known === false))
                notes.push('* okänd nyckel — etiketten är autogenererad');
            const unrecognized = payload.unrecognized ?? [];
            if (unrecognized.length) {
                notes.push(`Ej tolkade nycklar: ${
                    unrecognized.map(entry => entry.key).join(', ')}`);
            }
            for (const note of notes)
                this.menu.addMenuItem(this._makeInfoItem(note, 'claude-usage-note'));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Ikonpost, som GNOME:s egna menyval.
        const refreshItem = new PopupMenu.PopupImageMenuItem(
            'Uppdatera nu', 'view-refresh-symbolic');
        refreshItem.connect('activate', () => this._refresh(true));
        this.menu.addMenuItem(refreshItem);
    }
});

/* Namngivna exporter finns bara för testerna i tests/js/. GNOME Shell läser
 * enbart default-exporten, så de påverkar inte tillägget i drift. */
export {
    ClaudeUsageIndicator,
    BAR_WIDTH,
    clampPercent,
    formatAge,
    formatDelta,
    formatPercent,
    newBox,
    severityClass,
};

export default class ClaudeUsageExtension extends Extension {
    enable() {
        const indicator = new ClaudeUsageIndicator(resolveScriptPath());
        try {
            Main.panel.addToStatusArea(
                this.uuid, indicator, PANEL_POSITION, PANEL_BOX);
        } catch (error) {
            // Lämna inte en indikator med levande timers bakom oss om rollen
            // redan är tagen (kan hända vid snabb disable/enable).
            indicator.destroy();
            throw error;
        }
        this._indicator = indicator;
    }

    disable() {
        // Wayland kan inte ladda om Shell live, men lock screen anropar
        // disable() — allt måste bort, timers och signaler inkluderade.
        this._indicator?.destroy();
        this._indicator = null;
    }
}
