// @ts-nocheck: GTK / libadwaita are untyped here
// Backup & Restore: export the Niro settings to a file you choose, and restore from one with a preview first. The page draws the state of
// backupLogic's controller (loading, empty, ready, error, and while a call is out: exporting, reading, applying; then success or
// rollback). Nothing runs by itself: a file is written only after "Export", and settings change only after "Apply". The backend and the
// file pickers are injected, so tests pass fakes. Secrets are never exported (the page says what is left out).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {GioFiles, realEnv, appVersion} from './backupBackend.js';
import {createBackupFlow, EXCLUSIONS, shortValue, SOURCES} from './backupLogic.js';

const esc = s => GLib.markup_escape_text(String(s ?? ''), -1);
const STATUS = {
    loading: ['content-loading-symbolic', 'Looking at the settings', 'Finding which Niro settings are installed.'],
    empty: ['dialog-information-symbolic', 'Nothing to back up', 'No Niro settings schema is installed on this system.'],
    error: ['dialog-error-symbolic', 'The settings could not be read', ''],
};
const MAX_SHOWN = 200;

/** The file pickers (GTK's own dialogs). Each resolves a path, or null when cancelled. */
export function gtkDialogs(ctx) {
    const filters = () => { const f = new Gtk.FileFilter({name: 'Niro settings backup (JSON)'}); f.add_pattern('*.json'); const l = new Gio.ListStore({item_type: Gtk.FileFilter}); l.append(f); return l; };
    return {
        async save(name) {
            try { return (await new Gtk.FileDialog({title: 'Export Niro settings', initial_name: name, filters: filters()}).save(ctx.window, null))?.get_path() ?? null; } catch (_e) { return null; }
        },
        async open() {
            try { return (await new Gtk.FileDialog({title: 'Choose a Niro settings backup', filters: filters()}).open(ctx.window, null))?.get_path() ?? null; } catch (_e) { return null; }
        },
    };
}
Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');

