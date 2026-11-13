// @ts-nocheck: GTK / libadwaita are untyped here
// The model behind the pages (bindings, dependencies, shortcut conflicts) and the pages themselves.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {CATALOG} from './catalog.js';
import {
    advancedDisclosure, colorPicker, managedRow, settingsRow, settingsSection, settingsSelect, settingsSlider, settingsStepper,
    settingsSwitch, settingsText, shortcutRecorder, resetControl,
} from './components.js';
import type {Context} from './components.js';
import {dependencyMet} from './logic.js';
import {dockPreview, lookPreview, windowsPreview} from './previews.js';
import {bindingFor, Stores} from './store.js';
import type {Item} from './types.js';

const TONES = [['Ember', '#E8472B', '#1C1C1E'], ['Ocean', '#0A84FF', '#10161F'], ['Mint', '#30D158', '#101A14'],
    ['Violet', '#5E5CE6', '#171527'], ['Amber', '#FF9F0A', '#1C1810'], ['Mono', '#8E8E93', '#1C1C1E']];
const SYSTEM_SHORTCUT_SCHEMAS = ['org.gnome.desktop.wm.keybindings', 'org.gnome.shell.keybindings', 'org.gnome.mutter.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys'];

export class Model {
    constructor(ctx: Context) {
        this.ctx = ctx;
        this.stores = new Stores();
        this.cache = new Map();
        this.rows = new Map();     // item id -> the rows showing it (to grey them out when a dependency is off)
        this.byId = new Map(CATALOG.map(i => [i.id, i]));
        this.narrow = [];          // [widget, property, value] the window sets when it is narrow
        this.system = this.readSystemShortcuts();
    }

    item(id: string): Item {
        return this.byId.get(id);
    }

    /** Where an item's value lives: a managed one reads the Look item that owns it. */
    binding(item: Item) {
        const owner = item.managed ? this.item(item.managed) : item;
        if (!this.cache.has(owner.id))
            this.cache.set(owner.id, bindingFor(owner, this.stores));
        return this.cache.get(owner.id);
    }

    /** The live value of a setting by id: what the previews and the dependency checks use. */
    read = (id: string) => {
        const item = this.item(id);
        const b = item && this.binding(item);
        if (!b) return undefined;
        try {
            return Array.isArray(b) ? b.map(x => x.read()) : b.read();
        } catch (_e) {
            return undefined;
        }
    };

    available(item: Item) {
        return Boolean(this.binding(item));
    }

    // ---- Shortcut conflicts
    readSystemShortcuts() {
        const out = [];
        const source = Gio.SettingsSchemaSource.get_default();
        for (const id of SYSTEM_SHORTCUT_SCHEMAS) {
            const schema = source?.lookup(id, true);
            if (!schema) continue;
            const settings = new Gio.Settings({settings_schema: schema});
            for (const key of schema.list_keys()) {
                if (schema.get_key(key).get_value_type().dup_string() !== 'as') continue;
                for (const accel of settings.get_strv(key))
                    if (/[<]|^F\d|^XF86/.test(accel)) out.push({owner: `GNOME › ${key}`, accel});
            }
        }
        return out;
    }

    takenShortcuts(except: any[]) {
        const taken = [...this.system];
        for (const item of CATALOG.filter(i => i.kind === 'shortcut' || i.kind === 'shortcuts')) {
            const b = this.binding(item);
            if (!b) continue;
            (Array.isArray(b) ? b : [b]).forEach((one, n) => {
                if (except.includes(one)) return;
                const owner = `${item.menu} › ${item.title}${Array.isArray(b) ? ` ${n + 1}` : ''}`;
                for (const accel of one.read()) taken.push({owner, accel});
            });
        }
        return taken;
    }

    // ---- Dependencies
    track(item: Item, row) {
        if (!this.rows.has(item.id)) this.rows.set(item.id, []);
        this.rows.get(item.id).push(row);
        this.applyDependency(item, row);
        if (item.depends) {
            const dep = this.item(item.depends.id), b = dep && this.binding(dep);
            if (b && !Array.isArray(b)) b.subscribe(() => this.applyDependency(item, row));
        }
    }

