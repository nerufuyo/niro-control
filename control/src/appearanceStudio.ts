// @ts-nocheck: GTK / libadwaita are untyped here
// Appearance Studio: one place to try a change to the dock, island, windows or the panel look, see it, and then apply it or cancel.
// The controls edit a draft (a transaction over the real settings); nothing is written until Apply, and Apply reads every value
// back and puts the old ones back if one did not stick. It uses the settings that already exist and adds none.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {
    ALL_IDS, COMPONENTS, createStudio, detectPreset, MOTION_CONSUMERS, MOTION_KEYS, motionPlan, paletteReport, parseDefault, PRESET_LABELS, PRESET_ORDER,
    sameValue,
} from './appearanceLogic.js';
import {colorPicker, settingsRow, settingsSection, settingsSelect, settingsSlider, settingsStepper, settingsSwitch} from './components.js';
import {dockPreview, lookPreview, windowsPreview} from './previews.js';
import {page} from './pages.js';

// a setting the dock, island and windows read through Panel look: the preview of one follows the other
const ALIAS = {'dock.dock-opacity': 'niro.opacity', 'dock.dock-background-color': 'niro.tint', 'dock.dock-blur-enabled': 'niro.blur',
    'windows.blur': 'niro.blur', 'windows.opacity': 'niro.opacity'};
const STATE_TEXT = {loading: 'Loading…', ready: 'Ready. Changes here are a draft until you press Apply.', disabled: 'Unavailable', error: 'Error',
    applying: 'Applying…', success: 'Applied', rollback: 'Rolled back'};
const STATE_CLASS = {success: 'success', rollback: 'error', error: 'error', disabled: 'warning', applying: 'accent'};

/** Whether the system asks for less motion (GNOME's animations switch off). */
function systemReducedMotion() {
    try {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source?.lookup('org.gnome.desktop.interface', true)) return false;
        return !new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_boolean('enable-animations');
    } catch (_e) {
        return false;
    }
}

/**
 * `io` (tests): {read, write, available, reducedMotion}; by default the real settings through the model's bindings.
 * Returns {widget, studio, dispose}: dispose disconnects everything the page subscribed to.
 */
