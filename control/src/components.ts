// @ts-nocheck: GTK / libadwaita are untyped here
// The panel's reusable pieces: SettingsRow, SettingsSection, SettingsSwitch, SettingsSlider, SettingsStepper,
// SettingsSelect, ShortcutRecorder, ColorPicker, AdvancedDisclosure, SettingsSearch, PreviewPanel, ResetControl.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {canonicalAccel, findConflict, hasModifier} from './logic.js';
import type {Binding} from './store.js';
import type {Item} from './types.js';

/** What the rows need from the window around them. */
export interface Context {
    toast(message: string, retry?: () => void): void;
    openLook(): void;
    /** The shortcuts already taken, other than `except`'s own. */
    takenShortcuts(except: Binding[]): {owner: string; accel: string}[];
    inhibitShortcuts(on: boolean): void;
}

const guard = (ctx: Context, what: string, action: () => void) => {
    try {
        action();
    } catch (e) {
        ctx.toast(`Couldn't save "${what}": ${e.message}`, () => guard(ctx, what, action));
    }
};

// ---- ResetControl
export function resetControl(binding: Binding, ctx: Context, title: string) {
    const button = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat', 'circular'],
        tooltip_text: 'Reset to default', visible: false});
    button.update_property([Gtk.AccessibleProperty.LABEL], [`Reset ${title} to its default`]);
    button.connect('clicked', () => guard(ctx, title, () => binding.reset()));
    const sync = () => (button.visible = !binding.isDefault());
    sync();
    binding.subscribe(sync);
    return button;
}

// ---- Controls: each takes a binding and keeps itself in step with it
function bound(binding: Binding, widgetSet: (v: any) => void) {
    const sync = () => widgetSet(binding.read());
    sync();
    binding.subscribe(sync);
}

export function settingsSwitch(item: Item, binding: Binding, ctx: Context) {
    const sw = new Gtk.Switch({valign: Gtk.Align.CENTER});
    let busy = false;
    bound(binding, v => { busy = true; sw.set_active(Boolean(v)); busy = false; });
    sw.connect('notify::active', () => !busy && guard(ctx, item.title, () => binding.write(sw.get_active())));
    return {widget: sw, activatable: sw};
}

export function settingsSlider(item: Item, binding: Binding, ctx: Context) {
    const box = new Gtk.Box({spacing: 10, valign: Gtk.Align.CENTER});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, item.min, item.max, item.step || 1);
    scale.set_size_request(190, -1);
    scale.set_draw_value(false);
    const text = new Gtk.Label({css_classes: ['dim-label', 'numeric'], width_chars: 5, xalign: 1});
    const show = v => text.set_label(`${Number(v).toFixed(item.digits ?? 0)}${item.unit ? ' ' + item.unit : ''}`);
    let busy = false;
    bound(binding, v => { busy = true; scale.set_value(v); show(v); busy = false; });
    scale.connect('value-changed', () => {
        if (busy) return;
        const v = item.digits ? scale.get_value() : Math.round(scale.get_value());
        show(v);
        guard(ctx, item.title, () => binding.write(v));
    });
    scale.update_property([Gtk.AccessibleProperty.LABEL], [item.title]);
    box.append(scale); box.append(text);
    return {widget: box, focus: scale};
}

export function settingsStepper(item: Item, binding: Binding, ctx: Context) {
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    const spin = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: item.min, upper: item.max, step_increment: item.step || 1,
        page_increment: (item.step || 1) * 10}), digits: item.digits ?? 0, width_chars: 6, numeric: true});
    let busy = false;
    bound(binding, v => { busy = true; spin.set_value(Number(v)); busy = false; });
    spin.connect('value-changed', () => !busy && guard(ctx, item.title, () => binding.write(item.digits ? spin.get_value() : Math.round(spin.get_value()))));
    spin.update_property([Gtk.AccessibleProperty.LABEL], [item.title]);
    box.append(spin);
    if (item.unit)
        box.append(new Gtk.Label({label: item.unit, css_classes: ['dim-label']}));
    return {widget: box, focus: spin};
}

export function settingsSelect(item: Item, binding: Binding, ctx: Context) {
    const labels = item.options.map(o => o.label);
    const drop = Gtk.DropDown.new_from_strings(labels);
    drop.set_valign(Gtk.Align.CENTER);
    let busy = false;
    bound(binding, v => {
        busy = true;
        const at = item.options.findIndex(o => String(o.value) === String(v));
        drop.set_selected(at < 0 ? 0 : at);
        busy = false;
    });
    drop.connect('notify::selected', () => {
        if (busy) return;
        const value = item.options[drop.get_selected()].value;
        guard(ctx, item.title, () => binding.write(value));
    });
    drop.update_property([Gtk.AccessibleProperty.LABEL], [item.title]);
    return {widget: drop, focus: drop};
}

