/* Tester för extension/extension.js, körda mot stubbade GNOME-bibliotek.
 *
 *   node --import ./tests/js/register.mjs --test tests/js/
 *
 * Körs två gånger av tests/run.sh, med STUB_BOX_ORIENTATION=1 och =0, så att
 * både GNOME 48+ ('orientation') och GNOME 45–47 ('vertical') täcks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BAR_WIDTH,
    ClaudeUsageIndicator,
    clampPercent,
    formatAge,
    formatCountdown,
    formatDelta,
    formatPercent,
    newBox,
    severityClass,
} from '../../extension/extension.js';
import Extension from '../../extension/extension.js';
import {Clutter, GLib, St, fireTimer, resetState, state} from './stubs.mjs';

const SCRIPT = '/home/testuser/.local/bin/claude-usage';

const flush = async () => {
    for (let i = 0; i < 4; i++)
        await new Promise(resolve => setImmediate(resolve));
};

function limit(key, label, percent, severity, extra = {}) {
    return {
        key,
        label,
        known: true,
        percent,
        severity,
        // Inte exakt 7200: en nedräkning som flooras hamnar annars på
        // "1 h 59 min" så fort testet tar några millisekunder.
        resets_at_epoch: Date.now() / 1000 + 7500,
        resets_in_seconds: 7500,
        ...extra,
    };
}

function payload(overrides = {}) {
    return {
        schema: 1,
        ok: true,
        stale: false,
        source: 'network',
        age_seconds: 3,
        error: null,
        limits: [
            limit('five_hour', 'Session (5 h)', 42, 'ok'),
            limit('seven_day', 'Vecka – alla modeller', 75, 'warn'),
            limit('seven_day_opus', 'Vecka – Opus', 93.5, 'crit'),
        ],
        credits: {
            key: 'extra_usage',
            label: 'Credits',
            percent: null,
            severity: 'unknown',
            amount_summary: '0,00 / 85,00 EUR',
            fields: [
                {key: 'used_credits', label: 'Used credits', value: '0,00 EUR'},
                {key: 'disabled_reason', label: 'Disabled reason', value: 'out_of_credits'},
            ],
            display_fields: [
                {key: 'disabled_reason', label: 'Disabled reason', value: 'out_of_credits'},
            ],
        },
        extras: [],
        unrecognized: [],
        max_percent: 93.5,
        max_severity: 'crit',
        endpoint_documented: false,
        ...overrides,
    };
}

function setStdout(object) {
    state.subprocess = {stdout: JSON.stringify(object), stderr: '', exitStatus: 0};
}

async function build(object = payload()) {
    resetState();
    setStdout(object);
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();
    return indicator;
}

/** Plocka ut alla textsträngar ur ett menyträd. */
function texts(actor, found = []) {
    if (actor?.text)
        found.push(actor.text);
    for (const child of actor?.children ?? [])
        texts(child, found);
    return found;
}

function menuTexts(indicator) {
    return indicator.menu.items.flatMap(item => texts(item));
}

/** Hitta alla actors vars style_class matchar. */
function findByClass(actor, needle, found = []) {
    if (typeof actor?.style_class === 'string' && actor.style_class.includes(needle))
        found.push(actor);
    for (const child of actor?.children ?? [])
        findByClass(child, needle, found);
    return found;
}

// ---------------------------------------------------------------- formatters

test('formatDelta täcker dagar, timmar, minuter och gränsfall', () => {
    assert.equal(formatDelta(0), 'nu');
    assert.equal(formatDelta(-500), 'nu');
    assert.equal(formatDelta(30), '< 1 min');
    assert.equal(formatDelta(90), '1 min');
    assert.equal(formatDelta(3600), '1 h 0 min');
    assert.equal(formatDelta(7999), '2 h 13 min');
    assert.equal(formatDelta(300000), '3 d 11 h');
    assert.equal(formatDelta(null), null);
    assert.equal(formatDelta(undefined), null);
    assert.equal(formatDelta(NaN), null);
    assert.equal(formatDelta(Infinity), null);
});

