// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// With the island on, GNOME's own top bar is not needed (the island has the clock, the calendar, the system and power
// pages, the notifications): this takes it away, so windows have the whole screen and the island stands alone at the top.
// Setting `hide-top-bar`.
//
// The bar is slid off the screen, not hidden: its buttons then still have a place (Quick Settings on Super+S, the calendar and
// the menus of other extensions anchor to them), and it is not under the pointer. GNOME reserves the room for it in windows'
// work area from where the bar is and how big (`LayoutManager._updateRegions` does not look at whether it is shown), so it
// is also taken out of the struts, and put back as it was.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class BarHider {
    /** `onChange` is called after the bar went or came back (the island lays itself out again). */
    constructor(settings, onChange = () => {}) {
        this._settings = settings;
        this._onChange = onChange;
        this._hidden = false;
        this._changed = settings.connect('changed::hide-top-bar', () => this.sync(true));
        this.sync(false);
    }

    /** Whether the bar is away now. */
    get hidden() {
        return this._hidden;
    }

    /** Takes the bar away or brings it back as the setting says; `animate` slides it. */
    sync(animate = true) {
        const wanted = this._settings.get_boolean('hide-top-bar');
        if (wanted === this._hidden)
            return;
        if (wanted)
            this._hide(animate);
        else
            this._show(animate);
    }

    _hide(animate) {
        const box = Main.layoutManager.panelBox;
        this._hidden = true;
        // No room reserved for it in the work area; it still goes away with a full-screen window as before.
        Main.layoutManager.untrackChrome(box);
        Main.layoutManager.trackChrome(box, {affectsStruts: false, trackFullscreen: true});
        // The bar's height may change (scale, another style): it stays out.
        this._heightId = box.connect('notify::height', () => {
            if (this._hidden)
                box.translation_y = -box.height;
        });
        this._slide(-box.height, animate, Clutter.AnimationMode.EASE_IN_QUAD);
    }

    _show(animate) {
        const box = Main.layoutManager.panelBox;
        this._hidden = false;
        if (this._heightId) {
            box.disconnect(this._heightId);
            this._heightId = 0;
        }
        Main.layoutManager.untrackChrome(box);
        Main.layoutManager.trackChrome(box, {affectsStruts: true, trackFullscreen: true});
        this._slide(0, animate, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    _slide(to, animate, mode) {
        const box = Main.layoutManager.panelBox;
        box.remove_all_transitions();
        const done = () => {
            Main.layoutManager._queueUpdateRegions?.();
            this._onChange();
        };
        if (!animate || box.translation_y === to) {
            box.translation_y = to;
            done();
            return;
        }
        box.ease({translation_y: to, duration: 220, mode, onStopped: done});
    }

    /** The bar as GNOME has it (the island is going, or the setting is off). */
    destroy() {
        this._settings.disconnect(this._changed);
        if (this._hidden)
            this._show(false);
    }
}
