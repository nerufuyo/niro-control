// Niro Control: one control panel for the look of Isle, the dock, DigUp and app windows (org.niro.control).
// Runs under `gjs -m`; the gi:// modules come from the system, so they are typed loosely.
// @ts-nocheck: GJS bindings are not typed here
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
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

function build(app) {
    const settings = new Gio.Settings({schema_id: SCHEMA});
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

    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    view.set_content(page);
    const window = new Adw.ApplicationWindow({application: app, title: 'Niro Control', default_width: 520, default_height: 640});
    window.set_content(view);
    return window;
}

const app = new Adw.Application({application_id: 'org.niro.Control'});
app.connect('activate', () => (app.get_active_window() ?? build(app)).present());
app.run([System.programInvocationName, ...ARGV]);