test('formatCountdown är kompakt — panelen står intill klockan', () => {
    assert.equal(formatCountdown(0), 'nu');
    assert.equal(formatCountdown(-5), 'nu');
    assert.equal(formatCountdown(30), '<1m');
    assert.equal(formatCountdown(90), '1m');
    assert.equal(formatCountdown(3600), '1h 0m');
    assert.equal(formatCountdown(7999), '2h 13m');
    assert.equal(formatCountdown(300000), '3d 11h');
    assert.equal(formatCountdown(null), null);
    assert.equal(formatCountdown(NaN), null);
    assert.equal(formatCountdown(Infinity), null);
    // Kortare än popupens format, annars knuffar panelen klockan i sidled.
    assert.ok(formatCountdown(7999).length < formatDelta(7999).length);
});

test('formatPercent avrundar heltal och behåller decimal när det spelar roll', () => {
    assert.equal(formatPercent(42), '42 %');
    assert.equal(formatPercent(42.02), '42 %');
    assert.equal(formatPercent(93.5), '93.5 %');
    assert.equal(formatPercent(0), '0 %');
    assert.equal(formatPercent(null), '–');
    assert.equal(formatPercent('42'), '–');
    assert.equal(formatPercent(NaN), '–');
});

test('formatAge har sekundupplösning under en minut', () => {
    assert.equal(formatAge(0), 'just nu');
    assert.equal(formatAge(20), '20 s sedan');
    assert.equal(formatAge(600), '10 min sedan');
    assert.equal(formatAge(null), 'aldrig');
});

test('clampPercent håller sig inom 0–100 och avvisar skräp', () => {
    assert.equal(clampPercent(50), 50);
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(140), 100);
    assert.equal(clampPercent(null), null);
    assert.equal(clampPercent('50'), null);
});

test('severityClass faller tillbaka på unknown', () => {
    assert.equal(severityClass('ok'), 'claude-usage-ok');
    assert.equal(severityClass('warn'), 'claude-usage-warn');
    assert.equal(severityClass('crit'), 'claude-usage-crit');
    assert.equal(severityClass('nonsens'), 'claude-usage-unknown');
    assert.equal(severityClass(undefined), 'claude-usage-unknown');
});

// -------------------------------------------------------- versionskompatibilitet

test('newBox sätter den orienteringsproperty som finns i denna Shell-version', () => {
    const box = newBox(true);
    if (St.__hasOrientation) {
        assert.equal(box.orientation, Clutter.Orientation.VERTICAL,
            'GNOME 48+: orientation ska sättas');
        assert.equal(box.__vertical, undefined,
            'den deprekerade vertical-propertyn ska inte röras');
    } else {
        assert.equal(box.vertical, true, 'GNOME 45–47: vertical ska sättas');
        assert.equal(box.__orientation, undefined);
    }
    // Horisontella boxar ska aldrig sätta någon orienteringsproperty alls.
    const horizontal = newBox(false);
    assert.equal(horizontal.__orientation, undefined);
    assert.equal(horizontal.__vertical, undefined);
});

// ------------------------------------------------------------------- panelen

test('panelen visar sessionsgränsen med nedräkning, inte högsta värdet', async () => {
    const indicator = await build();
    // Minuten kan tippa över medan testet kör, så bara timmen låses fast.
    assert.match(indicator._panelLabel.text, /^42 % · 2h \d+m$/);
    assert.ok(!indicator._panelLabel.text.startsWith('94'),
        'veckogränsen på 93.5 % ska inte ta över panelen');
    assert.match(indicator._dot.style_class, /claude-usage-dot/);
    // Färgen följer sessionen (ok), inte max_severity (crit).
    assert.match(indicator._dot.style_class, /claude-usage-ok/);
    assert.equal(indicator._panelLabel.opacity, 255);
    indicator.destroy();
});

