// @ts-nocheck: GTK / libadwaita are untyped here
// Permissions: which programs may use Search's actions over D-Bus, and what they were asked lately. The page draws the state of
// permissionsLogic's controller. Giving access always asks here first (and Search asks again on its own screen); "Never allow" and
// "Remove" change nothing else and go straight through. The history shows who asked for what and the verdict, never arguments.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {DBusPermissionsBackend} from './permissionsBackend.js';
import {CAPABILITIES, CAPABILITY_TEXT, createPermissionsFlow, givesMoreAccess, SCOPE_TEXT, SCOPES, sentence, whenText} from './permissionsLogic.js';

const esc = s => GLib.markup_escape_text(String(s ?? ''), -1);
const STATUS = {
    loading: ['content-loading-symbolic', 'Reading permissions', 'Asking Niro Search for the grants.'],
    unavailable: ['dialog-warning-symbolic', 'Permissions are not available', ''],
    error: ['dialog-error-symbolic', 'Permissions could not be read', ''],
};

/** `backend` defaults to Search over D-Bus; `confirm(title, body, verb)` to an Adw.AlertDialog (resolves true when the user agrees). */
export function permissionsPage(model, ctx, backend = new DBusPermissionsBackend(), confirm = null) {
    const flow = createPermissionsFlow(backend);
    const S = flow.state;
    let disposed = false, loaded = false;
    const ask = confirm ?? ((title, body, verb) => new Promise(resolve => {
        const d = Adw.AlertDialog.new(title, body);
        d.add_response('cancel', 'Cancel'); d.add_response('go', verb); d.set_response_appearance('go', Adw.ResponseAppearance.SUGGESTED);
        d.set_default_response('cancel'); d.set_close_response('cancel');
        d.connect('response', (_d, r) => resolve(r === 'go'));
        d.present(ctx.window);
    }));

    const stack = new Gtk.Stack({vexpand: true, hexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});
    const spinner = new Gtk.Spinner({spinning: true, width_request: 32, height_request: 32, halign: Gtk.Align.CENTER});
    const retry = new Gtk.Button({label: 'Try again', halign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'pill']}); retry.set_name('perm-retry');
    const statusBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER});
    statusBox.append(spinner); statusBox.append(retry);
    const status = new Adw.StatusPage({vexpand: true, child: statusBox}); status.set_name('perm-status');
    retry.connect('clicked', () => flow.refresh());
    stack.add_named(status, 'status');
    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    stack.add_named(new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({child: body, maximum_size: 860, tightening_threshold: 600})}), 'main');

    const button = (label, fn, css = ['flat'], name = null) => { const b = new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css}); if (name) b.set_name(name); b.connect('clicked', fn); return b; };
    const group = (title, description = '') => { const g = new Adw.PreferencesGroup({title: esc(title), description: esc(description)}); body.append(g); return g; };
    const textRow = (title, subtitle = '', name = null, css = ['property']) => { const r = new Adw.ActionRow({title: esc(title), subtitle: esc(subtitle), title_lines: 0, subtitle_lines: 0, css_classes: css}); if (name) r.set_name(name); return r; };
    const busy = () => S.busy !== null;

    // the form keeps its text across redraws
    const form = {subject: '', capability: 'file', scope: 'deny'};

    /** The one place a grant is made: an allowing scope asks first, a deny does not. */
    async function requestGrant(subject, capability, scope) {
        let confirmed = false;
        if (scope !== 'deny') {
            const current = S.grants.find(g => g.subject === subject && g.capability === capability)?.scope ?? null;
            confirmed = await ask(`Let "${subject}" do more?`,
                `Allow "${subject}" to ${CAPABILITY_TEXT[capability]} (${SCOPE_TEXT[scope].toLowerCase()})?${current && !givesMoreAccess(current, scope) ? '' : '\n\nThis gives it more access than it has now.'}\n\nSearch will also ask on its own screen.`, 'Allow');
            if (!confirmed) return false;
        }
        return flow.grant(subject, capability, scope, confirmed);
    }

    function render() {
        if (disposed) return;
        if (S.view !== 'ready') {
            const [icon, title, text] = STATUS[S.view];
            status.set_icon_name(icon); status.set_title(title); status.set_description(esc(S.message || text));
            spinner.set_visible(S.view === 'loading'); spinner.set_spinning(S.view === 'loading'); retry.set_visible(S.view !== 'loading');
            stack.set_visible_child_name('status');
            return;
        }
        for (let c = body.get_first_child(); c; c = body.get_first_child()) body.remove(c);
        if (S.status) {
            const banner = new Adw.Banner({title: esc(S.status.text), button_label: 'Dismiss', revealed: true}); banner.set_name(`perm-${S.status.kind}`);
            banner.connect('button-clicked', () => flow.dismiss()); body.append(banner);
        }

        const intro = group('Programs and what they may do',
            S.enforced ? 'Other programs that use Search actions are checked against these settings.'
                : 'Not enforced yet: "Ask before other programs use Search actions" is off in Search, so these settings are kept but nothing is checked until you turn it on.');
        intro.set_name('perm-intro');
        if (!S.grants.length) intro.add(textRow('Nothing is set', 'A program with no setting is asked about each time it wants to do something.', 'perm-empty'));
        for (const g of S.grants) {
            const row = textRow(sentence(g), SCOPE_TEXT[g.scope], `perm-grant:${g.subject}:${g.capability}`, []);
            const rm = button('Remove', () => flow.revoke(g.subject, g.capability), ['flat'], `perm-revoke:${g.subject}:${g.capability}`); rm.set_sensitive(!busy());
            rm.update_property([Gtk.AccessibleProperty.LABEL], [`Remove the setting for ${g.subject}: ${CAPABILITY_TEXT[g.capability]}`]);
            row.add_suffix(rm);
            if (g.scope !== 'deny') {
                const deny = button('Never allow', () => requestGrant(g.subject, g.capability, 'deny'), ['flat'], `perm-deny:${g.subject}:${g.capability}`); deny.set_sensitive(!busy());
                row.add_suffix(deny);
            }
            intro.add(row);
        }
        intro.add(textRow('Only "Always allow" and "Never allow" are kept after a restart', 'The other two end with the session or after one use.', 'perm-note'));

        const add = group('Set a program', 'Giving access asks you to confirm. "Never allow" does not.');
        add.set_name('perm-add');
        const subject = new Adw.EntryRow({title: 'Program name'}); subject.set_name('perm-subject'); subject.set_text(form.subject);
        subject.connect('changed', () => { form.subject = subject.get_text().trim(); });
        add.add(subject);
        const capModel = Gtk.StringList.new(CAPABILITIES.map(c => `${c}: ${CAPABILITY_TEXT[c]}`));
        const cap = new Adw.ComboRow({title: 'May', model: capModel}); cap.set_name('perm-capability'); cap.set_selected(Math.max(0, CAPABILITIES.indexOf(form.capability)));
        cap.connect('notify::selected', () => { form.capability = CAPABILITIES[cap.get_selected()]; });
        add.add(cap);
        const scopeModel = Gtk.StringList.new(SCOPES.map(x => SCOPE_TEXT[x]));
        const scope = new Adw.ComboRow({title: 'How', model: scopeModel}); scope.set_name('perm-scope'); scope.set_selected(Math.max(0, SCOPES.indexOf(form.scope)));
        scope.connect('notify::selected', () => { form.scope = SCOPES[scope.get_selected()]; });
        add.add(scope);
        const go = button('Set', () => requestGrant(form.subject, form.capability, form.scope), ['suggested-action'], 'perm-set'); go.set_sensitive(!busy());
        const goRow = new Adw.ActionRow({title: 'Apply this setting'}); goRow.add_suffix(go); add.add(goRow);

        const hist = group('Recent requests', 'Who asked for what, and the answer. Arguments and content are never recorded.');
        hist.set_name('perm-history');
        if (!S.history.length) hist.add(textRow('No requests yet', '', 'perm-history-empty'));
        for (const h of S.history.slice(0, 50)) hist.add(textRow(`${h.subject}: ${CAPABILITY_TEXT[h.capability] ?? h.capability}`, `${h.verdict === 'allow' ? 'Allowed' : h.verdict === 'deny' ? 'Refused' : 'Asked'}, ${whenText(h.at)}`, 'perm-history-row'));
        if (S.history.length) {
            const clr = new Adw.ActionRow({title: 'Clear the history'}); const cb = button('Clear', () => flow.clearHistory(), ['flat'], 'perm-clear'); cb.set_sensitive(!busy());
            clr.add_suffix(cb); hist.add(clr);
        }
        if (S.busy) { const box = new Gtk.Box({spacing: 8, halign: Gtk.Align.CENTER}); box.set_name('perm-busy'); box.append(new Gtk.Spinner({spinning: true})); box.append(new Gtk.Label({label: S.busy === 'granting' ? 'Waiting for the answer on the screen…' : 'Working…'})); body.append(box); }
        stack.set_visible_child_name('main');
    }

    const unsubscribe = flow.subscribe(render);
    const ensure = () => { if (loaded) return Promise.resolve(); loaded = true; render(); return flow.refresh(); };
    const holder = new Gtk.Box({vexpand: true}); holder.append(stack);
    holder.connect('map', () => { if (!loaded) ensure(); });
    const dispose = () => { disposed = true; unsubscribe(); };
    render();
    return {widget: holder, ensure, flow, dispose, stack, requestGrant};
}
