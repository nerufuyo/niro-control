// @ts-nocheck: written for the island, which is not typed yet
// SPDX-License-Identifier: GPL-3.0-or-later

// What the Power and Controls pages say about the battery and the Wi-Fi, kept apart from GNOME so tests run it anywhere (tests/).

/** UPower's `State` as the island names it: 1 charging, 2 discharging, 4 fully charged, 5 waiting to charge and 6 waiting to
 * discharge (plugged in or not, but not moving); 3 (empty) counts as discharging. 'unknown' for 0 or anything new. */
export function batteryState(code) {
    switch (code) {
    case 1:
        return 'charging';
    case 2:
    case 3:
        return 'discharging';
    case 4:
        return 'full';
    case 5:
    case 6:
        return 'idle';
    default:
        return 'unknown';
    }
}

/** Whether the charger is in: charging, full, or held (a charge limit, a pause). */
export function pluggedIn(state) {
    return state === 'charging' || state === 'full' || state === 'idle';
}

/** "1 h 05 min", "45 min", "under a minute"; '' when UPower does not know (0 or less). */
export function durationText(seconds) {
    if (!(seconds > 0))
        return '';
    const minutes = Math.round(seconds / 60);
    if (minutes < 1)
        return 'under a minute';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours)
        return `${rest} min`;
    return `${hours} h ${String(rest).padStart(2, '0')} min`;
}

/** The two lines a battery card shows: {title, detail}. `battery` is {state, percent, timeToFull, timeToEmpty} (seconds). */
export function batteryStatus(battery) {
    const {state, timeToFull, timeToEmpty} = battery;
    switch (state) {
    case 'charging': {
        const left = durationText(timeToFull);
        return {title: 'Charging', detail: left ? `${left} until full` : 'Estimating…'};
    }
    case 'discharging': {
        const left = durationText(timeToEmpty);
        return {title: 'On battery', detail: left ? `${left} left` : 'Estimating…'};
    }
    case 'full':
        return {title: 'Fully charged', detail: 'Plugged in'};
    case 'idle':
        return {title: 'Plugged in', detail: 'Not charging'};
    default:
        return {title: 'Battery', detail: ''};
    }
}

/** The colour the level reads in: 'low' at or under `low` percent on battery, 'charging' while charging, else 'normal'. */
export function batteryTone(percent, state, low = 20) {
    if (state === 'charging' || state === 'full')
        return 'charging';
    return state === 'discharging' && percent <= low ? 'low' : 'normal';
}

/** "Health 92%" from the battery's capacity against its design (UPower's `Capacity`); '' when it is not known. */
export function healthText(capacity) {
    return capacity > 0 ? `Health ${Math.round(Math.min(capacity, 100))}%` : '';
}

/** "8.4 W" for the power moving in or out (UPower's `EnergyRate`); '' when idle or unknown. */
export function rateText(watts) {
    return watts >= 0.1 ? `${watts.toFixed(1)} W` : '';
}

/** The small print under the status: health and power joined, whatever is known. */
export function batteryFacts(battery) {
    return [healthText(battery.health), rateText(battery.rate)].filter(Boolean).join(' · ');
}

// ---- Wi-Fi

/** Networks from `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`: one per name, the connected one or the strongest,
 * connected first and then by signal. Names without a name (hidden networks) are left out. */
export function parseWifiList(text) {
    const seen = new Map();
    for (const line of (text ?? '').split('\n')) {
        // nmcli escapes ':' inside a field as '\:'.
        const fields = line.split(/(?<!\\):/).map(field => field.replace(/\\:/g, ':'));
        const [inUse, ssid, signal, security] = fields;
        if (!ssid)
            continue;
        const entry = {ssid, signal: Number(signal) || 0, secure: Boolean(security && security !== '--'), active: inUse === '*'};
        const known = seen.get(ssid);
        if (!known || entry.active || (!known.active && entry.signal > known.signal))
            seen.set(ssid, entry);
    }
    return [...seen.values()].sort((a, b) => b.active - a.active || b.signal - a.signal);
}

/** What went wrong in nmcli's message, in words for the page: {wrongPassword, message}. A refused password reads as
 * "Secrets were required" or an activation that failed with code 7 or 4; anything else gives nmcli's own last line. */
export function wifiFailure(stderr) {
    const text = String(stderr ?? '').trim();
    const wrongPassword = /secrets were required|wrong password|\(7\)|\(4\)|802\.1x supplicant failed/i.test(text);
    const last = text.split('\n').filter(Boolean).pop() ?? '';
    return {
        wrongPassword,
        message: wrongPassword ? 'Wrong password' : last.replace(/^Error:\s*/i, '') || 'Could not connect',
    };
}

/** How strongly a network shows: 0..3 bars from its signal percentage. */
export function signalBars(signal) {
    if (signal >= 75)
        return 3;
    if (signal >= 50)
        return 2;
    return signal >= 25 ? 1 : 0;
}

/** The power profiles in the order the Power page offers them, whichever the computer has. */
export const PROFILE_ORDER = ['power-saver', 'balanced', 'performance'];
export const PROFILE_NAMES = {'power-saver': 'Power Saver', 'balanced': 'Balanced', 'performance': 'Performance'};

export function orderedProfiles(profiles) {
    return PROFILE_ORDER.filter(name => profiles.includes(name)).concat(profiles.filter(name => !PROFILE_ORDER.includes(name)));
}
