// @ts-nocheck: GTK / libadwaita are untyped here
// Home: what the desktop is set to right now, at a glance. The active profile, the look, the island, the dock, how far the
// settings are from their defaults, quick actions, and anything that needs attention. Light: it reads, it never writes.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {CATALOG} from './catalog.js';

const POSITIONS = ['Bottom', 'Left', 'Right', 'Top'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const PARTS = [['Island', 'island@niro.local'], ['Dock', 'dock@niro.local'], ['Search', 'search@niro.local'], ['Window blur', 'blur@niro.local'],
    ['Rounded corners', 'corners@niro.local'], ['Emoji', 'emoji@niro.local'], ['Emulator', 'emulator@niro.local']];

/** Whether a name has an owner on the session bus (the island's programs are separate from its extension). */
export function busNameOwned(name: string): boolean {
    try {
        const reply = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
            new GLib.Variant('(s)', [name]), null, Gio.DBusCallFlags.NONE, 800, null);
        return reply.deepUnpack()[0];
    } catch (_e) {
        return false;
    }
}

const installed = (uuid: string) => GLib.file_test(`/usr/share/gnome-shell/extensions/${uuid}`, GLib.FileTest.IS_DIR);

export function homeData(model, staleParts: string[]) {
    const read = model.read;
    const engine = model.engine;
    const profiles = engine.list();
    const activeId = engine.active();
    const active = profiles.find(p => p.id === activeId) ?? null;
    const changes = active ? engine.modifications() : [];
    let differing = 0, total = 0;
    for (const item of engine.items) {
        const b = model.binding(item);
        if (!b) continue;
        total++;
        try { if (!(Array.isArray(b) ? b.every(x => x.isDefault()) : b.isDefault())) differing++; } catch (_e) { /* not counted */ }
    }
    const notices = [];
    if (staleParts.length) notices.push({kind: 'logout', text: `A newer ${staleParts.join(', ')} is installed. Log out and in to load it.`});
    for (const [name, uuid] of PARTS) if (!installed(uuid)) notices.push({kind: 'missing', text: `${name} is not installed.`});
    const daemon = busNameOwned('org.niro.island.Daemon');
    if (installed('island@niro.local') && !daemon) notices.push({kind: 'daemon', text: "The island's background service is not running: music, calls and the assistant need it."});
    const broken = engine.interrupted();
    if (broken) notices.push({kind: 'interrupted', text: `"${broken.label}" did not finish. Restore the backup made before it.`});
    if (!engine.backups().length) notices.push({kind: 'info', text: 'No backup yet. One is made before every profile is applied.'});
    return {
        profile: {name: active?.name ?? null, modified: changes.length, id: activeId, missing: Boolean(activeId && !active)},
        look: {accent: read('niro.accent'), tint: read('niro.tint'), opacity: read('niro.opacity'), blur: read('niro.blur'), strength: read('niro.blur-strength')},
        island: {shape: read('island.island-shape'), opens: read('island.open-on'), autoHide: read('island.auto-hide'), daemon, installed: installed('island@niro.local')},
        dock: {position: POSITIONS[read('dock.dock-position')] ?? '?', size: read('dock.icon-size'), magnification: read('dock.magnification-enabled'),
            autoHide: read('dock.auto-hide'), installed: installed('dock@niro.local')},
        config: {differing, total},
        notices,
        advanced: {
            parts: PARTS.map(([name, uuid]) => ({name, uuid, installed: installed(uuid)})),
            paths: {config: engine.root, builtin: engine.builtinDir},
            backups: engine.backups().length, profiles: profiles.length,
        },
    };
}

