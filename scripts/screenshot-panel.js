// Opens the control panel on the page named by NIRO_PAGE (a module id) and stays open: used by scripts/screenshots.sh.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

import {buildWindow} from '../control/build/window.js';

const app = new Adw.Application({application_id: 'org.niro.Screenshot'});
const find = (w, test) => { if (test(w)) return w; for (let c = w.get_first_child(); c; c = c.get_next_sibling()) { const r = find(c, test); if (r) return r; } return null; };
app.connect('activate', () => {
    const {window} = buildWindow(app);
    window.present();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        const list = find(window, w => w instanceof Gtk.ListBox && w.has_css_class('navigation-sidebar'));
        for (let r = list.get_row_at_index(0), i = 0; r; r = list.get_row_at_index(++i)) if (r.get_name() === (GLib.getenv('NIRO_PAGE') ?? 'home')) list.select_row(r);
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);
