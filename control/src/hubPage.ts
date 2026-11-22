// @ts-nocheck: GTK / libadwaita are untyped here
// Notifications: the hub's rules, quiet hours, snoozing and history, in the panel. The page draws the state of hubLogic's controller
// (loading, empty, ready, disabled, unavailable, permission, error, and "applying" while a call is out). It changes things only through
// Search's actions (via a backend it is given, so tests pass a fake); the two switches are the catalog's own settings. It shows application ids
// and counts, never a notification's title or text.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {DBusHubBackend} from './hubBackend.js';
import {createHub, RULE_VERDICTS} from './hubLogic.js';

const esc = (s) => GLib.markup_escape_text(String(s ?? ''), -1);
const STATUS = {
    loading: ['content-loading-symbolic', 'Looking for the Notification Hub', 'Asking Search for the hub\'s state.'],
    unavailable: ['network-offline-symbolic', 'Search is not running', ''],
    permission: ['dialog-password-symbolic', 'The hub needs permission', ''],
    error: ['dialog-error-symbolic', 'The hub could not be read', ''],
};
const VERDICT_TEXT = {show: 'Show', silent: 'Silent (no banner)', hide: 'Hide'};

/** Settings through the panel's model (the catalog's niro.notification-hub and niro.notification-hub-apply). */
function modelSettings(model) {
    const item = id => model.item(`niro.${id}`);
    const on = id => model.read(`niro.${id}`) === true;
    const write = (id, v) => { const b = model.binding(item(id)); if (!b || Array.isArray(b)) throw new Error('the setting is not available'); b.write(v); };
    return {hubOn: () => on('notification-hub'), applyOn: () => on('notification-hub-apply'),
        setHub: v => write('notification-hub', v), setApply: v => write('notification-hub-apply', v)};
}

