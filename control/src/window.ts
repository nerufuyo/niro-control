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
import {homePage} from './homePage.js';
import {profilesPage} from './profilesPage.js';

const MODULES = [
    ['home', 'Home', 'go-home-symbolic', (model, shared) => shared.home.widget],
    ['look', 'Look', 'preferences-desktop-theme-symbolic', lookPage], ['island', 'Island', 'view-pin-symbolic', islandPage],
    ['dock', 'Dock', 'view-app-grid-symbolic', dockPage], ['windows', 'Windows', 'window-new-symbolic', windowsPage],
    ['search', 'Search', 'system-search-symbolic', searchPage],
    ['profiles', 'Profiles', 'user-bookmarks-symbolic', (model, shared) => shared.profiles.widget], ['about', 'About', 'help-about-symbolic', aboutPage],
];

const CSS = `
.niro-window { background-color: alpha(@window_bg_color, 0.93); }
.niro-sidebar { background-color: alpha(@sidebar_bg_color, 0.86); }
.niro-window .boxed-list, .niro-window preferencesgroup > box > box > list { background-color: alpha(@card_bg_color, 0.88); }
.niro-subnav { background-color: alpha(@sidebar_bg_color, 0.6); }
.niro-subnav row { border-radius: 8px; margin: 1px 6px; }
.niro-preview { border-radius: 12px; background-color: alpha(@card_bg_color, 0.55); }
.niro-card { border-radius: 14px; background-color: alpha(@card_bg_color, 0.88); }
.niro-card-active { background-color: alpha(@accent_bg_color, 0.14); border-radius: 14px; }
.niro-preset { padding: 6px 10px; border-radius: 9px; }
.niro-sidebar row.activatable { border-radius: 9px; margin: 1px 6px; }
`;

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
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

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
    const model = new Model(ctx);
    const stale = GLib.getenv('NIRO_NOBANNER') ? [] : staleParts();
    const shared = {};
    shared.profiles = profilesPage(model.engine, ctx);
    shared.home = homePage(model, ctx, shared.profiles, stale);

    const content = new Gtk.Stack({hexpand: true, vexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
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

    const sideTop = new Adw.HeaderBar({show_title: false, css_classes: ['flat']});
    const sideBody = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    const searchBox = new Gtk.Box({margin_start: 10, margin_end: 10, margin_bottom: 8}); searchBox.append(search);
    sideBody.append(searchBox); sideBody.append(list);
    const sideView = new Adw.ToolbarView({content: sideBody}); sideView.add_top_bar(sideTop);
    sideView.add_css_class('niro-sidebar');

    const pageBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    const contentHeader = new Adw.HeaderBar({title_widget: contentTitle});
    const contentView = new Adw.ToolbarView({content: pageBox}); contentView.add_top_bar(contentHeader);
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
    return {window, model, search, select};
}

