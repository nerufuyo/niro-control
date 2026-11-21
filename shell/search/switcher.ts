// @ts-nocheck: GJS and shell imports, as the other extension files
// A window switcher: every open window as a card with a live picture of it, most recently used first. Arrow keys or Tab move,
// Enter or a click brings the window forward, Esc closes. Off until a shortcut is set (Niro Control › Search › Window switcher).
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

import {columnsFor, move} from './switcherRules.js';

// St.BoxLayout: `vertical` up to GNOME 50, `orientation` from 48.
const VERTICAL = parseInt(PACKAGE_VERSION, 10) >= 48 ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
const CARD_W = 240, PIC_W = 216, PIC_H = 140;

export class Switcher {
    constructor() {
        this._shade = null;
        this._grab = null;
        this._cards = [];
        this._windows = [];
        this._index = 0;
        this._cols = 1;
    }

    get isOpen() { return this._shade !== null; }

    /** Opens on the second window (the one you were in before this one), as Alt+Tab does. */
    open() {
        if (this._shade) return;
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null).filter(w => !w.is_skip_taskbar());
        if (!windows.length) { Main.notify('Niro Search', 'There are no windows to switch to.'); return; }
        this._windows = windows;
        this._cols = columnsFor(windows.length);
        this._index = windows.length > 1 ? 1 : 0;

        const monitor = Main.layoutManager.primaryMonitor;
        this._shade = new St.Bin({style: 'background-color: rgba(0, 0, 0, 0.45);', reactive: true, can_focus: true, x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const panel = new St.BoxLayout({...VERTICAL, style: 'background-color: rgba(28, 28, 32, 0.92); border-radius: 20px; padding: 18px; spacing: 12px;'});
        this._shade.set_child(panel);
        for (let start = 0; start < windows.length; start += this._cols) {
            const row = new St.BoxLayout({style: 'spacing: 12px;'});
            panel.add_child(row);
            windows.slice(start, start + this._cols).forEach((win, k) => { const card = this._card(win, start + k); row.add_child(card); this._cards.push(card); });
        }
        Main.uiGroup.add_child(this._shade);
        this._grab = Main.pushModal(this._shade, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab || (this._grab.get_seat_state?.() !== undefined && this._grab.get_seat_state() === Clutter.GrabState.NONE)) { this.close(); return; }
        this._shade.connect('key-press-event', (_a, event) => this._key(event));
        this._shade.connect('button-press-event', (_a, event) => { if (event.get_source() === this._shade) this.close(); return Clutter.EVENT_STOP; });
        global.stage.set_key_focus(this._shade);
        this._paint();
    }

    _card(win, i) {
        const card = new St.BoxLayout({...VERTICAL, reactive: true, track_hover: true, width: CARD_W, style: 'padding: 12px; border-radius: 14px; spacing: 8px;'});
        const frame = win.get_frame_rect();
        const scale = Math.min(PIC_W / frame.width, PIC_H / frame.height, 1);
        const actor = win.get_compositor_private();
        const holder = new St.Widget({width: PIC_W, height: PIC_H, x_align: Clutter.ActorAlign.CENTER});
        if (actor) {
            const clone = new Clutter.Clone({source: actor, width: Math.round(frame.width * scale), height: Math.round(frame.height * scale)});
            clone.set_position(Math.round((PIC_W - clone.width) / 2), Math.round((PIC_H - clone.height) / 2));
            holder.add_child(clone);
        }
        card.add_child(holder);
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        const label = new St.Label({text: win.get_title() || app?.get_name() || '', style: 'color: white; font-size: 12px; text-align: center;', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set_ellipsize(3);
        card.add_child(label);
        card.connect('button-press-event', () => { this._index = i; this._activate(); return Clutter.EVENT_STOP; });
        card.connect('enter-event', () => { this._index = i; this._paint(); return Clutter.EVENT_PROPAGATE; });
        return card;
    }

    _paint() {
        this._cards.forEach((c, i) => c.set_style(`padding: 12px; border-radius: 14px; spacing: 8px; ${i === this._index ? 'background-color: rgba(232, 71, 43, 0.35); border: 2px solid rgba(232, 71, 43, 0.9);' : 'border: 2px solid transparent;'}`));
    }

    _key(event) {
        const key = event.get_key_symbol();
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const dirs = {[Clutter.KEY_Left]: 'left', [Clutter.KEY_Right]: 'right', [Clutter.KEY_Up]: 'up', [Clutter.KEY_Down]: 'down'};
        if (key === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_space) { this._activate(); return Clutter.EVENT_STOP; }
        const dir = dirs[key] ?? (key === Clutter.KEY_Tab ? 'next' : key === Clutter.KEY_ISO_Left_Tab ? 'prev' : null);
        if (dir) { this._index = move(this._index, this._windows.length, this._cols, shift && dir === 'next' ? 'prev' : dir); this._paint(); }
        return Clutter.EVENT_STOP;
    }

    _activate() {
        const win = this._windows[this._index];
        this.close();
        if (win) Main.activateWindow(win);
    }

    close() {
        if (this._grab) { try { Main.popModal(this._grab); } catch (_e) { /* already released */ } }
        this._grab = null;
        this._shade?.destroy();
        this._shade = null;
        this._cards = [];
    }

    destroy() { this.close(); }
}