test('panelens nedräkning tickar med klockan, utan nätverksanrop', async () => {
    const indicator = await build(payload({
        limits: [limit('five_hour', 'Session (5 h)', 42, 'ok',
            {resets_at_epoch: Date.now() / 1000 + 7500})],
        credits: null,
    }));
    assert.match(indicator._panelLabel.text, /^42 % · 2h \d+m$/);

    indicator._panelEpoch = Date.now() / 1000 + 90;
    const spawnsBefore = state.spawns.length;
    fireTimer(indicator._clockTimerId);
    assert.equal(state.spawns.length, spawnsBefore, 'klockticket ska inte hämta data');
    assert.equal(indicator._panelLabel.text, '42 % · 1m');
    indicator.destroy();
});

test('gräns utan resets_at ger panelen procent utan nedräkning', async () => {
    const indicator = await build(payload({
        limits: [limit('five_hour', 'Session (5 h)', 42, 'ok',
            {resets_at_epoch: null})],
        credits: null,
    }));
    assert.equal(indicator._panelLabel.text, '42 %');
    indicator.destroy();
});

test('färgtrösklarna följer utilization: blå < 70, gul 70–89, röd >= 90', async () => {
    for (const [percent, severity, expected] of [
        [42, 'ok', /claude-usage-ok/],
        [70, 'warn', /claude-usage-warn/],
        [90, 'crit', /claude-usage-crit/],
    ]) {
        const indicator = await build(payload({
            limits: [limit('five_hour', 'Session (5 h)', percent, severity)],
            max_percent: percent,
            max_severity: severity,
            credits: null,
        }));
        assert.match(indicator._dot.style_class, expected, `${percent} %`);
        indicator.destroy();
    }
});

test('cachad data dimmas i panelen', async () => {
    const indicator = await build(payload({stale: true, age_seconds: 900}));
    assert.equal(indicator._panelLabel.opacity, 145);
    assert.equal(indicator._dot.opacity, 145, 'pricken dimmas också');
    assert.match(indicator._dot.style_class, /claude-usage-dot-stale/);
    // Prickens storlek får inte bero på om datan är färsk — inga ramar i CSS.
    indicator.destroy();
});

// -------------------------------------------------------------- inställningar

/**
 * Minimal Gio.Settings-ersättare. Indikatorn rör bara get_*/connect/disconnect,
 * så en vanlig JS-klass räcker — och håller testerna oberoende av GSettings.
 */
function fakeSettings(values = {}) {
    const store = {
        'panel-source': 'session',
        'show-countdown': true,
        'refresh-interval': 60,
        'panel-box': 'center',
        'panel-position': 1,
        'check-for-updates': false,
        'last-update-check': 0,
        ...values,
    };
    let nextId = 1;
    const handlers = new Map();
    return {
        store,
        handlers,
        get_string: key => store[key],
        get_boolean: key => store[key],
        get_int: key => store[key],
        get_int64: key => store[key],
        set_int64: (key, value) => {
            store[key] = value;
        },
        set_string: (key, value) => {
            store[key] = value;
            for (const [, entry] of handlers) {
                if (entry.signal === `changed::${key}`)
                    entry.callback();
            }
        },
        connect(signal, callback) {
            const id = nextId++;
            handlers.set(id, {signal, callback});
            return id;
        },
        disconnect(id) {
            handlers.delete(id);
        },
    };
}

async function buildWith(settings, object = payload()) {
    resetState();
    setStdout(object);
    const indicator = new ClaudeUsageIndicator(SCRIPT, settings);
    await flush();
    return indicator;
}

test('panel-source max låter den högsta gränsen styra panelen', async () => {
    const indicator = await buildWith(fakeSettings({'panel-source': 'max'}));
    assert.match(indicator._panelLabel.text, /^94 % · /, 'högsta värdet, avrundat');
    assert.match(indicator._dot.style_class, /claude-usage-crit/);
    indicator.destroy();
});

test('show-countdown av ger bara procenten', async () => {
    const indicator = await buildWith(fakeSettings({'show-countdown': false}));
    assert.equal(indicator._panelLabel.text, '42 %');
    indicator.destroy();
});

