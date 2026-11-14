// @ts-nocheck: GTK / libadwaita are untyped here
// The window of Niro Control: the one control panel for the look of the desktop (Island, Dock, Windows, Search).
// Runs under `gjs -m`. A sidebar of modules with a search over every setting; each module builds itself from the catalog.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {CATALOG} from './catalog.js';
import {settingsSearch} from './components.js';
import {searchItems} from './logic.js';
import {aboutPage, dockPage, islandPage, lookPage, Model, resultsPage, searchPage, windowsPage} from './pages.js';
import {detectPreset, effective, PRESET_KEYS, PRESETS} from './appearance.js';
import {stylesheet} from './appearanceTokens.js';
import {compatPage} from './compatPage.js';
import {homePage} from './homePage.js';
import {profilesPage} from './profilesPage.js';

const MODULES = [
    ['home', 'Home', 'go-home-symbolic', (model, shared) => shared.home.widget],
    ['look', 'Look', 'preferences-desktop-theme-symbolic', lookPage], ['island', 'Island', 'view-pin-symbolic', islandPage],
    ['dock', 'Dock', 'view-app-grid-symbolic', dockPage], ['windows', 'Windows', 'window-new-symbolic', windowsPage],
    ['search', 'Search', 'system-search-symbolic', searchPage],
    ['compat', 'Compatibility', 'preferences-system-symbolic', (model, shared) => shared.compat.widget],
    ['profiles', 'Profiles', 'user-bookmarks-symbolic', (model, shared) => shared.profiles.widget], ['about', 'About', 'help-about-symbolic', aboutPage],
];


export /** The parts of the shell that were updated on disk after the shell started: they run their old code until the next login. */
function staleParts(): string[] {
    try {
        const pid = new TextDecoder().decode(GLib.spawn_command_line_sync('pidof -s gnome-shell')[1]).trim();
        const started = Gio.File.new_for_path(`/proc/${pid}`).query_info('time::modified', 0, null).get_modification_date_time().to_unix();
        const parts = [['Island', 'island'], ['Dock', 'dock'], ['Search', 'search'], ['Blur', 'blur'], ['Corners', 'corners']];
        return parts.filter(([, id]) => {
            const f = Gio.File.new_for_path(`/usr/share/gnome-shell/extensions/${id}@niro.local/extension.js`);
            return f.query_exists(null) && f.query_info('time::modified', 0, null).get_modification_date_time().to_unix() > started;
        }).map(([name]) => name);
    } catch (_e) {
        return [];
    }
}

