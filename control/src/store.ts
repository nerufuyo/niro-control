// @ts-nocheck: GLib/Gio are untyped here
// Reads and writes the settings the catalog names. Everything goes through a Binding, so a row never knows which
// schema, key or dictionary field it is editing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {Item} from './types.js';

const EXTENSION_DIRS = ['/usr/share/gnome-shell/extensions', '/usr/local/share/gnome-shell/extensions',
    `${GLib.get_user_data_dir()}/gnome-shell/extensions`];
const UUID = {island: 'island@niro.local', dock: 'dock@niro.local', blur: 'blur@niro.local', corners: 'corners@niro.local'};
const SCHEMA = {niro: 'org.niro.control', island: 'org.gnome.shell.extensions.island', dock: 'org.gnome.shell.extensions.dock',
    blur: 'org.gnome.shell.extensions.blur-my-shell.applications', corners: 'org.gnome.shell.extensions.rounded-window-corners-reborn'};

/** NIRO_SCHEMA_DIR (tests) points at one folder of compiled schemas that holds them all. */
function open(source: string) {
    const test = GLib.getenv('NIRO_SCHEMA_DIR');
    const dirs = test ? [test] : source === 'niro' ? [null] : EXTENSION_DIRS.map(d => `${d}/${UUID[source]}/schemas`);
    for (const dir of dirs) {
        try {
            if (!dir)
                return new Gio.Settings({schema_id: SCHEMA[source]});
            const src = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
            const schema = src.lookup(SCHEMA[source], false);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch (_e) {
            // not here
        }
    }
    return null;
}

export class Stores {
    constructor() {
        this.by = {};
        for (const s of Object.keys(SCHEMA))
            this.by[s] = open(s);
    }

    has(source: string) {
        return Boolean(this.by[source]);
    }
}

export interface Binding {
    read(): any;
    write(value: any): void;
    reset(): void;
    isDefault(): boolean;
    subscribe(callback: () => void): () => void;
}

const reader = {b: 'get_boolean', i: 'get_int', u: 'get_uint', x: 'get_int64', d: 'get_double', s: 'get_string', as: 'get_strv'};
const writer = {b: 'set_boolean', i: 'set_int', u: 'set_uint', x: 'set_int64', d: 'set_double', s: 'set_string', as: 'set_strv'};

function check(ok: boolean, what: string) {
    if (!ok)
        throw new Error(`${what} can't be written (locked or read-only)`);
}

class KeyBinding {
    constructor(settings, key: string, type: string) {
        this.s = settings; this.key = key; this.type = type;
    }

    read() {
        return this.s[reader[this.type]](this.key);
    }

    write(value) {
        if (this.read() === value || (Array.isArray(value) && String(value) === String(this.read())))
            return; // no write for the same value
        check(this.s[writer[this.type]](this.key, value), this.key);
    }

    reset() {
        this.s.reset(this.key);
    }

    isDefault() {
        return this.s.get_value(this.key).equal(this.s.settings_schema.get_key(this.key).get_default_value());
    }

    /** The key this binding writes, for a snapshot: whether it holds a value of its own or is unset (the default, not stored). */
    keyRef() { return {settings: this.s, key: this.key, id: `${this.s.schema_id ?? this.s.settings_schema.get_id()}:${this.key}`}; }

    subscribe(callback) {
        const id = this.s.connect(`changed::${this.key}`, callback);
        return () => this.s.disconnect(id);
    }
}

// ---- Dictionary settings (rounded corners): one field of an a{sv}, the others left exactly as they were

function dictField(dict, path: string[]) {
    let node = dict;
    for (const part of path.slice(0, -1))
        node = node[part].deep_unpack();
    return node[path[path.length - 1]];
}

/** A variant like `like`, holding `value` (so a uint stays a uint). */
export function retype(like, value) {
    const t = like.get_type_string();
    if (t === 'b') return GLib.Variant.new_boolean(Boolean(value));
    if (t === 'd') return GLib.Variant.new_double(value);
    if (t === 'u') return GLib.Variant.new_uint32(value);
    if (t === 'x') return GLib.Variant.new_int64(value);
    if (t === 's') return GLib.Variant.new_string(String(value));
    return GLib.Variant.new_int32(value);
}

/** `dict` (an a{sv} unpacked once) with the field at `path` set to `value`. */
export function withField(dict, path: string[], value) {
    const copy = {...dict};
    if (path.length === 1) {
        copy[path[0]] = retype(copy[path[0]], value);
        return copy;
    }
    const inner = copy[path[0]].deep_unpack();
    copy[path[0]] = new GLib.Variant('a{sv}', withField(inner, path.slice(1), value));
    return copy;
}

class FieldBinding {
    constructor(settings, key: string, path: string[]) {
        this.s = settings; this.key = key; this.path = path;
    }

    get dict() {
        return this.s.get_value(this.key).deep_unpack();
    }

    read() {
        return dictField(this.dict, this.path).deep_unpack();
    }

    write(value) {
        if (this.read() === value)
            return;
        check(this.s.set_value(this.key, new GLib.Variant('a{sv}', withField(this.dict, this.path, value))), this.key);
    }

    reset() {
        const original = dictField(this.s.settings_schema.get_key(this.key).get_default_value().deep_unpack(), this.path).deep_unpack();
        this.write(original);
    }

    isDefault() {
        const original = dictField(this.s.settings_schema.get_key(this.key).get_default_value().deep_unpack(), this.path).deep_unpack();
        return this.read() === original;
    }

    keyRef() { return {settings: this.s, key: this.key, id: `${this.s.settings_schema.get_id()}:${this.key}`}; }

    subscribe(callback) {
        const id = this.s.connect(`changed::${this.key}`, callback);
        return () => this.s.disconnect(id);
    }
}

/** The numbers of a shadow (an a{si}): read as an object, written field by field. */
class ShadowBinding {
    constructor(settings, key: string) {
        this.s = settings; this.key = key;
    }

    read() {
        return this.s.get_value(this.key).deep_unpack();
    }

    write(obj) {
        check(this.s.set_value(this.key, new GLib.Variant('a{si}', obj)), this.key);
    }

    reset() {
        this.s.reset(this.key);
    }

    isDefault() {
        return this.s.get_value(this.key).equal(this.s.settings_schema.get_key(this.key).get_default_value());
    }

    keyRef() { return {settings: this.s, key: this.key, id: `${this.s.settings_schema.get_id()}:${this.key}`}; }

    subscribe(callback) {
        const id = this.s.connect(`changed::${this.key}`, callback);
        return () => this.s.disconnect(id);
    }
}

/** The binding of `item`: a list of them for a group of settings (Focus app 1 to 10, the two shadows). */
export function bindingFor(item: Item, stores: Stores) {
    const settings = stores.by[item.source];
    if (!settings)
        return null;
    if (item.kind === 'shortcuts')
        return Array.from({length: item.count}, (_v, i) => new KeyBinding(settings, `focus-app-${i + 1}`, 'as'));
    if (item.kind === 'dict')
        return item.keys.map(k => new ShadowBinding(settings, k));
    if (item.path)
        return new FieldBinding(settings, item.key, item.path);
    return new KeyBinding(settings, item.key, item.type);
}
