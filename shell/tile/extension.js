// SPDX-License-Identifier: GPL-3.0-or-later
// Tile: arranges the windows of each monitor in the chosen layout (see layouts.js), and keeps them so as windows come and go.
// Off until switched on (`enabled`): nothing is moved before that. Dialogs, full-screen, maximized, minimized and floated windows
// are left as they are.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {arrange, LAYOUT_IDS, LAYOUTS} from './layouts.js';

const RETILE_MS = 60;
const SHELL_MAJOR = parseInt(PACKAGE_VERSION.split('.')[0], 10);
const unmaximize = win => (SHELL_MAJOR >= 49 ? win.unmaximize() : win.unmaximize(Meta.MaximizeFlags.BOTH));
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
        if (this._retileId || !this._settings || this._dragging)
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
            const rects = arrange(layout, windows.length, {x: area.x, y: area.y, width: area.width, height: area.height}, {
                gapInner: this._settings.get_int('gap-inner'),
                gapOuter: this._settings.get_int('gap-outer'),
                masterFactor: this._settings.get_double('master-factor'),
                columnWidth: this._settings.get_double('column-width'),
                focus: Math.max(0, windows.indexOf(focus)),
            });
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
    }

    // ---- Drag and drop

    _beginDrag(win, op) {
        if (!this._settings?.get_boolean('enabled') || op !== Meta.GrabOp.MOVING || !this._order.includes(win) || !this._eligible(win))
            return;
        this._dragging = win;
    }

    _endDrag(win) {
        if (!this._dragging || this._dragging !== win)
            return;
        this._dragging = null;
        this._dropOn(win, ...global.get_pointer());
        this._schedule();
    }

    /** `win` was dropped with the pointer at (x, y): it takes the place of the tiled window under the pointer, and that one takes its place. */
    _dropOn(win, x, y) {
        const workspace = global.workspace_manager.get_active_workspace();
        const target = this._order.find(w => {
            if (w === win || !this._eligible(w) || w.get_workspace() !== workspace)
                return false;
            const r = w.get_frame_rect();
            return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        });
        if (!target)
            return false;   // dropped on nothing: it goes back to its tile
        const a = this._order.indexOf(win);
        const b = this._order.indexOf(target);
        [this._order[a], this._order[b]] = [target, win];
        return true;
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
