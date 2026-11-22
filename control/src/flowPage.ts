// @ts-nocheck: GTK / libadwaita are untyped here
// Niro Flow: workflows that switch profiles and layouts by themselves, off until the user turns Flow on. The page draws the state of
// flowLogic's controller (loading, empty, ready, disabled, unavailable, permission, unsupported, error, and "applying" while a call is out).
// It talks to the daemon only through a backend it is given, so tests pass a fake. It never runs a command: the actions come from
// Search's registry through the daemon, and only those Flow may run unattended are offered.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {DBusFlowBackend} from './flowBackend.js';
import {
    argsText, COMPARISONS, CONDITION_KINDS, CONDITION_VARS, createFlow, emptyForm, lastRun, newAction, previewLines, summarizeRun, triggerDef,
    triggerSentence, TRIGGERS, uniqueId, workflowToForm,
} from './flowLogic.js';

const esc = (s: string) => GLib.markup_escape_text(String(s ?? ''), -1);
const list = (items: string[]) => Gtk.StringList.new(items);
const STATUS = {
    loading: ['content-loading-symbolic', 'Looking for Niro Flow', 'Asking the Niro daemon what workflows exist.'],
    unavailable: ['network-offline-symbolic', 'The Niro daemon is not running', ''],
    permission: ['dialog-password-symbolic', 'Flow needs permission', ''],
    unsupported: ['dialog-warning-symbolic', 'This daemon does not match this panel', ''],
    error: ['dialog-error-symbolic', 'Flow could not be read', ''],
};

