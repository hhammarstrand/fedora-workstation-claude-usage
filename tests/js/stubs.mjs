/* Minimala stubbar för GNOME:s bibliotek, så att extension.js kan köras och
 * granskas utanför Shell. Stubbarna är avsiktligt strikta där riktiga GNOME är
 * strikt — GLib.Source.remove() kastar på okända id:n, precis som riktiga GLib
 * loggar en critical. Då fångas dubbelborttagning av timers i test.
 *
 * STUB_BOX_ORIENTATION=1 -> St.BoxLayout har 'orientation' (GNOME 48+)
 * STUB_BOX_ORIENTATION=0 -> St.BoxLayout har 'vertical'    (GNOME 45–47)
 */

export const state = {
    timers: new Map(),
    nextTimerId: 1,
    removedTimers: [],
    spawns: [],
    // Sätts av testet: {stdout, stderr, exitStatus, throwOnSpawn, neverFinish}
    subprocess: {stdout: '{}', stderr: '', exitStatus: 0},
    cancellations: 0,
    logs: [],
    notifications: [],
};

export function resetState() {
    state.timers.clear();
    state.nextTimerId = 1;
    state.removedTimers = [];
    state.spawns = [];
    state.subprocess = {stdout: '{}', stderr: '', exitStatus: 0};
    state.cancellations = 0;
    state.logs = [];
    state.notifications = [];
}

const BOX_HAS_ORIENTATION = process.env.STUB_BOX_ORIENTATION !== '0';

// --------------------------------------------------------------- actors

let actorSerial = 0;

export class Actor {
    constructor(props = {}) {
        this.__id = ++actorSerial;
        this.children = [];
        this.opacity = 255;
        this.style_class = '';
        this.style = '';
        Object.assign(this, props);
    }

    add_child(child) {
        this.children.push(child);
        child.parent = this;
    }

    get_children() {
        return this.children;
    }

    destroy() {
        this.destroyed = true;
    }
}

class LabelActor extends Actor {
    constructor(props = {}) {
        super(props);
        if (this.text === undefined)
            this.text = '';
        this.clutter_text = {};
    }
}

class BoxLayoutActor extends Actor {}

if (BOX_HAS_ORIENTATION) {
    Object.defineProperty(BoxLayoutActor.prototype, 'orientation', {
        get() {
            return this.__orientation ?? 0;
        },
        set(value) {
            this.__orientation = value;
        },
        configurable: true,
    });
} else {
    Object.defineProperty(BoxLayoutActor.prototype, 'vertical', {
        get() {
            return this.__vertical ?? false;
        },
        set(value) {
            this.__vertical = value;
        },
        configurable: true,
    });
}

export const St = {
    Widget: Actor,
    Label: LabelActor,
    BoxLayout: BoxLayoutActor,
    Bin: Actor,
    Icon: Actor,
    __hasOrientation: BOX_HAS_ORIENTATION,
};

// --------------------------------------------------------------- GObject

export const GObject = {
    registerClass(klass) {
        // Riktiga GObject låter konstruktorn anropa _init med samma argument.
        const Wrapped = class extends klass {
            constructor(...args) {
                super();
                this._init(...args);
            }
        };
        Object.defineProperty(Wrapped, 'name', {value: klass.name});
        return Wrapped;
    },
    ParamFlags: {READWRITE: 3},
};

// --------------------------------------------------------------- Clutter

export const Clutter = {
    ActorAlign: {FILL: 0, START: 1, CENTER: 2, END: 3},
    Orientation: {HORIZONTAL: 0, VERTICAL: 1},
};

export const Pango = {
    WrapMode: {WORD: 0, CHAR: 1, WORD_CHAR: 2},
    EllipsizeMode: {NONE: 0, END: 3},
};

// --------------------------------------------------------------- GLib

export const GLib = {
    PRIORITY_DEFAULT: 0,
    PRIORITY_DEFAULT_IDLE: 200,
    PRIORITY_LOW: 300,
    SOURCE_CONTINUE: true,
    SOURCE_REMOVE: false,
    FileTest: {EXISTS: 1, IS_EXECUTABLE: 8},

    get_home_dir: () => '/home/testuser',
    build_filenamev: parts => parts.join('/'),
    find_program_in_path: () => null,
    file_test: () => true,

    timeout_add_seconds(priority, interval, callback) {
        const id = state.nextTimerId++;
        state.timers.set(id, {priority, interval, callback});
        return id;
    },

    Source: {
        remove(id) {
            if (!state.timers.has(id)) {
                // Motsvarar GLib-criticalen "Source ID ... was not found".
                throw new Error(`GLib.Source.remove: okänt källid ${id}`);
            }
            state.timers.delete(id);
            state.removedTimers.push(id);
            return true;
        },
    },
};

/** Kör en registrerad timer-callback som Shell hade gjort.
 *  Returnerar callbacken GLib.SOURCE_REMOVE tas källan bort, precis som i GLib. */
export function fireTimer(id) {
    const timer = state.timers.get(id);
    if (!timer)
        throw new Error(`ingen timer med id ${id}`);
    const result = timer.callback();
    if (result === GLib.SOURCE_REMOVE)
        state.timers.delete(id);
    return result;
}

// --------------------------------------------------------------- Gio