test('en ändrad inställning slår igenom utan omstart', async () => {
    const settings = fakeSettings();
    const indicator = await buildWith(settings);
    assert.match(indicator._panelLabel.text, /^42 % · /);

    settings.set_string('panel-source', 'max');
    assert.match(indicator._panelLabel.text, /^94 % · /,
        'panelen ska rita om sig direkt när inställningen ändras');
    indicator.destroy();
});

test('utan GSettings används standardvärdena i stället för att krascha', async () => {
    const indicator = await buildWith(null);
    assert.match(indicator._panelLabel.text, /^42 % · /);
    indicator.destroy();
});

test('destroy kopplar bort inställningssignalerna', async () => {
    const settings = fakeSettings();
    const indicator = await buildWith(settings);
    assert.ok(settings.handlers.size > 0, 'något ska vara kopplat');
    indicator.destroy();
    assert.equal(settings.handlers.size, 0, 'inget får ligga kvar');
});

// ------------------------------------------------------------------- popupen

test('popupen får en rad per gräns, credits sist, plus Uppdatera nu', async () => {
    const indicator = await build();
    const all = menuTexts(indicator);

    assert.ok(all.some(text => text.includes('Session (5 h)')));
    assert.ok(all.some(text => text.includes('Vecka – alla modeller')));
    assert.ok(all.some(text => text.includes('Vecka – Opus')));
    assert.ok(all.some(text => text === '42 %'));
    assert.ok(all.some(text => text === '93.5 %'));
    assert.ok(all.some(text => text.includes('återställs om 2 h')));
    assert.ok(all.some(text => text === '0,00 / 85,00 EUR'), 'beloppen i rubriken');
    assert.ok(all.some(text => text.includes('Disabled reason: out_of_credits')));
    assert.ok(!all.some(text => text.includes('decimal_places')), 'ingen fältvägg');
    // Åtgärdsposterna ligger sist: hämta om, och versionskollen.
    assert.equal(all.at(-2), 'Uppdatera nu');
    assert.equal(all.at(-1), 'Sök efter uppdateringar');

    // Credits ska ligga efter alla gränsrader.
    const creditsIndex = all.findIndex(text => text === 'Credits');
    const opusIndex = all.findIndex(text => text.includes('Vecka – Opus'));
    assert.ok(creditsIndex > opusIndex, 'credits-raden ska ligga sist av raderna');

    indicator.destroy();
});

test('extras hamnar under en egen rubrik och driver inte panelen', async () => {
    const indicator = await build(payload({
        limits: [limit('five_hour', 'Session (5 h)', 10, 'ok')],
        extras: [limit('nimbus_quill', 'Nimbus quill', 99, 'crit', {known: false})],
        credits: null,
        // Skriptet räknar max_percent utan extras — panelen ska följa det.
        max_percent: 10,
        max_severity: 'ok',
    }));

    assert.match(indicator._panelLabel.text, /^10 %( ·|$)/, 'extras får inte höja siffran');
    assert.match(indicator._dot.style_class, /claude-usage-ok/,
        'en okänd nyckel på 99 % får inte färga panelen röd');

    const all = menuTexts(indicator);
    assert.ok(all.some(text => text.includes('Övrigt')), 'egen rubrik');
    assert.ok(all.some(text => text === 'Nimbus quill *'), 'men visas');
    assert.ok(all.some(text => text.includes('autogenererad')));
    // Rubriken ska stå före raden.
    const heading = all.findIndex(text => text.includes('Övrigt'));
    assert.ok(heading < all.findIndex(text => text === 'Nimbus quill *'));
    indicator.destroy();
});

test('inga extras ger ingen tom Övrigt-rubrik', async () => {
    const indicator = await build();
    assert.ok(!menuTexts(indicator).some(text => text.includes('Övrigt')));
    indicator.destroy();
});