    applyDependency(item: Item, row) {
        const met = dependencyMet(item, this.read);
        row.set_sensitive(met);
        const dep = item.depends && this.item(item.depends.id);
        if (dep) {
            const need = {on: 'is on', off: 'is off', eq: `is "${item.depends.value}"`, ne: `isn't "${item.depends.value}"`}[item.depends.op];
            row.set_tooltip_text(met ? (item.detail !== item.help ? item.detail : null) : `Available when "${dep.title}" ${need}`);
        }
    }

    // ---- Rows
    row(item: Item) {
        const ctx = this.ctx, b = this.binding(item);
        if (!b) {
            const gone = new Adw.ActionRow({title: GLib.markup_escape_text(item.title, -1), subtitle: 'Not available: its extension is not installed'});
            gone.set_sensitive(false);
            return gone;
        }
        let row;
        if (item.managed) {
            row = managedRow(item, this.managedText(item), ctx);
            b.subscribe(() => this.refreshManaged(row, item));
        } else if (item.kind === 'shortcuts') {
            row = new Adw.ExpanderRow({title: GLib.markup_escape_text(item.title, -1), subtitle: GLib.markup_escape_text(item.help, -1)});
            row.set_name(item.id);
            b.forEach((one, i) => {
                const sub = new Adw.ActionRow({title: `${item.title.replace(/ \d+ to \d+/, '')} ${i + 1}`});
                sub.add_suffix(resetControl(one, ctx, `Focus app ${i + 1}`));
                sub.add_suffix(shortcutRecorder(`Focus app ${i + 1}`, one, ctx, [one]).widget);
                row.add_row(sub);
            });
        } else if (item.kind === 'dict') {
            row = new Adw.ExpanderRow({title: GLib.markup_escape_text(item.title, -1), subtitle: GLib.markup_escape_text(item.help, -1)});
            row.set_name(item.id);
            const names = {horizontalOffset: 'Horizontal offset', verticalOffset: 'Vertical offset', blurOffset: 'Blur', spreadRadius: 'Spread', opacity: 'Opacity'};
            ['Focused', 'Unfocused'].forEach((which, n) => {
                item.fields.forEach(f => {
                    const field = {id: `${item.id}.${which}.${f}`, title: `${which} window: ${names[f].toLowerCase()}`, kind: 'stepper', min: f === 'opacity' ? 0 : -200,
                        max: f === 'opacity' ? 100 : 200, step: 1, digits: 0, unit: f === 'opacity' ? '%' : 'px', help: '', detail: ''};
                    const sub = {read: () => b[n].read()[f], write: v => b[n].write({...b[n].read(), [f]: v}), reset: () => b[n].reset(),
                        isDefault: () => b[n].isDefault(), subscribe: cb => b[n].subscribe(cb)};
                    const control = settingsStepper(field, sub, ctx);
                    const r = settingsRow(field, control, null, ctx);
                    row.add_row(r);
                });
            });
            const reset = new Gtk.Button({label: 'Reset', css_classes: ['flat'], valign: Gtk.Align.CENTER});
            reset.connect('clicked', () => b.forEach(x => x.reset()));
            row.add_suffix(reset);
        } else {
            let control;
            switch (item.kind) {
            case 'switch': control = settingsSwitch(item, b, ctx); break;
            case 'slider': control = settingsSlider(item, b, ctx); break;
            case 'stepper': control = settingsStepper(item, b, ctx); break;
            case 'select': control = settingsSelect(item, b, ctx); break;
            case 'color': control = colorPicker(item, b, ctx); break;
            case 'shortcut': control = shortcutRecorder(item.title, b, ctx); break;
            case 'list': control = settingsText(item, b, ctx, true); break;
            default: control = settingsText(item, b, ctx); break;
            }
            row = settingsRow(item, control, b, ctx);
        }
        this.track(item, row);
        return row;
    }

