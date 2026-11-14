// The GTK adapter against a throw-away config folder shaped like a real one: a gtk.css that is a symlink to a theme file.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BEGIN, GENERATED, install, plan, refresh, restore, status, withBlock, withoutBlock} from '../../control/build/gtkAdapter.js';

const fail = m => { throw new Error(m); };
const eq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) || fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const tmp = GLib.dir_make_tmp('niro-gtk-XXXXXX');
const cfg = `${tmp}/config`, backups = `${tmp}/backups`;
for (const d of ['gtk-4.0', 'gtk-3.0']) GLib.mkdir_with_parents(`${cfg}/${d}`, 0o755);
const theme = '@define-color accent_bg_color #E8472B;\nwindow { border-radius: 4px; }';    // no trailing newline, as a hand-written theme may be
GLib.file_set_contents(`${cfg}/gtk-4.0/gtk-Dark.css`, theme);
for (const n of ['gtk.css', 'gtk-dark.css']) Gio.File.new_for_path(`${cfg}/gtk-4.0/${n}`).make_symbolic_link(`${cfg}/gtk-4.0/gtk-Dark.css`, null);
GLib.file_set_contents(`${cfg}/gtk-3.0/gtk.css`, '@define-color theme_bg_color rgba(22,13,13,0.62);\n');
const gtk3Before = read(`${cfg}/gtk-3.0/gtk.css`);
const o = {configDir: cfg, backupRoot: backups, consent: true, scheme: 'dark', glass: 80, tint: '#1C1C1E', surfaces: {sidebar: 70, content: 85, elevated: 92}};

// the plan names the real files, once each
eq(plan(cfg).map(f => f.path.replace(cfg, '')), ['/gtk-4.0/niro-glass.css', '/gtk-4.0/gtk-Dark.css', '/gtk-3.0/niro-glass.css', '/gtk-3.0/gtk.css'], 'plan');
// no consent, no change
try { install({...o, consent: false}); fail('installed without consent'); } catch (e) { if (!/consent/.test(e.message)) throw e; }
eq(read(`${cfg}/gtk-4.0/gtk-Dark.css`), theme, 'untouched without consent');
eq(status(cfg, backups).installed, false, 'not installed');

// install: a block at the end, the symlink kept, the theme before it unchanged, a backup of each file
const r = install(o);
eq(GLib.file_test(`${cfg}/gtk-4.0/gtk.css`, GLib.FileTest.IS_SYMLINK), true, 'gtk.css is still a symlink');
const after = read(`${cfg}/gtk-4.0/gtk-Dark.css`);
if (!after.startsWith(theme)) fail('the theme text changed');
if (after.split(BEGIN).length !== 2) fail('exactly one block expected');
if (!read(`${cfg}/gtk-4.0/${GENERATED}`).includes('window.background')) fail('the generated stylesheet is missing');
if (!read(`${cfg}/gtk-3.0/${GENERATED}`).includes('GTK 3')) fail('the GTK 3 stylesheet is missing');
eq(read(`${r.backupDir}/4-gtk-Dark.css`), theme, 'backup of the theme');
eq(read(`${r.backupDir}/3-gtk.css`), gtk3Before, 'backup of the gtk3 file');
eq(status(cfg, backups).installed, true, 'installed');

// a second install adds nothing (one block), a refresh rewrites only the generated files
install(o);
eq(read(`${cfg}/gtk-4.0/gtk-Dark.css`).split(BEGIN).length, 2, 'idempotent');
refresh({...o, glass: 20});
if (!read(`${cfg}/gtk-4.0/${GENERATED}`).includes('rgba(28, 28, 30, 0.275')) fail('refresh did not apply the new glass');

// restore: byte-identical to what the user had, generated files gone, backups kept
restore(cfg);
eq(read(`${cfg}/gtk-4.0/gtk-Dark.css`), theme, 'restored theme');
eq(read(`${cfg}/gtk-3.0/gtk.css`), gtk3Before, 'restored gtk3 file');
eq(GLib.file_test(`${cfg}/gtk-4.0/${GENERATED}`, GLib.FileTest.EXISTS), false, 'generated file removed');
eq(GLib.file_test(`${cfg}/gtk-4.0/gtk.css`, GLib.FileTest.IS_SYMLINK), true, 'symlink survived restore');
eq(status(cfg, backups).installed, false, 'not installed again');
if (!status(cfg, backups).backups.length) fail('backups were removed');

// a config with no gtk files at all: created on install, deleted again on restore
const cfg2 = `${tmp}/empty`; GLib.mkdir_with_parents(cfg2, 0o755);
install({...o, configDir: cfg2});
if (!read(`${cfg2}/gtk-4.0/gtk.css`).includes(BEGIN)) fail('gtk.css not created');
restore(cfg2);
eq(GLib.file_test(`${cfg2}/gtk-4.0/gtk.css`, GLib.FileTest.EXISTS), false, 'created file removed on restore');

// a failure half-way leaves everything as it was: make the gtk-3.0 folder unwritable
const cfg3 = `${tmp}/broken`; for (const d of ['gtk-4.0', 'gtk-3.0']) GLib.mkdir_with_parents(`${cfg3}/${d}`, 0o755);
GLib.file_set_contents(`${cfg3}/gtk-4.0/gtk.css`, 'a { color: red; }\n');
GLib.chmod(`${cfg3}/gtk-3.0`, 0o500);
if (GLib.access(`${cfg3}/gtk-3.0`, 2) !== 0) {                      // (skipped as root, where nothing is unwritable)
    try { install({...o, configDir: cfg3}); fail('install should have failed'); } catch (e) { if (!/as they were/.test(e.message)) throw e; }
    eq(read(`${cfg3}/gtk-4.0/gtk.css`), 'a { color: red; }\n', 'rolled back');
    eq(GLib.file_test(`${cfg3}/gtk-4.0/${GENERATED}`, GLib.FileTest.EXISTS), false, 'rolled back generated file');
}
GLib.chmod(`${cfg3}/gtk-3.0`, 0o755);
// block helpers
eq(withoutBlock(withBlock('x\n', 4)), 'x\n', 'block round trip');
eq(withoutBlock('no block here'), 'no block here', 'no block');
print('appearance: gtk adapter ok');

// refresh: only differing files are rewritten, a disabled look writes a neutral file, nothing happens when not installed
{
    const cfg4 = `${tmp}/refresh`; for (const d of ['gtk-4.0', 'gtk-3.0']) GLib.mkdir_with_parents(`${cfg4}/${d}`, 0o755);
    const o4 = {...o, configDir: cfg4};
    eq(refresh({...o4}), [], 'not installed: nothing');
    install(o4);
    eq(refresh({...o4}), [], 'unchanged: nothing rewritten');
    eq(refresh({...o4, scheme: 'light'}).length, 2, 'a scheme change rewrites both files');
    eq(refresh({...o4, scheme: 'light'}), [], 'and then nothing again');
    eq(refresh({...o4, scheme: 'light', glass: 81}).length, 2, 'a glass change rewrites');
    const off = refresh({...o4, scheme: 'light', disabled: true});
    eq(off.length, 2, 'disabling rewrites');
    if (!read(`${cfg4}/gtk-4.0/${GENERATED}`).includes('switched off')) fail('a disabled look should write a neutral file');
    if (read(`${cfg4}/gtk-4.0/${GENERATED}`).includes('background-color')) fail('a disabled look must style nothing');
    restore(cfg4);
    print('appearance: refresh ok');
}
