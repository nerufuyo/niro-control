// @ts-nocheck: GTK / libadwaita are untyped here
// The Hyprland page: the compositor's look and behavior (gaps, corners, blur, shadow, opacity, animations, input), set from the
// panel. It is only there where Hyprland is. Settings go to ~/.config/hypr/niro.conf and are applied at once with
// `hyprctl keyword`; hyprland.conf gets one marked `source` line, added and removed from here, and nothing else of it is touched.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {addSource, BY_KEY, changed, DEFS, format, GROUPS, hasSource, keywordArgs, parse, PRESETS, removeSource, serialize} from './hyprland.js';
import type {Def, Overrides, Value} from './hyprland.js';

/** Hypr's config directory; `NIRO_HYPR_DIR` lets a test use another. */
export const hyprDir = () => GLib.getenv('NIRO_HYPR_DIR') ?? GLib.build_filenamev([GLib.get_user_config_dir(), 'hypr']);
const nirConf = () => GLib.build_filenamev([hyprDir(), 'niro.conf']);
const mainConf = () => GLib.build_filenamev([hyprDir(), 'hyprland.conf']);

/** Whether the page is worth showing: Hyprland is installed or this is a Hyprland session (`NIRO_HYPRLAND=1` forces it). */
export function hyprlandPresent(): boolean {
    return GLib.getenv('NIRO_HYPRLAND') === '1' || GLib.getenv('HYPRLAND_INSTANCE_SIGNATURE') !== null
        || GLib.find_program_in_path('hyprctl') !== null || GLib.file_test(hyprDir(), GLib.FileTest.IS_DIR);
}

const read = (path: string): string => {
    try { return new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1]); } catch (_e) { return ''; }
};
const write = (path: string, text: string) => {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
};

/**
 * `hyprctl keyword`, when there is a running Hyprland: the change shows now, no reload. Nothing happens, quietly, elsewhere.
 * `done` is told how it went: Hyprland answers "ok", or says why not (a layout an older version does not have).
 */
