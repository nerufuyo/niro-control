// Niro Control: one control panel for the look of Island, the dock, the search and app windows (org.niro.control).
// Runs under `gjs -m`; the gi:// modules come from the system, so they are typed loosely.
// @ts-nocheck: GJS bindings are not typed here
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const SCHEMA = 'org.niro.control';
const TONES: [string, string, string][] = [
    ['Ember', '#E8472B', '#1C1C1E'], ['Ocean', '#0A84FF', '#10161F'], ['Mint', '#30D158', '#101A14'],
    ['Violet', '#5E5CE6', '#171527'], ['Amber', '#FF9F0A', '#1C1810'], ['Mono', '#8E8E93', '#1C1C1E'],
];

const toHex = (rgba) => '#' + [rgba.red, rgba.green, rgba.blue]
    .map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

function toRgba(hex: string) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    return rgba;
}

function colourRow(settings, group, title: string, key: string) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), valign: Gtk.Align.CENTER});
    button.set_rgba(toRgba(settings.get_string(key)));
    button.connect('notify::rgba', () => {
        const hex = toHex(button.get_rgba());
        if (hex !== settings.get_string(key).toUpperCase())
            settings.set_string(key, hex);
    });
    settings.connect(`changed::${key}`, () => {
        const rgba = toRgba(settings.get_string(key));
        if (toHex(button.get_rgba()) !== toHex(rgba))
            button.set_rgba(rgba);
    });
    row.add_suffix(button);
    group.add(row);
}

function scaleRow(settings, group, title: string, key: string, subtitle: string) {
    const row = new Adw.ActionRow({title, subtitle});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1);
    scale.set_hexpand(true);
    scale.set_size_request(220, -1);
    scale.set_draw_value(true);
    scale.set_value_pos(Gtk.PositionType.RIGHT);
    scale.set_value(settings.get_int(key));
    scale.connect('value-changed', () => settings.set_int(key, Math.round(scale.get_value())));
    settings.connect(`changed::${key}`, () => scale.set_value(settings.get_int(key)));
    row.add_suffix(scale);
    group.add(row);
}

const EXTENSION_DIRS = ['/usr/share/gnome-shell/extensions', '/usr/local/share/gnome-shell/extensions',
    `${GLib.get_user_data_dir()}/gnome-shell/extensions`];

/** Settings of an extension, read from the schemas folder it ships; null when it is not installed. */
function extensionSettings(uuid: string, schemaId: string) {
    for (const base of EXTENSION_DIRS) {
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(`${base}/${uuid}/schemas`,
                Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(schemaId, false);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch (_e) {
            // not in this place
        }
    }
    return null;
}

function switchRow(settings, group, title: string, key: string, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function spinRow(settings, group, title: string, key: string, min: number, max: number, step: number, digits = 0) {
    const row = new Adw.SpinRow({title, digits, adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step})});
    const read = () => digits ? settings.get_double(key) : settings.get_int(key);
    row.set_value(read());
    row.connect('notify::value', () => {
        if (digits)
            settings.set_double(key, row.get_value());
        else
            settings.set_int(key, Math.round(row.get_value()));
    });
    settings.connect(`changed::${key}`, () => {
        if (row.get_value() !== read())
            row.set_value(read());
    });
    group.add(row);
}

function choiceRow(settings, group, title: string, key: string, choices: string[]) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices)});
    const sync = () => row.set_selected(Math.max(0, choices.indexOf(settings.get_string(key))));
    sync();
    row.connect('notify::selected', () => settings.set_string(key, choices[row.get_selected()]));
    settings.connect(`changed::${key}`, sync);
    group.add(row);
}

function launchRow(group, title: string, subtitle: string, argv: string[]) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.connect('activated', () => {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`${argv[0]}: ${e.message}`);
        }
    });
    group.add(row);
}

function missingPage(name: string) {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({title: name, description: `${name} is not installed.`});
    page.add(group);
    return page;
}

