// @ts-nocheck: GTK / libadwaita are untyped here
// The Tiling module of the panel: Overview, Layouts (ten cards with a diagram each), Workspaces, Window Rules, Appearance, Shortcuts, Monitors,
// Profiles and Advanced. It tells the extension what to do through TileBackend (D-Bus when the shell runs it, the settings otherwise) and
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

const SECTIONS = ['Overview', 'Layouts', 'Workspaces', 'Window Rules', 'Appearance', 'Shortcuts', 'Monitors', 'Profiles', 'Advanced'];
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
        return [g];
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

    const builders = {Overview: overview, Layouts: layouts, Workspaces: workspaces, 'Window Rules': rules, Appearance: appearance, Shortcuts: shortcuts, Monitors: monitors, Profiles: profiles, Advanced: advanced};
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