test('staplarna får bredd i proportion till procenten', async () => {
    const indicator = await build();
    const fills = indicator.menu.items.flatMap(
        item => findByClass(item, 'claude-usage-bar-fill'));
    assert.equal(fills.length, 3, 'en fyllnad per gräns');

    const widthOf = fill => Number(fill.style.match(/width:\s*(\d+)px/)[1]);
    assert.equal(widthOf(fills[0]), Math.round(BAR_WIDTH * 0.42));
    assert.equal(widthOf(fills[1]), Math.round(BAR_WIDTH * 0.75));
    assert.equal(widthOf(fills[2]), Math.round(BAR_WIDTH * 0.935));
    assert.match(fills[2].style_class, /claude-usage-crit/);

    const tracks = indicator.menu.items.flatMap(
        item => findByClass(item, 'claude-usage-bar-track'));
    for (const track of tracks)
        assert.match(track.style, new RegExp(`width:\\s*${BAR_WIDTH}px`));

    indicator.destroy();
});

test('0 % ger tom stapel och över 100 % svämmar inte över', async () => {
    const indicator = await build(payload({
        limits: [
            limit('five_hour', 'Noll', 0, 'ok'),
            limit('seven_day', 'Överfull', 140, 'crit'),
        ],
        credits: null,
        max_percent: 140,
        max_severity: 'crit',
    }));
    const fills = indicator.menu.items.flatMap(
        item => findByClass(item, 'claude-usage-bar-fill'));
    assert.match(fills[0].style, /width:\s*0px/);
    assert.match(fills[1].style, new RegExp(`width:\\s*${BAR_WIDTH}px`));
    // Siffran döljs inte bara för att stapeln är kapad.
    assert.ok(menuTexts(indicator).includes('140 %'));
    indicator.destroy();
});

test('gräns utan procent renderas ändå, med streck', async () => {
    const indicator = await build(payload({
        limits: [limit('five_hour', 'Session (5 h)', null, 'unknown')],
        credits: null,
        max_percent: null,
        max_severity: 'unknown',
    }));
    assert.ok(menuTexts(indicator).includes('–'));
    assert.equal(indicator._panelLabel.text, '–');
    indicator.destroy();
});

test('okänd nyckel märks med stjärna och får en fotnot', async () => {
    const indicator = await build(payload({
        limits: [limit('thirty_day_mystery', '30 dagar – Mystery', 12, 'ok',
            {known: false})],
        credits: null,
        unrecognized: [{key: 'account_uuid', reason: 'skalärt värde'}],
        max_percent: 12,
        max_severity: 'ok',
    }));
    const all = menuTexts(indicator);
    assert.ok(all.some(text => text === '30 dagar – Mystery *'));
    assert.ok(all.some(text => text.includes('autogenererad')));
    assert.ok(all.some(text => text.includes('Ej tolkade nycklar: account_uuid')));
    indicator.destroy();
});

test('nycklar utan värde samlas på en rad, skilda från de otolkade', async () => {
    // Ett riktigt svar har ett tiotal null-nycklar; blir de en rad var fyller
    // de hela popupen.
    const indicator = await build(payload({
        limits: [limit('five_hour', 'Session (5 h)', 12, 'ok')],
        credits: null,
        unrecognized: [
            {key: 'tangelo', reason: 'utan värde'},
            {key: 'amber_ladder', reason: 'utan värde'},
            {key: 'member_dashboard_available', reason: 'skalärt värde'},
        ],
        max_percent: 12,
        max_severity: 'ok',
    }));
    const all = menuTexts(indicator);
    const empty = all.filter(text => text.includes('Utan värde:'));
    assert.equal(empty.length, 1);
    assert.ok(empty[0].includes('tangelo'));
    assert.ok(empty[0].includes('amber_ladder'));
    assert.ok(!empty[0].includes('member_dashboard_available'));
    assert.ok(all.some(
        text => text === 'Ej tolkade nycklar: member_dashboard_available'));
    indicator.destroy();
});

