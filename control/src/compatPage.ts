// @ts-nocheck: GTK / libadwaita are untyped here
// Compatibility: how each application is (or is not) reached by Universal Appearance, per-application rules, the GTK theme
// integration (consent, backup, restore), and the matrix of what is known. A status is never claimed from a toolkit alone.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {APPLIES_LABEL, classify, effective, FAMILIES, parseRules, PRESET_KEYS, resolveScheme, serializeRules, setRule, STATUS_LABEL, UNKNOWN} from './appearance.js';
import {CATALOG} from './catalog.js';
import * as gtk from './gtkAdapter.js';

const scrolled = child => new Gtk.ScrolledWindow({child, hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true});
const FILTERS = ['All applications', 'With a rule', 'Excluded', 'Theme integration', 'Compositor effects only', 'Limited support', 'Unsupported'];
const FILTER_STATUS = {3: 'theme', 4: 'compositor', 5: 'limited', 6: 'unsupported'};
const FADE_WARNING = 'Window fade lowers the opacity of the whole window, so its text, icons and controls fade with the background. It also needs "Window-level effects for other applications" on.';

export const configDir = () => GLib.get_user_config_dir();
export const backupRoot = () => `${GLib.getenv('NIRO_CONFIG_DIR') ?? `${GLib.get_user_config_dir()}/niro-control`}/appearance-backups`;

/** The options the GTK adapter needs, from the shared Look. */
export function adapterOptions(model, dark: boolean) {
    const v = Object.fromEntries(PRESET_KEYS.map(k => [k, model.read(`niro.${k}`)]));
    const e = effective(v, {safeMode: model.read('niro.safe-mode') === true, highContrast: false});
    return {configDir: configDir(), scheme: resolveScheme(model.read('niro.color-scheme'), dark ? 'prefer-dark' : 'default'), disabled: model.read('niro.universal-enabled') === false || model.read('niro.affect-gtk') === false, glass: e.glass, tint: model.read('niro.tint'),
        surfaces: {sidebar: e.sidebar, content: e.content, elevated: e.elevated}};
}

