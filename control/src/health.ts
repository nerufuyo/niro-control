// Settings health: what is wrong, what is only unknown, and where to go about it. Pure: homePage.ts gathers the facts.
// Rules: "healthy" is said only when it was checked; a fact that could not be read is "unavailable", never a green tick.

export type State = 'healthy' | 'attention' | 'recovery' | 'unavailable';
export type Action = {kind: 'go'; page: string; label: string} | {kind: 'recover'; label: string} | {kind: 'logout'; label: string};
export interface Row {id: string; title: string; state: State; detail: string; action?: Action}

export interface ExtensionFact {name: string; uuid: string; installed: boolean; /** GNOME Shell's ExtensionState, null when the shell was not asked or did not answer */ state: number | null; error?: string}
export interface Facts {
    extensions: ExtensionFact[];
    /** null: unknown */
    daemon: boolean | null;
    islandInstalled: boolean;
    profile: {id: string | null; name: string | null; missing: boolean; modified: number};
    interrupted: {label: string} | null;
    stale: string[];
    unreachableSettings: number;
    configProblems: string[];
}

// GNOME Shell's ExtensionState values
const ACTIVE = 1, INACTIVE = 2, ERROR = 3, OUT_OF_DATE = 4, INITIALIZED = 6;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const join = (xs: string[]) => xs.join(', ');

export function extensionsRow(list: ExtensionFact[]): Row {
    const missing = list.filter(e => !e.installed);
    const known = list.filter(e => e.installed);
    const broken = known.filter(e => e.state === ERROR || e.state === OUT_OF_DATE);
    const off = known.filter(e => e.state === INACTIVE || e.state === INITIALIZED);
    const unknown = known.filter(e => e.state === null);
    if (broken.length) return {id: 'extensions', title: 'Extensions', state: 'attention', detail: `${join(broken.map(e => e.name))}: ${broken[0].error ?? (broken[0].state === OUT_OF_DATE ? 'out of date for this GNOME Shell' : 'failed to load')}`};
    if (off.length) return {id: 'extensions', title: 'Extensions', state: 'attention', detail: `${join(off.map(e => e.name))} installed but not running. Enable in Extensions, or log out and in.`};
    if (missing.length) return {id: 'extensions', title: 'Extensions', state: 'attention', detail: `${join(missing.map(e => e.name))} not installed`};
    if (unknown.length) return {id: 'extensions', title: 'Extensions', state: 'unavailable', detail: 'GNOME Shell did not report whether they are running'};
    if (known.some(e => e.state !== ACTIVE)) return {id: 'extensions', title: 'Extensions', state: 'attention', detail: 'An extension is in an unexpected state'};
    return {id: 'extensions', title: 'Extensions', state: 'healthy', detail: `${plural(known.length, 'extension')} running`};
}

export function assess(f: Facts): Row[] {
    const rows: Row[] = [];
    const bad = f.configProblems.length;
    rows.push(bad ? {id: 'configuration', title: 'Configuration', state: 'attention', detail: `${plural(bad, 'problem')} in the settings catalog: ${f.configProblems[0]}`}
        : f.unreachableSettings ? {id: 'configuration', title: 'Configuration', state: 'attention', detail: `${plural(f.unreachableSettings, 'setting')} cannot be read: their extension's settings are not installed`}
        : {id: 'configuration', title: 'Configuration', state: 'healthy', detail: 'Every setting can be read'});
    rows.push(extensionsRow(f.extensions));
    rows.push(!f.islandInstalled ? {id: 'service', title: 'Background service', state: 'unavailable', detail: 'The island is not installed'}
        : f.daemon === null ? {id: 'service', title: 'Background service', state: 'unavailable', detail: 'Could not ask the session bus'}
        : f.daemon ? {id: 'service', title: 'Background service', state: 'healthy', detail: 'Running'}
        : {id: 'service', title: 'Background service', state: 'attention', detail: 'Not running: music, calls and the assistant need it'});
    const p = f.profile;
    rows.push(p.missing ? {id: 'profile', title: 'Active profile', state: 'attention', detail: 'The profile that was active has been deleted', action: {kind: 'go', page: 'profiles', label: 'Profiles'}}
        : !p.id ? {id: 'profile', title: 'Active profile', state: 'healthy', detail: 'None applied: settings are as you set them'}
        : p.modified ? {id: 'profile', title: 'Active profile', state: 'attention', detail: `${p.name}: ${plural(p.modified, 'setting')} changed by hand since it was applied`, action: {kind: 'go', page: 'profiles', label: 'Review'}}
        : {id: 'profile', title: 'Active profile', state: 'healthy', detail: `${p.name}, unmodified`});
    rows.push(f.interrupted ? {id: 'recovery', title: 'Recovery', state: 'recovery', detail: `"${f.interrupted.label}" did not finish. A backup from before it is available.`, action: {kind: 'recover', label: 'Restore backup'}}
        : {id: 'recovery', title: 'Recovery', state: 'healthy', detail: 'Nothing pending'});
    rows.push(f.stale.length ? {id: 'restart', title: 'Log out needed', state: 'attention', detail: `A newer ${join(f.stale)} is installed and loads at the next login`, action: {kind: 'logout', label: 'Log out'}}
        : {id: 'restart', title: 'Log out needed', state: 'healthy', detail: 'No'});
    return rows;
}

const ORDER: State[] = ['healthy', 'unavailable', 'attention', 'recovery'];
/** The worst state of the rows (unavailable ranks below attention: not knowing is not the same as a fault). */
export function overall(rows: Row[]): State { return rows.reduce<State>((w, r) => ORDER.indexOf(r.state) > ORDER.indexOf(w) ? r.state : w, 'healthy'); }

export function summary(rows: Row[]): string {
    const n = (s: State) => rows.filter(r => r.state === s).length;
    if (overall(rows) === 'healthy') return 'Healthy';
    return [n('recovery') && `${n('recovery')} to recover`, n('attention') && `${n('attention')} need attention`, n('unavailable') && `${n('unavailable')} unknown`].filter(Boolean).join(', ');
}