/** The page. `backend` defaults to the daemon on the session bus; `ensure()` loads it now (it also loads the first time the page is shown). */
export function flowPage(model, ctx, backend = new DBusFlowBackend()) {
    const flow = createFlow(backend);
    const S = flow.state;
    const expanded = new Set();
    const timers = new Set();
    let disposed = false;
    let loaded = false;
    let draft = null, draftIsNew = false, draftLossy = [], editorBuilt = null;

    const stack = new Gtk.Stack({vexpand: true, hexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});

    // ---- Status screens (loading, unavailable, permission, unsupported, error)
    const statusSpinner = new Gtk.Spinner({spinning: true, width_request: 32, height_request: 32, halign: Gtk.Align.CENTER});
    const retry = new Gtk.Button({label: 'Try again', halign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'pill']});
    retry.set_name('flow-retry');
    const statusBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER});
    statusBox.append(statusSpinner); statusBox.append(retry);
    const status = new Adw.StatusPage({vexpand: true, child: statusBox});
    status.set_name('flow-status');
    retry.connect('clicked', () => flow.refresh());
    stack.add_named(status, 'status');

    // ---- Main
    const mainBody = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    const mainScroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({child: mainBody, maximum_size: 860, tightening_threshold: 600})});
    stack.add_named(mainScroll, 'main');

    const banner = new Adw.Banner({revealed: false});
    banner.set_name('flow-banner');
    banner.connect('button-clicked', () => flow.dismissNotice());

    const confirming = new Set();
    let rawGroup = null;

    const button = (label, fn, css = ['flat'], name = null) => {
        const b = new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css});
        if (name) b.set_name(name);
        b.connect('clicked', fn);
        return b;
    };
    const textRow = (title, subtitle = '') => new Adw.ActionRow({title: esc(title), subtitle: esc(subtitle), subtitle_lines: 0, title_lines: 0, css_classes: ['property']});

    const workflowRow = wf => {
        const row = new Adw.ExpanderRow({title: esc(wf.name || wf.id), expanded: expanded.has(wf.id)});
        row.set_name(`flow:${wf.id}`);
        const runs = S.history[wf.id] ?? [];
        const last = lastRun(runs);
        row.set_subtitle(esc(`${triggerSentence(wf.trigger)}${last ? ` · ${summarizeRun(last).text}` : ''}`));
        row.connect('notify::expanded', () => { if (row.get_expanded()) { expanded.add(wf.id); if (!S.history[wf.id]) flow.loadHistory(wf.id); } else expanded.delete(wf.id); });
        const sw = new Gtk.Switch({valign: Gtk.Align.CENTER, active: wf.enabled !== false});
        sw.set_name(`flow-enable:${wf.id}`);
        sw.update_property([Gtk.AccessibleProperty.LABEL], [`Switch ${wf.name || wf.id} on or off`]);
        sw.connect('state-set', (_s, on) => { if (on !== (wf.enabled !== false)) flow.setWorkflowEnabled(wf.id, on); return false; });
        row.add_suffix(sw);

        const steps = (wf.steps ?? []).map(s => (s.kind === 'action' ? `${s.name}${s.args && Object.keys(s.args).length ? ` (${argsText(s.args)})` : ''}` : s.kind === 'condition' ? 'if a condition holds' : s.kind === 'delay' ? `wait ${s.seconds} s` : 'set a variable'));
        row.add_row(textRow('Does', steps.join('  →  ') || 'Nothing'));
        if ((wf.allow ?? []).length) row.add_row(textRow('Allowed to use', wf.allow.join(', ')));

        const actions = new Gtk.Box({spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 12, margin_end: 12});
        actions.append(button('Preview', () => flow.dryRun(wf.id), ['flat'], `flow-preview:${wf.id}`));
        actions.append(button('Run now', () => flow.runNow(wf.id), ['flat'], `flow-run:${wf.id}`));
        if (S.running[wf.id]) actions.append(button('Cancel run', () => flow.cancel(wf.id), ['flat'], `flow-cancel:${wf.id}`));
        actions.append(button('Edit', () => openEditor(wf), ['flat'], `flow-edit:${wf.id}`));
        if (confirming.has(wf.id)) {
            actions.append(new Gtk.Label({label: 'Delete it for good?', css_classes: ['dim-label'], hexpand: true, xalign: 1}));
            actions.append(button('Keep', () => { confirming.delete(wf.id); render(); }, ['flat'], `flow-keep:${wf.id}`));
            actions.append(button('Delete', () => { confirming.delete(wf.id); flow.remove(wf.id); }, ['destructive-action'], `flow-delete-confirm:${wf.id}`));
        } else {
            actions.append(new Gtk.Box({hexpand: true}));
            actions.append(button('Delete…', () => { confirming.add(wf.id); render(); }, ['flat'], `flow-delete:${wf.id}`));
        }
        const holder = new Adw.PreferencesRow({activatable: false, focusable: false, child: actions});
        row.add_row(holder);

        const d = S.previews[wf.id];
        if (d) {
            const p = previewLines(d);
            const head = textRow(p.ok ? 'Preview: this is what would happen' : 'Preview: this would not run as it is', 'Nothing was run.');
            head.set_name(`flow-preview-head:${wf.id}`);
            row.add_row(head);
            p.lines.forEach(l => row.add_row(textRow(l)));
            p.problems.forEach(l => row.add_row(textRow('Problem', l)));
        }
        const hist = (S.history[wf.id] ?? []).slice(-5).reverse();
        if (hist.length) {
            hist.forEach(r => { const x = textRow(`Run ${r.id}`, summarizeRun(r).text); x.set_name(`flow-run-row:${wf.id}`); row.add_row(x); });
        } else if (S.history[wf.id]) row.add_row(textRow('No runs yet'));
        return row;
    };

    function render() {
        if (disposed) return;
        if (!['ready', 'empty', 'disabled'].includes(S.view)) {
            const [icon, title, text] = STATUS[S.view];
            status.set_icon_name(icon); status.set_title(title); status.set_description(esc(S.message || text));
            statusSpinner.set_visible(S.view === 'loading'); statusSpinner.set_spinning(S.view === 'loading');
            retry.set_visible(S.view !== 'loading');
            if (!draft) stack.set_visible_child_name('status');
            return;
        }
        if (!draft) stack.set_visible_child_name('main');
        let c;
        while ((c = mainBody.get_first_child())) mainBody.remove(c);
        banner.set_title(S.busy ? 'Working…' : S.notice ? esc(S.notice.text) : '');
        banner.set_button_label(S.busy || !S.notice ? '' : 'Dismiss');
        banner.set_revealed(Boolean(S.busy || S.notice));
        mainBody.append(banner);
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, sensitive: !S.busy});
        mainBody.append(content);

        const g = new Adw.PreferencesGroup({title: 'Niro Flow', description: 'Workflows react to what happens on the desktop (an app opens, the battery runs low, a time of day) and apply a profile or a layout. They only use what each workflow allows, and never run a command. Flow is off until you turn it on.'});
        const on = new Adw.SwitchRow({title: 'Turn Flow on', subtitle: S.enabled ? 'On: switched-on workflows can start by themselves' : 'Off: no timers, no events watched, nothing runs', active: S.enabled});
        on.set_name('flow-global');
        on.connect('notify::active', () => { if (on.get_active() !== S.enabled) flow.setGlobal(on.get_active()); });
        g.add(on);
        content.append(g);

        const wg = new Adw.PreferencesGroup({title: 'Workflows', description: !S.enabled ? 'Flow is off: you can edit and preview, but nothing runs.' : ''});
        const add = button('New workflow', () => openEditor(null), ['suggested-action'], 'flow-new');
        wg.set_header_suffix(add);
        if (!S.workflows.length) {
            const empty = textRow('No workflows yet', 'Start from a template below, or make your own with New workflow.');
            empty.set_name('flow-empty');
            wg.add(empty);
        }
        S.workflows.forEach(wf => wg.add(workflowRow(wf)));
        content.append(wg);

        if (S.templates.length) {
            const tg = new Adw.PreferencesGroup({title: 'Start from a template', description: 'A template is saved switched off. Look it over, then switch it on.'});
            for (const t of S.templates) {
                const r = new Adw.ActionRow({title: esc(t.title), subtitle: esc(triggerSentence(t.workflow.trigger))});
                r.set_name(`flow-template:${t.id}`);
                r.add_suffix(button('Use', async () => { const id = await flow.fromTemplate(t.id); if (id) { const wf = flow.byId(id); if (wf) { expanded.add(id); render(); } } }, ['flat'], `flow-use:${t.id}`));
                tg.add(r);
            }
            content.append(tg);
        }
        if (S.actionsError) {
            const ag = new Adw.PreferencesGroup({title: 'Actions', description: 'Search did not answer, so new actions cannot be checked or added now.'});
            ag.add(textRow('Reason', S.actionsError));
            content.append(ag);
        }
        if (S.fileProblems.length) {
            const pg = new Adw.PreferencesGroup({title: 'Workflow files Flow could not read', description: 'They are left as they are and are not run.'});
            S.fileProblems.forEach(p => pg.add(textRow(p.file, p.error)));
            content.append(pg);
        }
        const hg = new Adw.PreferencesGroup({title: 'History', description: 'What ran, when, and how it ended. Arguments are masked when their name looks like a secret.'});
        hg.add(button('Clear history', () => flow.clearHistory(), ['flat'], 'flow-clear-history'));
        content.append(hg);

        // Advanced: the workflows as the daemon stores them
        const raw = new Adw.PreferencesGroup({title: 'Workflow files (Advanced)', description: 'The JSON the daemon stores. Read-only here.', visible: model?.mode === 'advanced'});
        raw.set_name('flow-raw');
        S.workflows.forEach(wf => { const r = textRow(wf.id, JSON.stringify(wf)); r.set_subtitle_selectable?.(true); raw.add(r); });
        if (model?.advancedWidgets) { const at = model.advancedWidgets.indexOf(rawGroup); if (at >= 0) model.advancedWidgets.splice(at, 1); model.advancedWidgets.push(raw); }
        rawGroup = raw;
        content.append(raw);
    }

    // ---- Editor
    const editor = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    stack.add_named(editor, 'editor');

    function openEditor(wf) {
        if (wf) { const r = workflowToForm(wf); draft = r.form; draftLossy = r.lossy; draftIsNew = false; }
        else { draft = emptyForm(); draftLossy = []; draftIsNew = true; }
        S.saveProblems = [];
        buildEditor();
        stack.set_visible_child_name('editor');
    }
    const closeEditor = () => { draft = null; stack.set_visible_child_name(['ready', 'empty', 'disabled'].includes(S.view) ? 'main' : 'status'); render(); };

    function buildEditor() {
        let c;
        while ((c = editor.get_first_child())) editor.remove(c);
        const form = draft;
        const known = S.actions.filter(a => a.canRun);
        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
        const scroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({child: body, maximum_size: 860, tightening_threshold: 600})});

        const bar = new Gtk.Box({spacing: 8, margin_top: 10, margin_start: 18, margin_end: 18});
        bar.append(button('Cancel', closeEditor, ['flat'], 'flow-form-cancel'));
        bar.append(new Gtk.Label({label: draftIsNew ? 'New workflow' : 'Edit workflow', hexpand: true, css_classes: ['heading']}));
        const save = button('Save', async () => { if (await flow.save(form, {isNew: draftIsNew})) closeEditor(); else showProblems(); }, ['suggested-action'], 'flow-form-save');
        save.set_sensitive(!draftLossy.length);
        bar.append(save);
        editor.append(bar); editor.append(scroll);

        const eb = new Adw.Banner({revealed: false}); eb.set_name('flow-form-banner');
        body.append(eb);
        if (draftLossy.length) {
            const note = new Adw.PreferencesGroup({title: 'This workflow cannot be edited here', description: `It uses ${draftLossy.join(', ')}, which this form does not show, and saving the form would change it. You can still switch it on or off, preview it, run it and delete it.`});
            note.set_name('flow-form-lossy');
            body.append(note);
        }
        const basics = new Adw.PreferencesGroup({title: 'Workflow'});
        const name = new Adw.EntryRow({title: 'Name', text: form.name, sensitive: !draftLossy.length}); name.set_name('flow-form-name');
        const id = new Adw.EntryRow({title: 'Id (letters, digits, - . _)', text: form.id, sensitive: draftIsNew && !draftLossy.length}); id.set_name('flow-form-id');
        let idTouched = !draftIsNew || form.id !== '';
        name.connect('changed', () => { form.name = name.get_text(); if (!idTouched) { form.id = form.name.trim() ? uniqueId(form.name, S.workflows.map(w => w.id)) : ''; id.set_text(form.id); idTouched = false; } });
        id.connect('changed', () => { if (id.get_text() !== form.id) idTouched = true; form.id = id.get_text(); });
        const enabled = new Adw.SwitchRow({title: 'Switched on', subtitle: 'A new workflow starts off, so you can preview it first', active: form.enabled, sensitive: !draftLossy.length}); enabled.set_name('flow-form-enabled');
        enabled.connect('notify::active', () => (form.enabled = enabled.get_active()));
        basics.add(name); basics.add(id); basics.add(enabled);
        body.append(basics);

        // trigger
        const tg = new Adw.PreferencesGroup({title: 'When', description: 'What starts the workflow.'});
        const trig = new Adw.ComboRow({title: 'Trigger', model: list(TRIGGERS.map(t => t.label)), selected: Math.max(0, TRIGGERS.findIndex(t => t.type === form.trigger.type)), sensitive: !draftLossy.length}); trig.set_name('flow-form-trigger');
        const tfield = new Adw.EntryRow({title: '', sensitive: !draftLossy.length}); tfield.set_name('flow-form-trigger-field');
        const syncTrigger = () => {
            const d = triggerDef(form.trigger.type);
            tfield.set_visible(Boolean(d.field));
            if (d.field) { tfield.set_title(d.field.label); tfield.set_text(String(form.trigger[d.field.name] ?? '')); }
            trig.set_subtitle(d.hint);
        };
        trig.connect('notify::selected', () => { form.trigger.type = TRIGGERS[trig.get_selected()].type; syncTrigger(); });
        tfield.connect('changed', () => { const d = triggerDef(form.trigger.type); if (d.field) form.trigger[d.field.name] = tfield.get_text(); });
        syncTrigger();
        tg.add(trig); tg.add(tfield);
        body.append(tg);

        // condition
        const cg = new Adw.PreferencesGroup({title: 'Only if', description: 'An optional check made when the trigger fires.'});
        const ckind = new Adw.ComboRow({title: 'Condition', model: list(CONDITION_KINDS.map(k => k[1])), selected: Math.max(0, CONDITION_KINDS.findIndex(k => k[0] === form.condition.kind)), sensitive: !draftLossy.length}); ckind.set_name('flow-form-condition');
        const cvar = new Adw.ComboRow({title: 'Value', model: list(CONDITION_VARS.map(v => v.label)), selected: Math.max(0, CONDITION_VARS.findIndex(v => v.name === form.condition.var))}); cvar.set_name('flow-form-condition-var');
        const ccmp = new Adw.ComboRow({title: 'Compare', model: list(COMPARISONS.map(v => v[1])), selected: Math.max(0, COMPARISONS.findIndex(v => v[0] === form.condition.cmp))}); ccmp.set_name('flow-form-condition-cmp');
        const cval = new Adw.EntryRow({title: 'Is (text, number, true or false)', text: form.condition.value}); cval.set_name('flow-form-condition-value');
        const cfrom = new Adw.EntryRow({title: 'From (HH:MM)', text: form.condition.from}); cfrom.set_name('flow-form-condition-from');
        const cto = new Adw.EntryRow({title: 'To (HH:MM)', text: form.condition.to}); cto.set_name('flow-form-condition-to');
        const syncCondition = () => {
            const k = form.condition.kind;
            cvar.set_visible(k === 'eq' || k === 'cmp'); ccmp.set_visible(k === 'cmp'); cval.set_visible(k === 'eq' || k === 'cmp');
            cfrom.set_visible(k === 'time'); cto.set_visible(k === 'time');
            if (k === 'cmp' && form.condition.var !== 'battery') { form.condition.var = 'battery'; cvar.set_selected(CONDITION_VARS.findIndex(v => v.name === 'battery')); }
        };
        ckind.connect('notify::selected', () => { form.condition.kind = CONDITION_KINDS[ckind.get_selected()][0]; syncCondition(); });
        cvar.connect('notify::selected', () => (form.condition.var = CONDITION_VARS[cvar.get_selected()].name));
        ccmp.connect('notify::selected', () => (form.condition.cmp = COMPARISONS[ccmp.get_selected()][0]));
        cval.connect('changed', () => (form.condition.value = cval.get_text()));
        cfrom.connect('changed', () => (form.condition.from = cfrom.get_text()));
        cto.connect('changed', () => (form.condition.to = cto.get_text()));
        syncCondition();
        [ckind, cvar, ccmp, cval, cfrom, cto].forEach(w => cg.add(w));
        body.append(cg);

        // actions
        const ag = new Adw.PreferencesGroup({title: 'Then', description: known.length ? 'Run these in order. Only actions Flow may run on its own are listed.' : 'No action is available: Search is not answering, or offers nothing Flow may run.'});
        ag.set_name('flow-form-actions');
        const addBtn = button('Add an action', () => { if (known.length) { form.actions.push(newAction(known[0])); buildEditor(); } }, ['flat'], 'flow-form-add-action');
        addBtn.set_sensitive(known.length > 0 && !draftLossy.length);
        ag.set_header_suffix(addBtn);
        form.actions.forEach((a, i) => {
            const choices = known.some(k => k.id === a.name) ? known : [...known, {id: a.name, title: `${a.name} (not available)`, params: []}];
            const row = new Adw.ExpanderRow({title: esc(`${i + 1}. ${choices.find(k => k.id === a.name)?.title ?? a.name}`), expanded: true, sensitive: !draftLossy.length});
            row.set_name(`flow-form-action:${i}`);
            const pick = new Adw.ComboRow({title: 'Action', model: list(choices.map(k => k.title)), selected: Math.max(0, choices.findIndex(k => k.id === a.name))});
            pick.set_name(`flow-form-action-pick:${i}`);
            pick.connect('notify::selected', () => { const k = choices[pick.get_selected()]; if (k.id !== a.name) { form.actions[i] = newAction(k); buildEditor(); } });
            row.add_row(pick);
            const k = choices.find(x => x.id === a.name);
            for (const p of k?.params ?? []) row.add_row(paramRow(a, p, i));
            const rm = button('Remove', () => { form.actions.splice(i, 1); buildEditor(); }, ['flat', 'destructive-action'], `flow-form-remove:${i}`);
            row.add_suffix(rm);
            ag.add(row);
        });
        body.append(ag);

        const pg = new Adw.PreferencesGroup({title: 'Problems'});
        pg.set_name('flow-form-problems');
        pg.set_visible(false);
        body.append(pg);
        let shownRows = [];
        showProblems = () => {
            shownRows.forEach(r => pg.remove(r));
            shownRows = S.saveProblems.map((p, n) => { const r = textRow(p); r.set_name(`flow-problem:${n}`); pg.add(r); return r; });
            pg.set_visible(shownRows.length > 0);
            eb.set_title(S.busy ? 'Working…' : S.notice ? esc(S.notice.text) : '');
            eb.set_revealed(Boolean(S.busy || S.notice));
        };
        showProblems();
    }
    let showProblems = () => {};

    function paramRow(a, p, i) {
        const label = `${p.name}${p.required ? '' : ' (optional)'}`;
        const set = v => { if (v === '' || v === undefined || v === null) delete a.args[p.name]; else a.args[p.name] = v; };
        let w;
        if (p.type === 'number') {
            w = new Adw.SpinRow({title: label, adjustment: new Gtk.Adjustment({lower: p.min ?? 0, upper: p.max ?? 1e9, step_increment: 1, value: a.args[p.name] ?? p.min ?? 0})});
            if (!p.required && a.args[p.name] === undefined) w.set_subtitle('Not set');
            w.connect('notify::value', () => set(w.get_value()));
        } else if (p.type === 'enum' && Array.isArray(p.enum)) {
            w = new Adw.ComboRow({title: label, model: list(p.enum), selected: Math.max(0, p.enum.indexOf(a.args[p.name]))});
            w.connect('notify::selected', () => set(p.enum[w.get_selected()]));
            if (a.args[p.name] === undefined && p.enum.length) set(p.enum[0]);
        } else if (p.type === 'boolean') {
            w = new Adw.SwitchRow({title: label, active: a.args[p.name] === true});
            w.connect('notify::active', () => set(w.get_active()));
        } else {
            w = new Adw.EntryRow({title: label, text: String(a.args[p.name] ?? '')});
            w.connect('changed', () => set(w.get_text()));
        }
        w.set_name(`flow-form-arg:${i}:${p.name}`);
        return w;
    }

    // ---- Wiring
    const unsubscribe = flow.subscribe(() => {
        // an open editor keeps what the user typed: only its problem list follows the state
        if (draft && stack.get_visible_child_name() === 'editor') { showProblems(); return; }
        render();
    });
    const ensure = () => {
        if (loaded) return Promise.resolve();
        loaded = true;
        render();
        return flow.refresh();
    };
    const pollRun = id => {
        let n = 0;
        const t = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (disposed || ++n > 20 || !S.running[id]) { timers.delete(t); return GLib.SOURCE_REMOVE; }
            flow.loadHistory(id);
            return GLib.SOURCE_CONTINUE;
        });
        timers.add(t);
    };
    const origRun = flow.runNow;
    flow.runNow = async id => { const r = await origRun(id); if (r && !disposed) pollRun(id); return r; };

    const holder = new Gtk.Box({vexpand: true}); holder.append(stack);
    holder.connect('map', () => { if (!loaded) ensure(); else flow.refresh(); });
    const dispose = () => { disposed = true; unsubscribe(); timers.forEach(t => GLib.source_remove(t)); timers.clear(); };
    render();
    return {widget: holder, ensure, flow, dispose, stack, openEditor, closeEditor};
}