export function compatPage(model, ctx) {
    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
    const niro = model.stores.by.niro;
    const dark = () => Adw.StyleManager.get_default().get_dark();
    const item = id => CATALOG.find(i => i.id === id);

    // ---- switches that matter most
    const top = new Adw.PreferencesGroup({title: 'Universal Appearance', description: 'Glass for the background, solid for what you read. These switches are the same ones as in Look.'});
    for (const id of ['niro.universal-enabled', 'niro.safe-mode', 'niro.affect-gtk', 'niro.affect-thirdparty']) top.add(model.row(item(id)));
    const state = new Adw.ActionRow({title: 'Right now'});
    const sync = () => {
        const e = effective(Object.fromEntries(PRESET_KEYS.map(k => [k, model.read(`niro.${k}`)])), {safeMode: model.read('niro.safe-mode') === true, highContrast: false});
        state.set_subtitle(model.read('niro.universal-enabled') === false ? 'Off: nothing is restyled' : e.reasons.length ? e.reasons.join('; ') : 'As set in Look');
    };
    sync(); for (const id of ['universal-enabled', 'safe-mode', 'performance-mode']) { const b = model.binding(item(`niro.${id}`)); b?.subscribe?.(sync); }
    top.add(state);
    root.append(top);

    // ---- GTK theme integration
    const integ = new Adw.PreferencesGroup({title: 'GTK theme integration', description: 'Styles the window, sidebar and content backgrounds of GTK 3 and GTK 4 applications. Applications restart to pick it up.'});
    const stateRow = new Adw.ActionRow({title: 'Status'});
    const buttons = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    const install = new Gtk.Button({label: 'Install…', css_classes: ['suggested-action']});
    const restoreBtn = new Gtk.Button({label: 'Restore original'});
    buttons.append(install); buttons.append(restoreBtn); stateRow.add_suffix(buttons);
    integ.add(stateRow);
    const refreshState = () => {
        const s = gtk.status(configDir(), backupRoot());
        stateRow.set_subtitle(s.installed ? `Installed. ${s.backups.length ? `Backups of your gtk.css files: ${backupRoot()}` : ''}` : 'Not installed: your gtk.css files are untouched');
        install.set_label(s.installed ? 'Reinstall…' : 'Install…'); restoreBtn.set_sensitive(s.installed);
    };
    const alert = (title, body, verb, go) => {
        const d = Adw.AlertDialog.new(title, body);
        d.add_response('cancel', 'Cancel'); if (go) { d.add_response('go', verb); d.set_response_appearance('go', Adw.ResponseAppearance.SUGGESTED); }
        d.connect('response', (_d, r) => r === 'go' && go?.());
        d.present(ctx.window);
    };
    install.connect('clicked', () => {
        const files = gtk.plan(configDir()).map(f => `• ${f.path}: ${f.change}`).join('\n');
        alert('Install the GTK theme integration?', `These files will change. Each existing file is backed up first, and Restore puts them back exactly as they were.\n\n${files}\n\nBackups go to ${backupRoot()}.`, 'Install', () => {
            try { gtk.install({...adapterOptions(model, dark()), backupRoot: backupRoot(), consent: true}); ctx.toast('Installed. Restart applications to see it'); } catch (e) { alert("Couldn't install", e.message); }
            refreshState();
        });
    });
    restoreBtn.connect('clicked', () => alert('Restore your original GTK appearance?', 'Removes the integration from your gtk.css files and deletes the generated stylesheets. Your backups are kept.', 'Restore', () => {
        try { gtk.restore(configDir()); ctx.toast('Restored. Restart applications to see it'); } catch (e) { alert("Couldn't restore", e.message); }
        refreshState();
    }));
    refreshState();
    // a Look change rewrites the generated stylesheets, when the integration is installed
    const regen = () => { if (GLib.getenv('NIRO_SCHEMA_DIR')) return; try { gtk.refresh(adapterOptions(model, dark())); } catch (_e) { /* the next change retries */ } };
    for (const id of ['opacity', 'tint', 'color-scheme', 'safe-mode', 'universal-enabled', ...PRESET_KEYS]) model.binding(item(`niro.${id}`))?.subscribe?.(regen);
    root.append(integ);

    // ---- per-application rules
    const apps = new Adw.PreferencesGroup({title: 'Applications', description: 'Rules are kept by application id, never by window title. Inherit means the global appearance; Exclude switches every effect off for that application.'});
    const search = new Gtk.SearchEntry({placeholder_text: 'Find an application', hexpand: true});
    search.update_property([Gtk.AccessibleProperty.LABEL], ['Find an application']);
    const filter = new Gtk.DropDown({model: Gtk.StringList.new(FILTERS), valign: Gtk.Align.CENTER});
    filter.update_property([Gtk.AccessibleProperty.LABEL], ['Show applications']);
    const bar = new Gtk.Box({spacing: 8, margin_bottom: 6}); bar.append(search); bar.append(filter);
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    list.update_property([Gtk.AccessibleProperty.LABEL], ['Applications and their appearance rules']);
    let rules = parseRules(niro?.get_string('app-rules') ?? '{}');
    const save = next => { rules = next; niro?.set_string('app-rules', serializeRules(rules)); Gio.Settings.sync(); applyFilter(); };
    const rows = [];
    for (const info of Gio.AppInfo.get_all().filter(a => a.should_show()).sort((a, b) => a.get_name().localeCompare(b.get_name()))) {
        const id = (info.get_id() ?? '').replace(/\.desktop$/, '');
        const wm = info.get_string?.('StartupWMClass') || id;     // windows are matched by the class they announce, never by title
        const fam = classify(id, info.get_commandline?.() ?? '') ?? UNKNOWN;
        const row = new Adw.ActionRow({title: GLib.markup_escape_text(info.get_name(), -1), subtitle_lines: 2,
            subtitle: GLib.markup_escape_text(`${wm} · ${fam.name}\n${STATUS_LABEL[fam.status]} · ${APPLIES_LABEL[fam.applies]}`, -1)});
        row.set_tooltip_text(`${fam.how}\nLimit: ${fam.limit}\nCan be set: ${fam.customizations.join(', ')}\nEvidence: ${fam.evidence}`);
        row._text = `${info.get_name()} ${id} ${wm}`.toLowerCase(); row._wm = wm; row._status = fam.status;
        const icon = info.get_icon(); if (icon) row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 28}));
        // inherit or exclude: always there. Window fade: Advanced only, with its warning.
        const drop = new Gtk.DropDown({model: Gtk.StringList.new(['Inherit', 'Exclude']), valign: Gtk.Align.CENTER});
        drop.update_property([Gtk.AccessibleProperty.LABEL], [`Appearance rule for ${info.get_name()}`]);
        const fade = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: FADE_WARNING});
        fade.update_property([Gtk.AccessibleProperty.LABEL], [`Window fade for ${info.get_name()}`]);
        const amount = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: 20, upper: 100, step_increment: 5, value: 80}), valign: Gtk.Align.CENTER, tooltip_text: 'Whole-window opacity, in percent'});
        amount.update_property([Gtk.AccessibleProperty.LABEL], [`Window fade opacity for ${info.get_name()}`]);
        const fadeBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER}); fadeBox.append(new Gtk.Label({label: 'Fade', css_classes: ['caption']})); fadeBox.append(fade); fadeBox.append(amount);
        model.advancedWidgets.push(fadeBox); fadeBox.set_visible(model.mode === 'advanced');
        let busy = false;
        const show = () => {
            busy = true;
            const r = rules[wm];
            drop.set_selected(r?.mode === 'exclude' ? 1 : 0); fade.set_active(r?.mode === 'fade'); amount.set_value(r?.opacity ?? 80);
            amount.set_sensitive(r?.mode === 'fade'); fade.set_sensitive(r?.mode !== 'exclude');
            busy = false;
        };
        show();
        drop.connect('notify::selected', () => { if (busy) return; save(setRule(rules, wm, drop.get_selected() === 1 ? {mode: 'exclude'} : null)); show(); });
        fade.connect('notify::active', () => { if (busy) return; save(setRule(rules, wm, fade.get_active() ? {mode: 'fade', opacity: amount.get_value()} : null)); show(); });
        amount.connect('value-changed', () => { if (busy || !fade.get_active()) return; save(setRule(rules, wm, {mode: 'fade', opacity: amount.get_value()})); });
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', css_classes: ['flat', 'circular'], valign: Gtk.Align.CENTER, tooltip_text: 'Restore this application to the global appearance'});
        reset.update_property([Gtk.AccessibleProperty.LABEL], [`Restore ${info.get_name()} to the global appearance`]);
        reset.connect('clicked', () => { save(setRule(rules, wm, null)); show(); });
        row.add_suffix(fadeBox); row.add_suffix(drop); row.add_suffix(reset);
        list.append(row); rows.push(row);
    }
    const empty = new Gtk.Label({label: 'No application matches.', css_classes: ['dim-label'], margin_top: 12, visible: false});
    function applyFilter() {
        const q = search.get_text().trim().toLowerCase(), f = filter.get_selected(); let shown = 0;
        for (const r of rows) {
            const rule = rules[r._wm];
            const ok = (!q || r._text.includes(q)) && (f === 0 || (f === 1 && !!rule) || (f === 2 && rule?.mode === 'exclude') || (f >= 3 && r._status === FILTER_STATUS[f]));
            r.set_visible(ok); if (ok) shown++;
        }
        empty.set_visible(shown === 0);
    }
    search.connect('search-changed', applyFilter); filter.connect('notify::selected', applyFilter);
    const scroll = new Gtk.ScrolledWindow({child: list, min_content_height: 260, max_content_height: 420, hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true});
    const appsBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL}); appsBox.append(bar); appsBox.append(scroll); appsBox.append(empty);
    apps.add(appsBox);
    const advancedNote = new Gtk.Label({label: FADE_WARNING, wrap: true, xalign: 0, css_classes: ['caption', 'warning'], margin_top: 6});
    model.advancedWidgets.push(advancedNote); advancedNote.set_visible(model.mode === 'advanced');
    appsBox.append(advancedNote);
    root.append(apps);

    // ---- the matrix
    const matrix = new Adw.PreferencesGroup({title: 'What is known', description: 'A toolkit alone does not make an application compatible: each line says how it is reached, what it cannot do, and how that is known.'});
    for (const f of FAMILIES) {
        const row = new Adw.ExpanderRow({title: GLib.markup_escape_text(f.name, -1), subtitle: `${STATUS_LABEL[f.status]} · ${APPLIES_LABEL[f.applies]} · ${f.evidence}`});
        for (const [k, v] of [['How', f.how], ['Limit', f.limit], ['Can be set', f.customizations.join(', ')]]) { const r = new Adw.ActionRow({title: k, subtitle: GLib.markup_escape_text(v, -1), subtitle_lines: 4}); row.add_row(r); }
        matrix.add(row);
    }
    root.append(matrix);

    // ---- a test window: the three layers at the current settings
    const testBtn = new Gtk.Button({label: 'Open a test window', halign: Gtk.Align.START});
    testBtn.connect('clicked', () => {
        const w = new Adw.Window({title: 'Appearance test', default_width: 480, default_height: 320, css_classes: ['niro-window'], transient_for: ctx.window});
        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ['niro-content'], margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
        body.append(new Gtk.Label({label: 'Primary text stays solid', xalign: 0, css_classes: ['title-4']}));
        body.append(new Gtk.Label({label: 'Secondary text keeps its contrast over any wallpaper.', xalign: 0, css_classes: ['dim-label']}));
        const group = new Adw.PreferencesGroup(); const sw = new Adw.SwitchRow({title: 'A switch', active: true}); group.add(sw); body.append(group);
        const close = new Gtk.Button({label: 'Close', halign: Gtk.Align.END}); close.connect('clicked', () => w.close()); body.append(close);
        w.set_content(body); w.present();
    });
    root.append(testBtn);

    return {widget: scrolled(new Adw.Clamp({child: root, maximum_size: 760, tightening_threshold: 600}))};
}
