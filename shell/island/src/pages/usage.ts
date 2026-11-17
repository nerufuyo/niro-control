// @ts-nocheck: converted from JavaScript; types are added file by file
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Usage: how much of each AI plan's limits is used (Claude, ChatGPT as Codex saw it, opencode's Go plan, Grok), a bar per
// limit, and the balance left on a DeepSeek API account (no limits: its card says the money). Every provider is a column
// side by side, so all of it is in view at once; no tab without any.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import * as Palette from '../palette.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** A limit warns (an alert) and then turns red at these shares; Settings may move them (see `setMarks`). */
const MARKS = {warn: 80, critical: 95};
/** Each provider's colour, for its bars. */
const ACCENTS = {claude: [0.85, 0.47, 0.34], codex: [0.06, 0.64, 0.5], grok: [0.93, 0.94, 0.96], deepseek: [0.3, 0.42, 1], opencode: [0.2, 0.78, 0.68]};
const FALLBACK = Palette.BLUE;
/** How long the bars take to fill. */
const FILL_MS = 500;

/** RGB 0..1 as a CSS colour. */
const css = ([r, g, b], alpha = 1) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;

/** Each provider's logo (icons/), shown by its name. */
const LOGOS = {claude: 'island-claude', codex: 'island-openai', grok: 'island-grok'};

/** The provider's logo, or a dot of its colour for one without. */
function mark(id) {
    if (LOGOS[id])
        return new St.Icon({gicon: icon(LOGOS[id]), icon_size: 18, style_class: 'island-usage-logo', y_align: Clutter.ActorAlign.CENTER});
    const dot = new St.Widget({style_class: 'island-usage-mark', y_align: Clutter.ActorAlign.CENTER});
    dot.style = `background-color: ${css(ACCENTS[id] ?? FALLBACK)};`;
    return dot;
}