function lookPage(settings) {
    const page = new Adw.PreferencesPage();

    const tones = new Adw.PreferencesGroup({title: 'Tone', description: 'One accent and one surface tint for the whole desktop'});
    const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, max_children_per_line: 6, column_spacing: 8, row_spacing: 8});
    for (const [name, accent, tint] of TONES) {
        const button = new Gtk.Button({label: name});
        button.connect('clicked', () => {
            settings.set_string('accent', accent);
            settings.set_string('tint', tint);
        });
        flow.append(button);
    }
    tones.add(flow);
    page.add(tones);

    const colours = new Adw.PreferencesGroup({title: 'Colours'});
    colourRow(settings, colours, 'Accent', 'accent');
    colourRow(settings, colours, 'Surface tint', 'tint');
    page.add(colours);

    const glass = new Adw.PreferencesGroup({title: 'Glass', description: "Island, the dock, app windows and the search panel"});
    scaleRow(settings, glass, 'Opacity', 'opacity', '0 is clear, 100 is solid');
    const blur = new Adw.SwitchRow({title: 'Blur', subtitle: "Frosted glass behind the dock and app windows"});
    settings.bind('blur', blur, 'active', Gio.SettingsBindFlags.DEFAULT);
    glass.add(blur);
    scaleRow(settings, glass, 'Blur strength', 'blur-strength', '');
    page.add(glass);

    return page;
}

const INTERNAL_KEYS = new Set(['update-shown', 'prefs-page', 'focus-dnd-owned', 'focus-dnd-declined', 'agents-announced',
    'app-usage-clear', 'hidden-pages', 'event-calendar', 'clipboard-ignored-apps']);

const escape = (text: string) => GLib.markup_escape_text(text.replace(/\s+/g, ' ').trim(), -1);

/** A row for one key, by its type, with the schema's own title and description. */
function keyRow(settings, key: string) {
    const schemaKey = settings.settings_schema.get_key(key);
    const title = schemaKey.get_summary() ?? key;
    const subtitle = escape((schemaKey.get_description() ?? '').slice(0, 160));
    const type = schemaKey.get_value_type().dup_string();
    const [kind, detail] = schemaKey.get_range().deep_unpack();
    const range = detail.deep_unpack();
    let row;
    if (type === 'b') {
        row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    } else if (type === 's' && kind === 'enum') {
        const choices: string[] = range.map(v => v.deep_unpack?.() ?? v);
        row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices)});
        const sync = () => row.set_selected(Math.max(0, choices.indexOf(settings.get_string(key))));
        sync();
        row.connect('notify::selected', () => settings.set_string(key, choices[row.get_selected()]));
        settings.connect(`changed::${key}`, sync);
    } else if (type === 's') {
        row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_string(key)});
        row.connect('apply', () => settings.set_string(key, row.get_text()));
        settings.connect(`changed::${key}`, () => row.get_text() !== settings.get_string(key) && row.set_text(settings.get_string(key)));
    } else if (type === 'as') {
        row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_strv(key).join(', ')});
        row.connect('apply', () => settings.set_strv(key, row.get_text().split(',').map(t => t.trim()).filter(Boolean)));
        settings.connect(`changed::${key}`, () => {
            const text = settings.get_strv(key).join(', ');
            if (row.get_text() !== text)
                row.set_text(text);
        });
    } else if (type === 'i' || type === 'u' || type === 'x' || type === 'd') {
        const double = type === 'd';
        const [min, max] = kind === 'range' ? range : [double ? 0 : -1000000, double ? 100 : 1000000];
        row = new Adw.SpinRow({title, subtitle, digits: double ? 2 : 0,
            adjustment: new Gtk.Adjustment({lower: Number(min), upper: Number(max), step_increment: double ? 0.05 : 1})});
        const read = () => double ? settings.get_double(key) : Number(settings.get_value(key).deep_unpack());
        row.set_value(read());
        row.connect('notify::value', () => {
            if (double)
                settings.set_double(key, row.get_value());
            else if (type === 'i')
                settings.set_int(key, Math.round(row.get_value()));
            else
                settings.set_value(key, new GLib.Variant(type, Math.round(row.get_value())));
        });
        settings.connect(`changed::${key}`, () => row.get_value() !== read() && row.set_value(read()));
    }
    return row;
}

/** Every public key of a schema, in groups: `groupOf` names the group of a key, `order` is the groups' order. */
function generatedPage(settings, groupOf: (key: string) => string, order: string[]) {
    const page = new Adw.PreferencesPage();
    const groups = new Map<string, any>();
    for (const name of order)
        groups.set(name, new Adw.PreferencesGroup({title: name}));
    for (const key of settings.settings_schema.list_keys()) {
        const summary = settings.settings_schema.get_key(key).get_summary() ?? '';
        if (INTERNAL_KEYS.has(key) || summary.startsWith('Internal'))
            continue;
        const row = keyRow(settings, key);
        if (!row)
            continue;
        const name = groupOf(key);
        if (!groups.has(name))
            groups.set(name, new Adw.PreferencesGroup({title: name}));
        groups.get(name).add(row);
    }
    for (const group of groups.values())
        page.add(group);
    return page;
}

