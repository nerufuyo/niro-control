// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Niro the slime as a widget. It is drawn only while it moves: when it is calm nothing runs at all, only one wake-up for the next
// blink, glance or act; when it is not on screen, or animations are off in GNOME, not even that. See slime.js for its manners.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {onUiScale} from './compat.js';
import {Slime} from './slime.js';
import {drawSlime} from './slimeDraw.js';
import {motionOn} from './motion.js';

/** The most a stretch of sleep is made up for when it wakes (s); the slime's own steps are shorter still. */
const MAX_CATCH_UP = 5;

export const SlimeView = GObject.registerClass(
class SlimeView extends St.DrawingArea {
    /** `size` in CSS pixels. */
    _init(size, {seed = (Math.random() * 1e6) | 0, mood = 'idle'} = {}) {
        super._init({reactive: true, track_hover: false, accessible_role: 1 /* IMG */, accessible_name: 'Niro, the mascot'});
        this._size = size;
        this._slime = new Slime(seed);
        this._slime.setMood(mood);
        this._source = 0;
        this._last = 0;
        this._paused = false;
        /** How many frames were drawn, and how often the driver ran, and how long drawing took (ms), for the tests. */
        this.frames = 0;
        this.drives = 0;
        this.paintMs = 0;
        onUiScale(this, scale => this.set_size(this._size * scale, this._size * scale));
        this.connect('repaint', area => this._paint(area));
        this.connect('notify::mapped', () => this._drive());
        this.connect('button-press-event', () => {
            this.boing();
            return Clutter.EVENT_STOP;
        });
        const settings = St.Settings.get();
        this._animationsId = settings.connect('notify::enable-animations', () => this._drive());
        this.connect('destroy', () => {
            this._stop();
            settings.disconnect(this._animationsId);
        });
        this._drive();
    }

    get slime() {
        return this._slime;
    }

    get mood() {
        return this._slime.mood;
    }

    set mood(mood) {
        if (mood === this._slime.mood)
            return;
        this._slime.setMood(mood);
        this._drive();
    }

    /** Held still while off screen (a page that is not the one shown), though it is mapped. */
    set paused(paused) {
        if (this._paused === paused)
            return;
        this._paused = paused;
        this._drive();
    }

    /** Something happened: it wakes if it dozed. */
    poke() {
        this._slime.poke();
        this._drive();
    }

    /** A little knock and a hop: poke it and it boings. */
    boing() {
        this._slime.poke();
        this._slime.jolt(-6);
        this._slime.hop(210);
        this._drive();
    }

    /** Plays one of its idle acts now, if it is calm. */
    act(name) {
        this._slime.startAct(name);
        this._drive();
    }

    _animated() {
        return motionOn() && this.mapped && !this._paused;
    }

    _stop() {
        if (this._source) {
            GLib.source_remove(this._source);
            this._source = 0;
        }
    }

    /** Draws now, and sleeps until it needs drawing again: soon if it moves, at its next wake-up if it is calm, never if it cannot be seen. */
    _drive() {
        this.drives++;
        this._stop();
        if (!this._animated()) {
            // Animations off or out of sight: settle where it is going, so it is drawn right when it is seen again.
            this._slime.step(3);
            this._last = 0;
            this.queue_repaint();
            return;
        }
        const now = GLib.get_monotonic_time();
        if (this._last)
            this._slime.step(Math.min((now - this._last) / 1e6, MAX_CATCH_UP));
        this._last = now;
        this.queue_repaint();
        const wait = this._slime.needsFrames() ? this._slime.frameIntervalMs() : this._slime.nextWakeMs();
        if (!Number.isFinite(wait)) {
            this._last = 0;
            return;
        }
        this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(wait), () => {
            this._source = 0;
            this._drive();
            return GLib.SOURCE_REMOVE;
        });
        if (!this._slime.needsFrames())
            this._last = now;   // asleep in between: what passes is caught up on waking
    }

    _paint(area) {
        const started = GLib.get_monotonic_time();
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        drawSlime(cr, this._slime.frame(), Math.min(width, height));
        cr.$dispose();
        this.frames++;
        this.paintMs += (GLib.get_monotonic_time() - started) / 1000;
    }
});