test('tomt svar utan gränser säger det i stället för att visa en tom meny', async () => {
    const indicator = await build(payload({
        limits: [], credits: null, max_percent: null, max_severity: 'unknown',
    }));
    assert.ok(menuTexts(indicator).some(text => text.includes('inga gränser')));
    indicator.destroy();
});

test('nedräkningen räknas om vid klocktick utan nytt nätverksanrop', async () => {
    // 150 s ligger tryggt inne i "2 min"-intervallet även om testet tar en stund.
    const indicator = await build(payload({
        limits: [limit('five_hour', 'Session (5 h)', 42, 'ok',
            {resets_at_epoch: Date.now() / 1000 + 150})],
        credits: null,
    }));
    const before = menuTexts(indicator).find(text => text.includes('återställs'));
    assert.equal(before, 'återställs om 2 min');

    // Flytta nedräkningen bakåt och tick:a klockan.
    indicator._clockRows[0].epoch = Date.now() / 1000 + 30;
    const spawnsBefore = state.spawns.length;
    fireTimer(indicator._clockTimerId);
    assert.equal(state.spawns.length, spawnsBefore, 'klockticket ska inte hämta data');
    assert.ok(menuTexts(indicator).some(text => text === 'återställs om < 1 min'));
    indicator.destroy();
});

test('gräns utan resets_at säger det i stället för att visa fel tid', async () => {
    const indicator = await build(payload({
        limits: [limit('wibble', 'Wibble', 5, 'ok', {resets_at_epoch: null})],
        credits: null,
    }));
    assert.ok(menuTexts(indicator).some(
        text => text.includes('ingen känd återställningstid')));
    indicator.destroy();
});

// -------------------------------------------------------------- felhantering

test('saknat skript kraschar inte, utan visas som fel', async () => {
    resetState();
    state.subprocess = {throwOnSpawn: 'Failed to execute child process (No such file)'};
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();

    assert.equal(indicator._panelLabel.text, '!');
    assert.match(indicator._dot.style_class, /claude-usage-error/);
    assert.ok(menuTexts(indicator).some(text => text.includes(SCRIPT)));
    // Uppdatera nu finns kvar så att användaren kan försöka igen.
    assert.ok(menuTexts(indicator).includes('Uppdatera nu'));
    indicator.destroy();
});

test('ogiltig JSON från skriptet kraschar inte', async () => {
    resetState();
    state.subprocess = {stdout: 'inte json alls', stderr: '', exitStatus: 0};
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();
    assert.equal(indicator._panelLabel.text, '!');
    assert.ok(menuTexts(indicator).includes('Uppdatera nu'));
    indicator.destroy();
});

test('tom stdout med stderr visar stderr-texten', async () => {
    resetState();
    state.subprocess = {stdout: '', stderr: 'traceback: nåt gick fel', exitStatus: 1};
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();
    assert.ok(menuTexts(indicator).some(text => text.includes('nåt gick fel')));
    indicator.destroy();
});

test('429 med cachad data visar siffrorna och att de är cachade', async () => {
    const indicator = await build(payload({
        stale: true,
        source: 'cache',
        age_seconds: 420,
        error: {
            kind: 'rate_limited',
            message: 'Rate limitad av servern (429).',
            retry_after: '37',
        },
    }));
    const all = menuTexts(indicator);
    assert.ok(all.some(text => text.includes('429')));
    assert.ok(all.some(text => text.includes('Visar cachad data')));
    assert.ok(all.some(text => text.includes('Retry-After: 37')));
    // Siffrorna finns kvar.
    assert.ok(all.some(text => text.includes('Session (5 h)')));
    assert.match(indicator._panelLabel.text, /^42 % · 2h \d+m$/);
    indicator.destroy();
});

test('utgången token utan cache ger fel, inte tom panel', async () => {
    const indicator = await build({
        schema: 1,
        ok: false,
        stale: true,
        source: 'cache',
        age_seconds: null,
        error: {
            kind: 'unauthorized',
            message: 'Token avvisades (401) — kör ett Claude Code-kommando så förnyas den.',
        },
        limits: [],
        credits: null,
        unrecognized: [],
        max_percent: null,
        max_severity: 'unknown',
    });
    assert.equal(indicator._panelLabel.text, '!');
    assert.match(indicator._dot.style_class, /claude-usage-error/);
    assert.ok(menuTexts(indicator).some(text => text.includes('401')));
    indicator.destroy();
});

