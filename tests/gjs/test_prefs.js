/* Tester för extension/prefs.js, körda i gjs mot riktiga Gtk/Adw och ett
 * riktigt kompilerat GSettings-schema.
 *
 *   gjs -m tests/gjs/test_prefs.js
 *
 * Node-stubbarna duger inte här: dialogen är libadwaita-widgetar, inte St.
 * gjs finns på varje GNOME-maskin och är samma motor som Shell kör, så det här
 * är närmare verkligheten än en stubb ändå. Ingen fönsterserver behövs —
 * widgetarna byggs men visas aldrig.
 *
 * Kör via tests/run.sh, som också kompilerar schemat först.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// Extensions-appens moduler (ExtensionPreferences) ligger i en fristående
// gresource. Utan den går prefs.js inte att importera utanför Shell.
const EXTENSIONS_RESOURCE =
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource';

let failures = 0;
let checks = 0;

function check(condition, description) {
    checks++;
    if (condition) {
        print(`  ✓ ${description}`);
    } else {
        failures++;
        print(`  ✗ ${description}`);
    }
}

function equal(actual, expected, description) {
    check(actual === expected, `${description} (fick ${actual}, väntade ${expected})`);
}

function group(title) {
    print(`\n${title}`);
}

// ---------------------------------------------------------------- uppsättning

const here = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]);
const root = GLib.build_filenamev([here, '..', '..']);
const schemaDir = GLib.build_filenamev([root, 'extension', 'schemas']);
const prefsPath = GLib.build_filenamev([root, 'extension', 'prefs.js']);

if (!GLib.file_test(
    GLib.build_filenamev([schemaDir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) {
    printerr('gschemas.compiled saknas — kör glib-compile-schemas först.');
    imports.system.exit(1);
}

Gio.resources_register(Gio.Resource.load(EXTENSIONS_RESOURCE));
Gtk.init();
Adw.init();

const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir, Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup('org.gnome.shell.extensions.claude-usage', true);
if (!schema) {
    printerr('schemat gick inte att slå upp');
    imports.system.exit(1);
}

const {default: ClaudeUsagePreferences} = await import(`file://${prefsPath}`);

const extensionDir = Gio.File.new_for_path(
    GLib.build_filenamev([root, 'extension']));

class Harness extends ClaudeUsagePreferences {
    constructor() {
        super({
            uuid: 'claude-usage@hhammarstrand.github.io',
            name: 'Claude Usage',
            version: 2,
            'settings-schema': schema.get_id(),
            dir: extensionDir,
            path: extensionDir.get_path(),
        });
    }
}

const prefs = new Harness();
// getSettings() stubbas INTE: den riktiga letar upp schemas/ i dir, så testet
// täcker även att schemat faktiskt hittas från en installerad katalog.
const settings = prefs.getSettings();

const pages = [];
prefs.fillPreferencesWindow({
    set_default_size: () => {},
    add: page => pages.push(page),
});

function collectRows(widget, found = []) {
    let child = widget.get_first_child?.();
    while (child) {
        if (child instanceof Adw.PreferencesRow)
            found.push(child);
        collectRows(child, found);
        child = child.get_next_sibling();
    }
    return found;
}

const rows = pages.flatMap(page => collectRows(page));
const byTitle = title => rows.find(row => row.title === title);

// ------------------------------------------------------------------- tester

group('Dialogen byggs');
equal(pages.length, 2, 'två sidor');
check(pages.some(page => page.title === 'Panel'), 'en Panel-sida');
check(pages.some(page => page.title === 'Data'), 'en Data-sida');
for (const title of [
    'Panelens siffra',
    'Nedräkning i panelen',
    'Del av panelen',
    'Ordning inom den delen',
    'Hämta var',
    'Leta efter nya versioner automatiskt',
]) {
    check(byTitle(title) !== undefined, `raden "${title}" finns`);
}

group('Varje rad speglar sin nyckel — åt båda hållen');

const sourceRow = byTitle('Panelens siffra');
settings.set_string('panel-source', 'session');
equal(sourceRow.selected, 0, 'session ger första valet');
settings.set_string('panel-source', 'max');
equal(sourceRow.selected, 1, 'ändring i GSettings syns i dialogen');
sourceRow.selected = 0;
equal(settings.get_string('panel-source'), 'session', 'val i dialogen skriver nyckeln');

const countdownRow = byTitle('Nedräkning i panelen');
settings.set_boolean('show-countdown', false);
equal(countdownRow.active, false, 'switchen följer nyckeln');
countdownRow.active = true;
equal(settings.get_boolean('show-countdown'), true, 'switchen skriver nyckeln');

const boxRow = byTitle('Del av panelen');
settings.set_string('panel-box', 'right');
equal(boxRow.selected, 2, 'right är tredje valet');
boxRow.selected = 0;
equal(settings.get_string('panel-box'), 'left', 'valet skriver nyckeln');

const positionRow = byTitle('Ordning inom den delen');
// Nyckeln är int32 och propertyn gdouble — bindningen måste klara båda hållen.
settings.set_int('panel-position', 3);
equal(positionRow.value, 3, 'int-nyckel når en double-property');
positionRow.value = 0;
equal(settings.get_int('panel-position'), 0, 'och tillbaka igen');

const intervalRow = byTitle('Hämta var');
settings.set_int('refresh-interval', 300);
equal(intervalRow.value, 300, 'intervallet följer nyckeln');
intervalRow.value = 90;
equal(settings.get_int('refresh-interval'), 90, 'och skriver den');

group('Undertexten för ordning beror på vald del');
settings.set_string('panel-box', 'center');
check(positionRow.subtitle.includes('klockan'),
    'i mitten förklaras positionen med klockan');
settings.set_string('panel-box', 'right');
check(!positionRow.subtitle.includes('klockan'),
    'i sidoboxarna nämns inte klockan — där finns ingen');

group('Schemat har rimliga gränser');
const intervalRange = schema.get_key('refresh-interval').get_range().deep_unpack()[1];
check(intervalRange !== null, 'refresh-interval har ett intervall');
settings.reset('refresh-interval');
equal(settings.get_int('refresh-interval'), 60, 'standardintervallet är 60 s');
settings.reset('panel-source');
equal(settings.get_string('panel-source'), 'session',
    'panelen följer sessionen som standard');
settings.reset('show-countdown');
equal(settings.get_boolean('show-countdown'), true, 'nedräkningen är på som standard');

// Städa upp efter oss, så att en körning inte lämnar spår i dconf.
for (const key of ['panel-source', 'show-countdown', 'panel-box',
    'panel-position', 'refresh-interval', 'check-for-updates',
    'last-update-check'])
    settings.reset(key);

print(`\n${checks - failures}/${checks} kontroller gröna`);
if (failures > 0) {
    printerr(`${failures} kontroller misslyckades`);
    imports.system.exit(1);
}
