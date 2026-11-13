// SPDX-License-Identifier: GPL-3.0-or-later
// System page (local addition): CPU, memory, swap, temperature and network speed, read from /proc and /sys once a
// second while the page is open.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {label} from '../widgets.js';
import {Page} from './page.js';

const TICK_MS = 1000;

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch (_e) {
        return '';
    }
}

/** Finds the CPU temperature input once (AMD k10temp, or Intel coretemp). */
function findCpuTempPath() {
    for (let i = 0; i < 16; i++) {
        const dir = `/sys/class/hwmon/hwmon${i}`;
        const name = readText(`${dir}/name`).trim();
        if (name === 'k10temp' || name === 'coretemp') {
            for (const input of ['temp1_input', 'temp2_input'])
                if (readText(`${dir}/${input}`).trim() !== '')
                    return `${dir}/${input}`;
        }
    }
    return null;
}

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond >= 1048576)
        return `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`;
    if (bytesPerSecond >= 1024)
        return `${Math.round(bytesPerSecond / 1024)} KB/s`;
    return `${Math.round(bytesPerSecond)} B/s`;
}

// A bar filled to `share` (0..1) of its width.
const Meter = GObject.registerClass(class Meter extends St.Widget {
    _init() {
        super._init({style_class: 'isle-sys-track', x_expand: true});
        this._share = 0;
        this._fill = new St.Widget({style_class: 'isle-sys-fill'});
        this.add_child(this._fill);
    }

    set share(share) {
        share = Math.max(0, Math.min(1, share));
        if (Math.abs(share - this._share) < 0.004)
            return;
        this._share = share;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = box.get_size();
        const fill = new Clutter.ActorBox();
        fill.set_origin(0, 0);
        fill.set_size(this._share > 0 ? Math.max(height, Math.round(width * this._share)) : 0, height);
        this._fill.allocate(fill);
    }
});

/** One cell: a name and its value over a bar (the bar is left out for plain readings). */
function makeCell(name, withBar = true) {
    const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-sys-cell', x_expand: true});
    const top = new St.BoxLayout({style_class: 'isle-sys-top'});
    top.add_child(label(name, 'isle-sys-name', {x_expand: true}));
    const value = label('–', 'isle-sys-value');
    top.add_child(value);
    box.add_child(top);
    let meter = null;
    if (withBar) {
        meter = new Meter();
        box.add_child(meter);
    }
    return {box, value, meter};
}

export const SystemPage = GObject.registerClass(
class SystemPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-sys',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'system';
        this._cpuPrev = null;
        this._netPrev = null;
        this._tempPath = findCpuTempPath();

        this._cells = {
            cpu: makeCell('CPU'),
            mem: makeCell('Memory'),
            swap: makeCell('Swap'),
            temp: makeCell('Temperature'),
            down: makeCell('Download', false),
            up: makeCell('Upload', false),
        };
        const rows = [['cpu', 'mem'], ['swap', 'temp'], ['down', 'up']];
        const grid = new St.BoxLayout({...VERTICAL, style_class: 'isle-sys-grid', y_expand: true});
        for (const pair of rows) {
            const row = new St.BoxLayout({style_class: 'isle-sys-row', x_expand: true});
            for (const key of pair)
                row.add_child(this._cells[key].box);
            grid.add_child(row);
        }
        this.add_child(grid);
        this._sample();
    }

    onActivate() {
        this._tick();
    }

    onDeactivate() {
        this.cancel('tick');
    }

    _tick() {
        this._sample();
        this.later('tick', TICK_MS, () => this._tick());
    }

    _sample() {
        this._sampleCpu();
        this._sampleMemory();
        this._sampleTemp();
        this._sampleNet();
    }

    _sampleCpu() {
        const line = readText('/proc/stat').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
        if (line.length < 5)
            return;
        const idle = line[3] + (line[4] ?? 0);
        const total = line.reduce((a, b) => a + b, 0);
        if (this._cpuPrev) {
            const dTotal = total - this._cpuPrev.total;
            const dIdle = idle - this._cpuPrev.idle;
            if (dTotal > 0) {
                const usage = 1 - dIdle / dTotal;
                this._cells.cpu.value.text = `${Math.round(usage * 100)}%`;
                this._cells.cpu.meter.share = usage;
            }
        }
        this._cpuPrev = {total, idle};
    }

    _sampleMemory() {
        const info = {};
        for (const row of readText('/proc/meminfo').split('\n')) {
            const m = row.match(/^(\w+):\s+(\d+)/);
            if (m)
                info[m[1]] = Number(m[2]);
        }
        if (info.MemTotal) {
            const used = info.MemTotal - (info.MemAvailable ?? info.MemFree);
            this._cells.mem.value.text = `${(used / 1048576).toFixed(1)} / ${(info.MemTotal / 1048576).toFixed(0)} GB`;
            this._cells.mem.meter.share = used / info.MemTotal;
        }
        if (info.SwapTotal) {
            const used = info.SwapTotal - info.SwapFree;
            this._cells.swap.value.text = `${(used / 1048576).toFixed(1)} / ${(info.SwapTotal / 1048576).toFixed(0)} GB`;
            this._cells.swap.meter.share = used / info.SwapTotal;
        } else {
            this._cells.swap.value.text = 'off';
            this._cells.swap.meter.share = 0;
        }
    }

    _sampleTemp() {
        if (!this._tempPath) {
            this._cells.temp.value.text = 'n/a';
            return;
        }
        const celsius = Number(readText(this._tempPath)) / 1000;
        if (!Number.isFinite(celsius) || celsius <= 0)
            return;
        this._cells.temp.value.text = `${Math.round(celsius)}°C`;
        // Bar: 30 °C empty to 95 °C full.
        this._cells.temp.meter.share = (celsius - 30) / 65;
    }

    _sampleNet() {
        let rx = 0, tx = 0;
        for (const row of readText('/proc/net/dev').split('\n').slice(2)) {
            const [name, rest] = row.split(':');
            if (!rest || name.trim() === 'lo')
                continue;
            const f = rest.trim().split(/\s+/).map(Number);
            rx += f[0] || 0;
            tx += f[8] || 0;
        }
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._netPrev) {
            const dt = now - this._netPrev.time;
            if (dt > 0) {
                this._cells.down.value.text = formatSpeed(Math.max(0, (rx - this._netPrev.rx) / dt));
                this._cells.up.value.text = formatSpeed(Math.max(0, (tx - this._netPrev.tx) / dt));
            }
        }
        this._netPrev = {rx, tx, time: now};
    }
});
