// SPDX-License-Identifier: GPL-3.0-or-later
// Tile: arranges the windows of each monitor in the chosen layout (see layouts.js), and keeps them so as windows come and go.
// Off until switched on (`enabled`): nothing is moved before that. Dialogs, full-screen, maximized, minimized and floated windows
// are left as they are.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {arrange, dwindleSplits, inner, LAYOUT_IDS, LAYOUTS} from './layouts.js';

const RETILE_MS = 60;
const SHELL_MAJOR = parseInt(PACKAGE_VERSION.split('.')[0], 10);
const unmaximize = win => (SHELL_MAJOR >= 49 ? win.unmaximize() : win.unmaximize(Meta.MaximizeFlags.BOTH));
// the grab operations that pull a window's edge or corner
const RESIZING = new Set(Object.entries(Meta.GrabOp).filter(([name]) => /^RESIZING/.test(name)).map(([, v]) => v));
const isMaximized = win => Boolean(win.maximized_horizontally && win.maximized_vertically);
const KEYS = ['toggle', 'layout', 'promote', 'float', 'grow', 'shrink'];

export default class Tile extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._order = [];                 // windows in tile order: the first is the main one
        this._floating = new Set();       // windows the user took out of the tiling
        this._winSignals = new Map();
        this._signals = [];
        this._retileId = 0;
        this._state = new Map();          // window: "maximized|fullscreen" when last looked at
        this._dragging = null;            // the tiled window being moved with the pointer
        this._ghosts = [];                // the preview of the layout shown while a window is carried
        this._ghostTimer = 0;
        this._ghostCell = null;           // {monitor, index}: the tile the carried window would take
        this._resizing = null;            // the tiled window whose edge is being pulled
        this._ratios = new Map();         // monitor: Dwindle's split shares, made by resizing
        this._weights = new Map();        // monitor: the sizes of Horizontal and Vertical's tiles, made by resizing
        this._shape = new Map();          // monitor: which layout and count those belong to; another and they are forgotten
        this._placed = new WeakSet();     // windows the tiling has put in a tile: one of them maximized afterwards stays maximized

        const wm = global.window_manager;
        const display = global.display;
        const again = () => this._schedule();
        for (const s of ['destroy', 'minimize', 'unminimize', 'map', 'switch-workspace'])
            this._signals.push([wm, wm.connect(s, again)]);
        for (const s of ['window-created', 'in-fullscreen-changed', 'workareas-changed', 'window-entered-monitor', 'window-left-monitor'])
            this._signals.push([display, display.connect(s, again)]);
        this._signals.push([Main.layoutManager, Main.layoutManager.connect('monitors-changed', again)]);
        // Drag and drop: moving a tiled window over another and letting go swaps their places
        this._signals.push([display, display.connect('grab-op-begin', (_d, win, op) => this._beginDrag(win, op))]);
        this._signals.push([display, display.connect('grab-op-end', (_d, win) => this._endDrag(win))]);
        for (const key of ['enabled', 'layout', 'gap-inner', 'gap-outer', 'master-factor', 'column-width', 'floating-apps'])
            this._signals.push([this._settings, this._settings.connect(`changed::${key}`, again)]);
        this._signals.push([this._settings, this._settings.connect('changed::enabled', () => this._osd(this._settings.get_boolean('enabled') ? 'Tiling on' : 'Tiling off'))]);
        this._signals.push([this._settings, this._settings.connect('changed::layout', () => this._osd(this._layoutTitle()))]);

        const handlers = {
            toggle: () => this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled')),
            layout: () => this._nextLayout(),
            promote: () => this._promote(),
            float: () => this._toggleFloat(),
            grow: () => this._grow(0.05),
            shrink: () => this._grow(-0.05),
        };
        for (const key of KEYS)
            Main.wm.addKeybinding(`shortcut-${key}`, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, handlers[key]);
        this._schedule();
    }

    disable() {
        for (const key of KEYS)
            Main.wm.removeKeybinding(`shortcut-${key}`);
        for (const [source, id] of this._signals)
            source.disconnect(id);
        this._signals = [];
        for (const [win, ids] of this._winSignals) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (_e) { /* gone */ }
            }
        }
        this._winSignals.clear();
        if (this._retileId) {
            GLib.Source.remove(this._retileId);
            this._retileId = 0;
        }
        this._order = [];
        this._floating = null;
        this._state = null;
        this._stopGhost();
        this._ratios = this._weights = this._shape = null;
        this._placed = null;
        this._settings = null;
    }

    // ---- Which windows, and in which order

    _eligible(win) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL || win.skip_taskbar || win.is_override_redirect?.())
            return false;
        if (win.minimized || win.fullscreen)
            return false;
        // A window maximized before the tiling took it is brought into a tile; one the person maximized afterwards is left maximized
        if (isMaximized(win) && this._placed.has(win))
            return false;
        if (this._floating.has(win) || win.get_transient_for() || win.is_on_all_workspaces())
            return false;
        // allows_move()/allows_resize() are false while a window is maximized: a window that can be resized at all is meant
        if (!win.resizeable || (!isMaximized(win) && (!win.allows_move() || !win.allows_resize())))
            return false;
        const klass = win.get_wm_class_instance() ?? win.get_wm_class() ?? win.get_gtk_application_id?.();
        return !(klass && this._settings.get_strv('floating-apps').includes(klass));
    }

    /** Takes in the windows that are new and lets go of the ones that are gone. */
    _sync() {
        const alive = new Set(global.get_window_actors().map(a => a.meta_window).filter(w => w && w.window_type === Meta.WindowType.NORMAL));
        this._order = this._order.filter(w => alive.has(w));
        for (const w of [...this._winSignals.keys()]) {
            if (!alive.has(w)) {
                try { this._winSignals.get(w).forEach(id => w.disconnect(id)); } catch (_e) { /* gone */ }
                this._winSignals.delete(w);
                this._floating.delete(w);
                this._state.delete(w);
            }
        }
        for (const w of alive) {
            if (this._order.includes(w) || !w.get_compositor_private())
                continue;
            this._order.push(w);
            const ids = [w.connect('workspace-changed', () => this._schedule())];
            // maximizing or full screen takes a window out of the tiling and back: looked at when its size changes
            ids.push(w.connect('size-changed', () => {
                const now = `${isMaximized(w)}|${w.fullscreen}`;
                if (this._state.get(w) !== now) {
                    this._state.set(w, now);
                    this._schedule();
                }
            }));
            this._winSignals.set(w, ids);
            this._state.set(w, `${isMaximized(w)}|${w.fullscreen}`);
        }
    }

    // ---- Tiling

    _schedule() {
        // not while a window is carried: it would be put back under the pointer
        if (this._retileId || !this._settings || this._dragging || this._resizing)
            return;
        this._retileId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETILE_MS, () => {
            this._retileId = 0;
            try {
                this._retile();
            } catch (e) {
                console.warn(`Tile: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _retile() {
        if (!this._settings)
            return;
        this._sync();
        if (!this._settings.get_boolean('enabled'))
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const focus = global.display.focus_window;
        const layout = this._settings.get_string('layout');
        for (let monitor = 0; monitor < global.display.get_n_monitors(); monitor++) {
            const windows = this._order.filter(w => this._eligible(w) && w.get_workspace() === workspace && w.get_monitor() === monitor);
            if (!windows.length)
                continue;
            const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
            const rects = arrange(layout, windows.length, {x: area.x, y: area.y, width: area.width, height: area.height},
                this._options(Math.max(0, windows.indexOf(focus)), monitor, windows.length));
            windows.forEach((w, i) => this._place(w, rects[i]));
            if (layout === 'monocle' && focus && windows.includes(focus))
                focus.raise();
        }
    }

    _place(win, r) {
        if (isMaximized(win))
            unmaximize(win);
        this._placed.add(win);
        const now = win.get_frame_rect();
        if (now.x === r.x && now.y === r.y && now.width === r.width && now.height === r.height)
            return;
        win.move_resize_frame(true, r.x, r.y, r.width, r.height);
        this._glide(win, now, r);
    }

    /** The window glides from where it was to where it went, rather than jumping: its picture is moved back and let go. */
    _glide(win, from, to) {
        const actor = win.get_compositor_private();
        if (!actor || !this._settings.get_boolean('animate') || !St.Settings.get().enable_animations)
            return;
        const dx = from.x - to.x, dy = from.y - to.y;
        if (!dx && !dy)
            return;
        actor.remove_all_transitions();
        actor.translation_x = dx;
        actor.translation_y = dy;
        actor.ease({translation_x: 0, translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    // ---- Drag and drop, with a preview of the layout
    //
    // While a tiled window is carried, the layout it would make is drawn over the screen: one outlined cell for each tile (the carried
    // window included), the cell under the pointer lit. Letting go puts the window in that cell and the others move over for it.

    _beginDrag(win, op) {
        if (!this._settings?.get_boolean('enabled') || !this._order.includes(win) || !this._eligible(win))
            return;
        if (op === Meta.GrabOp.MOVING) {
            this._dragging = win;
            this._startGhost();
        } else if (RESIZING.has(op)) {
            this._resizing = win;   // the tiling waits; the new size is taken in when the edge is let go
        }
    }

    _endDrag(win) {
        if (this._resizing && this._resizing === win) {
            this._resizing = null;
            try {
                this._resized(win);
            } catch (e) {
                console.warn(`Tile: ${e.message}`);
            }
            this._schedule();
            return;
        }
        if (!this._dragging || this._dragging !== win)
            return;
        this._dragging = null;
        const cell = this._ghostCell;
        this._stopGhost();
        if (cell)
            this._insertAt(win, cell.monitor, cell.index);
        this._schedule();
    }

    /** The tiled windows of a monitor on the active workspace, but for `except`, in tile order. */
    _tiledOn(monitor, except) {
        const workspace = global.workspace_manager.get_active_workspace();
        return this._order.filter(w => w !== except && this._eligible(w) && w.get_workspace() === workspace && w.get_monitor() === monitor);
    }

    _options(focus = 0, monitor = -1, count = 0) {
        // what resizing made belongs to one layout and one number of windows on a monitor: another, and it starts over
        const key = `${this._settings.get_string('layout')}:${count}`;
        const mine = this._shape.get(monitor) === key;
        return {
            gapInner: this._settings.get_int('gap-inner'),
            gapOuter: this._settings.get_int('gap-outer'),
            masterFactor: this._settings.get_double('master-factor'),
            columnWidth: this._settings.get_double('column-width'),
            focus,
            ratios: mine ? this._ratios.get(monitor) : undefined,
            weights: mine ? this._weights.get(monitor) : undefined,
        };
    }

    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const i = monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return i >= 0 ? i : global.display.get_primary_monitor();
    }

    /** The cell of `rects` the point is in, else the nearest by its centre. */
    _cellAt(rects, x, y) {
        const inside = rects.findIndex(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
        if (inside >= 0)
            return inside;
        let best = 0, bestD = Infinity;
        rects.forEach((r, i) => {
            const d = (r.x + r.width / 2 - x) ** 2 + (r.y + r.height / 2 - y) ** 2;
            if (d < bestD) { best = i; bestD = d; }
        });
        return best;
    }

    _startGhost() {
        this._stopGhost();
        this._updateGhost();
        this._ghostTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._updateGhost();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGhost() {
        if (this._ghostTimer) {
            GLib.Source.remove(this._ghostTimer);
            this._ghostTimer = 0;
        }
        for (const g of this._ghosts)
            g.destroy();
        this._ghosts = [];
        this._ghostCell = null;
    }

    _updateGhost() {
        const win = this._dragging;
        if (!win || !this._settings)
            return;
        const [x, y] = global.get_pointer();
        const monitor = this._monitorAt(x, y);
        const others = this._tiledOn(monitor, win);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const rects = arrange(this._settings.get_string('layout'), others.length + 1, {x: area.x, y: area.y, width: area.width, height: area.height}, this._options(0, -1, others.length + 1));
        const shown = rects.filter(r => !r.hidden);
        const index = this._cellAt(shown, x, y);
        this._ghostCell = {monitor, index};
        while (this._ghosts.length < shown.length) {
            const g = new St.Widget({style_class: 'tile-ghost', reactive: false});
            Main.layoutManager.uiGroup.add_child(g);
            this._ghosts.push(g);
        }
        while (this._ghosts.length > shown.length)
            this._ghosts.pop().destroy();
        shown.forEach((r, i) => {
            const g = this._ghosts[i];
            g.set_position(r.x, r.y);
            g.set_size(r.width, r.height);
            if (i === index)
                g.add_style_pseudo_class('active');
            else
                g.remove_style_pseudo_class('active');
        });
    }

    /**
     * `win` was resized by hand: what the new size says about the layout is kept, so the others follow. The main window of the Master
     * layouts sets the master size, the columns of Scrolling set their width, and Dwindle, Horizontal and Vertical keep the shares.
     * Grid, Three columns and Monocle have no sizes to set: the window goes back.
     */
    _resized(win) {
        const monitor = win.get_monitor();
        const windows = this._tiledOn(monitor);
        const i = windows.indexOf(win);
        const n = windows.length;
        if (i < 0)
            return;
        const layout = this._settings.get_string('layout');
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const opts = this._options(0, monitor, n);
        const a = inner({x: area.x, y: area.y, width: area.width, height: area.height}, opts.gapOuter);
        const rects = arrange(layout, n, {x: area.x, y: area.y, width: area.width, height: area.height}, opts);
        const f = win.get_frame_rect();
        const dw = Math.abs(f.width - rects[i].width) >= 4;
        const dh = Math.abs(f.height - rects[i].height) >= 4;
        if (!dw && !dh)
            return;
        const gap = opts.gapInner;
        const keep = (field, value, lo, hi) => this._settings.set_double(field, Math.round(Math.max(lo, Math.min(hi, value)) * 100) / 100);
        const remember = (ratios, weights) => {
            this._shape.set(monitor, `${layout}:${n}`);
            if (ratios) this._ratios.set(monitor, ratios);
            if (weights) this._weights.set(monitor, weights);
        };
        switch (layout) {
        case 'master-left':
        case 'master-right':
        case 'center-master': {
            if (n < 2 || !dw)
                break;
            const centre = layout === 'center-master' && n >= 3;
            const room = a.width - (centre ? 2 : 1) * gap;
            keep('master-factor', i === 0 ? f.width / room : 1 - (centre ? 2 : 1) * f.width / room, 0.1, 0.9);
            break;
        }
        case 'scrolling':
            if (dw)
                keep('column-width', f.width / a.width, 0.2, 1);
            break;
        case 'horizontal':
            if (dw)
                remember(null, rects.map((r, k) => (k === i ? f.width : r.width)));
            break;
        case 'vertical':
            if (dh)
                remember(null, rects.map((r, k) => (k === i ? f.height : r.height)));
            break;
        case 'dwindle': {
            if (n < 2)
                break;
            const splits = dwindleSplits(n, a, gap, opts.ratios);
            const ratios = splits.map(sp => sp.share);
            if (i < n - 1) {   // the window is the first half of its own split
                const sp = splits[i];
                if (sp.wide && dw)
                    ratios[i] = f.width / (sp.rest.width - gap);
                else if (!sp.wide && dh)
                    ratios[i] = f.height / (sp.rest.height - gap);
            }
            if (i >= 1) {   // and the second half of the one before: it gives the space the window has left, when its size says so
                const sp = splits[i - 1];
                const ownWide = i < n - 1 ? splits[i].wide : null;
                if (sp.wide && dw && (ownWide === null || !ownWide))
                    ratios[i - 1] = 1 - f.width / (sp.rest.width - gap);
                else if (!sp.wide && dh && (ownWide === null || ownWide))
                    ratios[i - 1] = 1 - f.height / (sp.rest.height - gap);
            }
            remember(ratios.map(r => Math.max(0.1, Math.min(0.9, r))), null);
            break;
        }
        default:
            break;   // no sizes to keep: it goes back to its tile
        }
    }

    /** `win` goes to place `index` among the tiled windows of `monitor`; the others move over. */
    _insertAt(win, monitor, index) {
        if (win.get_monitor() !== monitor)
            win.move_to_monitor(monitor);
        const others = this._tiledOn(monitor, win);
        this._order = this._order.filter(w => w !== win);
        const before = others[index];
        if (before)
            this._order.splice(this._order.indexOf(before), 0, win);
        else if (others.length)
            this._order.splice(this._order.indexOf(others[others.length - 1]) + 1, 0, win);
        else
            this._order.push(win);
    }

    // ---- Shortcuts

    _nextLayout() {
        const i = LAYOUT_IDS.indexOf(this._settings.get_string('layout'));
        this._settings.set_string('layout', LAYOUT_IDS[(i + 1) % LAYOUT_IDS.length]);
    }

    _promote() {
        const win = global.display.focus_window;
        const i = this._order.indexOf(win);
        if (i <= 0)
            return;
        this._order.splice(i, 1);
        this._order.unshift(win);
        this._schedule();
    }

    _toggleFloat() {
        const win = global.display.focus_window;
        if (!win || win.window_type !== Meta.WindowType.NORMAL)
            return;
        if (this._floating.has(win))
            this._floating.delete(win);
        else
            this._floating.add(win);
        this._osd(this._floating.has(win) ? 'Floating' : 'Tiled');
        this._schedule();
    }

    _grow(by) {
        const v = this._settings.get_double('master-factor');
        this._settings.set_double('master-factor', Math.max(0.1, Math.min(0.9, Math.round((v + by) * 100) / 100)));
    }

    _layoutTitle() {
        return LAYOUTS.find(l => l[0] === this._settings.get_string('layout'))?.[1] ?? '';
    }

    _osd(text) {
        try {
            Main.osdWindowManager.showAll?.(Gio.ThemedIcon.new('view-grid-symbolic'), text, null, null)
                ?? Main.osdWindowManager.show(-1, Gio.ThemedIcon.new('view-grid-symbolic'), text, null);
        } catch (_e) { /* no OSD: the change shows anyway */ }
    }
}
