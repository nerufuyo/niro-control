// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// What mood the Niro Device page's slime is in, from what island-daemon says of the devices, kept apart from GNOME so tests run it
// anywhere (tests/). Cases, in the order they are looked at: a device asking to pair (alert: it needs you), a code open (listening:
// it waits for the device to type it), no device yet (curious), a device whose battery is low (sleepy: it is tired too), devices
// but none here (sad), and otherwise calm. And two short greetings: happy when a device comes online, in love when one is paired.

/** A battery at or below this is low (a device that does not read it says 255: unknown). */
export const LOW_BATTERY = 15;
/** How long a greeting lasts (ms). */
export const GREETING_MS = 4000;

/** What matters of the state, in a few facts. */
export function summarize({devices, pairing, request} = {}) {
    const list = Array.isArray(devices) ? devices : [];
    const online = list.filter(device => device?.online);
    return {
        count: list.length,
        online: online.length > 0,
        low: online.some(device => typeof device.status?.battery === 'number' && device.status.battery <= LOW_BATTERY),
        pairing: Boolean(pairing?.active),
        asking: Boolean(request?.pending),
    };
}

/** The mood that goes with the facts, when no greeting is on. */
export function baseMood(facts) {
    if (facts.asking)
        return 'alert';
    if (facts.pairing)
        return 'listening';
    if (facts.count === 0)
        return 'curious';
    if (!facts.online)
        return 'sad';
    return facts.low ? 'sleepy' : 'idle';
}

/** A short greeting for what just changed, or null: a device paired (love) or one came online (happy). */
export function greetingFor(before, now) {
    if (!before)
        return null;
    if (now.count > before.count && (before.pairing || before.asking))
        return 'love';
    if (!before.online && now.online && now.count > 0)
        return 'happy';
    return null;
}