// A limit's bar: the fill is `share` (0..1) of the width, times `sweep` as it grows in.
const Bar = GObject.registerClass({
    Properties: {
        'sweep': GObject.ParamSpec.double('sweep', null, null, GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class Bar extends St.Widget {
    /** `level` is 'normal', 'warn' or 'critical'. */
    _init(share, level, accent) {
        super._init({style_class: 'island-usage-track', x_expand: true});
        this._share = share;
        this._sweep = 1;
        this._fill = new St.Widget({style_class: `island-usage-fill ${level}`});
        // In the plan's colour until nearly used up, then red.
        if (level !== 'critical')
            this._fill.style = `background-color: ${css(accent)};`;
        this.add_child(this._fill);
    }

    /** 0..1, eased by `_fill`. */
    get sweep() {
        return this._sweep;
    }

    /** Lays the fill out again on every step. */
    set sweep(value) {
        this._sweep = value;
        this.notify('sweep');
        this.queue_relayout();
    }

    /** Fill width from share and sweep, never less than a round sliver. */
    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = box.get_size();
        // A sliver shows even at 1%.
        const filled = this._share > 0 ? Math.max(height, width * this._share * this._sweep) : 0;
        const fill = new Clutter.ActorBox();
        fill.set_origin(0, 0);
        fill.set_size(Math.round(filled), height);
        this._fill.allocate(fill);
    }
});

/** Left to right, whichever the daemon lists first: the order people read them in; any other after these. */
const ORDER = ['claude', 'deepseek', 'codex', 'opencode', 'grok'];

/** The most limits a card has room for (Claude's week and its model's, ChatGPT's two, opencode Go's three). */
const MAX_LIMITS = 3;
/** The page's own height, in CSS pixels: enough for a card with three limits, which the usual 150 is not. */
export const USAGE_HEIGHT = 226;

// The Usage page: every provider side by side, a column each (up to five), so all the numbers are in view at once with
// nothing to scroll.
export const UsagePage = GObject.registerClass(
class UsagePage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'island-page island-usage',
            layout_manager: new Clutter.BinLayout(),
            height: Math.max(height, USAGE_HEIGHT),
            reactive: true,
        });
        this.name = 'usage';
        this._marks = {...MARKS};
        this._bars = [];
        this._stamps = [];
        this._resetLabels = [];

        // Equal columns: a grid whose columns share the width.
        this._layout = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 10});
        this._grid = new St.Widget({layout_manager: this._layout, x_expand: true, y_expand: true});
        this.add_child(this._grid);

        this.watch(['usage'], () => this._update());
        this._update();
    }

    get minHeight() {
        return USAGE_HEIGHT;
    }

    /** As island-daemon last read them, in reading order. */
    _providers() {
        const rank = provider => {
            const at = ORDER.indexOf(provider.id);
            return at < 0 ? ORDER.length : at;
        };
        return [...(this.daemon.state.usage?.providers ?? [])].sort((a, b) => rank(a) - rank(b));
    }

    /** Only with a provider found (Claude Code or Codex signed in) and usage turned on. */
    get available() {
        return this._providers().length > 0;
    }

    /** The shares at which a bar warns, from Settings. */
    setMarks(warn, critical) {
        this._marks = {warn, critical};
        this._update();
    }

    /** Asks for fresh numbers and grows the bars in. */
    onActivate() {
        // Fresh numbers when looked at; island-daemon asks Claude at most every two minutes.
        this.daemon.call('usage', 'Refresh');
        this._update();
        this._fill();
    }

    /** Island's 12/24-hour setting changed: "Updated 20:40" as it says now, while on show. */
    clockChanged() {
        if (this.active)
            this._update();
    }

    /** Rebuilds the columns if what they show changed, else just their times. */
    _update() {
        const available = this.available;
        if (available !== this._wasAvailable) {
            this._wasAvailable = available;
            this.emit('availability-changed');
        }
        const providers = this._providers();
        // Built anew only when what is shown changed; else the times move on in place.
        const key = JSON.stringify([providers.map(({updated_ms: _at, ...rest}) => rest), this._marks]);
        if (key !== this._key) {
            this._key = key;
            this._grid.destroy_all_children();
            this._bars = [];
            this._stamps = [];
            this._resetLabels = [];
            providers.forEach((provider, column) => this._layout.attach(this._column(provider), column, 0, 1, 1));
        } else {
            this._retime(providers);
        }
        // Fresh numbers arriving as the bars grow in: the new bars carry on growing, never jump to full.
        const filled = this._filled();
        if (filled < 1)
            this._fill(filled);
        // "resets in 12m" counts down while it is on screen.
        if (this.active)
            this.later('minute', 60000, () => this._update());
    }

    /** The bars grow in from `from` (0..1 of the way) over what is left of the fill. */
    _fill(from = 0) {
        this._fillStart = GLib.get_monotonic_time() - from * FILL_MS * 1000;
        for (const bar of this._bars) {
            bar.sweep = from;
            bar.ease_property('sweep', 1, {duration: FILL_MS * (1 - from), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
    }

    /** How far the fill in progress has come (0..1), or 1 with none. */
    _filled() {
        const elapsed = (GLib.get_monotonic_time() - (this._fillStart ?? 0)) / 1000;
        return Math.min(1, elapsed / FILL_MS);
    }

    /** Brings "Updated 14:32" and "resets in 12m" up to date. */
    _retime(providers) {
        for (const [stamp, id] of this._stamps) {
            const provider = providers.find(entry => entry.id === id);
            const fromCodex = provider?.note?.startsWith('As of');
            if (provider && (!provider.note || fromCodex))
                stamp.text = updated(provider.updated_ms, fromCodex);
        }
        this._resetLabels.forEach(([reset, ms]) => (reset.text = resets(ms)));
    }

    /** One provider's column: its logo, name and plan, up to three limits (each a name and share, a bar, and when it
     * starts over), and at the foot how fresh the numbers are, or what is wrong. */
    _column(provider) {
        const accent = ACCENTS[provider.id] ?? FALLBACK;
        const column = new St.BoxLayout({...VERTICAL, style_class: 'island-usage-col', x_expand: true, y_expand: true});

        const head = new St.BoxLayout({style_class: 'island-usage-head'});
        head.add_child(mark(provider.id));
        const name = label(provider.name, 'island-usage-name');
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        head.add_child(name);
        column.add_child(head);
        if (provider.plan)
            column.add_child(label(provider.plan, 'island-usage-plan', {x_align: Clutter.ActorAlign.START}));

        const limits = new St.BoxLayout({...VERTICAL, style_class: 'island-usage-limits', y_expand: true});
        for (const window of provider.windows.slice(0, MAX_LIMITS))
            limits.add_child(this._limit(window, accent));
        if (provider.windows.length === 0) {
            const note = label(provider.empty || 'No limits reported yet', 'island-usage-empty');
            // A balance in two currencies, or where to put the key, is longer than the column is wide.
            note.clutter_text.line_wrap = true;
            note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            limits.add_child(note);
        }
        column.add_child(limits);

        const fromCodex = provider.note?.startsWith('As of');
        const warning = provider.note && !fromCodex;
        const stamp = label(warning ? provider.note : updated(provider.updated_ms, fromCodex),
            `island-usage-stamp${warning ? ' warning' : ''}`, {x_align: Clutter.ActorAlign.START});
        stamp.clutter_text.line_wrap = Boolean(warning);
        stamp.clutter_text.ellipsize = warning ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        this._stamps.push([stamp, provider.id]);
        column.add_child(stamp);
        return column;
    }

    // A limit: its name and share on a line, the bar, and when it starts over under it.
    _limit({label: name, percent, resets_at_ms: resetsAt}, accent) {
        const used = Math.max(0, Math.min(100, percent));
        // Its colour from the number shown: "80%" is never left white for a 79.6.
        const shown = Math.round(used);
        const level = shown >= this._marks.critical ? 'critical' : shown >= this._marks.warn ? 'warn' : 'normal';
        const limit = new St.BoxLayout({...VERTICAL, style_class: 'island-usage-limit'});
        const line = new St.BoxLayout({style_class: 'island-usage-line'});
        const title = label(name, 'island-usage-window', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        line.add_child(title);
        line.add_child(label(`${shown}%`, `island-usage-percent ${level}`));
        limit.add_child(line);

        const bar = new Bar(used / 100, level, accent);
        this._bars.push(bar);
        limit.add_child(bar);
        if (resetsAt > 0) {
            const reset = label(resets(resetsAt), 'island-usage-reset', {x_align: Clutter.ActorAlign.START});
            this._resetLabels.push([reset, resetsAt]);
            limit.add_child(reset);
        }
        return limit;
    }
});

/** "resets in 1h 20m", "resets in 2d 5h", "resets in 12m". */
function resets(ms) {
    const minutes = Math.max(0, Math.round((ms - Date.now()) / 60000));
    if (minutes < 1)
        return 'resets soon';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0)
        return hours ? `resets in ${days}d ${hours}h` : `resets in ${days}d`;
    if (hours > 0)
        return minutes % 60 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${hours}h`;
    return `resets in ${minutes}m`;
}

/** "Updated 14:32", or "From Codex, 14:32" for numbers as of Codex's last use; on another day, with its name. */
function updated(ms, fromCodex) {
    if (!ms)
        return '';
    const at = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const today = GLib.DateTime.new_now_local().format('%F') === at.format('%F');
    const when = today ? Format.timeOfDay(at) : `${at.format('%a')} ${Format.timeOfDay(at)}`;
    return fromCodex ? `From Codex, ${when}` : `Updated ${when}`;
}