export function appearanceStudioPage(model, ctx, io = {}) {
    const items = new Map(ALL_IDS.map(id => [id, model.item(id)]).filter(([, i]) => i));
    const bindingOf = id => { const item = items.get(id); return item ? model.binding(item) : null; };
    const real = {
        read: id => model.read(id),
        write: (id, value) => { const b = bindingOf(id); if (!b || Array.isArray(b)) throw new Error('not available'); b.write(value); },
        available: id => Boolean(items.get(id)) && Boolean(bindingOf(id)) && !Array.isArray(bindingOf(id)),
    };
    const IO = {...real, ...io};
    const defaults = Object.fromEntries([...items].map(([id, i]) => [id, parseDefault(i)]));
    const titles = Object.fromEntries([...items].map(([id, i]) => [id, i.title]));
    const studio = createStudio(ALL_IDS.filter(id => items.has(id)), IO, {defaults, titles});
    studio.load();    // before the rows: which settings can be applied decides which rows are controls
    const unsubs = [], controlListeners = new Set();
    let disposed = false;

    // ---- a binding for the controls that reads and writes the draft, never the settings
    const syncControls = () => [...controlListeners].forEach(cb => cb());
    const draftBinding = id => ({
        read: () => studio.value(id),
        write: v => {
            const r = studio.set(id, v);
            if (!r.ok) { syncControls(); throw new Error(r.reason); }
            if (r.note) ctx.toast(r.note);
        },
        reset: () => studio.reset(id),
        isDefault: () => sameValue(studio.value(id), defaults[id]),
        subscribe: cb => { controlListeners.add(cb); return () => controlListeners.delete(cb); },
    });

    const row = id => {
        const item = items.get(id);
        if (!item) return null;
        if (!studio.isSupported(id)) {
            const gone = new Adw.ActionRow({title: GLib.markup_escape_text(item?.title ?? id, -1),
                subtitle: GLib.markup_escape_text(`Unavailable: ${studio.unavailable().find(u => u.id === id)?.reason ?? 'it cannot be applied here'}`, -1)});
            gone.set_name(`studio:${id}`);
            gone.set_sensitive(false);
            return gone;
        }
        const b = draftBinding(id);
        let control;
        switch (item.kind) {
        case 'switch': control = settingsSwitch(item, b, ctx); break;
        case 'slider': control = settingsSlider(item, b, ctx); break;
        case 'stepper': control = settingsStepper(item, b, ctx); break;
        case 'select': control = settingsSelect(item, b, ctx); break;
        case 'color': control = colorPicker(item, b, ctx, true); break;
        default: return null;
        }
        const r = settingsRow(item, control, b, ctx);
        r.set_name(`studio:${id}`);
        return r;
    };

    // ---- previews: the same drawings as the module pages, reading the draft (or the settings as they are, with Before on)
    const read = id => studio.view(ALIAS[id] && studio.isSupported(ALIAS[id]) ? ALIAS[id] : id);
    const previews = {dock: dockPreview(read), windows: windowsPreview(read), look: lookPreview(read)};
    const previewStack = new Gtk.Stack({hexpand: true});
    for (const [name, p] of Object.entries(previews)) previewStack.add_named(p.frame, name);

    // ---- the parts of the page
    const status = new Gtk.Label({xalign: 0, wrap: true, hexpand: true, css_classes: ['heading']});
    const detail = new Gtk.Label({xalign: 0, wrap: true, selectable: false, css_classes: ['dim-label']});
    const summary = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['caption']});
    status.update_property([Gtk.AccessibleProperty.LABEL], ['Appearance Studio status']);
    const showing = new Gtk.Label({xalign: 0, css_classes: ['dim-label', 'caption']});

    const before = new Gtk.ToggleButton({label: 'Show before', tooltip_text: 'Draw the preview with the settings as they are now, without the draft'});
    before.connect('toggled', () => studio.setShowBefore(before.get_active()));
    const apply = new Gtk.Button({label: 'Apply', css_classes: ['suggested-action'], tooltip_text: 'Write the draft (Ctrl+Enter)'});
    const cancel = new Gtk.Button({label: 'Cancel', tooltip_text: 'Drop the draft; nothing was written (Esc)'});
    const resetAll = new Gtk.Button({label: 'Reset', tooltip_text: 'Put the defaults in the draft'});
    const restore = new Gtk.Button({label: 'Restore previous', tooltip_text: 'Put the values before the last Apply in the draft'});
    apply.connect('clicked', () => { studio.apply(); });
    cancel.connect('clicked', () => studio.cancel());
    resetAll.connect('clicked', () => studio.resetAll());
    restore.connect('clicked', () => { studio.restorePrevious(); });
    const actions = new Gtk.Box({spacing: 8, halign: Gtk.Align.START});
    [apply, cancel, resetAll, restore, before].forEach(b => actions.append(b));
    actions.update_property([Gtk.AccessibleProperty.LABEL], ['Appearance Studio actions']);

    // component picker: linked toggle buttons (Tab reaches them, Space chooses)
    const stack = new Gtk.Stack({hexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
    const picker = new Gtk.Box({css_classes: ['linked'], halign: Gtk.Align.START});
    picker.update_property([Gtk.AccessibleProperty.LABEL], ['Component to adjust']);
    let first = null;
    for (const c of COMPONENTS) {
        const group = settingsSection(c.label, c.note ?? '');
        for (const id of c.ids) { const r = row(id); if (r) group.add(r); }
        const children = [group];
        if (c.id === 'panel') children.push(themeGroup());
        stack.add_named(page(...children), c.id);
        const button = new Gtk.ToggleButton({label: c.label, tooltip_text: `Adjust the ${c.label.toLowerCase()}`});
        if (first) button.set_group(first);
        button.update_property([Gtk.AccessibleProperty.LABEL], [`Adjust ${c.label}`]);
        button.connect('toggled', () => {
            if (!button.get_active()) return;
            stack.set_visible_child_name(c.id);
            previewStack.set_visible_child_name(c.preview);
            showing.set_label(`Preview: ${c.label}`);
        });
        first ??= button;
        picker.append(button);
    }
    first.set_active(true);

    // ---- Theme: the accent and the contrast-checked palette made from it
    function themeGroup() {
        const group = settingsSection('Palette', 'The accent is checked against the surface tint: if it cannot be read there it is moved until it can, and you are told.');
        const note = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['caption']});
        note.update_property([Gtk.AccessibleProperty.LABEL], ['Accent contrast note']);
        const boxes = [true, false].map(dark => {
            const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 9, min_children_per_line: 2, column_spacing: 8, row_spacing: 6, homogeneous: false});
            flow.update_property([Gtk.AccessibleProperty.LABEL], [dark ? 'Palette on a dark surface' : 'Palette on a light surface']);
            return {dark, flow};
        });
        const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
        const fill = () => {
            const accent = String(studio.value('niro.accent') ?? '#E8472B');
            const adjusted = [];
            for (const {dark, flow} of boxes) {
                for (let c = flow.get_first_child(); c; c = flow.get_first_child()) flow.remove(c);
                const report = paletteReport(accent, dark);
                if (!report) { flow.append(new Gtk.Label({label: 'Not a colour yet'})); continue; }
                if (report.adjusted) adjusted.push(dark ? 'dark' : 'light');
                for (const t of report.tokens) {
                    const cell = new Gtk.Box({spacing: 6});
                    const sw = new Gtk.DrawingArea({content_width: 22, content_height: 22, accessible_role: Gtk.AccessibleRole.PRESENTATION});
                    sw.set_draw_func((_a, cr, w, h) => {
                        const [sr, sg, sb] = hex(report.surface), [r, g, b] = hex(t.color);
                        cr.setSourceRGBA(sr, sg, sb, 1); cr.rectangle(0, 0, w, h); cr.fill();
                        cr.setSourceRGBA(r, g, b, 1); cr.arc(w / 2, h / 2, 8, 0, 6.3); cr.fill();
                        cr.$dispose?.();
                    });
                    const text = `${t.token} ${t.color.toUpperCase()}, ${t.ratio.toFixed(1)}:1${t.min ? ` (needs ${t.min}:1)` : ''}`;
                    const label = new Gtk.Label({label: `${t.token} ${t.ratio.toFixed(1)}:1`, css_classes: ['caption', t.ok ? 'dim-label' : 'error']});
                    cell.append(sw); cell.append(label);
                    cell.update_property([Gtk.AccessibleProperty.LABEL], [`${text}${t.ok ? ', readable' : ', not readable'}`]);
                    cell.set_tooltip_text(text);
                    flow.append(cell);
                }
            }
            const lines = [];
            lines.push(adjusted.length ? `On the ${adjusted.join(' and ')} surface the chosen accent was lightened or darkened in the palette so text and graphics stay readable.` : 'The accent reads on both surfaces as it is.');
            lines.push(...studio.notes);
            note.set_label(lines.join(' '));
        };
        group.add(row('niro.accent') ?? new Gtk.Label());
        boxes.forEach(({dark, flow}) => {
            const holder = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 4});
            holder.append(new Gtk.Label({label: dark ? 'On a dark surface' : 'On a light surface', xalign: 0, css_classes: ['heading']}));
            holder.append(flow);
            group.add(holder);
        });
        group.add(note);
        controlListeners.add(fill);
        studio.subscribe(fill);
        fill();
        return group;
    }

    // ---- Motion: presets written onto the Dock's own settings
    const motion = settingsSection('Motion', 'Presets set the Dock\'s animation time and launch bounce. Nothing else reads a motion setting yet (see below).');
    const presetNames = [...PRESET_ORDER.map(p => PRESET_LABELS[p]), 'Custom values'];
    const dropdown = Gtk.DropDown.new_from_strings(presetNames);
    dropdown.set_valign(Gtk.Align.CENTER);
    dropdown.update_property([Gtk.AccessibleProperty.LABEL], ['Motion preset']);
    const reduced = new Gtk.Switch({valign: Gtk.Align.CENTER, active: IO.reducedMotion ? IO.reducedMotion() : systemReducedMotion()});
    reduced.update_property([Gtk.AccessibleProperty.LABEL], ['Reduced motion: 0 ms and no bounce']);
    const presetRow = new Adw.ActionRow({title: 'Preset', subtitle_lines: 0});
    presetRow.set_name('studio:motion-preset');
    presetRow.add_suffix(dropdown); presetRow.set_activatable_widget(dropdown);
    const reducedRow = new Adw.ActionRow({title: 'Reduced motion', subtitle_lines: 0,
        subtitle: 'Presets then write 0 ms and no bounce. It starts on when GNOME\'s animations switch is off.'});
    reducedRow.set_name('studio:motion-reduced');
    reducedRow.add_suffix(reduced); reducedRow.set_activatable_widget(reduced);
    let syncing = false, lastPreset = 'smooth';
    const choosePreset = () => {
        if (syncing) return;
        const name = PRESET_ORDER[dropdown.get_selected()];
        if (!name) return;
        lastPreset = name;
        const plan = motionPlan(name, reduced.get_active());
        for (const [id, v] of Object.entries(plan)) {
            const r = studio.set(id, v);
            if (!r.ok) ctx.toast(r.reason);
        }
        syncControls();
    };
    dropdown.connect('notify::selected', choosePreset);
    reduced.connect('notify::active', () => { if (!syncing) { const at = PRESET_ORDER.indexOf(lastPreset); dropdown.set_selected(at); choosePreset(); } });
    const syncPreset = () => {
        const d = studio.value('dock.animation-duration'), b = studio.value('dock.bounce-on-launch');
        const name = detectPreset(d, b);
        syncing = true;
        dropdown.set_selected(PRESET_ORDER.includes(name) ? PRESET_ORDER.indexOf(name) : PRESET_ORDER.length);
        syncing = false;
        if (PRESET_ORDER.includes(name)) lastPreset = name;
        presetRow.set_subtitle(GLib.markup_escape_text(studio.isSupported('dock.animation-duration')
            ? `Dock: ${d} ms, bounce ${b ? 'on' : 'off'}${name === 'reduced' ? ' (reduced motion)' : ''}` : 'Unavailable: the Dock is not installed', -1));
    };
    motion.add(presetRow); motion.add(reducedRow);
    for (const id of MOTION_KEYS) { const r = row(id); if (r) motion.add(r); }
    controlListeners.add(syncPreset); studio.subscribe(syncPreset); syncPreset();
    const consumers = settingsSection('Who uses motion today', 'Checked in the sources of each part.');
    for (const c of MOTION_CONSUMERS) {
        const r = new Adw.ActionRow({title: c.component, subtitle: GLib.markup_escape_text(c.how, -1), subtitle_lines: 0});
        r.add_suffix(new Gtk.Label({label: c.consumes ? 'Uses presets' : 'Not driven', css_classes: [c.consumes ? 'success' : 'dim-label']}));
        consumers.add(r);
    }

    // ---- layout
    const fmt = (id, v) => {
        const item = items.get(id);
        const o = item?.options?.find(x => String(x.value) === String(v));
        if (o) return o.label;
        if (typeof v === 'boolean') return v ? 'on' : 'off';
        return `${typeof v === 'number' && item?.digits ? v.toFixed(item.digits) : v}${item?.unit && typeof v === 'number' ? ' ' + item.unit : ''}`;
    };
    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 14, margin_start: 18, margin_end: 18, margin_bottom: 10});
    const top = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
    top.append(status); top.append(detail); top.append(previewStack); top.append(showing); top.append(picker); top.append(summary); top.append(actions);
    root.append(top);
    const body = page(stack, motion, consumers);
    const scroller = new Gtk.ScrolledWindow({child: body, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER});
    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    content.append(root); content.append(scroller);
    const loading = new Adw.StatusPage({icon_name: 'content-loading-symbolic', title: 'Loading', vexpand: true});
    const unavailable = new Adw.StatusPage({icon_name: 'dialog-warning-symbolic', title: 'Appearance Studio is unavailable', vexpand: true});
    const widget = new Gtk.Stack({hexpand: true, vexpand: true});
    widget.add_named(loading, 'loading'); widget.add_named(content, 'content'); widget.add_named(unavailable, 'unavailable');
    widget.set_visible_child_name('loading');

    const render = () => {
        const s = studio.state;
        const failed = s === 'disabled' || s === 'error';
        widget.set_visible_child_name(s === 'loading' ? 'loading' : failed ? 'unavailable' : 'content');
        if (failed) { unavailable.set_title(s === 'error' ? 'Appearance Studio hit an error' : 'Appearance Studio is unavailable'); unavailable.set_description(studio.message); }
        status.set_label(STATE_TEXT[s]);
        for (const c of ['success', 'error', 'warning', 'accent']) status.remove_css_class(c);
        if (STATE_CLASS[s]) status.add_css_class(STATE_CLASS[s]);
        detail.set_label(s === 'ready' && !studio.message ? '' : studio.message);
        detail.set_visible(Boolean(detail.get_label()));
        const changes = studio.changes();
        summary.set_label(changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'} in the draft: ${changes.map(c => `${titles[c.key] ?? c.key} ${fmt(c.key, c.before)} → ${fmt(c.key, c.after)}`).join('; ')}`
            : 'No changes in the draft.');
        const busy = s === 'applying' || failed || s === 'loading';
        apply.set_sensitive(!busy && changes.length > 0);
        cancel.set_sensitive(!busy && changes.length > 0);
        resetAll.set_sensitive(!busy);
        restore.set_sensitive(!busy && studio.canRestore());
        before.set_sensitive(!busy);
        Object.values(previews).forEach(p => p.area.queue_draw());
    };
    studio.subscribe(render);
    studio.subscribe(syncControls);

    // keyboard: Ctrl+Enter applies, Esc drops the draft (a control that handles Esc itself, like an open menu, gets it first)
    const keys = new Gtk.ShortcutController();
    keys.add_shortcut(new Gtk.Shortcut({trigger: Gtk.ShortcutTrigger.parse_string('<Control>Return'), action: Gtk.CallbackAction.new(() => { if (apply.get_sensitive()) studio.apply(); return true; })}));
    keys.add_shortcut(new Gtk.Shortcut({trigger: Gtk.ShortcutTrigger.parse_string('Escape'), action: Gtk.CallbackAction.new(() => { if (!cancel.get_sensitive()) return false; studio.cancel(); return true; })}));
    content.add_controller(keys);

    // the settings changed by something else (the Dock page, a profile): take the new values, keep the draft of what was changed here
    const external = () => { if (!disposed && studio.state !== 'applying') studio.refresh(); };
    for (const id of ALL_IDS) {
        if (!studio.isSupported(id)) continue;
        const b = bindingOf(id);
        if (b && !Array.isArray(b)) unsubs.push(b.subscribe(external));
    }
    render();

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubs.splice(0).forEach(u => { try { u(); } catch (_e) { /* already gone */ } });
        controlListeners.clear();
    };
    widget.connect('destroy', dispose);
    return {widget, studio, dispose, previews, apply, cancel, resetAll, restore, before, dropdown, reduced, stack, picker};
}