export function buildWindow(app) {
    const provider = new Gtk.CssProvider();
    const manager = Adw.StyleManager.get_default();
    let model;
    // the glass follows Look > Opacity and the dark/light scheme; nothing else in the panel does
    const a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    const read = id => model?.read(`niro.${id}`);
    const values = () => Object.fromEntries(PRESET_KEYS.map(k => [k, read(k)]));
    // what the panel shows: the settings, made safer where readability needs it (high contrast, safe mode, floors)
    const restyle = () => {
        const e = effective(values(), {safeMode: read('safe-mode') === true, highContrast: manager.get_high_contrast() || a11y.get_boolean('high-contrast')});
        const scheme = read('color-scheme') === 'dark' ? 'dark' : read('color-scheme') === 'light' ? 'light' : (manager.get_dark() ? 'dark' : 'light');
        const on = read('universal-enabled') !== false && read('affect-gtk') !== false;
        // switched off, the panel keeps its own readable defaults instead of the shared glass
        provider.load_from_string(stylesheet(scheme, on ? e.glass : 100, read('tint'), on ? {sidebar: e.sidebar, content: e.content, elevated: e.elevated} : {sidebar: 100, content: 100, elevated: 100}));
    };
    restyle();
    // above USER (800): a user-wide ~/.config/gtk-4.0/gtk.css theme must not repaint the panel's layers (it set opaque backgrounds and a fixed text colour)
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 50);

    const overlay = new Adw.ToastOverlay();
    const window = new Adw.ApplicationWindow({application: app, title: 'Niro Control', default_width: 1060, default_height: 740, css_classes: ['niro-window']});
    window.set_size_request(380, 420);
    const size = (GLib.getenv('NIRO_SIZE') ?? '').match(/^(\d+)x(\d+)$/); // to look at the panel at another size
    if (size) window.set_default_size(Number(size[1]), Number(size[2]));

    const ctx = {
        window,
        toast: (message, retry, label = 'Retry') => {
            const t = Adw.Toast.new(message);
            t.set_timeout(retry ? 8 : 4);
            if (retry) { t.set_button_label(label); t.connect('button-clicked', retry); }
            overlay.add_toast(t);
        },
        openLook: () => select('look'),
        go: id => select(id),
        focusSearch: () => search.grab_focus(),
        logout: () => { try { Gio.Subprocess.new(['gnome-session-quit', '--logout'], Gio.SubprocessFlags.NONE); } catch (e) { ctx.toast(`Couldn't log out: ${e.message}`); } },
        takenShortcuts: except => model.takenShortcuts(except),
        inhibitShortcuts: on => {
            // Super+… would go to the shell instead of the recorder: ask it to leave the keys to this window
            const surface = window.get_surface();
            if (surface?.inhibit_system_shortcuts && on) surface.inhibit_system_shortcuts(null);
            else if (surface?.restore_system_shortcuts && !on) surface.restore_system_shortcuts();
        },
    };
    model = new Model(ctx);
    const watch = (id, fn) => { const b = model.binding(CATALOG.find(i => i.id === id)); if (b && !Array.isArray(b)) b.subscribe(fn); };
    for (const id of ['tint', 'universal-enabled', 'affect-gtk', 'safe-mode', 'color-scheme', ...PRESET_KEYS]) watch(`niro.${id}`, restyle);
    // choosing a preset writes its values; changing a value by hand makes the preset "custom"
    let applying = false;
    watch('niro.preset', () => {
        const name = read('preset');
        if (applying || !PRESETS[name] || detectPreset(values()) === name) return;
        applying = true;
        try { for (const k of PRESET_KEYS) model.binding(CATALOG.find(i => i.id === `niro.${k}`)).write(PRESETS[name][k]); } finally { applying = false; }
        restyle();
    });
    const syncPreset = () => { if (applying) return; const name = detectPreset(values()); if (read('preset') !== name) { applying = true; try { model.binding(CATALOG.find(i => i.id === 'niro.preset')).write(name); } finally { applying = false; } } };
    for (const k of PRESET_KEYS) watch(`niro.${k}`, syncPreset);
    a11y.connect('changed::high-contrast', restyle); manager.connect('notify::high-contrast', restyle);
    manager.connect('notify::dark', restyle);
    restyle();
    const stale = GLib.getenv('NIRO_NOBANNER') ? [] : staleParts();
    ctx.stale = stale;
    const shared = {};
    shared.profiles = profilesPage(model.engine, ctx);
    shared.home = homePage(model, ctx, shared.profiles, stale);
    shared.compat = compatPage(model, ctx);

    const content = new Gtk.Stack({hexpand: true, vexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
    // reduced motion: GNOME's animations switch also stops the panel's crossfade
    const motion = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const syncMotion = () => content.set_transition_duration(motion.get_boolean('enable-animations') ? 120 : 0);
    syncMotion(); motion.connect('changed::enable-animations', syncMotion);
    const titles = new Map();
    for (const [id, title, , make] of MODULES) {
        content.add_named(make(model, shared), id);
        titles.set(id, title);
    }

    // sidebar: the search, then the modules
    const list = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE, vexpand: true});
    list.update_property([Gtk.AccessibleProperty.LABEL], ['Settings modules']);
    for (const [id, title, icon] of MODULES) {
        const box = new Gtk.Box({spacing: 10, margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        box.append(new Gtk.Image({icon_name: icon})); box.append(new Gtk.Label({label: title, xalign: 0}));
        const row = new Gtk.ListBoxRow({child: box}); row.set_name(id);
        list.append(row);
    }
    let current = 'home';
    const contentTitle = new Adw.WindowTitle({title: 'Home'});
    const select = (id) => { current = id; list.select_row(list.get_row_at_index(MODULES.findIndex(m => m[0] === id))); };
    list.connect('row-selected', (_l, row) => {
        if (!row) return;
        current = row.get_name();
        search.set_text('');
        content.set_visible_child_name(current);
        contentTitle.set_title(titles.get(current));
        banner.set_revealed(stale.length > 0 && current !== 'home');   // Home lists it already
        split.set_show_content(true);
    });

    let results = null;
    const find = (query) => {
        if (!query.trim()) { content.set_visible_child_name(current); contentTitle.set_title(titles.get(current)); return; }
        if (results) content.remove(results);
        results = resultsPage(model, searchItems(CATALOG, query), query.trim());
        content.add_named(results, 'results');
        content.set_visible_child_name('results');
        contentTitle.set_title('Search results');
        split.set_show_content(true);
    };
    const search = settingsSearch(find, () => { content.set_visible_child_name(current); contentTitle.set_title(titles.get(current)); });

    // the window buttons (close, minimise, maximise) sit at the left, on the sidebar's header, whatever the system layout says
    const LEFT = 'close,minimize,maximize:';
    const sideTop = new Adw.HeaderBar({show_title: false, css_classes: ['flat'], decoration_layout: LEFT});
    const sideBody = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    const searchBox = new Gtk.Box({margin_start: 10, margin_end: 10, margin_bottom: 8}); searchBox.append(search);
    sideBody.append(searchBox); sideBody.append(list);
    const sideView = new Adw.ToolbarView({content: sideBody}); sideView.add_top_bar(sideTop);
    sideView.add_css_class('niro-sidebar');

    const pageBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    const contentHeader = new Adw.HeaderBar({title_widget: contentTitle, decoration_layout: ':'});
    const contentView = new Adw.ToolbarView({content: pageBox, css_classes: ['niro-content']}); contentView.add_top_bar(contentHeader);
    // Simple shows the common settings; Advanced shows all of them. Only what is shown changes, never a value.
    const modeBox = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
    const simple = new Gtk.ToggleButton({label: 'Simple', tooltip_text: 'Common settings'});
    const advanced = new Gtk.ToggleButton({label: 'Advanced', group: simple, tooltip_text: 'Every setting, raw keys and diagnostics'});
    modeBox.append(simple); modeBox.append(advanced);
    modeBox.update_property([Gtk.AccessibleProperty.LABEL], ['Settings detail: Simple or Advanced']);
    (model.mode === 'advanced' ? advanced : simple).set_active(true);
    advanced.connect('toggled', () => model.setMode(advanced.get_active() ? 'advanced' : 'simple'));
    contentHeader.pack_end(modeBox);
    model.setMode(model.mode, false);
    model.onModeChanged = m => (m === 'advanced' ? advanced : simple).get_active() || (m === 'advanced' ? advanced : simple).set_active(true);
    const banner = new Adw.Banner({title: `A newer ${stale.join(', ')} is installed. Log out and in to load it.`, button_label: 'Log out', revealed: stale.length > 0});
    banner.connect('button-clicked', () => { try { Gio.Subprocess.new(['gnome-session-quit', '--logout'], Gio.SubprocessFlags.NONE); } catch (e) { ctx.toast(`Couldn't log out: ${e.message}`); } });
    pageBox.append(banner); pageBox.append(content); // in the page, not a top bar: a banner that wraps would cover the first rows
    overlay.set_child(contentView);
    const split = new Adw.NavigationSplitView({sidebar: Adw.NavigationPage.new(sideView, 'Niro Control'), content: Adw.NavigationPage.new(overlay, 'Settings'),
        min_sidebar_width: 210, max_sidebar_width: 250, sidebar_width_fraction: 0.24});
    window.set_content(split);
    const bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse('max-width: 760sp'));
    bp.add_setter(split, 'collapsed', true);
    bp.add_setter(contentHeader, 'decoration-layout', LEFT); // narrow: the sidebar is hidden, the buttons move to the page's header
    bp.connect('apply', () => split.set_show_content(true)); // narrow: start on the page, the back arrow shows the modules
    // narrow: the sections list of Island and Dock becomes a menu above the page (watched by hand: breakpoints are one at a time)
    let narrow = null;
    window.add_tick_callback(() => {
        const now = window.get_width() > 0 && window.get_width() <= 660;
        if (now !== narrow) { narrow = now; model.narrow.forEach(([widget, prop, value]) => widget.set_property(prop, now ? value : !value)); }
        return GLib.SOURCE_CONTINUE;
    });
    window.add_breakpoint(bp);

    // keyboard: Ctrl+F searches, Ctrl+1…6 switch modules, Esc leaves the search
    const keys = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.GLOBAL});
    keys.add_shortcut(new Gtk.Shortcut({trigger: Gtk.ShortcutTrigger.parse_string('<Control>f'), action: Gtk.CallbackAction.new(() => { search.grab_focus(); return true; })}));
    MODULES.forEach(([id], i) => keys.add_shortcut(new Gtk.Shortcut({trigger: Gtk.ShortcutTrigger.parse_string(`<Control>${i + 1}`),
        action: Gtk.CallbackAction.new(() => { select(id); return true; })})));
    window.add_controller(keys);

    const scheme = GLib.getenv('NIRO_SCHEME'); // light / dark: to look at the other appearance
    if (scheme) Adw.StyleManager.get_default().set_color_scheme(scheme === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK);
    const first = GLib.getenv('NIRO_PAGE');
    select(MODULES.some(m => m[0] === first) ? first : 'home');
    const query = GLib.getenv('NIRO_SEARCH');
    if (query) search.set_text(query);
    return {window, model, search, select, ensureAll: () => shared.compat.ensure()};
}

