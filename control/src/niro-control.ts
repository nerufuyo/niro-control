// @ts-nocheck: GTK / libadwaita are untyped here
// Niro Control. Runs under `gjs -m`.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {runCli} from './cli.js';
import {buildWindow} from './window.js';

const code = runCli(ARGV);
if (code !== null) {
    System.exit(code);
} else {
    const app = new Adw.Application({application_id: 'org.niro.Control'});
    // The application's icon (hicolor, from the package): the window's and the About page's.
    app.connect('startup', () => Gtk.Window.set_default_icon_name('org.niro.Control'));
    app.connect('activate', () => (app.get_active_window() ?? buildWindow(app).window).present());
    app.run([System.programInvocationName, ...ARGV]);
}