test('ett fel efter lyckad hämtning behåller de senaste siffrorna', async () => {
    const indicator = await build();
    assert.match(indicator._panelLabel.text, /^42 % · 2h \d+m$/);

    // Nästa körning misslyckas helt.
    state.subprocess = {throwOnSpawn: 'skriptet försvann'};
    await indicator._refresh(false);
    await flush();

    assert.match(indicator._panelLabel.text, /^42 % · /, 'gamla siffror ska kvarstå');
    assert.ok(menuTexts(indicator).some(text => text.includes('skriptet försvann')));
    // ...men de ska märkas som gamla, trots att svaret sa stale: false.
    assert.equal(indicator._panelLabel.opacity, 145);
    assert.equal(indicator._dot.opacity, 145);
    assert.match(indicator._dot.style_class, /claude-usage-dot-stale/);
    indicator.destroy();
});

test('destroy städar vakthunden för ett pågående anrop', async () => {
    resetState();
    setStdout(payload());
    state.subprocess.neverFinish = true;
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();
    // Uppdatering, klocka och vakthund.
    assert.equal(state.timers.size, 3);

    indicator.destroy();
    assert.equal(state.timers.size, 0, 'ingen källa får överleva disable()');
    assert.equal(indicator._watchdogTimerId, 0);
});

test('enable() lämnar ingen indikator kvar om panelen avvisar rollen', async () => {
    resetState();
    setStdout(payload());
    const {Main} = await import('./stubs.mjs');
    const original = Main.panel.addToStatusArea;
    Main.panel.addToStatusArea = () => {
        throw new Error('rollen är redan tagen');
    };
    try {
        const extension = new Extension({uuid: 'claude-usage@test'});
        assert.throws(() => extension.enable(), /rollen är redan tagen/);
        await flush();
        assert.equal(state.timers.size, 0, 'timers ska städas när enable() fallerar');
    } finally {
        Main.panel.addToStatusArea = original;
    }
});

// ------------------------------------------------------------ timers/signaler

test('två timers registreras och båda begär fortsatt körning', async () => {
    const indicator = await build();
    assert.equal(state.timers.size, 2, 'en uppdaterings- och en klocktimer');

    assert.equal(fireTimer(indicator._refreshTimerId), GLib.SOURCE_CONTINUE);
    assert.equal(fireTimer(indicator._clockTimerId), GLib.SOURCE_CONTINUE);
    await flush();
    assert.equal(state.timers.size, 2, 'timrarna ska leva vidare');
    indicator.destroy();
});

test('uppdateringstimern hämtar data på nytt', async () => {
    const indicator = await build();
    const before = state.spawns.length;
    fireTimer(indicator._refreshTimerId);
    await flush();
    assert.equal(state.spawns.length, before + 1);
    assert.deepEqual(state.spawns.at(-1), [SCRIPT, '--json'], 'utan --force');
    indicator.destroy();
});

test('öppnad popup triggar en uppdatering', async () => {
    const indicator = await build();
    const before = state.spawns.length;

    indicator.menu.emitOpenStateChanged(true);
    await flush();
    assert.equal(state.spawns.length, before + 1);

    // Stängning ska inte hämta något.
    indicator.menu.emitOpenStateChanged(false);
    await flush();
    assert.equal(state.spawns.length, before + 1);
    indicator.destroy();
});

test('Uppdatera nu forcerar förbi cachen', async () => {
    const indicator = await build();
    const refreshItem = indicator.menu.items.at(-1);
    assert.equal(refreshItem.text, 'Uppdatera nu');
    // Ikonpost med symbolisk ikon, som GNOME:s egna menyval.
    assert.equal(refreshItem.iconName, 'view-refresh-symbolic');

    refreshItem.activate();
    await flush();
    assert.deepEqual(state.spawns.at(-1), [SCRIPT, '--json', '--force']);
    indicator.destroy();
});

