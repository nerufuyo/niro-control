// A libadwaita test window with the things the GTK adapter must not break: a sidebar, an entry, a list, a popover menu and a dialog.
// TEST_STATE=popover|dialog opens one of them. Used by scripts/gtk-apps-shots.sh.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Adw.Application({application_id: 'org.niro.GtkTest', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const win = new Adw.ApplicationWindow({application: app, default_width: 820, default_height: 520});
    const side = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
    for (const t of ['Documents', 'Music', 'Pictures']) side.append(new Gtk.Label({label: t, xalign: 0, margin_top: 8, margin_bottom: 8, margin_start: 8}));
    const menu = new Gio.Menu(); menu.append('Open', 'app.open'); menu.append('Rename', 'app.rename'); menu.append('Delete', 'app.delete');
    const button = new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu});
    const sideView = new Adw.ToolbarView({content: side}); sideView.add_top_bar(new Adw.HeaderBar({show_title: false}));
    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, margin_start: 18, margin_end: 18});
    content.append(new Gtk.Label({label: 'Readable content over the glass', xalign: 0, css_classes: ['title-2']}));
    content.append(new Gtk.Entry({placeholder_text: 'An input field', text: 'typed text'}));
    const group = new Adw.PreferencesGroup({title: 'Settings group'}); group.add(new Adw.SwitchRow({title: 'A switch', subtitle: 'With a description', active: true})); group.add(new Adw.ActionRow({title: 'A row', subtitle: 'Secondary text'}));
    content.append(group);
    const tv = new Gtk.TextView({height_request: 90}); tv.get_buffer().set_text('A text view: typed text must stay readable.', -1); content.append(tv);
    const header = new Adw.HeaderBar(); header.pack_end(button);
    const contentView = new Adw.ToolbarView({content}); contentView.add_top_bar(header);
    const split = new Adw.NavigationSplitView({sidebar: Adw.NavigationPage.new(sideView, 'Sidebar'), content: Adw.NavigationPage.new(contentView, 'Content')});
    win.set_content(split); win.present();
    const state = GLib.getenv('TEST_STATE');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        if (state === 'popover') button.popup();
        if (state === 'dialog') { const d = Adw.AlertDialog.new('Delete the file?', 'This cannot be undone.'); d.add_response('cancel', 'Cancel'); d.add_response('del', 'Delete'); d.set_response_appearance('del', Adw.ResponseAppearance.DESTRUCTIVE); d.present(win); }
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
