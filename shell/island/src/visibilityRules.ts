// @ts-nocheck: converted from JavaScript; types are added file by file
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// When the closed island auto-hides: no GNOME imports, so it can be tested without a shell.

/** When the closed island on screen hides ('now', 'later' after Settings' wait, or false) for `mode` (off, always,
 * top-bar or windows); at once over a full-screen app, which it shows only for alerts. */
export function autoHide({mode, presentation, visible, hovered, fullscreen, barHidden, windowAtTop, overview = false, fullscreenReveal = false}) {
    if (!visible || presentation !== 'compact')
        return false;
    // The Overview (Super) has the whole top for its own search: the closed island steps out of it, and returns with it.
    if (overview)
        return 'now';
    // Over a full-screen app it stays away, but for the pointer at the top (when Settings allow): it shows while the pointer is on it.
    if (fullscreen)
        return fullscreenReveal && hovered ? false : 'now';
    if (mode === 'top-bar' && barHidden)
        return 'now';
    if (hovered)
        return false;
    if (mode === 'always' || (mode === 'windows' && windowAtTop))
        return 'later';
    return false;
}

/** How much of the hidden island's top takes the pointer to bring it back, in px: none over a full-screen app or
 * with a hidden bar (that bar comes back first), else the bar's band, or `edge` at a display's top. */
export function revealBand({mode, fullscreen, barHeight, edge, overview = false, fullscreenReveal = false}) {
    if (overview)
        return 0;
    if (fullscreen)
        return fullscreenReveal ? edge : 0;
    if (mode === 'top-bar')
        return 0;
    return Math.max(barHeight, edge);
}
