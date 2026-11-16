// SPDX-License-Identifier: GPL-3.0-or-later
// The quick layout switcher: a compact overlay with the ten layouts, a search box, and a preview of the one chosen. Type to search, arrows to
// move, Enter (or a click) to apply, Escape to leave. It applies the layout to the active workspace through the `apply` it is given.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {arrange, searchLayouts} from './layouts.js';

const COLUMNS = 5;

const box = (vertical, props = {}) => {
    try {
        return new St.BoxLayout({...props, orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL});
    } catch (_e) {
        return new St.BoxLayout({...props, vertical});   // GNOME 46 and 47
    }
};

/** A picture of `layout` for four windows, in the colour of the text around it. */
function diagram(layout, width, height, strong) {
    const area = new St.DrawingArea({style_class: 'tile-switcher-diagram', width, height});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const rects = arrange(layout, 4, {x: 0, y: 0, width: w, height: h}, {gapInner: Math.round(w / 30), gapOuter: Math.round(w / 30), masterFactor: 0.55, columnWidth: 0.5, focus: 1});
        rects.forEach((r, i) => {
            if (r.hidden)
                return;
            const radius = Math.max(3, Math.round(w / 28));
            cr.newSubPath();
            cr.arc(r.x + r.width - radius, r.y + radius, radius, -Math.PI / 2, 0);
            cr.arc(r.x + r.width - radius, r.y + r.height - radius, radius, 0, Math.PI / 2);
            cr.arc(r.x + radius, r.y + r.height - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(r.x + radius, r.y + radius, radius, Math.PI, 1.5 * Math.PI);
            cr.closePath();
            cr.setSourceRGBA(1, 1, 1, i === 0 ? (strong ? 0.85 : 0.6) : (strong ? 0.4 : 0.25));
            cr.fill();
        });
        cr.$dispose();
    });
    return area;
}

export class LayoutSwitcher {
    /**
     * @param current the id of the layout in use
     * @param workspace the number of the workspace the layout is for (shown in the preview)
     * @param apply called with the id the person chose
     * @param closed called when it is gone, however it went
     */
    constructor({current, workspace, apply, closed = null}) {
        this._current = current;
        this._workspace = workspace;
        this._apply = apply;
        this._closedCallback = closed;
        this._visible = searchLayouts('');
        this._index = Math.max(0, this._visible.findIndex(l => l[0] === current));
        this._closed = false;
    }

    open(monitor) {
        this._backdrop = new St.Bin({style_class: 'tile-switcher-backdrop', reactive: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._backdrop.set_position(monitor.x, monitor.y);
        this._backdrop.set_size(monitor.width, monitor.height);
        const panel = box(true, {style_class: 'tile-switcher', reactive: true});
        this._panel = panel;
        this._backdrop.set_child(panel);

        panel.add_child(new St.Label({text: 'Window layout', style_class: 'tile-switcher-title'}));
        this._entry = new St.Entry({style_class: 'tile-switcher-entry', hint_text: 'Search layouts…', can_focus: true, track_hover: true});
        panel.add_child(this._entry);
        this._grid = box(true, {style_class: 'tile-switcher-grid'});
        panel.add_child(this._grid);
        this._previewBox = box(false, {style_class: 'tile-switcher-preview'});
        panel.add_child(this._previewBox);

        this._entry.clutter_text.connect('text-changed', () => {
            this._visible = searchLayouts(this._entry.get_text());
            this._index = 0;
            this._render();
        });
        // Keys are looked at on their way down, before the text field takes them: arrows, Enter and Escape would otherwise be its own
        this._backdrop.connect('captured-event', (_a, event) => (event.type() === Clutter.EventType.KEY_PRESS ? this._key(event) : Clutter.EVENT_PROPAGATE));
        this._backdrop.connect('button-press-event', (_a, event) => {
            if (event.get_source() === this._backdrop)
                this.close();
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.uiGroup.add_child(this._backdrop);
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab) {   // another modal has the keyboard: not now
            this.close();
            return false;
        }
        this._render();
        global.stage.set_key_focus(this._entry);
        return true;
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        try {
            if (this._grab)
                Main.popModal(this._grab);
        } catch (_e) { /* already let go */ }
        this._backdrop?.destroy();
        this._backdrop = null;
        this._closedCallback?.();
    }

    _key(event) {
        const symbol = event.get_key_symbol();
        const n = this._visible.length;
        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return: case Clutter.KEY_KP_Enter: case Clutter.KEY_ISO_Enter:
            this._choose(this._index);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            if (n) this._index = (this._index + 1) % n;
            break;
        case Clutter.KEY_Left:
            if (n) this._index = (this._index - 1 + n) % n;
            break;
        case Clutter.KEY_Down:
            if (n) this._index = Math.min(n - 1, this._index + COLUMNS);
            break;
        case Clutter.KEY_Up:
            if (n) this._index = Math.max(0, this._index - COLUMNS);
            break;
        case Clutter.KEY_Tab:
            if (n) this._index = (this._index + 1) % n;
            break;
        default:
            return Clutter.EVENT_PROPAGATE;   // typing goes to the search box
        }
        this._render();
        return Clutter.EVENT_STOP;
    }

    _choose(index) {
        const layout = this._visible[index];
        if (!layout)
            return;
        this.close();
        this._apply(layout[0]);
    }

    _render() {
        this._grid.destroy_all_children();
        if (!this._visible.length) {
            this._grid.add_child(new St.Label({text: 'No layout matches', style_class: 'tile-switcher-empty'}));
        } else {
            let row = null;
            this._visible.forEach(([id, title], i) => {
                if (i % COLUMNS === 0) {
                    row = box(false, {style_class: 'tile-switcher-row'});
                    this._grid.add_child(row);
                }
                const card = new St.Button({style_class: 'tile-switcher-card', reactive: true, can_focus: false, track_hover: true, accessible_name: title});
                if (i === this._index)
                    card.add_style_class_name('selected');
                if (id === this._current)
                    card.add_style_class_name('current');
                const inner = box(true, {style_class: 'tile-switcher-card-inner'});
                inner.add_child(diagram(id, 104, 66, i === this._index));
                inner.add_child(new St.Label({text: title, style_class: 'tile-switcher-card-title'}));
                card.set_child(inner);
                card.connect('clicked', () => this._choose(i));
                card.connect('notify::hover', () => {
                    if (card.hover && this._index !== i) {
                        this._index = i;
                        this._render();
                    }
                });
                row.add_child(card);
            });
        }
        this._previewBox.destroy_all_children();
        const pick = this._visible[this._index];
        if (pick) {
            this._previewBox.add_child(diagram(pick[0], 190, 118, true));
            const text = box(true, {style_class: 'tile-switcher-preview-text', y_align: Clutter.ActorAlign.CENTER});
            text.add_child(new St.Label({text: pick[1], style_class: 'tile-switcher-preview-title'}));
            const note = new St.Label({text: pick[2], style_class: 'tile-switcher-preview-note'});
            note.clutter_text.line_wrap = true;
            text.add_child(note);
            text.add_child(new St.Label({text: `Enter applies it to workspace ${this._workspace}${pick[0] === this._current ? ' (in use now)' : ''}`, style_class: 'tile-switcher-preview-hint'}));
            this._previewBox.add_child(text);
        }
    }
}
