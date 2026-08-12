/* prefs.js — inställningsdialog för Claude Usage (GNOME 45+, libadwaita).
 *
 * Öppnas med:  gnome-extensions prefs claude-usage@hhammarstrand.github.io
 * eller från Extensions-appen.
 *
 * Allt som ställs in här ligger i GSettings under
 * org.gnome.shell.extensions.claude-usage. Tillägget lyssnar på ändringarna
 * och reagerar direkt — ingen utloggning behövs för att byta inställning.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/** Nycklarnas ordning i respektive ComboRow. Index <-> nick. */
const PANEL_SOURCES = ['session', 'max'];
const PANEL_BOXES = ['left', 'center', 'right'];

/**
 * Koppla en ComboRow till en strängnyckel. Gio.Settings.bind() klarar inte
 * strängar mot 'selected', så mappningen görs för hand — åt båda hållen.
 */
function bindCombo(settings, key, row, values) {
    const apply = () => {
        const index = values.indexOf(settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    apply();
    const changedId = settings.connect(`changed::${key}`, apply);
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    // Dialogen kan stängas medan signalen lever kvar på settings-objektet.
    row.connect('destroy', () => settings.disconnect(changedId));
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(620, 640);
        window.add(this._panelPage(settings));
        window.add(this._dataPage(settings));
    }

    // ------------------------------------------------------------- panelen

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const what = new Adw.PreferencesGroup({
            title: 'Vad siffran visar',
            description: 'Popupen visar alltid alla gränser, oavsett det här.',
        });
        page.add(what);

        const source = new Adw.ComboRow({
            title: 'Panelens siffra',
            subtitle: 'Vilken gräns som styr procenten och prickens färg',
            model: new Gtk.StringList({
                strings: ['Sessionsgränsen (5 h)', 'Den högsta gränsen'],
            }),
        });
        what.add(source);
        bindCombo(settings, 'panel-source', source, PANEL_SOURCES);

        const countdown = new Adw.SwitchRow({
            title: 'Nedräkning i panelen',
            subtitle: 'Tid till nästa återställning, i kompakt form (2h 5m)',
        });
        what.add(countdown);
        settings.bind('show-countdown', countdown, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        const where = new Adw.PreferencesGroup({
            title: 'Placering',
            description: 'Ändringen slår igenom direkt — ingen utloggning behövs.',
        });
        page.add(where);

        const box = new Adw.ComboRow({
            title: 'Del av panelen',
            subtitle: 'Mitten lägger indikatorn intill klockan',
            model: new Gtk.StringList({
                strings: ['Vänster', 'Mitten (intill klockan)', 'Höger'],
            }),
        });
        where.add(box);
        bindCombo(settings, 'panel-box', box, PANEL_BOXES);

        const position = new Adw.SpinRow({
            title: 'Plats inom den delen',
            subtitle: '0 = före klockan, 1 = efter den',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 20, step_increment: 1, page_increment: 1,
            }),
        });
        where.add(position);
        settings.bind('panel-position', position, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        return page;
    }

    // ---------------------------------------------------------------- data

    _dataPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Data',
            icon_name: 'preferences-system-network-symbolic',
        });

        const fetching = new Adw.PreferencesGroup({
            title: 'Hämtning',
            description:
                'Siffrorna kommer från en odokumenterad endpoint som kan ' +
                'ändras utan förvarning. Skriptets cache har samma TTL som ' +
                'intervallet, så tätare hämtning ger inte färskare siffror.',
        });
        page.add(fetching);

        const interval = new Adw.SpinRow({
            title: 'Hämta var',
            subtitle: 'Sekunder mellan automatiska hämtningar',
            adjustment: new Gtk.Adjustment({
                lower: 30, upper: 900, step_increment: 15, page_increment: 60,
            }),
        });
        fetching.add(interval);
        settings.bind('refresh-interval', interval, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        const updates = new Adw.PreferencesGroup({
            title: 'Programuppdatering',
            description:
                'Uppdateringen körs från popupen: "Sök efter uppdateringar". ' +
                'Ingenting hämtas eller installeras utan att du klickar.',
        });
        page.add(updates);

        const auto = new Adw.SwitchRow({
            title: 'Leta efter nya versioner automatiskt',
            subtitle: 'Frågar GitHub en gång per dygn. Installerar aldrig något själv.',
        });
        updates.add(auto);
        settings.bind('check-for-updates', auto, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        const version = new Adw.ActionRow({
            title: 'Installerad version',
            subtitle: String(this.metadata.version ?? 'okänd'),
        });
        updates.add(version);

        return page;
    }
}

// Bara för testerna; GNOME läser enbart default-exporten.
export {bindCombo, PANEL_BOXES, PANEL_SOURCES};
