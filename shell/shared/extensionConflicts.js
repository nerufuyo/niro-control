// Extension Compatibility core (vNext S29). Pure: a rule database with a confidence level and a reason. It only reports; it never
// disables another extension. Rules are keyed by extension uuid (`ours` is a prefix or a list of prefixes); a person can mark one as a false positive and it stops showing.

export const RULES = [
    {id: 'dock-overlap', ours: ['niro-dock', 'dock@niro.local'], theirs: ['dash-to-dock@micxgx.gmail.com', 'dash-to-panel@jderose9.github.com', 'ubuntu-dock@ubuntu.com'],
        confidence: 'high', reason: 'Two docks occupy the same screen edge and both reserve space for themselves.'},
    {id: 'tiling-overlap', ours: ['niro-tile', 'tile@niro.local'], theirs: ['tilingshell@ferrarodomenico.com', 'forge@jmmaranan.com', 'pop-shell@system76.com', 'tiling-assistant@leleat-on-github', 'tiling-assistant@ubuntu.com'],
        confidence: 'high', reason: 'Two tiling managers both move and resize windows: each tiles on edge drag and binds Super+arrow style shortcuts, so one undoes or fights the other (Ubuntu\'s Tiling Assistant is on by default there).'},
    {id: 'blur-overlap', ours: ['niro-blur', 'blur@niro.local'], theirs: ['blur-my-shell@aunetx', 'rounded-window-corners@fxgn'],
        confidence: 'medium', reason: 'Both change how windows or the shell are drawn; the order they load in can change the result.'},
    {id: 'notification-overlap', ours: ['niro-island', 'island@niro.local'], theirs: ['notification-banner-reloaded@marcinjakubowski.github.com', 'notification-timeout@chlumskyvaclav.gmail.com'],
        confidence: 'medium', reason: 'Both take over notification banners.'},
    {id: 'search-overlap', ours: ['niro-search', 'search@niro.local'], theirs: ['gnome-fuzzy-app-search@gnome-shell-extensions.Czarlie.gitlab.com', 'search-light@icedman.github.com'],
        confidence: 'low', reason: 'Both draw a launcher over the overview; it can be fine if only one is bound to the shortcut.'},
];

/**
 * `installed`: [{uuid, enabled, shellVersions: []}]; `shell`: major version; `ignored`: rule ids marked as false positives.
 * Returns {conflicts, incompatible}: nothing is changed.
 */
export function analyze(installed, shell, ignored = [], rules = RULES) {
    const enabled = new Set(installed.filter(e => e.enabled).map(e => e.uuid));
    const conflicts = [];
    for (const r of rules) {
        if (ignored.includes(r.id))
            continue;
        const prefixes = [].concat(r.ours);   // Niro's own extensions are `name@niro.local`; the older `niro-name` prefix is kept
        const ours = [...enabled].filter(u => prefixes.some(p => u.startsWith(p)));
        const theirs = r.theirs.filter(t => enabled.has(t));
        if (ours.length && theirs.length)
            conflicts.push({id: r.id, ours, theirs, confidence: r.confidence, reason: r.reason});
    }
    const incompatible = installed.filter(e => e.enabled && e.shellVersions?.length && !e.shellVersions.some(v => String(v).split('.')[0] === String(shell)))
        .map(e => ({uuid: e.uuid, shellVersions: e.shellVersions}));
    return {conflicts, incompatible};
}

/** A shortcut bound by more than one extension: {accel, owners[]}. `bindings`: [{owner, accel}]. */
export function shortcutClashes(bindings) {
    const m = new Map();
    for (const b of bindings)
        m.set(b.accel, [...(m.get(b.accel) ?? []), b.owner]);
    return [...m].filter(([, o]) => new Set(o).size > 1).map(([accel, owners]) => ({accel, owners: [...new Set(owners)]}));
}