const islandGroup = (key: string) =>
    /^(shortcut-|voice-shortcut|super-v)/.test(key) ? 'Shortcuts'
    : /^(voice-|bot-)/.test(key) ? 'Voice assistant'
    : /^usage-/.test(key) ? 'AI usage'
    : /^(alert-|system-alerts|event-|privacy-|call-|gnome-banners|replace-osd|alerts-over-fullscreen|chimes)/.test(key) ? 'Alerts'
    : /^(island-|open-|notch-|hover-|auto-hide|top-bar|compact|glass|clock-|track-peek)/.test(key) ? 'Island'
    : 'Features';

function islandPage() {
    const settings = extensionSettings('island@niro.local', 'org.gnome.shell.extensions.island');
    return settings ? generatedPage(settings, islandGroup, ['Island', 'Alerts', 'Features', 'Voice assistant', 'AI usage', 'Shortcuts'])
        : missingPage('Island');
}

const dockGroup = (key: string) =>
    /^(magnification|animation|bounce|icon-quality|show-threshold)/.test(key) ? 'Motion'
    : /^(dock-|icon-size|custom-css)/.test(key) ? 'Appearance'
    : 'Behaviour';

function dockPage() {
    const settings = extensionSettings('dock@niro.local', 'org.gnome.shell.extensions.dock');
    return settings ? generatedPage(settings, dockGroup, ['Appearance', 'Motion', 'Behaviour']) : missingPage('Dock');
}

/** One group with a row for every public key of a schema. */
function keyGroup(settings, title: string, subtitle = '') {
    const group = new Adw.PreferencesGroup({title, description: subtitle});
    for (const key of settings.settings_schema.list_keys()) {
        const row = keyRow(settings, key);
        if (row)
            group.add(row);
    }
    return group;
}

function windowsPage() {
    const page = new Adw.PreferencesPage();
    const blur = extensionSettings('blur@niro.local', 'org.gnome.shell.extensions.blur-my-shell.applications');
    const corners = extensionSettings('corners@niro.local', 'org.gnome.shell.extensions.rounded-window-corners-reborn');
    if (blur)
        page.add(keyGroup(blur, 'Window blur', 'Opacity and blur are also set together with the rest of the desktop in Look'));
    if (corners)
        page.add(keyGroup(corners, 'Rounded corners'));
    return page;
}

function searchPage(settings) {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({title: 'Application search', description: 'Finds the applications you have installed as you type. Its tone and opacity follow Look.'});
    group.add(keyRow(settings, 'search-shortcut'));
    page.add(group);
    return page;
}

function build(app) {
    const settings = new Gio.Settings({schema_id: SCHEMA});
    const stack = new Adw.ViewStack();
    stack.add_titled_with_icon(lookPage(settings), 'look', 'Look', 'preferences-desktop-theme-symbolic');
    stack.add_titled_with_icon(islandPage(), 'island', 'Island', 'view-pin-symbolic');
    stack.add_titled_with_icon(dockPage(), 'dock', 'Dock', 'view-app-grid-symbolic');
    stack.add_titled_with_icon(windowsPage(), 'windows', 'Windows', 'window-new-symbolic');
    stack.add_titled_with_icon(searchPage(settings), 'search', 'Search', 'system-search-symbolic');
    const first = GLib.getenv('NIRO_PAGE');
    if (first && stack.get_child_by_name(first))
        stack.set_visible_child_name(first);
    const header = new Adw.HeaderBar({title_widget: new Adw.ViewSwitcher({stack, policy: Adw.ViewSwitcherPolicy.WIDE})});
    const view = new Adw.ToolbarView();
    view.add_top_bar(header);
    view.set_content(stack);
    const window = new Adw.ApplicationWindow({application: app, title: 'Niro Control', default_width: 600, default_height: 720});
    window.set_content(view);
    return window;
}

const app = new Adw.Application({application_id: 'org.niro.Control'});
app.connect('activate', () => (app.get_active_window() ?? build(app)).present());
app.run([System.programInvocationName, ...ARGV]);