test('samtidiga uppdateringar dubbleras inte', async () => {
    resetState();
    setStdout(payload());
    state.subprocess.neverFinish = true;
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();
    assert.equal(state.spawns.length, 1, 'första anropet pågår');

    // Medan det hänger ska inget nytt anrop startas.
    fireTimer(indicator._refreshTimerId);
    indicator.menu.emitOpenStateChanged(true);
    await flush();
    assert.equal(state.spawns.length, 1);
    indicator.destroy();
});

test('en hängande subprocess avbryts av vakthunden', async () => {
    resetState();
    setStdout(payload());
    state.subprocess.neverFinish = true;
    const indicator = new ClaudeUsageIndicator(SCRIPT);
    await flush();

    // Vakthundstimern är den tredje (uppdatering, klocka, vakthund).
    const watchdog = [...state.timers.keys()].at(-1);
    assert.equal(state.cancellations, 0);
    fireTimer(watchdog);
    assert.equal(state.cancellations, 1, 'cancellable ska avbrytas');
    indicator.destroy();
});

test('destroy städar timers, signalhandlers och cancellable', async () => {
    const indicator = await build();
    const menu = indicator.menu;
    assert.equal(state.timers.size, 2);
    assert.equal(menu.handlerCount, 1);
    const refreshId = indicator._refreshTimerId;
    const clockId = indicator._clockTimerId;

    indicator.destroy();

    assert.equal(state.timers.size, 0, 'inga timers får leva vidare');
    assert.ok(state.removedTimers.includes(refreshId), 'uppdateringstimern städad');
    assert.ok(state.removedTimers.includes(clockId), 'klocktimern städad');
    assert.equal(menu.handlerCount, 0, 'menyns signalhandler ska kopplas bort');
    assert.equal(indicator._refreshTimerId, 0);
    assert.equal(indicator._clockTimerId, 0);
    assert.equal(indicator._menuSignalId, 0);
    assert.equal(state.cancellations, 1, 'pågående anrop ska avbrytas');
});

test('destroy två gånger kastar inte (GLib skulle logga en critical)', async () => {
    const indicator = await build();
    indicator.destroy();
    assert.doesNotThrow(() => indicator.destroy());
});

test('uppdatering efter destroy gör ingenting', async () => {
    const indicator = await build();
    indicator.destroy();
    const before = state.spawns.length;
    await indicator._refresh(true);
    await flush();
    assert.equal(state.spawns.length, before, 'inga anrop efter destroy');
    assert.doesNotThrow(() => indicator._updateClocks());
});

test('timer som hunnit fyra efter destroy städas inte två gånger', async () => {
    const indicator = await build();
    const refreshId = indicator._refreshTimerId;
    indicator.destroy();
    // Timern är borta ur GLib; att försöka igen skulle kasta.
    assert.throws(() => fireTimer(refreshId));
});

// ------------------------------------------------------------ extension-klass

test('enable() lägger indikatorn i panelen och disable() tar bort den', async () => {
    resetState();
    setStdout(payload());

    const extension = new Extension({uuid: 'claude-usage@test'});
    extension.enable();
    await flush();

    const {Main} = await import('./stubs.mjs');
    assert.ok(Main.panel.statusArea['claude-usage@test'], 'ska ha lagts till i panelen');
    assert.equal(Main.panel.statusArea['claude-usage@test'].box, 'center',
        'ska ligga i panelens mittbox, intill klockan');
    assert.equal(Main.panel.statusArea['claude-usage@test'].position, 1,
        'position 1 = direkt till höger om klockan');
    assert.equal(state.timers.size, 2);

    extension.disable();
    assert.equal(state.timers.size, 0, 'disable() ska städa timers');
    assert.equal(extension._indicator, null);

    // disable() två gånger ska vara ofarligt.
    assert.doesNotThrow(() => extension.disable());
});
