// @ts-nocheck: GTK / libadwaita are untyped here
// The Tiling module of the panel: Overview, Layouts (ten cards with a diagram each), Workspaces, Window Rules, Appearance, Shortcuts, Monitors,
// Groups, Snapshots, Profiles and Advanced. It tells the extension what to do through TileBackend (D-Bus when the shell runs it, the settings otherwise) and
// says in words when something fails.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {CATALOG} from './catalog.js';
import {page} from './pages.js';
import {parseRules} from './tile/config.js';
import {arrange, LAYOUTS, LAYOUT_IDS} from './tile/layouts.js';
import {profileDir, TileBackend} from './tileBackend.js';

const SECTIONS = ['Overview', 'Layouts', 'Workspaces', 'Window Rules', 'Advanced Rules', 'Appearance', 'Shortcuts', 'Monitors', 'Groups', 'Snapshots', 'Profiles', 'Advanced'];
const TITLES = Object.fromEntries(LAYOUTS.map(([id, title]) => [id, title]));
const group = (title, description = '') => new Adw.PreferencesGroup({title, description});

/** Draws `layout` for four windows: the card's picture. Colours follow the theme. */
function diagram(layout, current) {
    const area = new Gtk.DrawingArea({content_width: 150, content_height: 92, css_classes: ['tile-diagram']});
    area.update_property([Gtk.AccessibleProperty.LABEL], [`Diagram of the ${TITLES[layout]} layout`]);
    area.set_draw_func((widget, cr, width, height) => {
        const fg = widget.get_color();
        const rects = arrange(layout, 4, {x: 0, y: 0, width, height}, {gapInner: 4, gapOuter: 4, masterFactor: 0.55, columnWidth: 0.5, focus: 1});
        rects.forEach((r, i) => {
            if (r.hidden) return;
            const radius = 5;
            cr.newSubPath();
            cr.arc(r.x + r.width - radius, r.y + radius, radius, -Math.PI / 2, 0);
            cr.arc(r.x + r.width - radius, r.y + r.height - radius, radius, 0, Math.PI / 2);
            cr.arc(r.x + radius, r.y + r.height - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(r.x + radius, r.y + radius, radius, Math.PI, 1.5 * Math.PI);
            cr.closePath();
            cr.setSourceRGBA(fg.red, fg.green, fg.blue, i === 0 ? 0.55 : 0.22);
            cr.fill();
        });
    });
    return area;
}

const layoutCombo = (withDefault = true) => {
    const names = LAYOUTS.map(l => l[1]);
    return Gtk.StringList.new(withDefault ? ['Default', ...names] : names);
};

export function tilingPage(model, ctx) {
    const backend = new TileBackend(model.stores);
    const toast = m => ctx.toast(m);
    const attempt = (what, fn) => { try { return fn(); } catch (e) { toast(`${what}: ${e.message}`); return null; } };
    const refreshers = [];
    let state = null;
    const live = () => { state = attempt('Could not read the tiling', () => backend.state()); return state; };

    // ---- Overview
    const overview = () => {
        const root = [];
        if (!/GNOME/i.test(GLib.getenv('XDG_CURRENT_DESKTOP') ?? 'GNOME')) {
            const banner = new Adw.Banner({title: 'This session is not GNOME. The tiling only moves windows under GNOME Shell and does nothing here.', revealed: true});
            root.push(banner);
        }
        const g = group('Tiling', 'Arranges the windows of each monitor, none over another. Dialogs and full-screen windows are left alone.');
        const on = new Adw.SwitchRow({title: 'Tile the windows', subtitle: 'Off: windows stay where they are'});
        on.set_active(backend.settings.get_boolean('enabled'));
        let syncing = false;
        on.connect('notify::active', () => { if (!syncing) attempt('Could not switch tiling', () => backend.setEnabled(on.active)); });
        g.add(on);
        const layoutRow = new Adw.ActionRow({title: 'Layout', subtitle: '', css_classes: ['property']});
        const wsRow = new Adw.ActionRow({title: 'Active workspace', css_classes: ['property']});
        const monRow = new Adw.ActionRow({title: 'Monitors', css_classes: ['property']});
        const sess = new Adw.ActionRow({title: 'Session', css_classes: ['property']});
        const win = new Adw.ActionRow({title: 'Windows', css_classes: ['property']});
        [layoutRow, wsRow, monRow, win, sess].forEach(r => { r.set_subtitle_selectable?.(true); g.add(r); });
        const refresh = () => {
            syncing = true; on.set_active(backend.settings.get_boolean('enabled')); syncing = false;
            const s = state ?? backend.settingsState();
            layoutRow.set_subtitle(`${TITLES[s.layout]} (general)${Object.keys(s.layoutMap?.workspaces ?? {}).length ? `, ${Object.keys(s.layoutMap.workspaces).length} workspace(s) with their own` : ''}`);
            if (state) {
                const ws = state.workspaces.find(w => w.active);
                wsRow.set_subtitle(ws ? `${ws.index}${ws.name ? ` "${ws.name}"` : ''}: ${TITLES[ws.layout]}, ${ws.windows} window(s)` : '');
                monRow.set_subtitle(state.monitors.map(m => `${m.index}${m.primary ? '*' : ''}: ${m.width}×${m.height}${m.scale !== 1 ? ` @${m.scale}×` : ''}, ${TITLES[m.layout]}, ${m.tiled} tiled`).join('\n'));
                win.set_subtitle(`${state.windows.length} open, ${state.windows.filter(w => w.tiled).length} tiled, ${state.windows.filter(w => w.floating).length} floating`);
                sess.set_subtitle(`${state.session.type === 'wayland' ? 'Wayland' : 'X11'}, GNOME Shell ${state.session.shell}, the tiling extension is running`);
            } else {
                wsRow.set_subtitle('Not known: the tiling extension is not running');
                monRow.set_subtitle('Not known');
                win.set_subtitle('Not known');
                sess.set_subtitle('The tiling extension is not running. Log out and in, or: gnome-extensions enable tile@niro.local');
            }
        };
        refreshers.push(refresh);
        root.push(g);
        return root;
    };

    // ---- Layouts: ten cards
    let scope = 0;   // 0 general, 1 this workspace, 2.. a monitor
    const layouts = () => {
        const g = group('Layouts', 'Pick a layout. It applies to the windows right away.');
        const scopeRow = new Adw.ComboRow({title: 'Apply to', subtitle: 'All workspaces, only the one in front, or one monitor'});
        const scopes = () => {
            const names = ['All workspaces (general)', 'The active workspace'];
            (state?.monitors ?? []).forEach(m => names.push(`Monitor ${m.index}${m.primary ? ' (primary)' : ''}`));
            return Gtk.StringList.new(names);
        };
        scopeRow.set_model(scopes());
        scopeRow.connect('notify::selected', () => { scope = scopeRow.selected; });
        g.add(scopeRow);
        const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 5, min_children_per_line: 1, homogeneous: true, column_spacing: 12, row_spacing: 12, margin_top: 6});
        const buttons = new Map();
        for (const [id, title, description] of LAYOUTS) {
            const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10, css_classes: ['card']});
            card.append(diagram(id));
            card.append(new Gtk.Label({label: title, css_classes: ['heading'], wrap: true, margin_top: 4}));
            card.append(new Gtk.Label({label: description, css_classes: ['caption', 'dim-label'], wrap: true, max_width_chars: 22, lines: 4, ellipsize: 3, vexpand: true, xalign: 0.5, justify: Gtk.Justification.CENTER}));
            const apply = new Gtk.Button({label: 'Apply', margin_start: 10, margin_end: 10, margin_bottom: 10, css_classes: ['pill']});
            apply.update_property([Gtk.AccessibleProperty.LABEL], [`Apply the ${title} layout`]);
            apply.connect('clicked', () => {
                const target = scope === 0 ? {} : scope === 1 ? {workspace: (state?.workspaces.find(w => w.active)?.index) ?? 1} : {monitor: scope - 2};
                if (attempt(`Could not apply ${title}`, () => backend.apply(id, target)) === false) toast(`${title} was not accepted`);
                live(); refreshers.forEach(f => f());
            });
            card.append(apply);
            buttons.set(id, apply);
            flow.append(card);
        }
        const mark = () => {
            const s = state ?? backend.settingsState();
            const ws = state?.workspaces.find(w => w.active);
            const current = scope === 1 && ws ? ws.layout : scope >= 2 && state ? state.monitors[scope - 2]?.layout : s.layout;
            for (const [id, b] of buttons) { b.set_label(id === current ? 'In use' : 'Apply'); b.set_sensitive(id !== current); if (id === current) b.add_css_class('suggested-action'); else b.remove_css_class('suggested-action'); }
            scopeRow.set_model(scopes()); scopeRow.set_selected(Math.min(scope, (state?.monitors.length ?? 0) + 1));
        };
        refreshers.push(mark);
        const wrap = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        wrap.append(g); wrap.append(flow);
        return [wrap];
    };

    // ---- Workspaces
    const workspaces = () => {
        const g = group('Workspaces', 'Each workspace can have a layout of its own; "Default" follows the general layout (or its monitor\'s).');
        const rows = [];
        const sync = () => {
            if (!state) { if (!rows.length) { const r = new Adw.ActionRow({title: 'The tiling extension is not running', subtitle: 'Workspaces show here once it is.'}); g.add(r); rows.push(r); } return; }
            if (rows.length !== state.workspaces.length || rows[0]?._empty) {
                rows.splice(0).forEach(r => g.remove(r));
                state.workspaces.forEach(w => {
                    const row = new Adw.ComboRow({title: '', model: layoutCombo()});
                    row._index = w.index;
                    row.connect('notify::selected', () => {
                        if (row._syncing) return;
                        if (row.selected === 0) attempt('Could not clear the layout', () => backend.clear({workspace: row._index}));
                        else attempt('Could not apply the layout', () => backend.apply(LAYOUT_IDS[row.selected - 1], {workspace: row._index}));
                    });
                    g.add(row); rows.push(row);
                });
            }
            state.workspaces.forEach((w, i) => {
                const row = rows[i];
                row._syncing = true;
                row.set_title(`Workspace ${w.index}${w.name ? ` "${w.name}"` : ''}${w.active ? ' (in front)' : ''}`);
                row.set_subtitle(`${w.windows} window(s)`);
                const own = state.layoutMap.workspaces?.[String(w.index)];
                row.set_selected(own ? LAYOUT_IDS.indexOf(own) + 1 : 0);
                row._syncing = false;
            });
        };
        refreshers.push(sync);
        return [g];
    };

    // ---- Window Rules
    const rules = () => {
        const g = group('Window rules', 'Per application, by its window class (the app id: org.gnome.Calculator, firefox…). Float keeps it out of the tiling; Tile tiles it anyway; a workspace sends its windows there when they open.');
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        const read = () => parseRules(backend.settings.get_string('window-rules'));
        const save = next => attempt('Could not save the rules', () => backend.change({'window-rules': JSON.stringify(next)}, 'rules'));
        const draw = () => {
            let c; while ((c = list.get_first_child())) list.remove(c);
            const all = read();
            if (!all.length) list.append(new Adw.ActionRow({title: 'No rules yet', subtitle: 'Add one below, or pick from the windows open now.', css_classes: ['dim-label']}));
            all.forEach((r, i) => {
                const row = new Adw.ActionRow({title: GLib.markup_escape_text(r.match, -1), subtitle: [r.action === 'float' ? 'Floats' : r.action === 'tile' ? 'Always tiled' : '', r.workspace ? `Opens on workspace ${r.workspace}` : ''].filter(Boolean).join(' · ')});
                const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
                del.update_property([Gtk.AccessibleProperty.LABEL], [`Remove the rule for ${r.match}`]);
                del.connect('clicked', () => { save(read().filter((_x, k) => k !== i)); draw(); });
                row.add_suffix(del);
                list.append(row);
            });
        };
        const add = group('Add a rule');
        const match = new Adw.EntryRow({title: 'Application (window class)'});
        const action = new Adw.ComboRow({title: 'Tiling', model: Gtk.StringList.new(['Leave as it is', 'Float (never tiled)', 'Tile (always)'])});
        const ws = new Adw.SpinRow({title: 'Open on workspace', subtitle: '0: where it opens', adjustment: new Gtk.Adjustment({lower: 0, upper: 36, step_increment: 1, value: 0})});
        const open = new Gtk.MenuButton({icon_name: 'view-list-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Pick from the open windows'});
        const pop = new Gtk.Popover(); const picks = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        pop.set_child(picks); open.set_popover(pop); match.add_suffix(open);
        open.connect('notify::active', () => {
            let c; while ((c = picks.get_first_child())) picks.remove(c);
            const classes = [...new Set((live()?.windows ?? []).map(w => w.class).filter(Boolean))];
            if (!classes.length) picks.append(new Gtk.Label({label: 'No windows known (the extension is not running)', css_classes: ['dim-label']}));
            classes.forEach(k => { const b = new Gtk.Button({label: k, css_classes: ['flat']}); b.connect('clicked', () => { match.set_text(k); pop.popdown(); }); picks.append(b); });
        });
        const addButton = new Gtk.Button({label: 'Add the rule', halign: Gtk.Align.END, css_classes: ['suggested-action'], margin_top: 6});
        addButton.connect('clicked', () => {
            const name = match.get_text().trim();
            if (!name) { toast('Give the application\'s window class first'); return; }
            if (action.selected === 0 && ws.value === 0) { toast('A rule needs a tiling choice or a workspace'); return; }
            const rule = {match: name, ...(action.selected === 1 ? {action: 'float'} : action.selected === 2 ? {action: 'tile'} : {}), ...(ws.value > 0 ? {workspace: Math.round(ws.value)} : {})};
            if (save([...read().filter(r => r.match.toLowerCase() !== name.toLowerCase()), rule]) !== null) { match.set_text(''); action.set_selected(0); ws.set_value(0); draw(); }
        });
        [match, action, ws].forEach(r => add.add(r));
        add.add(addButton);
        draw();
        const wrap = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        wrap.append(g); wrap.append(list);
        return [wrap, add];
    };

    // ---- Advanced Rules: the rules engine (conditions, priority, stop), its conflicts and a dry run that applies nothing
    const advancedRules = () => {
        const esc = t => GLib.markup_escape_text(String(t), -1);
        const confirm = ctx.confirm ?? ((title, body, label, done) => {
            const d = Adw.AlertDialog.new(title, body);
            d.add_response('cancel', 'Cancel'); d.add_response('go', label); d.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
            d.choose(ctx.window, null, (_d, r) => { if (d.choose_finish(r) === 'go') done(); });
        });
        const intro = group('Advanced rules', 'Rules with conditions (application, title, workspace, monitor, type, time), a priority and an optional stop. They run once when a window first appears, in priority order; the first rule to set an action wins it. Off by default. The simple rules in Window Rules keep working either way.');
        const engine = new Adw.SwitchRow({title: 'Use the advanced rules', subtitle: 'Windows already open are only changed when you press Apply to open windows below.'});
        engine.update_property([Gtk.AccessibleProperty.LABEL], ['Use the advanced window rules']);
        let syncing = false;
        engine.connect('notify::active', () => {
            if (syncing) return;
            if (attempt('Could not change the rules engine', () => backend.change({'rules-engine': engine.active}, 'rules engine')) === null) { syncing = true; engine.set_active(backend.settings.get_boolean('rules-engine')); syncing = false; }
            draw(false);
        });
        intro.add(engine);

        // the rule list
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        list.update_property([Gtk.AccessibleProperty.LABEL], ['Advanced window rules']);
        const status = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label'], margin_top: 4});
        const stored = () => { try { return backend.advancedRules(); } catch (e) { return {error: e.message}; } };
        const writeRules = (next, done) => {
            const r = attempt('Rules not saved', () => backend.saveAdvancedRules(next));
            if (r === null) return false;
            toast(done); draw(true); return true;
        };
        const summary = r => {
            const c = Object.entries(r.conditions ?? {}).map(([k, v]) => `${k} ${typeof v === 'object' ? `${v.from}-${v.to}` : v}`).join(', ');
            const a = Object.entries(r.actions ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
            return `When ${c || 'nothing'}: ${a || 'nothing'}. Priority ${r.priority ?? 0}${r.stop ? ', stops after' : ''}${r.enabled === false ? ', off' : ''}`;
        };
        const conflictsGroup = group('Conflicts', 'Rules that disagree, or that can never run.');
        const conflictRows = [];
        let drawn = null;
        let editing = null, original = null;
        const draw = force => {
            const text = backend.settings.get_string('advanced-rules');
            syncing = true; engine.set_active(backend.settings.get_boolean('rules-engine')); syncing = false;
            if (!force && text === drawn) return;
            drawn = text;
            let c; while ((c = list.get_first_child())) list.remove(c);
            conflictRows.splice(0).forEach(r => conflictsGroup.remove(r));
            const data = stored();
            const report = backend.rulesReport(text);
            const note = (title, subtitle, cls) => new Adw.ActionRow({title: esc(title), subtitle: esc(subtitle), css_classes: cls ? [cls] : []});
            if (data.error) {
                list.append(note('The stored rules cannot be read', data.error, 'error'));
            } else if (!data.length) {
                list.append(note('No advanced rules yet', 'Add one below. A rule needs a condition and an action.', 'dim-label'));
            } else {
                data.forEach((r, i) => {
                    const row = new Adw.ActionRow({title: esc(r?.id ?? `rule ${i + 1}`), subtitle: esc(summary(r ?? {})), activatable: false});
                    const on = new Gtk.Switch({active: r?.enabled !== false, valign: Gtk.Align.CENTER});
                    on.update_property([Gtk.AccessibleProperty.LABEL], [`Rule ${r?.id}: enabled`]);
                    on.connect('state-set', (_s, v) => { writeRules(stored().map((x, k) => k === i ? {...x, enabled: v} : x), `Rule ${r.id} ${v ? 'on' : 'off'}`); return false; });
                    const edit = new Gtk.Button({icon_name: 'document-edit-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Edit the rule'});
                    edit.update_property([Gtk.AccessibleProperty.LABEL], [`Edit the rule ${r?.id}`]);
                    edit.connect('clicked', () => loadForm(i));
                    const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: 'Remove the rule'});
                    del.update_property([Gtk.AccessibleProperty.LABEL], [`Remove the rule ${r?.id}`]);
                    del.connect('clicked', () => confirm(`Remove the rule "${r?.id}"?`, 'It stops applying to new windows. Undo in Profiles brings it back.', 'Remove', () => { writeRules(stored().filter((_x, k) => k !== i), `Removed ${r?.id}`); if (editing === r?.id) resetForm(); }));
                    row.add_prefix(on); row.add_suffix(edit); row.add_suffix(del);
                    list.append(row);
                });
            }
            status.set_label(report.problems.length ? `${report.problems.length} problem(s) in the stored rules; the shell skips the invalid ones.` : '');
            status.set_visible(report.problems.length > 0);
            for (const p of report.problems) { const r = note('Invalid', p, 'error'); r.add_prefix(new Gtk.Image({icon_name: 'dialog-error-symbolic', css_classes: ['error']})); conflictsGroup.add(r); conflictRows.push(r); }
            for (const k of report.conflicts) {
                const r = note(k.kind === 'shadowed' ? `"${k.b}" can never run` : `"${k.a}" and "${k.b}" both set ${k.key}`,
                    k.kind === 'shadowed' ? `"${k.a}" matches the same windows first and stops.` : `"${k.a}" wins (higher priority). ${k.certain ? 'Certain: one rule\'s conditions contain the other\'s.' : 'Possible: a window can match both.'}`);
                r.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']})); conflictsGroup.add(r); conflictRows.push(r);
            }
            if (!conflictRows.length) { const r = note('No conflicts', data.length ? 'No two rules set different values for one window.' : 'There are no rules to compare.', 'dim-label'); conflictsGroup.add(r); conflictRows.push(r); }
        };

        // the form: add a rule, or change the one being edited
        const form = group('Add or edit a rule', 'Conditions must all hold. An empty condition is ignored; a rule needs at least one condition and one action.');
        const spin = (title, subtitle, lower, upper, step = 1, digits = 0) => new Adw.SpinRow({title, subtitle, digits, adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, value: lower})});
        const id = new Adw.EntryRow({title: 'Rule name (letters, digits, dot, dash)'});
        const priority = spin('Priority', 'Higher runs first', -100, 100);
        priority.set_value(0);
        const enabled = new Adw.SwitchRow({title: 'Enabled', active: true});
        const stop = new Adw.SwitchRow({title: 'Stop after this rule', subtitle: 'Lower rules are skipped for a window this rule matched'});
        const cApp = new Adw.EntryRow({title: 'Condition: application (window class)'});
        const cTitle = new Adw.EntryRow({title: 'Condition: title contains (or /regex/)'});
        const cWs = spin('Condition: workspace', '0: any', 0, 36);
        const cMon = spin('Condition: monitor', '-1: any', -1, 15); cMon.set_value(-1);
        const TYPES = ['', 'normal', 'dialog', 'utility'];
        const cType = new Adw.ComboRow({title: 'Condition: window type', model: Gtk.StringList.new(['Any', 'Normal', 'Dialog', 'Utility'])});
        const cFrom = new Adw.EntryRow({title: 'Condition: from (HH:MM, with To)'});
        const cTo = new Adw.EntryRow({title: 'Condition: to (HH:MM)'});
        const aWs = spin('Action: move to workspace', '0: leave', 0, 36);
        const aMon = spin('Action: move to monitor', '-1: leave', -1, 15); aMon.set_value(-1);
        const aTile = new Adw.ComboRow({title: 'Action: tiling', model: Gtk.StringList.new(['Leave as it is', 'Float (never tiled)', 'Tile (always)'])});
        const aAbove = new Adw.SwitchRow({title: 'Action: keep above other windows'});
        const aFullscreen = new Adw.SwitchRow({title: 'Action: make full screen'});
        const aOpacity = spin('Action: opacity', '0: leave. Not applied on this system', 0, 1, 0.05, 2);
        for (const r of [id, enabled, priority, stop, cApp, cTitle, cWs, cMon, cType, cFrom, cTo, aWs, aMon, aTile, aAbove, aFullscreen, aOpacity]) form.add(r);
        const submit = new Gtk.Button({label: 'Add the advanced rule', css_classes: ['suggested-action'], halign: Gtk.Align.END, margin_top: 6});
        const cancel = new Gtk.Button({label: 'Cancel editing', css_classes: ['flat'], halign: Gtk.Align.END, margin_top: 6, visible: false});
        const resetForm = () => {
            editing = null; original = null; submit.set_label('Add the advanced rule'); cancel.set_visible(false);
            for (const e of [id, cApp, cTitle, cFrom, cTo]) e.set_text('');
            priority.set_value(0); enabled.set_active(true); stop.set_active(false); cWs.set_value(0); cMon.set_value(-1); cType.set_selected(0);
            aWs.set_value(0); aMon.set_value(-1); aTile.set_selected(0); aAbove.set_active(false); aFullscreen.set_active(false); aOpacity.set_value(0);
        };
        const loadForm = i => {
            const r = stored()[i]; if (!r) return;
            resetForm();
            editing = r.id; original = r; submit.set_label('Save the advanced rule'); cancel.set_visible(true);
            const c = r.conditions ?? {}, a = r.actions ?? {};
            id.set_text(r.id ?? ''); priority.set_value(r.priority ?? 0); enabled.set_active(r.enabled !== false); stop.set_active(r.stop === true);
            cApp.set_text(c.appId ?? ''); cTitle.set_text(c.title ?? ''); cWs.set_value(c.workspace ?? 0); cMon.set_value(c.monitor ?? -1);
            cType.set_selected(Math.max(0, TYPES.indexOf(c.type ?? ''))); cFrom.set_text(c.time?.from ?? ''); cTo.set_text(c.time?.to ?? '');
            aWs.set_value(a.workspace ?? 0); aMon.set_value(a.monitor ?? -1); aTile.set_selected(a.tile === 'float' ? 1 : a.tile === 'tile' ? 2 : 0);
            aAbove.set_active(a.above === true); aFullscreen.set_active(a.fullscreen === true); aOpacity.set_value(a.opacity ?? 0);
            id.grab_focus();
        };
        const build = () => {
            const conditions = {...(original?.conditions ?? {})}, actions = {...(original?.actions ?? {})};
            const put = (o, k, v, on) => { if (on) o[k] = v; else delete o[k]; };
            put(conditions, 'appId', cApp.get_text().trim(), cApp.get_text().trim() !== '');
            put(conditions, 'title', cTitle.get_text(), cTitle.get_text() !== '');
            put(conditions, 'workspace', Math.round(cWs.value), cWs.value > 0);
            put(conditions, 'monitor', Math.round(cMon.value), cMon.value >= 0);
            put(conditions, 'type', TYPES[cType.selected], cType.selected > 0);
            const from = cFrom.get_text().trim(), to = cTo.get_text().trim();
            put(conditions, 'time', {from, to}, from !== '' || to !== '');
            put(actions, 'workspace', Math.round(aWs.value), aWs.value > 0);
            put(actions, 'monitor', Math.round(aMon.value), aMon.value >= 0);
            put(actions, 'tile', aTile.selected === 1 ? 'float' : 'tile', aTile.selected > 0);
            put(actions, 'above', true, aAbove.active);
            put(actions, 'fullscreen', true, aFullscreen.active);
            put(actions, 'opacity', Math.round(aOpacity.value * 100) / 100, aOpacity.value > 0);
            return {id: id.get_text().trim(), enabled: enabled.active, priority: Math.round(priority.value), stop: stop.active, conditions, actions};
        };
        submit.connect('clicked', () => {
            const rule = build();
            const data = stored();
            if (data.error) { toast(`The stored rules cannot be read: ${data.error}`); return; }
            if (!rule.id) { toast('Give the rule a name first'); id.grab_focus(); return; }
            if (data.some(r => r?.id === rule.id && r.id !== editing)) { toast(`There is already a rule named "${rule.id}"`); id.grab_focus(); return; }
            const next = editing ? data.map(r => r?.id === editing ? rule : r) : [...data, rule];
            const problems = backend.rulesReport(JSON.stringify(next)).problems;
            if (problems.length) { toast(`Not saved: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`); return; }
            if (writeRules(next, editing ? `Saved ${rule.id}` : `Added ${rule.id}`)) resetForm();
        });
        cancel.connect('clicked', resetForm);

        // the dry run: describes what the rules would do to a window; nothing is applied
        const dry = group('Dry run', 'Type a window and see what the rules would do. This only reports; no window is touched, and it works whether or not the engine is on.');
        const dApp = new Adw.EntryRow({title: 'Dry run: application (window class)'});
        const dTitle = new Adw.EntryRow({title: 'Dry run: window title'});
        const dWs = spin('Dry run: workspace', '0: not given', 0, 36);
        const dMon = spin('Dry run: monitor', '-1: not given', -1, 15); dMon.set_value(-1);
        const dType = new Adw.ComboRow({title: 'Dry run: window type', model: Gtk.StringList.new(['Normal', 'Dialog', 'Utility'])});
        const run = new Gtk.Button({label: 'Run the dry run', css_classes: ['suggested-action'], halign: Gtk.Align.END, margin_top: 6});
        for (const r of [dApp, dTitle, dWs, dMon, dType]) dry.add(r);
        const out = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        out.update_property([Gtk.AccessibleProperty.LABEL], ['Dry run result']);
        const WHY = {appId: 'application', title: 'title', workspace: 'workspace', monitor: 'monitor', type: 'type', time: 'time of day', profile: 'profile (not known to the tiling yet, so it does not match)'};
        const showDry = () => {
            let c; while ((c = out.get_first_child())) out.remove(c);
            const text = backend.settings.get_string('advanced-rules');
            const r = attempt('Dry run failed', () => backend.dryRun({appId: dApp.get_text().trim(), title: dTitle.get_text(), workspace: dWs.value > 0 ? Math.round(dWs.value) : null, monitor: dMon.value >= 0 ? Math.round(dMon.value) : null, type: ['normal', 'dialog', 'utility'][dType.selected]}, text));
            if (!r) return;
            const row = (title, subtitle, icon, cls) => { const x = new Adw.ActionRow({title: esc(title), subtitle: esc(subtitle)}); if (icon) x.add_prefix(new Gtk.Image({icon_name: icon, css_classes: cls ? [cls] : []})); out.append(x); return x; };
            if (!r.ruleCount) { row('No rules to run', 'Add a valid rule above (invalid rules are left out).', null); return; }
            if (!r.engineOn) row('The engine is off', 'The shell does not apply these rules until you switch it on above.', 'dialog-information-symbolic');
            for (const t of r.trace)
                row(`${t.id}: ${t.matched ? 'matched' : t.skipped ? 'skipped' : 'did not match'}`,
                    t.skipped ? t.skipped : t.why.map(w => `${WHY[w.key] ?? w.key} ${w.ok ? 'fits' : 'does not fit'}`).join('; '),
                    t.matched ? 'emblem-ok-symbolic' : 'window-close-symbolic', t.matched ? 'success' : 'dim-label');
            const acts = Object.entries(r.actions);
            row(acts.length ? 'Would do' : 'Would do nothing', acts.filter(([k]) => !r.unsupported.includes(k)).map(([k, v]) => `${k} ${v} (from ${r.from[k]})`).join('; ') || (acts.length ? 'Nothing this system can apply.' : 'No rule matched this window.'), null);
            for (const k of r.unsupported) row(`${k}: not applied on this system`, `A rule asks for ${k} ${r.actions[k]} (from ${r.from[k]}); the shell leaves it alone.`, 'dialog-warning-symbolic', 'warning');
        };
        run.connect('clicked', showDry);
        for (const e of [dApp, dTitle]) e.connect('entry-activated', showDry);

        // apply to the windows already open: a preview of what would change first, then a confirmation; the shell does it once
        const applyG = group('Apply to open windows', 'The rules above only act on a window when it first appears. This runs them once over the windows that are open now: it lists what would change, and changes it only after you confirm. The engine must be on. Pressing it again changes nothing more.');
        const applyBtn = new Gtk.Button({label: 'Apply to open windows', css_classes: ['suggested-action'], halign: Gtk.Align.END, margin_top: 6});
        const applyOut = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        applyOut.update_property([Gtk.AccessibleProperty.LABEL], ['Windows the rules would change']);
        const clearApply = () => { let c; while ((c = applyOut.get_first_child())) applyOut.remove(c); };
        const line = (w, bare) => `${w.appId || 'window'} "${w.title}": ${Object.entries(w.actions).map(([k, v]) => `${k} ${v}`).join(', ')}${bare ? '' : ` (rule ${[...new Set(Object.values(w.from ?? {}))].join(', ')})`}`;
        applyBtn.connect('clicked', () => {
            clearApply();
            const r = attempt('Could not preview the rules', () => backend.applyRules(false));
            if (!r) return;
            const add = (t, sub, cls) => applyOut.append(new Adw.ActionRow({title: esc(t), subtitle: esc(sub ?? ''), css_classes: cls ? [cls] : []}));
            for (const w of r.applied) add(line(w, true), `from ${[...new Set(Object.values(w.from ?? {}))].join(', ')}`);
            for (const w of r.skipped) add(`Left alone: ${w.appId || 'window'} ${w.key ?? ''}`.trim(), w.reason, 'dim-label');
            if (!r.applied.length) { toast('Nothing to change: the open windows already match the rules'); return; }
            confirm(`Apply the rules to ${r.applied.length} open window${r.applied.length === 1 ? '' : 's'}?`, r.applied.map(w => line(w)).join('\n'), 'Apply', () => {
                const done = attempt('The rules were not applied', () => backend.applyRules(true));
                if (!done) return;
                toast(`Applied to ${done.applied.length} window${done.applied.length === 1 ? '' : 's'}`);
                clearApply();
            });
        });
        applyG.add(applyOut);

        draw(true);
        refreshers.push(() => draw(false));
        const top = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        top.append(intro); top.append(list); top.append(status);
        const formBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6}); formBox.append(form);
        const buttons = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, halign: Gtk.Align.END}); buttons.append(cancel); buttons.append(submit); formBox.append(buttons);
        const dryBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12}); dryBox.append(dry); dryBox.append(run); dryBox.append(out);
        const applyBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12}); applyBox.append(applyG); applyBox.append(applyBtn);
        return [top, formBox, conflictsGroup, applyBox, dryBox];
    };

    // ---- Appearance, Shortcuts: the settings, as in the Windows page
    const items = ids => ids.map(id => CATALOG.find(i => i.id === id)).filter(Boolean);
    const appearance = () => {
        const g1 = model.section('Gaps and motion', items(['tile.gap-inner', 'tile.gap-outer', 'tile.animate']));
        const g2 = model.section('Corners, transparency and shadow', items(['corners.global-rounded-corner-settings.borderRadius', 'windows.opacity', 'corners.shadows']),
            'Rounded corners, shadow and opacity belong to the window effects of Niro; they are set here and in Windows. Opacity is set once, in Look.');
        const g3 = group('Borders', 'GNOME draws no border around tiled windows and this tiling does not add one, so there is nothing to set here.');
        return [g1, g2, g3];
    };
    const shortcuts = () => [model.section('Tiling shortcuts', CATALOG.filter(i => i.source === 'tile' && i.kind === 'shortcut'),
        'A shortcut already used by another is refused, with the name of the one that has it.')];

    // ---- Monitors
    const monitors = () => {
        const g = group('Monitors', 'A layout for each monitor. A workspace\'s own layout still wins over it. Plugging a monitor in or out is followed at once.');
        const rows = [];
        const sync = () => {
            if (!state) { if (!rows.length) { const r = new Adw.ActionRow({title: 'The tiling extension is not running', subtitle: 'Monitors show here once it is.'}); g.add(r); rows.push(r); r._empty = true; } return; }
            if (rows.length !== state.monitors.length || rows[0]?._empty) {
                rows.splice(0).forEach(r => g.remove(r));
                state.monitors.forEach(m => {
                    const row = new Adw.ComboRow({title: '', model: layoutCombo()});
                    row._index = m.index;
                    row.connect('notify::selected', () => {
                        if (row._syncing) return;
                        if (row.selected === 0) attempt('Could not clear the layout', () => backend.clear({monitor: row._index}));
                        else attempt('Could not apply the layout', () => backend.apply(LAYOUT_IDS[row.selected - 1], {monitor: row._index}));
                    });
                    g.add(row); rows.push(row);
                });
            }
            state.monitors.forEach((m, i) => {
                const row = rows[i];
                row._syncing = true;
                row.set_title(`Monitor ${m.index}${m.primary ? ' (primary)' : ''}`);
                row.set_subtitle(`${m.width}×${m.height} at ${m.x},${m.y}${m.scale !== 1 ? `, scale ${m.scale}×` : ''}, ${m.tiled} tiled`);
                const own = state.layoutMap.monitors?.[String(m.index)];
                row.set_selected(own ? LAYOUT_IDS.indexOf(own) + 1 : 0);
                row._syncing = false;
            });
        };
        refreshers.push(sync);
        const recovery = group('Unplugging a monitor', 'Off by default. When on, the windows of a monitor that leaves go to the primary monitor and go back when it returns. Only windows are moved; no display setting is changed.');
        const rec = new Adw.SwitchRow({title: 'Move windows off a monitor that leaves, and back when it returns'});
        rec.update_property([Gtk.AccessibleProperty.LABEL], ['Monitor recovery']);
        rec.set_active(backend.settings.get_boolean('monitor-recovery'));
        rec.connect('notify::active', () => attempt('Could not change monitor recovery', () => backend.setMonitorRecovery(rec.active)));
        refreshers.push(() => { const v = backend.settings.get_boolean('monitor-recovery'); if (rec.active !== v) rec.set_active(v); });
        recovery.add(rec);
        return [g, recovery];
    };

    // ---- Profiles
    const profiles = () => {
        const g = group('Profiles', `Saved layout setups (layout, gaps, sizes, rules, per-workspace and per-monitor layouts), in ${profileDir()}. Shortcuts and the on/off switch are not part of a profile.`);
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        const picker = (save, name, done) => {
            const dialog = new Gtk.FileDialog();
            dialog.set_default_filter(Object.assign(new Gtk.FileFilter(), {name: 'Profiles (JSON)'}));
            if (save) { dialog.set_initial_name(`${name}.json`); dialog.save(ctx.window, null, (d, r) => { try { done(d.save_finish(r).get_path()); } catch (_e) { /* cancelled */ } }); }
            else dialog.open(ctx.window, null, (d, r) => { try { done(d.open_finish(r).get_path()); } catch (_e) { /* cancelled */ } });
        };
        const draw = () => {
            let c; while ((c = list.get_first_child())) list.remove(c);
            const all = backend.profiles();
            if (!all.length) list.append(new Adw.ActionRow({title: 'No profiles yet', subtitle: 'Save the current setup below.', css_classes: ['dim-label']}));
            for (const p of all) {
                const row = new Adw.ActionRow({title: GLib.markup_escape_text(p.name, -1), subtitle: `${TITLES[p.layout] ?? p.layout}  ${p.saved.slice(0, 10)}`});
                const mk = (icon, tip, fn) => { const b = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: tip}); b.update_property([Gtk.AccessibleProperty.LABEL], [`${tip}: ${p.name}`]); b.connect('clicked', fn); row.add_suffix(b); };
                mk('document-open-symbolic', 'Load', () => { const c2 = attempt('Could not load the profile', () => backend.loadProfile(p.name)); if (c2) { toast(c2.length ? `"${p.name}" loaded` : `"${p.name}": nothing differs`); live(); refreshers.forEach(f => f()); } });
                mk('document-save-as-symbolic', 'Export', () => picker(true, p.name, path => attempt('Could not export', () => { backend.exportProfile(p.name, path); toast(`Written ${path}`); })));
                mk('user-trash-symbolic', 'Delete', () => { attempt('Could not delete', () => backend.deleteProfile(p.name)); draw(); });
                list.append(row);
            }
        };
        const name = new Adw.EntryRow({title: 'Save the current setup as…'});
        name.set_show_apply_button(true);
        name.connect('apply', () => { const n = attempt('Could not save', () => backend.saveProfile(name.get_text())); if (n) { name.set_text(''); toast(`Saved "${n}"`); draw(); } });
        const more = group('Other');
        const imp = new Adw.ActionRow({title: 'Import a profile…', subtitle: 'A file made by Export or by `niro-tile profile export`'});
        const impB = new Gtk.Button({label: 'Choose a file', valign: Gtk.Align.CENTER});
        impB.connect('clicked', () => picker(false, '', path => { const n = attempt('Could not import', () => backend.importProfile(path)); if (n) { toast(`Imported "${n}"`); draw(); } }));
        imp.add_suffix(impB); more.add(imp);
        const undo = new Adw.ActionRow({title: 'Undo the last change', subtitle: 'Every change made here or by niro-tile is backed up first'});
        const undoB = new Gtk.Button({label: 'Undo', valign: Gtk.Align.CENTER});
        undoB.connect('clicked', () => { const l = attempt('Nothing to undo', () => backend.undo()); if (l) { toast(`Undone: ${l}`); live(); refreshers.forEach(f => f()); } });
        undo.add_suffix(undoB); more.add(undo);
        const reset = new Adw.ActionRow({title: 'Reset the layout settings', subtitle: 'Layout, gaps, sizes, rules and the floating list back at their defaults (can be undone)'});
        const resetB = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        resetB.connect('clicked', () => {
            const d = Adw.AlertDialog.new('Reset the layout settings?', 'The layout, gaps, sizes, rules and the list of floating apps go back to their defaults. You can undo it.');
            d.add_response('cancel', 'Cancel'); d.add_response('reset', 'Reset'); d.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            d.choose(ctx.window, null, (_d, r) => { if (d.choose_finish(r) !== 'reset') return; const c2 = attempt('Could not reset', () => backend.reset()); if (c2) { toast(c2.length ? 'Reset' : 'Already at the defaults'); live(); refreshers.forEach(f => f()); } });
        });
        reset.add_suffix(resetB); more.add(reset);
        draw();
        const wrap = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        wrap.append(g); wrap.append(list);
        const save = group(''); save.add(name);
        return [wrap, save, more];
    };


    // ---- Groups and Snapshots: what the shell remembers about windows (org.niro.Tile GroupsCall / SnapshotsCall)
    const esc2 = s => GLib.markup_escape_text(String(s ?? ''), -1);
    const ask = ctx.confirm ?? ((title, body, label, done) => {
        const d = Adw.AlertDialog.new(title, body);
        d.add_response('cancel', 'Cancel'); d.add_response('go', label); d.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
        d.choose(ctx.window, null, (_d, r) => { if (d.choose_finish(r) === 'go') done(); });
    });
    const iconButton = (icon, tip, fn) => { const b = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER, css_classes: ['flat'], tooltip_text: tip}); b.update_property([Gtk.AccessibleProperty.LABEL], [tip]); b.connect('clicked', fn); return b; };
    const textButton = (label, fn, css = []) => { const b = new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css}); b.connect('clicked', fn); return b; };
    const windowLabel = w => `${w.title || '(no title)'}${w.class ? `  ·  ${w.class}` : ''}  ·  workspace ${w.workspace || 'all'}`;
    /** One line for what an activate / restore did, partial failures included. */
    const movedSentence = r => `${r.preview ? 'Would move' : 'Moved'} ${r.preview ? r.planned : r.applied.length} window(s)${r.closed?.length ? `, ${r.closed.length} not open` : ''}${r.failed?.length ? `, ${r.failed.length} could not be moved` : ''}`;

    const groupsSection = () => {
        const g = group('Groups', 'Named sets of windows. Activating one brings its windows back to where the group lives (workspace and monitor) and focuses it; a window that is closed is listed, not an error. Kept in ~/.config/niro/tile-groups.json.');
        const rows = [];
        const open = new Set();
        let signature = '';
        const redraw = (force = false) => {
            let groups;
            try { groups = backend.groups(); } catch (e) { groups = []; if (force) toast(`Could not read the groups: ${e.message}`); }
            const sig = JSON.stringify([groups, state?.windows?.map(w => w.id)]);
            if (!force && sig === signature) return;
            signature = sig;
            rows.splice(0).forEach(r => g.remove(r));
            const note = (title, subtitle) => { const r = new Adw.ActionRow({title, subtitle, css_classes: ['dim-label']}); g.add(r); rows.push(r); };
            if (!state) note('The tiling extension is not running', 'Groups can be seen here but not changed until it is.');
            else if (!groups.length) note('No groups yet', 'Name one below, then add windows to it.');
            for (const grp of groups) {
                const exp = new Adw.ExpanderRow({title: esc2(grp.name), subtitle: grp.offline ? `${grp.members.length} window(s)` : `${grp.open} open, ${grp.closed} closed`});
                exp.set_expanded(open.has(grp.id));
                exp.connect('notify::expanded', () => { if (exp.expanded) open.add(grp.id); else open.delete(grp.id); });
                const act = (what, fn) => () => { const r = attempt(what, fn); if (r) { toast(r.preview === undefined ? 'Done' : movedSentence(r)); live(); redraw(true); } };
                exp.add_suffix(textButton('Activate', act('Could not activate the group', () => backend.activateGroup(grp.id)), ['suggested-action']));
                exp.add_suffix(iconButton('user-trash-symbolic', `Delete the group ${grp.name}`, () => ask(`Delete the group "${grp.name}"?`, 'The windows are not closed; only the group is forgotten.', 'Delete', () => { if (attempt('Could not delete the group', () => backend.deleteGroup(grp.id))) { open.delete(grp.id); redraw(true); } })));
                for (const m of grp.members) {
                    const row = new Adw.ActionRow({title: esc2(m.title || m.appId || '(window)'), subtitle: esc2(`${m.appId || 'no app id'}${m.open ? '' : '  ·  not open'}`)});
                    row.add_prefix(new Gtk.Image({icon_name: m.open ? 'emblem-ok-symbolic' : 'window-close-symbolic', css_classes: [m.open ? 'success' : 'dim-label']}));
                    if (m.open) row.add_suffix(iconButton('list-remove-symbolic', `Take ${m.title || m.appId} out of the group`, () => { if (attempt('Could not remove the window', () => backend.removeFromGroup(grp.id, m.windowId))) redraw(true); }));
                    exp.add_row(row);
                }
                // add one of the open windows
                const candidates = (state?.windows ?? []).filter(w => !grp.members.some(m => m.windowId === w.id));
                if (candidates.length) {
                    const pick = new Adw.ComboRow({title: 'Add a window', model: Gtk.StringList.new(candidates.map(windowLabel))});
                    pick.add_suffix(textButton('Add', () => { if (attempt('Could not add the window', () => backend.addToGroup(grp.id, candidates[pick.selected].id))) { live(); redraw(true); } }));
                    exp.add_row(pick);
                }
                const where = new Adw.ActionRow({title: 'Where it lives', subtitle: grp.target ? `Workspace ${grp.target.workspace ?? 'any'}, monitor ${grp.target.monitorConnected === false ? 'not connected' : (grp.target.monitorIndex ?? 'any')}` : 'Not set'});
                where.add_suffix(textButton('Remember the current place', () => { if (attempt('Could not remember the place', () => backend.rememberGroup(grp.id))) redraw(true); }));
                where.add_suffix(textButton('Move windows there', act('Could not restore the group', () => backend.restoreGroup(grp.id))));
                exp.add_row(where);
                const rename = new Adw.EntryRow({title: 'Rename'}); rename.set_show_apply_button(true);
                rename.connect('apply', () => { if (attempt('Could not rename the group', () => backend.renameGroup(grp.id, rename.get_text()))) redraw(true); });
                exp.add_row(rename);
                g.add(exp); rows.push(exp);
            }
        };
        refreshers.push(() => redraw(false));
        const create = new Adw.EntryRow({title: 'New group (empty)'});
        create.set_show_apply_button(true);
        create.connect('apply', () => { if (attempt('Could not create the group', () => backend.createGroup(create.get_text(), []))) { create.set_text(''); redraw(true); } });
        const add = group(''); add.add(create);
        return [g, add];
    };

    const snapshotsSection = () => {
        const g = group('Snapshots', 'A record of which window was on which workspace and monitor. Restoring moves the windows that are still open; it never closes anything. What was open inside an app is not saved or restored. Apps that are not running are listed and started only when you press Start.');
        const rows = [];
        const open = new Set();
        let signature = '';
        const redraw = (force = false) => {
            let data;
            try { data = backend.live ? backend.snapshots() : {snapshots: [], invalid: 0}; } catch (e) { data = {snapshots: [], invalid: 0}; if (force) toast(`Could not read the snapshots: ${e.message}`); }
            const sig = JSON.stringify(data);
            if (!force && sig === signature) return;
            signature = sig;
            rows.splice(0).forEach(r => g.remove(r));
            const note = (title, subtitle) => { const r = new Adw.ActionRow({title, subtitle, css_classes: ['dim-label']}); g.add(r); rows.push(r); };
            if (!state) note('The tiling extension is not running', 'Snapshots are taken and restored through it.');
            else if (!data.snapshots.length) note('No snapshots yet', 'Take one below.');
            if (data.invalid) note(`${data.invalid} stored snapshot(s) could not be read`, 'They are ignored and left in the file.');
            for (const s of data.snapshots) {
                const exp = new Adw.ExpanderRow({title: esc2(s.name), subtitle: `${new Date(s.at).toLocaleString()}  ·  ${s.windows} window(s)${s.pinned ? '  ·  pinned' : ''}`});
                exp.set_expanded(open.has(s.id));
                exp.connect('notify::expanded', () => { if (exp.expanded) open.add(s.id); else open.delete(s.id); });
                const detail = [];
                const clearDetail = () => detail.splice(0).forEach(r => exp.remove(r));
                const addDetail = r => { exp.add_row(r); detail.push(r); };
                let previewed = false;
                const restoreRow = new Adw.ActionRow({title: 'Restore the windows that are open', subtitle: 'Preview first. Only workspace and monitor are put back.'});
                const restoreB = textButton('Restore…', () => {}, ['destructive-action']);
                restoreB.set_sensitive(false);
                const showPlan = r => {
                    clearDetail();
                    const c = r.counts;
                    addDetail(new Adw.ActionRow({title: 'Preview', subtitle: `${c.place ?? 0} to move, ${c.relaunch ?? 0} not running, ${c.unsupported ?? 0} without an app id, ${c.skip ?? 0} skipped. ${r.note}`}));
                    for (const i of r.items) {
                        const row = new Adw.ActionRow({title: esc2(`${i.appId || 'unknown app'}${i.title ? `  ·  ${i.title}` : ''}`),
                            subtitle: esc2({place: i.noop ? 'already in place' : `to workspace ${i.workspace ?? 'same'}, monitor ${i.monitor}`, relaunch: 'not running', unsupported: i.reason ?? 'cannot be matched', skip: i.reason ?? 'skipped'}[i.action] + (i.note ? `  (${i.note})` : ''))});
                        if (i.action === 'relaunch')
                            row.add_suffix(textButton('Start', () => { const l = attempt(`Could not start ${i.appId}`, () => backend.launchFromSnapshot(s.id, i.appId)); if (l) toast(`Started ${l.launched}`); }));
                        addDetail(row);
                    }
                    previewed = true;
                    restoreB.set_sensitive((c.place ?? 0) - (r.items.filter(i => i.noop).length) > 0);
                };
                const previewB = textButton('Preview', () => { const r = attempt('Could not plan the restore', () => backend.restoreSnapshot(s.id, false)); if (r) showPlan(r); });
                restoreB.connect('clicked', () => {
                    if (!previewed) return;
                    ask(`Move the windows to where they were in "${s.name}"?`, 'Windows that are open are moved to their workspace and monitor. Nothing is closed and no app is started.', 'Move windows', () => {
                        const r = attempt('Could not restore', () => backend.restoreSnapshot(s.id, true));
                        if (!r) return;
                        toast(`Moved ${r.applied.length} window(s)${r.failed.length ? `, ${r.failed.length} could not be moved` : ''}`);
                        live(); previewed = false; restoreB.set_sensitive(false); showPlan(attempt('Could not read the result', () => backend.restoreSnapshot(s.id, false)) ?? r);
                    });
                });
                restoreRow.add_suffix(previewB); restoreRow.add_suffix(restoreB);
                exp.add_row(restoreRow);
                const cmp = new Adw.ActionRow({title: 'Compare with now'});
                cmp.add_suffix(textButton('Compare', () => {
                    const r = attempt('Could not compare', () => backend.diffSnapshots(s.id));
                    if (r) toast(`Since "${s.name}": ${r.diff.added.length} window(s) added, ${r.diff.removed.length} gone, ${r.diff.moved.length} moved`);
                }));
                exp.add_row(cmp);
                const pin = new Adw.SwitchRow({title: 'Keep it (never cleaned up)'}); pin.set_active(s.pinned);
                pin.connect('notify::active', () => { if (pin.active !== s.pinned && attempt('Could not change the pin', () => backend.pinSnapshot(s.id, pin.active))) redraw(true); });
                exp.add_row(pin);
                exp.add_suffix(iconButton('user-trash-symbolic', `Delete the snapshot ${s.name}`, () => ask(`Delete the snapshot "${s.name}"?`, 'Only the record is removed; no window is touched.', 'Delete', () => { if (attempt('Could not delete the snapshot', () => backend.deleteSnapshot(s.id))) redraw(true); })));
                g.add(exp); rows.push(exp);
            }
        };
        refreshers.push(() => redraw(false));
        const take = new Adw.EntryRow({title: 'Take a snapshot now (a name is optional)'});
        take.set_show_apply_button(true);
        take.connect('apply', () => { const r = attempt('Could not take a snapshot', () => backend.takeSnapshot(take.get_text(), false)); if (r) { take.set_text(''); toast(`Saved ${r.windows} window(s)`); redraw(true); } });
        const takeG = group(''); takeG.add(take);
        const tidy = group('Clean up', 'Keeps the newest 20 and none older than 30 days; kept (pinned) snapshots always stay. Taking a snapshot does this too.');
        const tidyRow = new Adw.ActionRow({title: 'Remove old snapshots'});
        tidyRow.add_suffix(textButton('Clean up', () => { const r = attempt('Could not clean up', () => backend.retainSnapshots()); if (r) { toast(r.dropped ? `Removed ${r.dropped} old snapshot(s)` : 'Nothing to remove'); redraw(true); } }));
        tidy.add(tidyRow);
        return [takeG, g, tidy];
    };

    // ---- Advanced: diagnostics, the raw data, the log
    const advanced = () => {
        const checks = group('Checks', 'What works and what does not.');
        const rows = [];
        const run = () => {
            rows.splice(0).forEach(r => checks.remove(r));
            for (const c of backend.doctor()) {
                const row = new Adw.ActionRow({title: c.name, subtitle: GLib.markup_escape_text(c.detail, -1)});
                row.add_prefix(new Gtk.Image({icon_name: c.ok ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic', css_classes: [c.ok ? 'success' : 'warning']}));
                checks.add(row); rows.push(row);
            }
        };
        const recheck = new Gtk.Button({label: 'Check again', css_classes: ['flat'], valign: Gtk.Align.CENTER});
        recheck.connect('clicked', () => { live(); run(); });
        checks.set_header_suffix(recheck);
        run();
        const raw = group('Configuration', 'The data behind the pages, as JSON. It is checked before it is saved, and a change is backed up first.');
        const editor = (title, key, fallback) => {
            const exp = new Adw.ExpanderRow({title});
            const view = new Gtk.TextView({monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8, css_classes: ['card']});
            view.get_buffer().set_text(JSON.stringify(JSON.parse(backend.settings.get_string(key) || fallback), null, 1), -1);
            view.update_property([Gtk.AccessibleProperty.LABEL], [title]);
            const save = new Gtk.Button({label: 'Check and save', halign: Gtk.Align.END, margin_top: 6, margin_bottom: 6, margin_end: 8, css_classes: ['suggested-action']});
            save.connect('clicked', () => {
                const b = view.get_buffer(); const text = b.get_text(b.get_start_iter(), b.get_end_iter(), false);
                try { JSON.parse(text); } catch (e) { toast(`Not JSON: ${e.message}`); return; }
                if (attempt(`Not saved`, () => backend.change({[key]: JSON.stringify(JSON.parse(text))}, `edit ${key}`)) !== null) toast('Saved');
            });
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL}); box.append(view); box.append(save);
            const r = new Adw.PreferencesRow({child: box}); exp.add_row(r);
            return exp;
        };
        raw.add(editor('Layouts of workspaces and monitors', 'layout-map', '{}'));
        raw.add(editor('Window rules', 'window-rules', '[]'));
        raw.add(editor('Advanced window rules', 'advanced-rules', '[]'));
        const log = group('Log', 'What the tiling reported since this session started.');
        const logView = new Gtk.TextView({editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, css_classes: ['card'], top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8, height_request: 140});
        const readLog = () => {
            try {
                const out = new TextDecoder().decode(GLib.spawn_command_line_sync('journalctl --user -b -g "Tile:|tile@niro" --no-pager -n 40 -o cat')[1]).trim();
                logView.get_buffer().set_text(out || 'Nothing reported.', -1);
            } catch (e) { logView.get_buffer().set_text(`Could not read the log: ${e.message}`, -1); }
        };
        const reload = new Gtk.Button({label: 'Reload', css_classes: ['flat'], valign: Gtk.Align.CENTER});
        reload.connect('clicked', readLog);
        log.set_header_suffix(reload);
        readLog();
        const logBox = new Gtk.ScrolledWindow({child: logView, min_content_height: 140, vexpand: false});
        const stateGroup = group('Live state', 'What the extension reports over D-Bus (org.niro.Tile).');
        const stateView = new Gtk.TextView({editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, css_classes: ['card'], top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8});
        const stateBox = new Gtk.ScrolledWindow({child: stateView, min_content_height: 160});
        const showState = () => stateView.get_buffer().set_text(state ? JSON.stringify(state, null, 1) : 'The extension is not running.', -1);
        refreshers.push(showState);
        const wrap1 = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12}); wrap1.append(log); wrap1.append(logBox);
        const wrap2 = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12}); wrap2.append(stateGroup); wrap2.append(stateBox);
        return [checks, raw, wrap1, wrap2];
    };

    const builders = {Overview: overview, Layouts: layouts, Workspaces: workspaces, 'Window Rules': rules, 'Advanced Rules': advancedRules, Appearance: appearance, Shortcuts: shortcuts, Monitors: monitors, Groups: groupsSection, Snapshots: snapshotsSection, Profiles: profiles, Advanced: advanced};
    const stack = new Gtk.Stack({hexpand: true, vexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
    const list = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
    list.update_property([Gtk.AccessibleProperty.LABEL], ['Tiling sections']);
    live();
    for (const s of SECTIONS) {
        stack.add_named(page(...builders[s]()), s);
        const row = new Gtk.ListBoxRow({child: new Gtk.Label({label: s, xalign: 0, margin_top: 8, margin_bottom: 8, margin_start: 6, margin_end: 6})});
        row.set_name(s);
        list.append(row);
    }
    const picker = Gtk.DropDown.new_from_strings(SECTIONS);
    picker.set_visible(false); picker.set_margin_start(14); picker.set_margin_end(14); picker.set_margin_top(8);
    picker.update_property([Gtk.AccessibleProperty.LABEL], ['Section']);
    let syncing = false;
    list.connect('row-selected', (_l, row) => { if (!row) return; stack.set_visible_child_name(row.get_name()); syncing = true; picker.set_selected(SECTIONS.indexOf(row.get_name())); syncing = false; });
    picker.connect('notify::selected', () => !syncing && list.select_row(list.get_row_at_index(picker.get_selected())));
    list.select_row(list.get_row_at_index(0));
    const side = new Gtk.ScrolledWindow({child: list, hscrollbar_policy: Gtk.PolicyType.NEVER, min_content_width: 190, vexpand: true, css_classes: ['niro-subnav']});
    const rule = new Gtk.Separator();
    const body = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
    body.append(side); body.append(rule); body.append(stack);
    const outer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    outer.append(picker); outer.append(body);
    model.narrow.push([picker, 'visible', true], [side, 'visible', false], [rule, 'visible', false]);

    // the pages follow the shell while they are in view
    const tick = () => { live(); refreshers.forEach(f => f()); };
    let timer = 0;
    outer.connect('map', () => { tick(); if (!timer) timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { tick(); return GLib.SOURCE_CONTINUE; }); });
    outer.connect('unmap', () => { if (timer) { GLib.Source.remove(timer); timer = 0; } });
    refreshers.forEach(f => f());
    return outer;
}
