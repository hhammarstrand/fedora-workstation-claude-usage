/* ESM-loader som mappar gi:// och resource:///org/gnome/shell/... till
 * stubbarna i stubs.mjs, så att extension.js kan importeras av Node.
 */

import {pathToFileURL} from 'node:url';

const STUBS = pathToFileURL(new URL('./stubs.mjs', import.meta.url).pathname).href;

const GI_EXPORTS = {
    GObject: 'GObject',
    St: 'St',
    Clutter: 'Clutter',
    GLib: 'GLib',
    Gio: 'Gio',
    Pango: 'Pango',
};

const RESOURCE_MODULES = {
    // Tillägget gör `import * as Main` och läser Main.panel, så `panel` måste
    // vara en egen namngiven export.
    'resource:///org/gnome/shell/ui/main.js':
        `import {Main} from ${JSON.stringify(STUBS)};
         export const panel = Main.panel;
         export default Main;`,
    'resource:///org/gnome/shell/ui/panelMenu.js':
        `import {PanelMenuButton} from ${JSON.stringify(STUBS)};
         export {PanelMenuButton as Button};`,
    'resource:///org/gnome/shell/ui/popupMenu.js':
        `import {PopupMenu} from ${JSON.stringify(STUBS)};
         export const PopupBaseMenuItem = PopupMenu.PopupBaseMenuItem;
         export const PopupMenuItem = PopupMenu.PopupMenuItem;
         export const PopupSeparatorMenuItem = PopupMenu.PopupSeparatorMenuItem;`,
    'resource:///org/gnome/shell/extensions/extension.js':
        `export {Extension} from ${JSON.stringify(STUBS)};
         export const gettext = text => text;`,
};

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('gi://')) {
        const name = specifier.slice('gi://'.length);
        if (!(name in GI_EXPORTS))
            throw new Error(`stubbar saknas för ${specifier}`);
        return {url: `stub-gi:${name}`, shortCircuit: true};
    }
    if (specifier.startsWith('resource://')) {
        if (!(specifier in RESOURCE_MODULES))
            throw new Error(`stubbar saknas för ${specifier}`);
        return {url: `stub-resource:${specifier}`, shortCircuit: true};
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith('stub-gi:')) {
        const name = url.slice('stub-gi:'.length);
        return {
            format: 'module',
            shortCircuit: true,
            source: `import {${GI_EXPORTS[name]}} from ${JSON.stringify(STUBS)};
                     export default ${GI_EXPORTS[name]};`,
        };
    }
    if (url.startsWith('stub-resource:')) {
        const key = url.slice('stub-resource:'.length);
        return {format: 'module', shortCircuit: true, source: RESOURCE_MODULES[key]};
    }
    return nextLoad(url, context);
}
