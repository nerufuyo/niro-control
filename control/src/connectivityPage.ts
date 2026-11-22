// @ts-nocheck: GTK / libadwaita are untyped here
// Connectivity: Wi-Fi, Bluetooth and VPN switches, as far as Search can honestly offer them. Search only has toggles (no read-only state),
// so the page shows whether each one can run here, asks before flipping, and shows Search's answer. It says so on the page (LIMITS).
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {DBusConnectivityBackend} from './connectivityBackend.js';
import {createConnectivityFlow, LIMITS} from './connectivityLogic.js';

const esc = s => GLib.markup_escape_text(String(s ?? ''), -1);

export function connectivityPage(model, ctx, backend = new DBusConnectivityBackend(), confirm = null) {
    const ask = confirm ?? (item => new Promise(resolve => {
        const d = Adw.AlertDialog.new(`Switch ${item.title}?`, `${item.what}\n\n${item.warning}\n\nThe current state is not known to this page: it flips whatever it is now.`);
        d.add_response('cancel', 'Cancel'); d.add_response('go', 'Switch'); d.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
        d.set_default_response('cancel'); d.set_close_response('cancel');
        d.connect('response', (_d, r) => resolve(r === 'go'));
        d.present(ctx.window);
    }));
    const flow = createConnectivityFlow(backend, ask);
    const S = flow.state;
    let disposed = false, loaded = false;

    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    const scroller = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: new Adw.Clamp({child: body, maximum_size: 860, tightening_threshold: 600})});

    function render() {
        if (disposed) return;
        for (let c = body.get_first_child(); c; c = body.get_first_child()) body.remove(c);
        if (S.view === 'unavailable') {
            const b = new Adw.Banner({title: esc(S.message), button_label: 'Try again', revealed: true}); b.set_name('conn-unavailable');
            b.connect('button-clicked', () => flow.refresh()); body.append(b);
        }
        const g = new Adw.PreferencesGroup({title: 'Connections', description: 'Each switch flips the connection and asks first.'}); g.set_name('conn-list'); body.append(g);
        for (const r of S.rows) {
            const sub = !r.available && S.view === 'ready' ? `Not available: ${r.reason}` : r.last ?? (S.view === 'loading' ? 'Checking…' : r.item.what);
            const row = new Adw.ActionRow({title: esc(r.item.title), subtitle: esc(sub), title_lines: 0, subtitle_lines: 0, icon_name: r.item.icon}); row.set_name(`conn-${r.item.id}`);
            const b = new Gtk.Button({label: 'Switch…', valign: Gtk.Align.CENTER, css_classes: ['flat']}); b.set_name(`conn-toggle-${r.item.id}`);
            b.set_sensitive(r.available && S.busy === null && S.view === 'ready');
            b.update_property([Gtk.AccessibleProperty.LABEL], [`Switch ${r.item.title} on or off`]);
            b.connect('clicked', () => flow.toggle(r.item.id));
            row.add_suffix(b); g.add(row);
        }
        const lim = new Adw.PreferencesGroup({title: 'What this page cannot do'}); lim.set_name('conn-limits'); body.append(lim);
        for (const t of LIMITS) lim.add(new Adw.ActionRow({title: esc(t), title_lines: 0, css_classes: ['property']}));
    }

    const unsubscribe = flow.subscribe(render);
    const ensure = () => { if (loaded) return Promise.resolve(); loaded = true; render(); return flow.refresh(); };
    const holder = new Gtk.Box({vexpand: true}); holder.append(scroller);
    holder.connect('map', () => { if (!loaded) ensure(); });
    render();
    return {widget: holder, ensure, flow, dispose() { disposed = true; unsubscribe(); }};
}