    valueText(item: Item) {
        const v = this.read(item.id);
        if (v === undefined) return '';
        if (item.kind === 'switch') return v ? 'On' : 'Off';
        return `${typeof v === 'number' ? (item.digits ? v.toFixed(item.digits) : Math.round(v)) : v}${item.unit ? ' ' + item.unit : ''}`;
    }

    /** What a managed setting shows in place of a control. */
    managedText(item: Item) {
        return item.id === 'dock.custom-css' ? 'Follows the accent' : this.valueText(this.item(item.managed));
    }

    refreshManaged(row, item: Item) {
        row.set_subtitle(GLib.markup_escape_text(`${item.help || 'Set in Look.'} Now: ${this.managedText(item)}`, -1));
    }

    /** A section of rows (the advanced ones in a disclosure at its end) with a reset for the whole group. */
    section(title: string, items: Item[], description = '') {
        const group = settingsSection(title, description, () => this.confirmReset(title, items));
        const advanced = items.filter(i => i.advanced && !i.managed);
        items.filter(i => !advanced.includes(i)).forEach(i => group.add(this.row(i)));
        if (advanced.length) {
            const more = advancedDisclosure();
            advanced.forEach(i => more.add_row(this.row(i)));
            group.add(more);
        }
        return group;
    }

    confirmReset(title: string, items: Item[]) {
        const dialog = Adw.AlertDialog.new(`Reset "${title}"?`, 'Every setting in this section goes back to its default. Settings that Look controls are left alone.');
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this.ctx.window, null, (_d, result) => {
            if (dialog.choose_finish(result) !== 'reset') return;
            for (const item of items.filter(i => !i.managed)) {
                const b = this.binding(item);
                try {
                    (Array.isArray(b) ? b : [b]).forEach(x => x?.reset());
                } catch (e) {
                    this.ctx.toast(`Couldn't reset "${item.title}": ${e.message}`);
                }
            }
        });
    }
}

const scrolled = child => new Gtk.ScrolledWindow({child, hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true});
const page = (...children) => {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    children.forEach(c => box.append(c));
    return scrolled(new Adw.Clamp({child: box, maximum_size: 760, tightening_threshold: 600}));
};

function previewBlock(model: Model, p) {
    const redraw = () => p.area.queue_draw();
    p.ids.forEach(id => {
        const b = model.binding(model.item(id) ?? {});
        if (b && !Array.isArray(b)) b.subscribe(redraw);
        else if (Array.isArray(b)) b.forEach(x => x.subscribe(redraw));
    });
    return p.frame;
}