const hexOf = rgba => '#' + [rgba.red, rgba.green, rgba.blue].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const rgbaOf = hex => { const c = new Gdk.RGBA(); c.parse(hex); return c; };

/** A colour swatch that opens the colour dialog; `withHex` adds a field for the hex value. */
export function colorPicker(item: Item, binding: Binding, ctx: Context, withHex = false) {
    const box = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), valign: Gtk.Align.CENTER});
    button.update_property([Gtk.AccessibleProperty.LABEL], [item.title]);
    const entry = new Gtk.Entry({max_length: 9, width_chars: 9, visible: withHex, css_classes: ['monospace']});
    let busy = false;
    bound(binding, v => { busy = true; button.set_rgba(rgbaOf(v)); entry.set_text(String(v).toUpperCase()); busy = false; });
    button.connect('notify::rgba', () => {
        if (busy) return;
        const hex = hexOf(button.get_rgba());
        guard(ctx, item.title, () => binding.write(hex));
    });
    const applyHex = () => {
        const text = entry.get_text().trim();
        const c = new Gdk.RGBA();
        if (!/^#[0-9a-fA-F]{6}$/.test(text) || !c.parse(text)) {
            ctx.toast(`"${text}" isn't a colour: write it as #RRGGBB`);
            entry.set_text(binding.read());
            return;
        }
        guard(ctx, item.title, () => binding.write(text.toUpperCase()));
    };
    entry.connect('activate', applyHex);
    box.append(button); if (withHex) box.append(entry);
    return {widget: box, focus: button};
}

export function settingsText(item: Item, binding: Binding, ctx: Context, list = false) {
    const entry = new Gtk.Entry({width_chars: list ? 26 : 22, valign: Gtk.Align.CENTER, hexpand: false,
        placeholder_text: list ? 'comma-separated' : ''});
    let busy = false;
    bound(binding, v => { busy = true; entry.set_text(list ? v.join(', ') : String(v)); busy = false; });
    const apply = () => {
        if (busy) return;
        const text = entry.get_text();
        guard(ctx, item.title, () => binding.write(list ? text.split(',').map(t => t.trim()).filter(Boolean) : text));
    };
    entry.connect('activate', apply);
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', apply);
    entry.add_controller(focus);
    entry.update_property([Gtk.AccessibleProperty.LABEL], [item.title]);
    return {widget: entry, focus: entry};
}

// ---- ShortcutRecorder
const MODIFIER_KEYS = new Set([Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock]);

/** Records a key combination; refuses one another shortcut already uses. Backspace clears, Esc cancels. */
export function shortcutRecorder(title: string, binding: Binding, ctx: Context, siblings: Binding[] = [binding]) {
    const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
    const button = new Gtk.Button({css_classes: ['flat'], can_focus: true});
    const shown = new Gtk.ShortcutLabel({disabled_text: 'Disabled'});
    const hint = new Gtk.Label({label: 'Press the new shortcut…', css_classes: ['dim-label']});
    const stack = new Gtk.Stack(); stack.add_named(shown, 'shown'); stack.add_named(hint, 'hint');
    button.set_child(stack);
    button.set_tooltip_text('Click, then press the shortcut. Backspace clears; Esc cancels.');
    button.update_property([Gtk.AccessibleProperty.LABEL], [`${title}: shortcut`]);
    let recording = false;
    const show = () => { const [first] = binding.read(); shown.set_accelerator(first ?? ''); };
    show(); binding.subscribe(show);

    const stop = () => { recording = false; stack.set_visible_child_name('shown'); ctx.inhibitShortcuts(false); };
    const commit = accel => {
        if (accel && !hasModifier(accel)) { ctx.toast('Use at least one modifier key (Super, Alt, Ctrl) with it'); return; }
        const clash = accel && findConflict(accel, ctx.takenShortcuts(siblings));
        if (clash) { ctx.toast(`Already used by ${clash.owner}`); return; }
        stop();
        guard(ctx, title, () => binding.write(accel ? [canonicalAccel(accel)] : []));
    };
    button.connect('clicked', () => {
        if (recording) { stop(); return; }
        recording = true; stack.set_visible_child_name('hint'); ctx.inhibitShortcuts(true); button.grab_focus();
    });
    const press = (keyval, state) => {
        if (!recording) return false;
        if (keyval === Gdk.KEY_Escape) { stop(); return true; }
        if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) { commit(''); return true; }
        if (MODIFIER_KEYS.has(keyval)) return true;
        const accel = Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), state & Gtk.accelerator_get_default_mod_mask());
        if (accel) commit(accel);
        return true;
    };
    const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
    keys.connect('key-pressed', (_c, keyval, _code, state) => press(keyval, state));
    button.add_controller(keys);
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', () => recording && stop());
    button.add_controller(focus);

    // Where the system keeps the key from the app (Super+…), a typed shortcut does the same job.
    const type = new Gtk.MenuButton({icon_name: 'document-edit-symbolic', css_classes: ['flat', 'circular'], valign: Gtk.Align.CENTER,
        tooltip_text: 'Type the shortcut, as <Super>space'});
    type.update_property([Gtk.AccessibleProperty.LABEL], [`Type the shortcut for ${title}`]);
    const pop = new Gtk.Popover();
    const entry = new Gtk.Entry({placeholder_text: '<Super>space', width_chars: 18});
    entry.connect('activate', () => {
        const text = entry.get_text().trim();
        const [ok] = text ? Gtk.accelerator_parse(text) : [true];
        if (!ok) { ctx.toast(`"${text}" isn't a shortcut: write it like <Super>space`); return; }
        pop.popdown(); commit(text);
    });
    pop.set_child(entry); type.set_popover(pop);
    box.append(button); box.append(type);
    return {widget: box, focus: button, press, click: () => button.emit('clicked')};
}