export function homePage(model, ctx, profilesApi, staleParts: string[]) {
    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    const scroller = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true,
        child: new Adw.Clamp({child: root, maximum_size: 860, tightening_threshold: 600})});
    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18});
    root.append(body);

    const card = (title: string, rows: [string, string][], open?: [string, string]) => {
        const g = new Adw.PreferencesGroup({title});
        for (const [k, v] of rows) {
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(k, -1)});
            row.add_suffix(new Gtk.Label({label: String(v), css_classes: ['dim-label'], xalign: 1, wrap: false}));
            g.add(row);
        }
        if (open) {
            const b = new Gtk.Button({label: open[0], halign: Gtk.Align.END, css_classes: ['flat']});
            b.connect('clicked', () => ctx.go(open[1]));
            g.set_header_suffix(b);
        }
        return g;
    };

    function render() {
        let child;
        while ((child = body.get_first_child())) body.remove(child);
        const d = homeData(model, staleParts);

        // the active profile
        const head = new Adw.PreferencesGroup({title: d.profile.name ? `Active profile: ${d.profile.name}` : 'No active profile',
            description: d.profile.missing ? 'The profile that was active has been deleted.' : d.profile.name ? (d.profile.modified ? `${plural(d.profile.modified, 'setting')} changed by hand since it was applied.` : 'The settings match this profile.') : 'Apply a profile to set the whole desktop at once.'});
        const row = new Gtk.Box({spacing: 8, margin_top: 4});
        for (const p of model.engine.list().slice(0, 4)) {
            const b = new Gtk.Button({label: p.name, css_classes: p.id === d.profile.id && !d.profile.modified ? ['suggested-action'] : []});
            b.connect('clicked', () => profilesApi.apply(p));
            row.append(b);
        }
        const all = new Gtk.Button({label: 'All profiles…', css_classes: ['flat']});
        all.connect('clicked', () => ctx.go('profiles'));
        row.append(all);
        head.add(row);
        body.append(head);

        // notices
        if (d.notices.length) {
            const g = new Adw.PreferencesGroup({title: 'Needs attention'});
            for (const n of d.notices.filter(x => x.kind !== 'info')) {
                const r = new Adw.ActionRow({title: GLib.markup_escape_text(n.text, -1), icon_name: n.kind === 'logout' ? 'system-log-out-symbolic' : 'dialog-warning-symbolic'});
                if (n.kind === 'interrupted') {
                    const b = new Gtk.Button({label: 'Restore backup', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
                    b.connect('clicked', () => profilesApi.recover());
                    r.add_suffix(b);
                }
                if (n.kind === 'logout') {
                    const b = new Gtk.Button({label: 'Log out', valign: Gtk.Align.CENTER});
                    b.connect('clicked', () => ctx.logout());
                    r.add_suffix(b);
                }
                g.add(r);
            }
            if (g.get_first_child() && d.notices.some(x => x.kind !== 'info')) body.append(g);
            const info = d.notices.find(x => x.kind === 'info');
            if (info) {
                const r = new Adw.ActionRow({title: GLib.markup_escape_text(info.text, -1), icon_name: 'dialog-information-symbolic'});
                const b = new Gtk.Button({label: 'Back up now', valign: Gtk.Align.CENTER, css_classes: ['flat']});
                b.connect('clicked', () => { try { model.engine.backup('Manual backup'); render(); ctx.toast('Backed up the settings'); } catch (e) { ctx.toast(e.message); } });
                r.add_suffix(b);
                const g2 = new Adw.PreferencesGroup(); g2.add(r); body.append(g2);
            }
        }

        // the three areas side by side
        const grid = new Gtk.Grid({column_spacing: 12, row_spacing: 12, column_homogeneous: true});
        const look = card('Look', [['Opacity', `${d.look.opacity} %`], ['Blur', d.look.blur ? `On, strength ${d.look.strength} %` : 'Off'], ['Accent', String(d.look.accent)]], ['Open', 'look']);
        grid.attach(look, 0, 0, 1, 1);
        grid.attach(card('Island', d.island.installed ? [['Shape', d.island.shape], ['Opens on', d.island.opens], ['Auto-hide', d.island.autoHide],
            ['Background service', d.island.daemon ? 'Running' : 'Not running']] : [['Status', 'Not installed']], ['Open', 'island']), 1, 0, 1, 1);
        grid.attach(card('Dock', d.dock.installed ? [['Position', d.dock.position], ['Icon size', `${d.dock.size} px`], ['Magnification', d.dock.magnification ? 'On' : 'Off'],
            ['Auto-hide', d.dock.autoHide ? 'On' : 'Off']] : [['Status', 'Not installed']], ['Open', 'dock']), 2, 0, 1, 1);
        body.append(grid);

        // the configuration as a whole
        const cfg = new Adw.PreferencesGroup({title: 'Desktop configuration'});
        const r = new Adw.ActionRow({title: d.config.differing ? `${plural(d.config.differing, 'setting')} differ from the defaults` : 'Every setting is at its default',
            subtitle: `${d.config.total} settings in all, across the island, dock, windows, search and look`});
        const search = new Gtk.Button({label: 'Search settings', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        search.connect('clicked', () => ctx.focusSearch());
        r.add_suffix(search);
        cfg.add(r);
        body.append(cfg);

        // advanced: diagnostics
        if (model.mode === 'advanced') {
            const g = new Adw.PreferencesGroup({title: 'Diagnostics', description: 'Where things are and what is installed'});
            for (const p of d.advanced.parts) {
                const pr = new Adw.ActionRow({title: p.name, subtitle: p.uuid});
                pr.add_suffix(new Gtk.Label({label: p.installed ? 'Installed' : 'Missing', css_classes: [p.installed ? 'success' : 'error']}));
                g.add(pr);
            }
            for (const [k, v] of [['Profiles and backups', d.advanced.paths.config], ['Built-in profiles', d.advanced.paths.builtin], ['Backups kept', String(d.advanced.backups)], ['Profiles', String(d.advanced.profiles)]]) {
                const pr = new Adw.ActionRow({title: k});
                pr.add_suffix(new Gtk.Label({label: v, css_classes: ['dim-label', 'monospace'], selectable: true, xalign: 1, wrap: true}));
                g.add(pr);
            }
            body.append(g);
        }
    }

    render();
    model.onMode = () => render();
    let timer = 0;
    const later = () => { if (timer) GLib.source_remove(timer); timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { timer = 0; render(); return GLib.SOURCE_REMOVE; }); };
    for (const s of Object.values(model.stores.by)) s?.connect('changed', later);
    return {widget: scroller, refresh: render};
}
