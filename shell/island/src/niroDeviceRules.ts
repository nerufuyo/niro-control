// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// What the Niro Device page says of a code and of a device, kept apart from GNOME so tests run it anywhere (tests/).

/** "123456" as "123 456", to read and type in two halves; anything else as it is. */
export function formatCode(code) {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Seconds as "1:47", rounded up (the last second shows as 0:01, never 0:00 early), never below 0:00. */
export function formatLeft(seconds) {
    const left = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** What a device's row says under its name: whether it is here, and its battery when it said. */
export function deviceStatus(device) {
    if (!device.online)
        return 'Offline';
    const battery = device.status?.battery;
    // A device that does not read its battery says 255.
    if (typeof battery !== 'number' || battery > 100)
        return 'Online';
    return `Online · ${battery}%${device.status.charging ? ' · charging' : ''}`;
}

/** How long the page keeps a code: its two minutes and a little over, for the clocks of two processes. */
export const CODE_KEEP_MS = 125000;

/** Whether the code the page keeps is still worth showing. `StartPairing` hands the code over before the property that says
 * a code is open reaches the island, so a code not yet open does not end it; one that was open and no longer is (used, run out,
 * cancelled elsewhere) does, and so does its time. Gives the code to keep and whether it has been seen open. */
export function codeKept({code, seenOpen, open, now, until}) {
    if (!code || now > until)
        return {code: null, seenOpen: false};
    if (open)
        return {code, seenOpen: true};
    return seenOpen ? {code: null, seenOpen: false} : {code, seenOpen: false};
}
