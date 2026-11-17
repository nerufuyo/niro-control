// @ts-nocheck: converted from JavaScript; types are added file by file
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Niro Device page: the assistants (a screen, a microphone and a speaker) paired with this Niro. Add one (island-daemon
// makes a six-digit code, shown here to type on the device), allow it when it asks, see which are online and their battery,
// forget one. The code is only handed over once, by `StartPairing`, so it is kept here while it lasts. Off until its switch in
// Settings is on. It changes only as island-daemon's state does.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {CODE_KEEP_MS, codeKept, deviceStatus, formatCode, formatLeft} from '../niroDeviceRules.js';
import {iconButton, label, pillButton} from '../widgets.js';
import {Page} from './page.js';

export const NiroDevicePage = GObject.registerClass(
class NiroDevicePage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'island-page island-nd-page',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'niro';
        /** The code `StartPairing` returned, while it is open; it is not in any property. */
        this._code = null;
        /** Until when it is worth keeping, and whether island-daemon has said it is open (see `codeKept`). */
        this._codeUntil = 0;
        this._codeSeenOpen = false;
        this._shown = '';

        const column = new St.BoxLayout({...VERTICAL, style_class: 'island-nd', x_expand: true, y_expand: true});
        const header = new St.BoxLayout({style_class: 'island-nd-header'});
        header.add_child(label('Niro Device', 'island-nd-title', {x_expand: true}));
        this._action = pillButton('Add a device', 'island-pill-small', () => this._toggle());
        header.add_child(this._action);
        column.add_child(header);

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'island-nd-list'});
        const scroll = new St.ScrollView({
            style_class: 'island-nd-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._list);
        column.add_child(scroll);
        this.add_child(column);

        this.watch(['niroDevices', 'niroPairing', 'niroRequest'], () => this._update());
        this._update();
    }

    /** A device waits for the answer: the tab shows a dot, and this is the page to open. */
    get hasNews() {
        return Boolean(this.daemon.state.niroRequest?.pending);
    }

    get relevant() {
        return this.hasNews || Boolean(this.daemon.state.niroPairing?.active);
    }

    onActivate() {
        this._tick();
    }

    /** Add a device, or give the code up. */
    async _toggle() {
        if (this.daemon.state.niroPairing?.active) {
            this._code = null;
            await this.daemon.call('niroDevices', 'CancelPairing');
            return;
        }
        // The code comes back once; island-daemon says by the property that one is open.
        // A method's out arguments come back as an array: the code is its first.
        const result = await this.daemon.call('niroDevices', 'StartPairing');
        this._code = Array.isArray(result) && typeof result[0] === 'string' ? result[0] : null;
        this._codeUntil = Date.now() + CODE_KEEP_MS;
        this._codeSeenOpen = false;
        this._update(true);
    }

    /** The countdown, once a second while the page shows a code. */
    _tick() {
        const pairing = this.daemon.state.niroPairing;
        if (!pairing?.active || !this._code) {
            this.cancel('tick');
            return;
        }
        if (this._countdown)
            this._countdown.text = `${formatLeft((pairing.expires_at_ms - Date.now()) / 1000)} left`;
        this.later('tick', 1000, () => this._tick());
    }

    /** Rebuilt only when what it shows changed, so a button under the pointer is not replaced each time. */
    _update(force = false) {
        const {niroDevices, niroPairing, niroRequest} = this.daemon.state;
        const devices = niroDevices ?? [];
        const pairing = niroPairing ?? {active: false};
        const request = niroRequest ?? {pending: false};
        // A code that ended (its time, its tries, a device paired) is not shown any more; one not yet said to be
        // open is kept (see `codeKept`).
        ({code: this._code, seenOpen: this._codeSeenOpen} = codeKept({
            code: this._code, seenOpen: this._codeSeenOpen, open: Boolean(pairing.active), now: Date.now(), until: this._codeUntil,
        }));
        const shown = JSON.stringify([devices, pairing.active, request, this._code]);
        if (shown === this._shown && !force)
            return;
        this._shown = shown;

        this._action.label = pairing.active ? 'Cancel' : 'Add a device';
        this._list.destroy_all_children();
        this._countdown = null;

        if (request.pending)
            this._list.add_child(this._requestCard(request));
        if (pairing.active)
            this._list.add_child(this._codeCard(pairing));
        for (const device of devices)
            this._list.add_child(this._deviceRow(device));
        if (!devices.length && !pairing.active && !request.pending) {
            const note = label('No device yet. Add one to ask and be told from your desk.', 'island-nd-note',
                {x_expand: true, y_align: Clutter.ActorAlign.START});
            note.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR});
            this._list.add_child(note);
        }
        this._tick();
        this.emit('news-changed');
    }

    /** The code to type on the device, and how long it has. */
    _codeCard(pairing) {
        const card = new St.BoxLayout({...VERTICAL, style_class: 'island-nd-card'});
        if (this._code) {
            card.add_child(label(formatCode(this._code), 'island-nd-code', {x_align: Clutter.ActorAlign.START}));
            const line = new St.BoxLayout({style_class: 'island-nd-line'});
            line.add_child(label('Type it on the device', 'island-nd-hint', {x_expand: true}));
            this._countdown = label(`${formatLeft((pairing.expires_at_ms - Date.now()) / 1000)} left`, 'island-nd-hint');
            line.add_child(this._countdown);
            card.add_child(line);
        } else {
            // The code is handed over once; after the island restarted, a new one is the way.
            card.add_child(label('A code is open, but it is not shown here. Cancel, then add again.', 'island-nd-hint'));
        }
        return card;
    }

    /** A device that typed the right code asks to be let in. */
    _requestCard(request) {
        const card = new St.BoxLayout({...VERTICAL, style_class: 'island-nd-card island-nd-ask'});
        const title = label(`${request.name} wants to pair`, 'island-nd-name', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        card.add_child(title);
        card.add_child(label(request.device_id, 'island-nd-hint'));
        const buttons = new St.BoxLayout({style_class: 'island-nd-buttons', x_align: Clutter.ActorAlign.END});
        buttons.add_child(pillButton('Deny', 'island-pill-small', () => this.daemon.call('niroDevices', 'Answer', false)));
        buttons.add_child(pillButton('Allow', 'island-pill-small island-nd-allow', () => this.daemon.call('niroDevices', 'Answer', true)));
        card.add_child(buttons);
        return card;
    }

    /** A paired device: whether it is here, its battery, and a way to forget it. */
    _deviceRow(device) {
        const row = new St.BoxLayout({style_class: `island-nd-row${device.online ? ' online' : ''}`});
        row.add_child(new St.Widget({style_class: 'island-nd-dot', y_align: Clutter.ActorAlign.CENTER}));
        const words = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const name = label(device.name, 'island-nd-name');
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        words.add_child(name);
        words.add_child(label(deviceStatus(device), 'island-nd-hint'));
        row.add_child(words);
        row.add_child(iconButton('island-close-symbolic', 'island-nd-forget',
            () => this.daemon.call('niroDevices', 'Forget', device.device_id),
            {size: 12, accessibleName: `Forget ${device.name}`}));
        return row;
    }
});