export function hubPage(model, ctx, backend = new DBusHubBackend(), settings = modelSettings(model)) {
    const hub = createHub(backend, settings);
    const S = hub.state;
    let disposed = false, loaded = false;

    const stack = new Gtk.Stack({vexpand: true, hexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});
    const statusSpinner = new Gtk.Spinner({spinning: true, width_request: 32, height_request: 32, halign: Gtk.Align.CENTER});
    const retry = new Gtk.Button({label: 'Try again', halign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'pill']});
    retry.set_name('hub-retry');
    const statusBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER});
    statusBox.append(statusSpinner); statusBox.append(retry);
    const status = new Adw.StatusPage({vexpand: true, child: statusBox});
    status.set_name('hub-status');
    retry.connect('clicked', () => hub.refresh());
    stack.add_named(status, 'status');

    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    stack.add_named(new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({child: body, maximum_size: 860, tightening_threshold: 600})}), 'main');

    const banner = new Adw.Banner({revealed: false}); banner.set_name('hub-banner');
    banner.connect('button-clicked', () => hub.dismissNotice());
    // typed values survive a redraw (a rule added, a refresh) so a half-written form is not wiped
    const form = {app: '', verdict: 0, from: '22:00', to: '07:00', snoozeApp: '', minutes: '30'};
    const problems = {rule: '', quiet: '', snooze: ''};

    const button = (label, fn, css = ['flat'], name = null) => {
        const b = new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css}); if (name) b.set_name(name);
        b.connect('clicked', fn); return b;
    };
    const problemRow = (key, name) => {
        const row = new Adw.ActionRow({title: esc(problems[key]), css_classes: ['error'], title_lines: 0}); row.set_name(name);
        row.set_visible(problems[key] !== ''); return row;
    };
    const group = (title, description = '') => { const g = new Adw.PreferencesGroup({title: esc(title), description: esc(description)}); body.append(g); return g; };
    const entry = (name, key, placeholder, width = 22) => {
        const e = new Gtk.Entry({text: form[key], placeholder_text: placeholder, width_chars: width, valign: Gtk.Align.CENTER}); e.set_name(name);
        e.connect('changed', () => { form[key] = e.get_text(); });
        e.update_property([Gtk.AccessibleProperty.LABEL], [placeholder]);
        return e;
    };
    const busy = () => S.busy !== null;

    function render() {
        if (disposed) return;
        if (!['ready', 'empty', 'disabled'].includes(S.view)) {
            const [icon, title, text] = STATUS[S.view];
            status.set_icon_name(icon); status.set_title(title); status.set_description(esc(S.message || text));
            statusSpinner.set_visible(S.view === 'loading'); statusSpinner.set_spinning(S.view === 'loading');
            retry.set_visible(S.view !== 'loading');
            stack.set_visible_child_name('status');
            return;
        }
        for (let c = body.get_first_child(); c; c = body.get_first_child()) body.remove(c);
        banner.set_revealed(S.notice !== null);
        if (S.notice) { banner.set_title(esc(S.notice.text)); banner.set_button_label('Dismiss'); }
        body.append(banner);

        // ---- switches (the catalog's own settings)
        const sw = group('Notification Hub', 'Off by default. When on, Search counts which application sent each notification and how urgent it was, never the title or the text, only in memory.');
        const hubRow = new Adw.ActionRow({title: 'Apply notification rules', subtitle: S.hubOn ? 'On' : 'Off', title_lines: 0, subtitle_lines: 0}); hubRow.set_name('hub-row');
        const hubSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER, active: S.hubOn, sensitive: !busy()}); hubSwitch.set_name('hub-switch');
        hubSwitch.update_property([Gtk.AccessibleProperty.LABEL], ['Apply notification rules']);
        hubSwitch.connect('state-set', (_s, on) => { if (on !== S.hubOn) hub.setHub(on); return false; });
        hubRow.add_suffix(hubSwitch); hubRow.set_activatable_widget(hubSwitch); sw.add(hubRow);
        const applyRow = new Adw.ActionRow({title: 'Hide or silence notifications by rule', title_lines: 0, subtitle_lines: 0,
            subtitle: S.applyOn ? 'Rules change what you see. Urgent notifications are never hidden.' : 'Off: rules are only counted and nothing is changed.'});
        applyRow.set_name('hub-apply-row');
        const applySwitch = new Gtk.Switch({valign: Gtk.Align.CENTER, active: S.applyOn, sensitive: S.hubOn && !busy()}); applySwitch.set_name('hub-apply-switch');
        applySwitch.update_property([Gtk.AccessibleProperty.LABEL], ['Hide or silence notifications by rule']);
        applySwitch.connect('state-set', (_s, on) => { if (on !== S.applyOn) hub.setApply(on); return false; });
        applyRow.add_suffix(applySwitch); applyRow.set_activatable_widget(applySwitch); sw.add(applyRow);

        if (S.view === 'disabled') {
            const off = new Adw.StatusPage({icon_name: 'notifications-disabled-symbolic', title: 'The hub is off', description: esc(S.message || 'Turn on "Apply notification rules" above to set rules, quiet hours and snoozing here.'), vexpand: false});
            off.set_name('hub-disabled'); body.append(off);
            stack.set_visible_child_name('main');
            return;
        }

        // ---- what the hub has seen
        const seen = group('Seen so far', 'Application ids and counts since the hub was switched on (the last 200).');
        const seenRow = new Adw.ActionRow({title: S.seen === null ? 'Not counted yet' : `${S.seen} notification${S.seen === 1 ? '' : 's'}`, subtitle: S.apps.length ? '' : 'Nothing has arrived yet.', subtitle_lines: 0}); seenRow.set_name('hub-seen');
        seen.add(seenRow);
        S.apps.forEach(a => { const r = new Adw.ActionRow({title: esc(a.app), subtitle: `${a.count} notification${a.count === 1 ? '' : 's'}`}); r.set_name(`hub-app:${a.app}`); seen.add(r); });
        seen.set_header_suffix(button('Clear', () => hub.clearHistory(), ['flat'], 'hub-clear'));

        // ---- rules
        const rules = group('Rules', 'What happens to an application\'s notifications. * means every application.');
        if (!S.rulesKnown) rules.add(new Adw.ActionRow({title: 'The list of rules could not be read', subtitle: S.ruleCount === null ? 'Search keeps them in notification-rules.json.' : `Search reports ${S.ruleCount} rule${S.ruleCount === 1 ? '' : 's'}. You can still add or remove one by its application id.`, subtitle_lines: 0, title_lines: 0}));
        else if (!S.rules.length) { const r = new Adw.ActionRow({title: 'No rules yet', subtitle: 'Every notification shows as usual.'}); r.set_name('hub-no-rules'); rules.add(r); }
        for (const rule of S.rules) {
            const r = new Adw.ActionRow({title: esc(rule.app), subtitle: VERDICT_TEXT[rule.verdict] ?? rule.verdict}); r.set_name(`hub-rule:${rule.app}`);
            const rm = button('Remove', () => hub.removeRule(rule.app), ['flat', 'destructive-action'], `hub-remove:${rule.app}`);
            rm.set_sensitive(!busy());
            rm.update_property([Gtk.AccessibleProperty.LABEL], [`Remove the rule for ${rule.app}`]);
            r.add_suffix(rm); rules.add(r);
        }
        const addRow = new Adw.ActionRow({title: 'Add a rule', title_lines: 0}); addRow.set_name('hub-add-row');
        const appEntry = entry('hub-rule-app', 'app', 'Application id or *');
        const verdict = new Gtk.DropDown({model: Gtk.StringList.new(RULE_VERDICTS.map(v => VERDICT_TEXT[v])), selected: form.verdict, valign: Gtk.Align.CENTER}); verdict.set_name('hub-rule-verdict');
        verdict.update_property([Gtk.AccessibleProperty.LABEL], ['What happens']);
        verdict.connect('notify::selected', () => { form.verdict = verdict.get_selected(); });
        const add = button('Add', async () => { problems.rule = await hub.addRule(form.app, RULE_VERDICTS[form.verdict]) ?? ''; if (!problems.rule) form.app = ''; render(); }, ['suggested-action'], 'hub-rule-add');
        add.set_sensitive(!busy());
        appEntry.connect('activate', () => add.emit('clicked'));
        addRow.add_suffix(appEntry); addRow.add_suffix(verdict); addRow.add_suffix(add); rules.add(addRow);
        rules.add(problemRow('rule', 'hub-rule-problem'));

        // ---- quiet hours
        const quiet = group('Quiet hours', 'No banners between two times each day. Urgent notifications still show.');
        const qState = new Adw.ActionRow({title: S.quiet ? `Quiet from ${S.quiet.from} to ${S.quiet.to}` : 'Quiet hours are off', title_lines: 0}); qState.set_name('hub-quiet-state');
        if (S.quiet) qState.add_suffix(button('Turn off', () => hub.clearQuiet(), ['flat'], 'hub-quiet-off'));
        quiet.add(qState);
        const qRow = new Adw.ActionRow({title: S.quiet ? 'Change the hours' : 'Set the hours', subtitle: 'HH:MM, 24 hours', title_lines: 0}); qRow.set_name('hub-quiet-row');
        const setQ = button('Set', async () => { problems.quiet = await hub.setQuiet(form.from, form.to) ?? ''; render(); }, ['suggested-action'], 'hub-quiet-set');
        setQ.set_sensitive(!busy());
        qRow.add_suffix(entry('hub-quiet-from', 'from', 'From (22:00)', 6)); qRow.add_suffix(entry('hub-quiet-to', 'to', 'To (07:00)', 6)); qRow.add_suffix(setQ);
        quiet.add(qRow); quiet.add(problemRow('quiet', 'hub-quiet-problem'));

        // ---- snooze
        const snooze = group('Snooze an application', 'Silences one application for a while (1 to 1440 minutes). Urgent notifications still show. Snoozes are forgotten when the shell restarts.');
        const sRow = new Adw.ActionRow({title: 'Snooze', title_lines: 0}); sRow.set_name('hub-snooze-row');
        const goS = button('Snooze', async () => { problems.snooze = await hub.snooze(form.snoozeApp, Number(form.minutes)) ?? ''; render(); }, ['suggested-action'], 'hub-snooze-go');
        goS.set_sensitive(!busy());
        sRow.add_suffix(entry('hub-snooze-app', 'snoozeApp', 'Application id')); sRow.add_suffix(entry('hub-snooze-minutes', 'minutes', 'Minutes', 5)); sRow.add_suffix(goS);
        snooze.add(sRow); snooze.add(problemRow('snooze', 'hub-snooze-problem'));

        if (S.busy) { const spin = new Gtk.Spinner({spinning: true, halign: Gtk.Align.CENTER}); spin.set_name('hub-applying'); body.append(spin); }
        stack.set_visible_child_name('main');
    }

    const unsubscribe = hub.subscribe(render);
    const ensure = () => { if (loaded) return Promise.resolve(); loaded = true; render(); return hub.refresh(); };
    const holder = new Gtk.Box({vexpand: true}); holder.append(stack);
    holder.connect('map', () => { if (!loaded) ensure(); else hub.refresh(); });
    const dispose = () => { disposed = true; unsubscribe(); };
    render();
    return {widget: holder, ensure, hub, dispose, stack};
}