/** `env` and `files` default to the real settings and files; `dialogs` to GTK's pickers. */
export function backupPage(model, ctx, env = realEnv(appVersion()), files = new GioFiles(), dialogs = gtkDialogs(ctx)) {
    const flow = createBackupFlow(env, files);
    const S = flow.state;
    let disposed = false, loaded = false;

    const stack = new Gtk.Stack({vexpand: true, hexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});
    const statusSpinner = new Gtk.Spinner({spinning: true, width_request: 32, height_request: 32, halign: Gtk.Align.CENTER});
    const retry = new Gtk.Button({label: 'Try again', halign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'pill']}); retry.set_name('backup-retry');
    const statusBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER});
    statusBox.append(statusSpinner); statusBox.append(retry);
    const status = new Adw.StatusPage({vexpand: true, child: statusBox}); status.set_name('backup-status');
    retry.connect('clicked', () => flow.refresh());
    stack.add_named(status, 'status');

    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    stack.add_named(new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({child: body, maximum_size: 860, tightening_threshold: 600})}), 'main');

    const button = (label, fn, css = ['flat'], name = null) => {
        const b = new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css}); if (name) b.set_name(name);
        b.connect('clicked', fn); return b;
    };
    const group = (title, description = '') => { const g = new Adw.PreferencesGroup({title: esc(title), description: esc(description)}); body.append(g); return g; };
    const textRow = (title, subtitle = '', name = null, css = ['property']) => {
        const r = new Adw.ActionRow({title: esc(title), subtitle: esc(subtitle), title_lines: 0, subtitle_lines: 0, css_classes: css}); if (name) r.set_name(name); return r;
    };
    const busy = () => S.busy !== null;
    const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

    async function doExport() { const path = await dialogs.save(`niro-settings-${stamp()}.json`); if (path) await flow.exportTo(path); }
    async function doChoose() { const path = await dialogs.open(); if (path) await flow.loadFile(path); }

    function render() {
        if (disposed) return;
        if (S.view !== 'ready') {
            const [icon, title, text] = STATUS[S.view];
            status.set_icon_name(icon); status.set_title(title); status.set_description(esc(S.message || text));
            statusSpinner.set_visible(S.view === 'loading'); statusSpinner.set_spinning(S.view === 'loading');
            retry.set_visible(S.view !== 'loading');
            stack.set_visible_child_name('status');
            return;
        }
        for (let c = body.get_first_child(); c; c = body.get_first_child()) body.remove(c);

        if (S.status) {
            const banner = new Adw.Banner({title: esc(S.status.text), button_label: 'Dismiss', revealed: true}); banner.set_name(`backup-${S.status.kind}`);
            banner.connect('button-clicked', () => flow.dismiss());
            body.append(banner);
        }

        // ---- export
        const ex = group('Export', 'Writes the settings of the Niro parts that are installed to a JSON file you choose. Nothing is exported until you press Export.');
        ex.add(textRow('Included', S.groups.map(g => g[1]).join(', '), 'backup-included'));
        const left = textRow('Never included', EXCLUSIONS.join('\n'), 'backup-excluded');
        ex.add(left);
        const exRow = new Adw.ActionRow({title: 'Export settings', title_lines: 0}); exRow.set_name('backup-export-row');
        const exBtn = button('Export…', () => doExport(), ['suggested-action'], 'backup-export'); exBtn.set_sensitive(!busy());
        exBtn.update_property([Gtk.AccessibleProperty.LABEL], ['Export the Niro settings to a file']);
        exRow.add_suffix(exBtn); ex.add(exRow);
        if (S.lastExport?.excluded.length) ex.add(textRow('Left out of the last export', S.lastExport.excluded.join(', '), 'backup-last-excluded'));

        // ---- restore
        const re = group('Restore', 'Choose a backup to see what it would change. Nothing is written until you press Apply, and a failed import is put back.');
        const pick = new Adw.ActionRow({title: 'Choose a backup…', title_lines: 0}); pick.set_name('backup-choose-row');
        const pickBtn = button('Choose…', () => doChoose(), ['flat'], 'backup-choose'); pickBtn.set_sensitive(!busy());
        pickBtn.update_property([Gtk.AccessibleProperty.LABEL], ['Choose a Niro settings backup to restore']);
        pick.add_suffix(pickBtn); re.add(pick);
        if (S.applied && !S.plan) {
            const u = textRow('Undo the last import', `${S.applied.changes.length} setting${S.applied.changes.length === 1 ? '' : 's'} changed`, 'backup-undo-row', []);
            const ub = button('Undo', () => flow.undo(), ['flat'], 'backup-undo'); ub.set_sensitive(!busy()); u.add_suffix(ub); re.add(u);
        }

        const plan = S.plan;
        if (plan) {
            const pv = group(`Preview: ${plan.file ?? 'backup'}`, plan.ok
                ? `${plan.changes.length} setting${plan.changes.length === 1 ? '' : 's'} would change; ${plan.unchanged} already the same${plan.skipped.length ? `; not installed here and skipped: ${plan.skipped.map(s => SOURCES.find(x => x[0] === s)?.[1] ?? s).join(', ')}` : ''}.`
                : 'This backup was refused. Nothing will be written.');
            pv.set_name('backup-preview');
            for (const p of plan.problems.slice(0, MAX_SHOWN)) pv.add(textRow(p, '', 'backup-problem', ['error']));
            if (plan.ok && !plan.changes.length) pv.add(textRow('Nothing to change', 'Every setting in the backup already has this value.', 'backup-nochange'));
            for (const c of plan.changes.slice(0, MAX_SHOWN)) pv.add(textRow(c.id, `${shortValue(c.before)}  →  ${shortValue(c.after)}`, `backup-change:${c.id}`));
            if (plan.changes.length > MAX_SHOWN) pv.add(textRow(`and ${plan.changes.length - MAX_SHOWN} more`, '', 'backup-more'));
            const acts = new Gtk.Box({spacing: 8, halign: Gtk.Align.END, margin_top: 6});
            const cancel = button('Cancel', () => flow.cancel(), ['flat'], 'backup-cancel'); cancel.set_sensitive(!busy());
            const apply = button('Apply', () => flow.apply(), ['suggested-action'], 'backup-apply'); apply.set_sensitive(plan.ok && plan.changes.length > 0 && !busy());
            apply.update_property([Gtk.AccessibleProperty.LABEL], ['Apply the imported settings']);
            acts.append(cancel); acts.append(apply); body.append(acts);
        }

        if (S.busy) {
            const box = new Gtk.Box({spacing: 8, halign: Gtk.Align.CENTER}); box.set_name('backup-applying');
            box.append(new Gtk.Spinner({spinning: true}));
            box.append(new Gtk.Label({label: S.busy === 'applying' ? 'Applying and checking each setting…' : S.busy === 'exporting' ? 'Exporting…' : 'Reading the backup…'}));
            body.append(box);
        }
        stack.set_visible_child_name('main');
    }

    const unsubscribe = flow.subscribe(render);
    const ensure = () => { if (loaded) return Promise.resolve(); loaded = true; render(); return flow.refresh(); };
    const holder = new Gtk.Box({vexpand: true}); holder.append(stack);
    holder.connect('map', () => { if (!loaded) ensure(); });
    const dispose = () => { disposed = true; unsubscribe(); };
    render();
    return {widget: holder, ensure, flow, dispose, stack, doExport, doChoose};
}
