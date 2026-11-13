// Niro Control: one control panel for the look of Isle, the dock, DigUp and app windows (org.niro.control).
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

    const glass = new Adw.PreferencesGroup({title: 'Glass', description: "Isle, the dock, app windows and DigUp's panel"});
    scaleRow(settings, glass, 'Opacity', 'opacity', '0 is clear, 100 is solid');
    const blur = new Adw.SwitchRow({title: 'Blur', subtitle: "Frosted glass behind the dock and app windows (not DigUp's panel)"});
    settings.bind('blur', blur, 'active', Gio.SettingsBindFlags.DEFAULT);
    glass.add(blur);
    scaleRow(settings, glass, 'Blur strength', 'blur-strength', '');
    page.add(glass);

    return page;
}

function islePage() {
    const settings = extensionSettings('isle@zickrian.github.io', 'org.gnome.shell.extensions.isle');
    if (!settings)
        return missingPage('Isle');
    const page = new Adw.PreferencesPage();
    const look = new Adw.PreferencesGroup({title: 'Island'});
    choiceRow(settings, look, 'Shape', 'island-shape', ['notch', 'pill']);
    choiceRow(settings, look, 'Opens on', 'open-on', ['hover', 'click']);
    spinRow(settings, look, 'Hover delay (ms)', 'hover-delay', 0, 1000, 10);
    choiceRow(settings, look, 'Auto-hide', 'auto-hide', ['off', 'always', 'top-bar', 'windows']);
    choiceRow(settings, look, 'Size when open', 'open-size', ['standard', 'large']);
    choiceRow(settings, look, 'Top bar style', 'top-bar-style', ['glass', 'black']);
    switchRow(settings, look, 'Compact top bar', 'compact-top-bar');
    switchRow(settings, look, 'Space below the island', 'notch-gap');
    page.add(look);
    const alerts = new Adw.PreferencesGroup({title: 'Alerts'});
    switchRow(settings, alerts, 'System alerts', 'system-alerts', 'Battery, network, Bluetooth, Caps Lock');
    switchRow(settings, alerts, 'Calendar event alerts', 'event-alerts');
    switchRow(settings, alerts, 'Volume and brightness in the island', 'replace-osd');
    switchRow(settings, alerts, 'Alerts over full-screen apps', 'alerts-over-fullscreen');
    switchRow(settings, alerts, 'Camera, microphone and screen-share indicators', 'privacy-indicators');
    page.add(alerts);
    const more = new Adw.PreferencesGroup({title: 'Features'});
    switchRow(settings, more, 'Clipboard history', 'clipboard-history');
    switchRow(settings, more, 'Voice assistant', 'voice-assistant');
    switchRow(settings, more, 'AI plan usage', 'usage-enabled');
    switchRow(settings, more, 'Look up lyrics online', 'lyrics-online');
    switchRow(settings, more, 'Chimes', 'chimes');
    page.add(more);
    const all = new Adw.PreferencesGroup();
    launchRow(all, 'All Isle settings', 'Shortcuts, assistant, calendar, pages, and the rest', ['gnome-extensions', 'prefs', 'isle@zickrian.github.io']);
    page.add(all);
    return page;
}

function dockPage() {
    const settings = extensionSettings('macos-dock@vinnytherobot.github.io', 'org.gnome.shell.extensions.macosdock');
    if (!settings)
        return missingPage('Dock');
    const page = new Adw.PreferencesPage();
    const size = new Adw.PreferencesGroup({title: 'Dock'});
    spinRow(settings, size, 'Icon size', 'icon-size', 16, 128, 1);
    spinRow(settings, size, 'Corner radius', 'dock-border-radius', 0, 40, 1);
    switchRow(settings, size, 'Auto-hide', 'auto-hide');
    switchRow(settings, size, 'Show running apps', 'show-running-apps');
    switchRow(settings, size, 'Running indicators', 'running-indicators');
    switchRow(settings, size, 'Drag to reorder', 'drag-reorder');
    switchRow(settings, size, 'Applications button', 'show-applications-button');
    page.add(size);
    const motion = new Adw.PreferencesGroup({title: 'Motion'});
    switchRow(settings, motion, 'Magnification', 'magnification-enabled');
    spinRow(settings, motion, 'Magnification scale', 'magnification-scale', 1, 3, 0.05, 2);
    spinRow(settings, motion, 'Magnification reach', 'magnification-falloff', 40, 300, 5);
    switchRow(settings, motion, 'Bounce on launch', 'bounce-on-launch');
    spinRow(settings, motion, 'Animation duration (ms)', 'animation-duration', 0, 1000, 10);
    page.add(motion);
    const windows = new Adw.PreferencesGroup({title: 'Windows and media'});
    switchRow(settings, windows, 'Window previews', 'window-previews');
    switchRow(settings, windows, 'Media controls', 'media-controls');
    page.add(windows);
    return page;
}

function searchPage() {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({title: 'Search (DigUp)', description: 'Opens with Super+Space. Its folders, model and shortcut are set in DigUp itself.'});
    launchRow(group, 'Open DigUp', 'The window, with its settings', ['digup-shell']);
    page.add(group);
    return page;
}

function build(app) {
    const settings = new Gio.Settings({schema_id: SCHEMA});
    const stack = new Adw.ViewStack();
    stack.add_titled_with_icon(lookPage(settings), 'look', 'Look', 'preferences-desktop-theme-symbolic');
    stack.add_titled_with_icon(islePage(), 'isle', 'Isle', 'view-pin-symbolic');
    stack.add_titled_with_icon(dockPage(), 'dock', 'Dock', 'view-app-grid-symbolic');
    stack.add_titled_with_icon(searchPage(), 'search', 'Search', 'system-search-symbolic');
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