function applyNow(def: Def, value: Value, done?: (ok: boolean, message: string) => void) {
    if (!GLib.getenv('HYPRLAND_INSTANCE_SIGNATURE') || !GLib.find_program_in_path('hyprctl')) return;
    try {
        const p = Gio.Subprocess.new(['hyprctl', ...keywordArgs(def, value)], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        p.communicate_utf8_async(null, null, (_p, res) => {
            try {
                const out = (p.communicate_utf8_finish(res)[1] ?? '').trim();
                done?.(out === 'ok' || out === '', out);
            } catch (_e) { /* the file has it */ }
        });
    } catch (_e) { /* the file has it */ }
}

export function hyprlandPage(_model, ctx) {
    let values: Overrides = parse(read(nirConf()));
    const rows = new Map<string, {sync: () => void}>();
    let syncing = false;

    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    const page = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({child: root, maximum_size: 860, tightening_threshold: 600})});

    const save = () => { write(nirConf(), serialize(changed(values))); };
    const set = (def: Def, value: Value | undefined) => {
        if (value === undefined) delete values[def.key]; else values[def.key] = value;
        save();
        rows.get(def.key)?.sync();
        applyNow(def, value ?? def.default, (ok, message) => {
            // a value this Hyprland does not take (Scrolling on an older one): put the old value back and say why
            if (ok || def.kind !== 'select') return;
            delete values[def.key]; save(); rows.get(def.key)?.sync();
            const d = Adw.AlertDialog.new(`${def.title}: not accepted`, `This Hyprland answered: ${message}. The setting is back at its default.`);
            d.add_response('ok', 'OK'); d.present(ctx?.window);
        });
    };

    // ---- Connection to hyprland.conf
    const link = new Adw.PreferencesGroup({title: 'Connection', description: 'Niro keeps its settings in its own file, so your hyprland.conf stays as you wrote it.'});
    const state = new Adw.ActionRow({title: 'hyprland.conf reads Niro\'s settings'});
    const toggle = new Gtk.Button({label: 'Connect', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
    state.add_suffix(toggle);
    const syncLink = () => {
        const on = hasSource(read(mainConf()));
        state.set_subtitle(on ? `One line in ${mainConf()} loads ${nirConf()}` : `Adds one line to ${mainConf()}; remove it here any time`);
        toggle.set_label(on ? 'Disconnect' : 'Connect');
        toggle.remove_css_class(on ? 'suggested-action' : 'destructive-action'); toggle.add_css_class(on ? 'destructive-action' : 'suggested-action');
    };
    toggle.connect('clicked', () => {
        try {
            const conf = read(mainConf());
            if (hasSource(conf)) write(mainConf(), removeSource(conf));
            else { save(); write(mainConf(), addSource(conf, nirConf())); }
            syncLink();
            if (GLib.getenv('HYPRLAND_INSTANCE_SIGNATURE') && GLib.find_program_in_path('hyprctl')) Gio.Subprocess.new(['hyprctl', 'reload'], 0);
        } catch (e) {
            const d = Adw.AlertDialog.new('Could not change hyprland.conf', e.message); d.add_response('ok', 'OK'); d.present(ctx?.window);
        }
    });
    link.add(state);
    root.append(link);
    syncLink();

    // ---- Presets
    const presets = new Adw.PreferencesGroup({title: 'Start from'});
    const names = Object.keys(PRESETS);
    const preset = new Adw.ComboRow({title: 'Preset', subtitle: 'Sets the values below; each can still be changed', model: Gtk.StringList.new(['Choose…', ...names.map(n => PRESETS[n].title)])});
    preset.connect('notify::selected', () => {
        const name = names[preset.selected - 1];
        if (!name || syncing) return;
        syncing = true;
        try {
            // the look only: input and miscellaneous settings are not the preset's to change
            for (const def of DEFS.filter(d => !['Input', 'Miscellaneous'].includes(d.group))) set(def, PRESETS[name].values[def.key]);
        } finally { syncing = false; }
        preset.set_selected(0);
    });
    presets.add(preset);
    root.append(presets);

    // ---- Settings
    for (const group of GROUPS) {
        const g = new Adw.PreferencesGroup({title: group});
        for (const def of DEFS.filter(d => d.group === group)) {
            let row, get, put;
            if (def.kind === 'switch') {
                row = new Adw.SwitchRow({title: def.title, subtitle: def.subtitle ?? ''});
                get = () => row.active; put = v => row.set_active(Boolean(v));
                row.connect('notify::active', () => { if (!syncing) set(def, row.active); });
            } else if (def.kind === 'select') {
                row = new Adw.ComboRow({title: def.title, subtitle: def.subtitle ?? '', model: Gtk.StringList.new(def.options.map(o => o[1]))});
                get = () => def.options[row.selected][0]; put = v => row.set_selected(Math.max(0, def.options.findIndex(o => o[0] === String(v))));
                row.connect('notify::selected', () => { if (!syncing) set(def, get()); });
            } else {
                const digits = def.kind === 'int' ? 0 : def.step < 0.01 ? 3 : 2;
                row = new Adw.SpinRow({title: def.title, subtitle: def.subtitle ?? '', digits, adjustment: new Gtk.Adjustment({lower: def.min, upper: def.max, step_increment: def.step, page_increment: def.step * 5})});
                get = () => row.value; put = v => row.set_value(Number(v));
                row.connect('notify::value', () => { if (!syncing) set(def, def.kind === 'int' ? Math.round(row.value) : Math.round(row.value * 10000) / 10000); });
            }
            const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Back to the default', css_classes: ['flat', 'circular']});
            reset.update_property([Gtk.AccessibleProperty.LABEL], [`Reset ${def.title}`]);
            reset.connect('clicked', () => set(def, undefined));
            row.add_suffix(reset);
            const sync = () => {
                syncing = true;
                try { put(values[def.key] ?? def.default); } finally { syncing = false; }
                reset.set_visible(values[def.key] !== undefined && format(def, values[def.key]) !== format(def, def.default));
            };
            rows.set(def.key, {sync});
            sync();
            g.add(row);
        }
        root.append(g);
    }
    return {widget: page, values: () => values, reload: () => { values = parse(read(nirConf())); for (const r of rows.values()) r.sync(); syncLink(); }};
}
