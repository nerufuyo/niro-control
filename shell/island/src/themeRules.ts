// The times of the light/dark schedule, kept apart from GJS so tests can run them (tests/).

/** "07:30" as minutes after midnight, or `fallback` for anything else. */
export function minutesOf(text: string, fallback: number): number {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text ?? '');
    if (!m) return fallback;
    const h = +m[1], mi = +m[2];
    return h > 23 || mi > 59 ? fallback : h * 60 + mi;
}

/** Whether `minute` (after midnight) is in the dark period that starts at `darkFrom` and lasts until `lightFrom`, over midnight if need be. */
export function isDarkAt(minute: number, lightFrom: number, darkFrom: number): boolean {
    if (lightFrom === darkFrom) return false;
    return lightFrom < darkFrom ? minute >= darkFrom || minute < lightFrom : minute >= darkFrom && minute < lightFrom;
}


/** Whether `minute` is inside the quiet hours from `from` until `until` (over midnight if need be). */
export function isInside(minute: number, from: number, until: number): boolean {
    return isDarkAt(minute, until, from);
}
