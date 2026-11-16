// The Hyprland page against a throw-away config folder: with a display it builds, writes only what was changed, reads it back,
// resets, connects and disconnects hyprland.conf and leaves the rest of that file as it was.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const fail = m => { throw new Error(m); };
const dir = GLib.dir_make_tmp('niro-hypr-XXXXXX');
GLib.setenv('NIRO_HYPR_DIR', dir, true);
GLib.setenv('NIRO_HYPRLAND', '1', true);
const text = p => { try { return new TextDecoder().decode(Gio.File.new_for_path(`${dir}/${p}`).load_contents(null)[1]); } catch (_e) { return null; } };

const {hyprlandPresent, hyprlandPage} = await import('../../control/build/hyprlandPage.js');
const {DEFS} = await import('../../control/build/hyprland.js');
if (!hyprlandPresent()) fail('Hyprland is not seen though NIRO_HYPRLAND=1');

if (!Gtk.init_check()) { print('hyprland page: no display, the logic tests cover the rest'); imports.system.exit(0); }
const Adw = (await import('gi://Adw?version=1')).default; Adw.init();

const original = '# mine\nmonitor=,preferred,auto,1\n';
Gio.File.new_for_path(`${dir}/hyprland.conf`).replace_contents(new TextEncoder().encode(original), null, false, 0, null);
const page = hyprlandPage({}, {window: null});
if (!page.widget) fail('no widget');

// find a row by its title and drive it
const find = (w, title) => { for (let c = w.get_first_child(); c; c = c.get_next_sibling()) { if (c.title === title) return c; const r = find(c, title); if (r) return r; } return null; };
const rounding = find(page.widget, 'Rounded corners') ?? fail('no rounding row');
rounding.set_value(12);
if (!/decoration:rounding = 12/.test(text('niro.conf') ?? '')) fail(`rounding not written: ${text('niro.conf')}`);
const blur = find(page.widget, 'Blur behind windows') ?? fail('no blur row');
blur.set_active(false);
if (!/decoration:blur:enabled = false/.test(text('niro.conf'))) fail('blur switch not written');
rounding.set_value(0);   // the default: not worth a line
if (/rounding/.test(text('niro.conf'))) fail('a default was written');
if (page.values()['decoration:blur:enabled'] !== false) fail('value lost');

// an arrangement sets its layout and options at once; changing one option by hand makes it Custom
const arrangement = find(page.widget, 'Arrangement') ?? fail('no arrangement row');
arrangement.set_selected(3);   // Center master
if (!/general:layout = master/.test(text('niro.conf')) || !/master:orientation = center/.test(text('niro.conf'))) fail(`arrangement not written: ${text('niro.conf')}`);
const mfact = find(page.widget, 'Master: size of the large window') ?? fail('no mfact row');
mfact.set_value(0.8);
if (arrangement.get_selected() !== 10) fail(`not Custom after a change: ${arrangement.get_selected()}`);
arrangement.set_selected(0);   // Dwindle: nothing of the others left behind
if (/master:/.test(text('niro.conf'))) fail(`Dwindle left master settings: ${text('niro.conf')}`);

// connect: one line is added; disconnect: hyprland.conf is as it was
let connect; const walk = w => { for (let c = w.get_first_child(); c; c = c.get_next_sibling()) { if (c instanceof Gtk.Button && c.label === 'Connect') connect = c; walk(c); } }; walk(page.widget);
connect ?? fail('no Connect button');
connect.emit('clicked');
if (!/source = .*niro\.conf # niro-control/.test(text('hyprland.conf')) || !text('hyprland.conf').startsWith(original)) fail(`not connected cleanly: ${text('hyprland.conf')}`);
if (connect.label !== 'Disconnect') fail('button did not change');
connect.emit('clicked');
if (text('hyprland.conf') !== original) fail(`hyprland.conf not restored: ${JSON.stringify(text('hyprland.conf'))}`);

if (DEFS.length < 20) fail('settings missing');
print('hyprland page: ok');
