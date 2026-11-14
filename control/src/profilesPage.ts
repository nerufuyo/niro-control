// @ts-nocheck: GTK / libadwaita are untyped here
// The Profiles page: the active profile and whether it was changed by hand, a card for each profile (apply, rename,
// duplicate, update, export, delete), new and import, and the backups. Every change is previewed before it is applied.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {CATALOG} from './catalog.js';
import {describeValue, diff, stalePartsAffected, summarize} from './profileLogic.js';
import type {Change, Summary} from './profileLogic.js';
import type {ProfileEngine} from './profiles.js';

const MENUS = ['Look', 'Island', 'Dock', 'Windows', 'Search'];
const when = (iso: string) => GLib.DateTime.new_from_iso8601(iso, null)?.to_local().format('%d %b %Y, %H:%M') ?? iso;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function profilesPage(engine: ProfileEngine, ctx) {
    const byId = new Map(CATALOG.map(i => [i.id, i]));
    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    const scroller = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true,
        child: new Adw.Clamp({child: root, maximum_size: 860, tightening_threshold: 600})});

    // ---- Dialogs
    const failure = (title: string, message: string) => {
        const d = Adw.AlertDialog.new(title, message);
        d.add_response('ok', 'OK');
        d.present(ctx.window);
    };
    const attempt = (title: string, fn: () => void) => {
        try { fn(); } catch (e) { failure(title, e.message); }
    };

    const changeList = (changes: Change[]) => {
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        for (const c of changes) {
            const item = byId.get(c.id);
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(item?.title ?? c.id, -1), subtitle: GLib.markup_escape_text(`${c.menu} › ${c.group}`, -1)});
            row.add_suffix(new Gtk.Label({label: `${describeValue(item, c.from)}  →  ${describeValue(item, c.to)}`, css_classes: ['numeric'], wrap: false, xalign: 1}));
            list.append(row);
        }
        return new Gtk.ScrolledWindow({child: list, min_content_height: Math.min(300, 56 * changes.length + 4), max_content_height: 320,
            hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true});
    };

    /** Shows what would change: a headline and the areas first, the old and new values on request; `go` runs when the person agrees. */
    const confirm = (title: string, changes: Change[], verb: string, go: () => void, sum?: Summary) => {
        sum ??= summarize(changes, {...engine.capture(), ...Object.fromEntries(changes.map(c => [c.id, c.to]))}, engine.items, ctx.stale ?? []);
        const empty = !changes.length;
        const d = Adw.AlertDialog.new(title, sum.headline);
        if (!empty) {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
            box.append(new Gtk.Label({label: sum.categories.map(c => `${c.menu} ${c.count}`).join('   ·   '), xalign: 0, css_classes: ['heading']}));
            const more = new Gtk.Expander({label: 'Show old and new values', child: changeList(changes)});
            more.update_property([Gtk.AccessibleProperty.DESCRIPTION], [sum.headline]);
            box.append(more);
            for (const [text, css] of [...sum.conflicts.map(c => [`Note: ${c}.`, 'warning']), ...(sum.login ? [[sum.login, 'warning']] : []), [sum.undo, 'dim-label']])
                box.append(new Gtk.Label({label: text, wrap: true, xalign: 0, css_classes: ['caption', css]}));
            d.set_extra_child(box);
        }
        d.add_response('cancel', 'Cancel');
        if (!empty) { d.add_response('go', verb); d.set_response_appearance('go', Adw.ResponseAppearance.SUGGESTED); d.set_default_response('go'); }
        d.connect('response', (_d, response) => response === 'go' && go());
        d.present(ctx.window);
    };

    const report = (name: string, result) => {
        if (result.ok) {
            const t = result.changed.length ? `Applied "${name}": ${plural(result.changed.length, 'setting')} changed` : `"${name}" already matches`;
            ctx.toast(t, result.changed.length ? () => undoLast() : undefined, 'Undo');
            const pending = stalePartsAffected(result.changed, ctx.stale ?? [], CATALOG);
            const lines = [...(result.notes ?? []).map(n => n.text), ...(pending.length ? [`${pending.join(', ')} ${pending.length === 1 ? 'has' : 'have'} an update that loads at your next login: until then these settings are read by the older version.`] : [])];
            if (lines.length) failure('Applied, with notes', lines.join('\n\n'));
        } else {
            failure(`Couldn't apply "${name}"`,
                `"${result.failed.title}" could not be written: ${result.failed.error}.\n` +
                (result.rolledBack ? 'Everything written before it was put back, so nothing changed.' :
                    `Some settings could not be put back: ${result.rollbackErrors.join('; ')}. Restore the backup "Before applying ${name}" under Backups.`));
        }
        refresh();
    };

    const undoLast = () => {
        const last = engine.backups()[0];
        if (last) attempt('Undo failed', () => { const r = engine.restore(last.file); report('the backup', r); });
    };

    const apply = (profile) => {
        const target = engine.settingsOf(profile);
        const changes = engine.preview(target);
        confirm(`Apply "${profile.name}"?`, changes, 'Apply', () => attempt('Apply failed', () => report(profile.name, engine.apply(profile.id))),
            summarize(changes, {...engine.capture(), ...target}, engine.items, ctx.stale ?? []));
    };

    const ask = (title: string, body: string, initial: string, verb: string, go: (text: string, menus: string[]) => void, scopes = false) => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        const entry = new Gtk.Entry({text: initial, activates_default: true, hexpand: true});
        entry.update_property([Gtk.AccessibleProperty.LABEL], ['Profile name']);
        box.append(entry);
        const checks = [];
        if (scopes) {
            box.append(new Gtk.Label({label: 'Include (leave some out for a partial profile)', xalign: 0, css_classes: ['dim-label', 'caption']}));
            const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 5, column_spacing: 6, row_spacing: 4});
            for (const m of MENUS) {
                const c = new Gtk.CheckButton({label: m, active: true});
                flow.append(c); checks.push([m, c]);
            }
            box.append(flow);
        }
        const d = Adw.AlertDialog.new(title, body);
        d.set_extra_child(box);
        d.add_response('cancel', 'Cancel'); d.add_response('go', verb);
        d.set_response_appearance('go', Adw.ResponseAppearance.SUGGESTED); d.set_default_response('go');
        d.connect('response', (_d, response) => {
            if (response !== 'go') return;
            const menus = checks.filter(([, c]) => c.get_active()).map(([m]) => m);
            if (scopes && !menus.length) { failure('Nothing selected', 'Choose at least one area to include.'); return; }
            go(entry.get_text(), scopes && menus.length < MENUS.length ? menus : []);
        });
        d.present(ctx.window);
        entry.grab_focus();
    };

    const fileDialog = (title: string, save: boolean, name: string, done: (path: string) => void) => {
        const dialog = new Gtk.FileDialog({title, initial_name: name});
        const filter = new Gtk.FileFilter({name: 'Niro profiles (JSON)'}); filter.add_pattern('*.json');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter}); filters.append(filter);
        dialog.set_filters(filters);
        const finish = (_d, res) => {
            try {
                const file = save ? dialog.save_finish(res) : dialog.open_finish(res);
                if (file) done(file.get_path());
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) ctx.toast(e.message);
            }
        };
        if (save) dialog.save(ctx.window, null, finish); else dialog.open(ctx.window, null, finish);
    };

    // ---- The pieces of the page
    const status = new Adw.PreferencesGroup();
    const actions = new Gtk.Box({spacing: 8, halign: Gtk.Align.START});
    const cards = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 3, min_children_per_line: 1, column_spacing: 12, row_spacing: 12, homogeneous: true, valign: Gtk.Align.START});
    const backupsGroup = new Adw.PreferencesGroup({title: 'Backups', description: 'A backup is made before every profile is applied or restored. The last 10 are kept.'});
    const backupsExpander = new Adw.ExpanderRow({title: 'Backups', subtitle: 'Restore an earlier state of every setting'});
    let backupRows = [];

    const newBtn = new Gtk.Button({label: 'Save current as profile…', css_classes: ['suggested-action']});
    newBtn.connect('clicked', () => ask('New profile', 'Saves the settings in force now.', '', 'Save', (name, menus) =>
        attempt('Not saved', () => { const p = engine.create(name, {menus}); engine.setActive(p.id); refresh(); ctx.toast(`Saved "${p.name}"`); }), true));
    const importBtn = new Gtk.Button({label: 'Import…'});
    importBtn.connect('clicked', () => fileDialog('Import a profile', false, '', path => attempt('Not imported', () => {
        const {profile, warnings} = engine.importFrom(path);
        refresh();
        ctx.toast(`Imported "${profile.name}"${warnings.length ? ` with ${plural(warnings.length, 'note')}` : ''}`);
        if (warnings.length) failure(`Imported "${profile.name}", with notes`, warnings.map(w => `• ${w}`).join('\n'));
    })));
    const backupBtn = new Gtk.Button({label: 'Back up now'});
    backupBtn.connect('clicked', () => attempt('Backup failed', () => { const b = engine.backup('Manual backup'); refresh(); ctx.toast(`Backed up ${plural(b.count, 'setting')}`); }));
    [newBtn, importBtn, backupBtn].forEach(b => actions.append(b));

    const card = (p, active: boolean, modified: boolean) => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 14, margin_bottom: 14, margin_start: 14, margin_end: 14, css_classes: active ? ['niro-card-active'] : []});
        const head = new Gtk.Box({spacing: 8});
        head.append(new Gtk.Label({label: p.name, xalign: 0, hexpand: true, css_classes: ['title-4'], ellipsize: 3, max_width_chars: 20}));
        if (active) head.append(new Gtk.Label({label: modified ? 'Active · modified' : 'Active', css_classes: [modified ? 'warning' : 'success', 'caption-heading']}));
        box.append(head);
        box.append(new Gtk.Label({label: p.description || 'No description', xalign: 0, wrap: true, css_classes: ['dim-label'], lines: 2, ellipsize: 3, vexpand: true, valign: Gtk.Align.START, max_width_chars: 26, width_chars: 22}));
        const own = Object.keys(p.settings).length;
        const tags = [p.builtin ? 'Built-in' : 'Yours', p.extends ? `Based on ${(engine.get(p.extends)?.name ?? p.extends)}` : (own >= engine.items.length * 0.9 ? 'Complete' : `Partial · ${plural(own, 'setting')}`)];
        box.append(new Gtk.Label({label: tags.join('  ·  '), xalign: 0, css_classes: ['caption', 'dim-label']}));
        const row = new Gtk.Box({spacing: 6});
        const applyBtn = new Gtk.Button({label: active && !modified ? 'Applied' : 'Apply', css_classes: active && !modified ? [] : ['suggested-action'], sensitive: !(active && !modified), hexpand: true});
        applyBtn.connect('clicked', () => apply(p));
        row.append(applyBtn);
        const menu = new Gio.Menu();
        menu.append('Rename…', `p.rename::${p.id}`); menu.append('Duplicate', `p.duplicate::${p.id}`);
        menu.append('Update from current settings', `p.update::${p.id}`); menu.append('Export…', `p.export::${p.id}`);
        menu.append('Delete', `p.delete::${p.id}`);
        const more = new Gtk.MenuButton({icon_name: 'view-more-symbolic', css_classes: ['flat'], menu_model: menu, tooltip_text: 'More'});
        more.update_property([Gtk.AccessibleProperty.LABEL], [`More actions for ${p.name}`]);
        row.append(more);
        box.append(row);
        const frame = new Gtk.Frame({child: box, css_classes: ['niro-card']});
        return frame;
    };

    // actions of the card menus
    const group = new Gio.SimpleActionGroup();
    const act = (name, fn) => {
        const a = new Gio.SimpleAction({name, parameter_type: new GLib.VariantType('s')});
        a.connect('activate', (_a, param) => fn(engine.get(param.unpack())));
        group.add_action(a);
    };
    const protectedMsg = (p) => p.builtin && failure('Built-in profile', `"${p.name}" is built in and can't be changed or deleted. Duplicate it to make your own copy.`);
    act('rename', p => protectedMsg(p) ?? ask('Rename profile', '', p.name, 'Rename', name => attempt('Not renamed', () => { engine.rename(p.id, name); refresh(); })));
    act('duplicate', p => attempt('Not duplicated', () => { const c = engine.duplicate(p.id); refresh(); ctx.toast(`Created "${c.name}"`); }));
    act('update', p => {
        if (protectedMsg(p)) return;
        const ids = Object.keys(p.settings);
        const changes = diff(p.settings, engine.capture(ids), engine.items);
        confirm(`Update "${p.name}" from the current settings?`, changes, 'Update', () =>
            attempt('Not updated', () => { engine.updateFromCurrent(p.id); refresh(); ctx.toast(`Updated "${p.name}"`); }),
            summarize(changes, {}, [], [], 'The profile is rewritten from the settings in force now. The settings themselves stay as they are.'));
    });
    act('export', p => fileDialog('Export profile', true, `${p.id}.json`, path => attempt('Not exported', () => { engine.exportTo(p.id, path); ctx.toast(`Exported to ${path}`); })));
    act('delete', p => {
        if (protectedMsg(p)) return;
        const d = Adw.AlertDialog.new(`Delete "${p.name}"?`, 'The profile file is removed. Your current settings are not changed.');
        d.add_response('cancel', 'Cancel'); d.add_response('go', 'Delete'); d.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
        d.connect('response', (_d, r) => r === 'go' && attempt('Not deleted', () => { engine.remove(p.id); refresh(); }));
        d.present(ctx.window);
    });
    scroller.insert_action_group('p', group);

    // ---- Refresh
    function refresh() {
        const activeId = engine.active();
        const mods = engine.modifications();
        const profiles = engine.list();
        const active = profiles.find(p => p.id === activeId);

        status.set_title(active ? `Active profile: ${active.name}` : 'No active profile');
        status.set_description(!active ? 'Apply a profile to make it active.' : mods.length ? `${plural(mods.length, 'setting')} changed by hand since it was applied.` : 'The settings match this profile.');
        if (status._extra) status.remove(status._extra);
        status._extra = null;
        if (status._broken) status.remove(status._broken);
        status._broken = null;
        const broken = engine.interrupted();
        if (broken) {
            const r = new Adw.ActionRow({title: 'A change did not finish', subtitle: GLib.markup_escape_text(`"${broken.label}" was interrupted. ${broken.backup ? 'Restore the backup made before it to be sure of what is set.' : ''}`, -1), icon_name: 'dialog-warning-symbolic'});
            const undo = new Gtk.Button({label: 'Restore backup', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
            undo.connect('clicked', () => attempt('Recovery failed', () => { report('the backup', engine.recover()); }));
            const keep = new Gtk.Button({label: 'Keep as is', valign: Gtk.Align.CENTER});
            keep.connect('clicked', () => { engine.dismissInterrupted(); refresh(); });
            r.add_suffix(undo); r.add_suffix(keep);
            status.add(r); status._broken = r;
        }
        if (active && mods.length) {
            const row = new Adw.ActionRow({title: 'Settings differ from the profile', subtitle: mods.slice(0, 3).map(c => byId.get(c.id)?.title ?? c.id).join(', ') + (mods.length > 3 ? `, and ${mods.length - 3} more` : '')});
            const review = new Gtk.Button({label: 'Review', valign: Gtk.Align.CENTER});
            review.connect('clicked', () => confirm(`Changed since "${active.name}" was applied`, mods, 'Revert to profile', () => attempt('Revert failed', () => report(active.name, engine.apply(active.id)))));
            row.add_suffix(review);
            if (!active.builtin) {
                const save = new Gtk.Button({label: 'Save into profile', valign: Gtk.Align.CENTER});
                save.connect('clicked', () => attempt('Not saved', () => { engine.updateFromCurrent(active.id); refresh(); ctx.toast(`Updated "${active.name}"`); }));
                row.add_suffix(save);
            }
            status.add(row); status._extra = row;
        }
        let child;
        while ((child = cards.get_first_child())) cards.remove(child);
        for (const p of profiles) cards.append(card(p, p.id === activeId, p.id === activeId && mods.length > 0));

        backupRows.forEach(r => backupsExpander.remove(r)); backupRows = [];
        const backups = engine.backups();
        backupsExpander.set_subtitle(backups.length ? `${plural(backups.length, 'backup')}, newest ${when(backups[0].createdAt)}` : 'None yet');
        for (const b of backups) {
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(b.label, -1), subtitle: `${when(b.createdAt)} · ${plural(b.count, 'setting')}`});
            const restore = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER});
            restore.connect('clicked', () => attempt('Restore failed', () => {
                const target = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(b.file)[1])).settings;
                { const changes = engine.preview(target); confirm(`Restore "${b.label}"?`, changes, 'Restore', () => attempt('Restore failed', () => report('the backup', engine.restore(b.file))), summarize(changes, {...engine.capture(), ...target}, engine.items, ctx.stale ?? [], 'The settings as they are now are backed up first.')); }
            }));
            const del = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Delete this backup'});
            del.update_property([Gtk.AccessibleProperty.LABEL], [`Delete backup ${b.label}`]);
            del.connect('clicked', () => attempt('Not deleted', () => { engine.deleteBackup(b.file); refresh(); }));
            row.add_suffix(restore); row.add_suffix(del);
            backupsExpander.add_row(row); backupRows.push(row);
        }
    }

    root.append(status); root.append(actions); root.append(cards);
    const bg = new Adw.PreferencesGroup(); bg.add(backupsExpander); root.append(bg);

    // the settings can change from anywhere (the other pages, gsettings): look again a moment after the last change
    let timer = 0;
    const later = () => { if (timer) GLib.source_remove(timer); timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => { timer = 0; refresh(); return GLib.SOURCE_REMOVE; }); };
    for (const s of Object.values(engine.stores.by)) s?.connect('changed', later);
    refresh();
    return {widget: scroller, refresh, apply, recover: () => attempt('Recovery failed', () => { report('the backup', engine.recover()); })};
}