// ---- SettingsRow: title, then the description below it, then the control and the reset button
export function settingsRow(item: Item, control: {widget: any; activatable?: any; focus?: any}, binding: Binding | null, ctx: Context) {
    const row = new Adw.ActionRow({title: GLib.markup_escape_text(item.title, -1), subtitle: GLib.markup_escape_text(item.help, -1),
        subtitle_lines: 0, title_lines: 0});
    row.set_name(item.id);
    if (item.detail && item.detail !== item.help)
        row.set_tooltip_text(item.detail);
    if (binding)
        row.add_suffix(resetControl(binding, ctx, item.title));
    row.add_suffix(control.widget);
    if (control.activatable)
        row.set_activatable_widget(control.activatable);
    else if (control.focus)
        row.set_activatable_widget(control.focus);
    return row;
}

/** A setting Look writes: its current value, and the way to Look. Never a second place to change it. */
export function managedRow(item: Item, value: string, ctx: Context) {
    const row = new Adw.ActionRow({title: GLib.markup_escape_text(item.title, -1), subtitle: GLib.markup_escape_text(item.help || 'Set in Look.', -1),
        subtitle_lines: 0});
    row.set_name(item.id);
    row.add_suffix(new Gtk.Label({label: value, css_classes: ['dim-label', 'numeric']}));
    const open = new Gtk.Button({label: 'Change in Look', css_classes: ['flat'], valign: Gtk.Align.CENTER});
    open.connect('clicked', () => ctx.openLook());
    row.add_suffix(open);
    return row;
}

// ---- SettingsSection / AdvancedDisclosure
export function settingsSection(title: string, description = '', onReset?: () => void) {
    const group = new Adw.PreferencesGroup({title: GLib.markup_escape_text(title, -1), description: GLib.markup_escape_text(description, -1)});
    if (onReset) {
        const reset = new Gtk.Button({label: 'Reset section', css_classes: ['flat']});
        reset.connect('clicked', onReset);
        group.set_header_suffix(reset);
    }
    return group;
}

export function advancedDisclosure() {
    return new Adw.ExpanderRow({title: 'Advanced', subtitle: 'Rarely changed', icon_name: 'preferences-other-symbolic'});
}

// ---- SettingsSearch
export function settingsSearch(onChange: (query: string) => void, onStop: () => void) {
    const entry = new Gtk.SearchEntry({placeholder_text: 'Search settings', hexpand: true});
    entry.update_property([Gtk.AccessibleProperty.LABEL], ['Search all settings']);
    entry.connect('search-changed', () => onChange(entry.get_text()));
    entry.connect('stop-search', () => { entry.set_text(''); onStop(); });
    return entry;
}

// ---- PreviewPanel: a drawn preview in a quiet frame, with a caption
export function previewPanel(caption: string, drawFn: (cr: any, w: number, h: number, area: any) => void, height = 190) {
    const frame = new Gtk.Frame({css_classes: ['niro-preview']});
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    const area = new Gtk.DrawingArea({content_height: height, hexpand: true});
    area.set_draw_func((a, cr, w, h) => { drawFn(cr, w, h, a); cr.$dispose?.(); });
    area.update_property([Gtk.AccessibleProperty.LABEL], [`${caption} (a drawing)`]);
    box.append(area);
    box.append(new Gtk.Label({label: caption, css_classes: ['dim-label', 'caption'], margin_top: 6, margin_bottom: 8}));
    frame.set_child(box);
    return {frame, area};
}