// ---- Look
export function lookPage(model: Model) {
    const items = CATALOG.filter(i => i.menu === 'Look');
    const accent = model.item('niro.accent'), tint = model.item('niro.tint');
    const tone = settingsSection('Theme', 'One accent and one tint for the whole desktop');
    const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 6, min_children_per_line: 3, column_spacing: 8, row_spacing: 8, homogeneous: true});
    const buttons = [];
    for (const [name, a, t] of TONES) {
        const button = new Gtk.Button({css_classes: ['niro-preset']});
        const inner = new Gtk.Box({spacing: 8, halign: Gtk.Align.CENTER});
        const swatch = new Gtk.DrawingArea({content_width: 18, content_height: 18});
        const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
        swatch.set_draw_func((_a, cr, w, h) => {
            const [tr, tg, tb] = hex(t), [ar, ag, ab] = hex(a);
            cr.setSourceRGBA(tr, tg, tb, 1); cr.arc(w / 2, h / 2, 9, 0, 6.3); cr.fill();
            cr.setSourceRGBA(ar, ag, ab, 1); cr.arc(w / 2, h / 2, 5, 0, 6.3); cr.fill();
            cr.$dispose?.();
        });
        inner.append(swatch); inner.append(new Gtk.Label({label: name}));
        button.set_child(inner);
        button.connect('clicked', () => { model.binding(accent).write(a); model.binding(tint).write(t); });
        button.update_property([Gtk.AccessibleProperty.LABEL], [`Use the ${name} tone`]);
        flow.append(button); buttons.push([button, a, t]);
    }
    const mark = () => buttons.forEach(([b, a, t]) => {
        const on = model.read('niro.accent')?.toUpperCase() === a && model.read('niro.tint')?.toUpperCase() === t;
        on ? b.add_css_class('suggested-action') : b.remove_css_class('suggested-action');
    });
    mark(); model.binding(accent).subscribe(mark); model.binding(tint).subscribe(mark);
    const box = new Adw.PreferencesGroup(); box.add(flow);
    const toneGroup = settingsSection('Tone', '', () => model.confirmReset('Tone', items.filter(i => i.group === 'Tone')));
    items.filter(i => i.group === 'Tone').forEach(i => toneGroup.add(model.row(i)));
    const more = advancedDisclosure();
    for (const it of [accent, tint]) {
        const hex = colorPicker(it, model.binding(it), model.ctx, true);
        const row = new Adw.ActionRow({title: `${it.title} (hex)`, subtitle: 'Write it as #RRGGBB'});
        row.add_suffix(hex.widget); more.add_row(row);
    }
    toneGroup.add(more);
    const glass = model.section('Glass', items.filter(i => i.group === 'Glass'), 'Shared by the island, the dock and the windows');
    return page(previewBlock(model, lookPreview(model.read)), tone && box, toneGroup, glass);
}

