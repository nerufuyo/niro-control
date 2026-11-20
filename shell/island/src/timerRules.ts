// @ts-nocheck: converted from JavaScript; types are added file by file
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The timer's typed lengths, kept apart so tests run it anywhere (tests/).

/** The minutes typed in `text`, kept to `min`..`max`; null when it holds no number. */
export function typedMinutes(text, min, max) {
    const trimmed = String(text).trim();
    if (!/^\d+$/.test(trimmed))
        return null;
    return Math.min(max, Math.max(min, Number.parseInt(trimmed, 10)));
}

/** A stopwatch reading: M:SS under an hour, H:MM:SS from there on. */
export function stopwatchText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const two = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A stopwatch: runs from `since` (a clock reading in ms) on top of what ran before; laps are the readings kept. */
export class Stopwatch {
    constructor() { this.reset(); }

    reset() { this.base = 0; this.since = null; this.laps = []; }

    get running() { return this.since !== null; }

    elapsed(now) { return this.base + (this.since === null ? 0 : Math.max(0, now - this.since)); }

    toggle(now) {
        if (this.since === null) {
            this.since = now;
        } else {
            this.base = this.elapsed(now);
            this.since = null;
        }
    }

    /** Keeps the reading as a lap (only while running); returns it. */
    lap(now) {
        if (this.since === null)
            return null;
        const total = this.elapsed(now);
        const last = this.laps.length ? this.laps[this.laps.length - 1].total : 0;
        const entry = {n: this.laps.length + 1, total, split: total - last};
        this.laps.push(entry);
        return entry;
    }
}
