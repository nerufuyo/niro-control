// @ts-nocheck: imports the plain-JS shared core, copied next to this file by the build (shared/tokens.js)
// Opt-in motion preset for the island's fades and slides. `dur(ms)` is the one place a hard-coded duration passes through: with the
// `motion-preset` setting "default" (or empty) it returns `ms` untouched; with a preset it scales it, and with "off" (or GNOME's
// "reduce animations" while a preset is chosen) it returns 0. Not covered, on purpose: the springs that size the island (layout and hit-testing follow them) and the voice meter's per-frame timeline
// (it carries the live level, not decoration). Loops and auto-hide/voice/chat transitions ask `motionOn()`.
import St from 'gi://St';
import {motionAllowed, scaleDuration} from './shared/tokens.js';
import {motionModeFor} from './surfaceMotion.js';

const KEY = 'motion-preset';
let settings = null;
let stSettings = null;
let ids = [];
let stId = 0;
let preset = '';
let reduced = false;
const refresh = () => {
    preset = settings?.get_string(KEY) ?? '';
    reduced = stSettings ? stSettings.enable_animations === false : false;
};

/** Starts following the setting and GNOME's animations switch. Call `release()` to stop. */
export function configure(gsettings) {
    release();
    settings = gsettings;
    stSettings = St.Settings.get();
    ids = [settings.connect(`changed::${KEY}`, refresh)];
    stId = stSettings.connect('notify::enable-animations', refresh);
    refresh();
}

export function release() {
    ids.forEach(id => settings?.disconnect(id));
    if (stId)
        stSettings?.disconnect(stId);
    ids = []; stId = 0; settings = null; stSettings = null; preset = ''; reduced = false;
}

/** False with preset 'off' or GNOME's reduce-animations (live read); with 'default' it is the plain animations check. */
export const motionOn = () => motionAllowed({preset, reduced: St.Settings.get().enable_animations === false});

/** `ms` for the chosen preset (see scaleDuration in shared/tokens.js). */
export const dur = ms => scaleDuration(ms, {preset, reduced});

/** 'off' (instant: preset "off" or GNOME's animations off), 'reduced' (the "minimal" preset: moves, never overshoots, no stagger) or 'full'
 * (see surfaceMotion.ts `motionModeFor`). The springs and the choreography read this; fades and slides read `dur()`. */
export const motionMode = () => motionModeFor({preset, reduced: St.Settings.get().enable_animations === false});
