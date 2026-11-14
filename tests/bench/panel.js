// Control panel timings, on a display: time from process start (NIRO_BENCH_T0, epoch ms) to the first drawn frame, memory and
// CPU while idle, and how long a module switch takes to draw. Prints JSON. Run by scripts/benchmark-performance.sh.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {buildWindow} from '../../control/build/window.js';

const t0 = Number(GLib.getenv('NIRO_BENCH_T0') ?? 0);
const IDLE = Number(GLib.getenv('NIRO_BENCH_IDLE') ?? 8);
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const mem = () => Object.fromEntries([...read('/proc/self/smaps_rollup').matchAll(/^(Rss|Pss):\s+(\d+) kB/gm)].map(m => [m[1].toLowerCase() + '_mb', Number(m[2]) / 1024]));
const cpuTicks = () => { const f = read('/proc/self/stat').split(')')[1].trim().split(' '); return Number(f[11]) + Number(f[12]); };
const out = {};

const app = new Adw.Application({application_id: 'org.niro.Bench', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const {window} = buildWindow(app);
    window.connect('map', () => window.add_tick_callback(() => {
        out.first_frame_ms = GLib.get_real_time() / 1000 - t0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { settle(window); return GLib.SOURCE_REMOVE; });
        return GLib.SOURCE_REMOVE;
    }));
    window.present();
});

function settle(window) {
    const ticks = cpuTicks(); const start = GLib.get_monotonic_time();
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, IDLE, () => {
        const hz = 100; // USER_HZ on Linux
        out.idle_cpu_percent = (cpuTicks() - ticks) / hz / ((GLib.get_monotonic_time() - start) / 1e6) * 100;
        Object.assign(out, mem());
        navigate(window);
        return GLib.SOURCE_REMOVE;
    });
}

function find(widget, test) {
    if (test(widget)) return widget;
    for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) { const r = find(c, test); if (r) return r; }
    return null;
}

function navigate(window) {
    const list = find(window, w => w instanceof Gtk.ListBox && w.has_css_class('navigation-sidebar'));
    const rows = []; for (let r = list.get_row_at_index(0), i = 0; r; r = list.get_row_at_index(++i)) rows.push(r);
    const samples = [];
    const jobs = [...rows, ...rows, ...rows];
    const next = () => {
        const row = jobs.shift();
        if (!row) { out.nav_ms = samples; print(JSON.stringify(out)); app.quit(); return; }
        const a = GLib.get_monotonic_time();
        list.select_row(row);
        let frames = 0;
        window.add_tick_callback(() => {
            if (++frames < 2) return GLib.SOURCE_CONTINUE; // the frame after the switch has been drawn
            samples.push((GLib.get_monotonic_time() - a) / 1000);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { next(); return GLib.SOURCE_REMOVE; });
            return GLib.SOURCE_REMOVE;
        });
    };
    next();
}

app.run([]);