// ---- A module with sub-pages (Island, Dock): a list of its groups beside them
function subnav(model: Model, menu: string, order: string[], header?: any) {
    const items = CATALOG.filter(i => i.menu === menu);
    const groups = order.filter(g => items.some(i => i.group === g));
    const stack = new Gtk.Stack({hexpand: true, vexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
    const list = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
    list.update_property([Gtk.AccessibleProperty.LABEL], [`${menu} sections`]);
    for (const g of groups) {
        const gi = items.filter(i => i.group === g);
        const label = new Gtk.Label({label: g, xalign: 0, margin_top: 8, margin_bottom: 8, margin_start: 6, margin_end: 6});
        const count = new Gtk.Label({label: String(gi.length), css_classes: ['dim-label', 'caption'], hexpand: true, xalign: 1});
        const box = new Gtk.Box({spacing: 6}); box.append(label); box.append(count);
        const row = new Gtk.ListBoxRow({child: box}); row.set_name(g);
        list.append(row);
        stack.add_named(page(model.section(g, gi)), g);
    }
    // in a narrow window the list becomes a menu above the page
    const picker = Gtk.DropDown.new_from_strings(groups);
    picker.set_visible(false); picker.set_margin_start(14); picker.set_margin_end(14); picker.set_margin_top(8);
    picker.update_property([Gtk.AccessibleProperty.LABEL], ['Section']);
    let syncing = false;
    list.connect('row-selected', (_l, row) => {
        if (!row) return;
        stack.set_visible_child_name(row.get_name());
        syncing = true; picker.set_selected(groups.indexOf(row.get_name())); syncing = false;
    });
    picker.connect('notify::selected', () => !syncing && list.select_row(list.get_row_at_index(picker.get_selected())));
    list.select_row(list.get_row_at_index(0));
    const side = new Gtk.ScrolledWindow({child: list, hscrollbar_policy: Gtk.PolicyType.NEVER, min_content_width: 200, vexpand: true, css_classes: ['niro-subnav']});
    const rule = new Gtk.Separator();
    const body = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
    body.append(side); body.append(rule); body.append(stack);
    const outer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    if (header) outer.append(header);
    outer.append(picker); outer.append(body);
    model.narrow.push([picker, 'visible', true], [side, 'visible', false], [rule, 'visible', false]);
    return outer;
}

export const islandPage = (model: Model) => subnav(model, 'Island', ['Appearance and Behavior', 'Alerts', 'Music', 'Focus', 'Clipboard',
    'Voice Assistant', 'AI Usage', 'AI Agents', 'Shortcuts', 'Pages and Features']);

export function dockPage(model: Model) {
    const preview = new Gtk.Box({margin_top: 14, margin_start: 18, margin_end: 18, margin_bottom: 6});
    preview.append(previewBlock(model, dockPreview(model.read)));
    preview.get_first_child().set_hexpand(true);
    return subnav(model, 'Dock', ['Appearance', 'Motion', 'Applications and Indicators', 'Windows and Media', 'Shortcuts'], preview);
}

export function windowsPage(model: Model) {
    const items = CATALOG.filter(i => i.menu === 'Windows');
    return page(previewBlock(model, windowsPreview(model.read)),
        model.section('Window Blur', items.filter(i => i.group === 'Window Blur'), 'Opacity and blur are set once, in Look'),
        model.section('Rounded Corners', items.filter(i => i.group === 'Rounded Corners')));
}

export function searchPage(model: Model) {
    const items = CATALOG.filter(i => i.menu === 'Search');
    return page(model.section('Application Search', items, 'Finds the applications you have installed as you type. Its tone and opacity follow Look.'));
}

// ---- About
export function aboutPage(model: Model) {
    let version = 'development build';
    try { version = new TextDecoder().decode(GLib.file_get_contents('/usr/share/niro-control/VERSION')[1]).trim(); } catch (_e) { /* not installed */ }
    const group = new Adw.PreferencesGroup({title: 'Niro Control', description: `Version ${version}`});
    const parts = [['Island', 'island@niro.local'], ['Dock', 'dock@niro.local'], ['Search', 'search@niro.local'], ['Window blur', 'blur@niro.local'],
        ['Rounded corners', 'corners@niro.local'], ['Emoji', 'emoji@niro.local'], ['Emulator', 'emulator@niro.local']];
    const installed = uuid => GLib.file_test(`/usr/share/gnome-shell/extensions/${uuid}`, GLib.FileTest.IS_DIR);
    const parts_group = new Adw.PreferencesGroup({title: 'Parts'});
    for (const [name, uuid] of parts) {
        const row = new Adw.ActionRow({title: name, subtitle: uuid});
        row.add_suffix(new Gtk.Label({label: installed(uuid) ? 'Installed' : 'Missing', css_classes: [installed(uuid) ? 'success' : 'error']}));
        parts_group.add(row);
    }
    const actions = new Adw.PreferencesGroup({title: 'After an update'});
    const logout = new Adw.ActionRow({title: 'Log out', subtitle: 'The shell loads new versions of Island, Dock and Search when you log in again', activatable: true});
    logout.add_suffix(new Gtk.Image({icon_name: 'system-log-out-symbolic'}));
    logout.connect('activated', () => { try { Gio.Subprocess.new(['gnome-session-quit', '--logout'], Gio.SubprocessFlags.NONE); } catch (e) { model.ctx.toast(`Couldn't log out: ${e.message}`); } });
    actions.add(logout);
    return page(group, parts_group, actions);
}

// ---- Search results: the same rows, found by what they say
export function resultsPage(model: Model, found: Item[], query: string) {
    if (!found.length) {
        return new Adw.StatusPage({icon_name: 'edit-find-symbolic', title: 'No settings found', description: `Nothing matches "${query}"`, vexpand: true});
    }
    const groups = [];
    for (const item of found) {
        const key = `${item.menu} › ${item.group}`;
        let g = groups.find(x => x.key === key);
        if (!g) groups.push(g = {key, items: []});
        g.items.push(item);
    }
    const box = [];
    for (const g of groups) {
        const section = settingsSection(g.key);
        g.items.forEach(i => section.add(model.row(i)));
        box.push(section);
    }
    box.unshift(new Gtk.Label({label: `${found.length} setting${found.length === 1 ? '' : 's'}`, xalign: 0, css_classes: ['dim-label']}));
    return page(...box);
}