class CancellableStub {
    constructor() {
        this._cancelled = false;
    }

    cancel() {
        this._cancelled = true;
        state.cancellations += 1;
    }

    is_cancelled() {
        return this._cancelled;
    }
}

class SubprocessStub {
    constructor(argv) {
        this.argv = argv;
    }

    communicate_utf8_async(stdin, cancellable, callback) {
        const config = state.subprocess;
        if (config.neverFinish)
            return;
        // Riktiga Gio anropar callbacken asynkront.
        queueMicrotask(() => callback(this, {__result: true}));
    }

    communicate_utf8_finish() {
        const config = state.subprocess;
        if (config.finishThrows)
            throw new Error(config.finishThrows);
        return [true, config.stdout, config.stderr];
    }

    get_exit_status() {
        return state.subprocess.exitStatus ?? 0;
    }
}

export const Gio = {
    SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
    Cancellable: CancellableStub,
    Subprocess: {
        new(argv, _flags) {
            state.spawns.push(argv);
            if (state.subprocess.throwOnSpawn)
                throw new Error(state.subprocess.throwOnSpawn);
            return new SubprocessStub(argv);
        },
    },
};

// ------------------------------------------------- resource:// shell-moduler

class MenuStub {
    constructor() {
        this.items = [];
        this._handlers = new Map();
        this._nextId = 1;
        this.isOpen = false;
    }

    connect(signal, callback) {
        const id = this._nextId++;
        this._handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        if (!this._handlers.has(id))
            throw new Error(`menu.disconnect: okänt handler-id ${id}`);
        this._handlers.delete(id);
    }

    removeAll() {
        this.items = [];
    }

    addMenuItem(item) {
        this.items.push(item);
    }

    get handlerCount() {
        return this._handlers.size;
    }

    emitOpenStateChanged(isOpen) {
        this.isOpen = isOpen;
        for (const {signal, callback} of this._handlers.values()) {
            if (signal === 'open-state-changed')
                callback(this, isOpen);
        }
    }
}

export class PanelMenuButton extends Actor {
    constructor() {
        super();
        this._signals = new Map();
        this._nextSignalId = 1;
    }

    _init(menuAlignment, nameText, dontCreateMenu) {
        this.menuAlignment = menuAlignment;
        this.accessible_name = nameText;
        this.menu = dontCreateMenu ? null : new MenuStub();
    }

    connect(signal, callback) {
        const id = this._nextSignalId++;
        this._signals.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this._signals.delete(id);
    }

    destroy() {
        this.destroyed = true;
        for (const {signal, callback} of this._signals.values()) {
            if (signal === 'destroy')
                callback(this);
        }
    }
}

class PopupBaseMenuItemStub extends Actor {
    constructor(params = {}) {
        super();
        this.params = params;
        this.style_class = params.style_class ?? '';
    }
}

class PopupMenuItemStub extends PopupBaseMenuItemStub {
    constructor(text, params = {}) {
        super(params);
        this.text = text;
        this._activateHandlers = [];
    }

    connect(signal, callback) {
        if (signal === 'activate')
            this._activateHandlers.push(callback);
        return this._activateHandlers.length;
    }

    activate() {
        for (const callback of this._activateHandlers)
            callback(this);
    }
}

class PopupImageMenuItemStub extends PopupMenuItemStub {
    constructor(text, iconName, params = {}) {
        super(text, params);
        this.iconName = iconName;
    }
}

class PopupSeparatorMenuItemStub extends Actor {
    constructor() {
        super();
        this.isSeparator = true;
    }
}

export const PopupMenu = {
    PopupBaseMenuItem: PopupBaseMenuItemStub,
    PopupMenuItem: PopupMenuItemStub,
    PopupImageMenuItem: PopupImageMenuItemStub,
    PopupSeparatorMenuItem: PopupSeparatorMenuItemStub,
};

export const Main = {
    /** Main.notify i Shell lägger en transient notis i meddelandefältet.
     *  Här samlas de i state.notifications så testerna kan räkna dem. */
    notify(title, body = null) {
        state.notifications.push({title, body});
    },
    panel: {
        statusArea: {},
        // Strikt som den riktiga panelen: rollen får bara tas en gång, och
        // platsen frigörs när indikatorn förstörs (Panel._addToPanelBox
        // kopplar en destroy-hanterare som tar bort den ur statusArea).
        // Utan det skulle en flytt av indikatorn se ut att fungera i test
        // men kasta "Extension point conflict" på en riktig Shell.
        addToStatusArea(role, indicator, position, box) {
            if (this.statusArea[role]) {
                throw new Error(
                    `Extension point conflict: there is already a status indicator for role ${role}`);
            }
            this.statusArea[role] = {indicator, position, box};
            indicator.connect('destroy', () => {
                delete this.statusArea[role];
            });
            return indicator;
        },
    },
};

export class Extension {
    constructor(metadata = {}) {
        this.metadata = metadata;
        this.uuid = metadata.uuid ?? 'claude-usage@test';
        this.openedPreferences = 0;
    }

    /** Sätts av testet när ett settings-objekt ska finnas. */
    getSettings() {
        if (!this.__settings)
            throw new Error(`Schema could not be found for extension ${this.uuid}`);
        return this.__settings;
    }

    openPreferences() {
        this.openedPreferences++;
    }
}
