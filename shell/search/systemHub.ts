// @ts-nocheck: the shared cores are plain JS copied into build/shared by the build
// System Experience (workstream F): the clipboard, notification, performance, audio, HUD, privacy and shelf cores as opt-in Search actions.
// Pure: no GNOME imports, so node tests it with fake services. The shell (extension.ts + systemShell.ts) passes in `services`: the clock, timers,
// the daemon's clipboard, /proc, pactl, the on-screen display, and two watchers. Everything is off until its setting is on; `sync()` starts or
// stops each timer and watcher to match the settings, and `stop()` leaves nothing running or kept.
import {sensitiveKind, isExpired} from './shared/clipboardTools.js';
import {decide, remember, summarize} from './shared/notificationRules.js';
import {createHistory, exportDiagnostics, nextInterval} from './shared/perfHistory.js';
import {parsePactlDevices, parsePactlStreams, planStreamVolume, planRules, createLoopGuard, recordMoves} from './shared/audioRouter.js';
import {createHud, HUD_KINDS} from './shared/hud.js';
import {createPrivacy} from './shared/privacy.js';
import {createShelf, DEFAULTS as SHELF_DEFAULTS} from './shared/shelfCollections.js';
import {createHub as createWidgetHub, validateWidgetManifest} from './shared/widgetRegistry.js';

const MIN = 60000;
export const SETTING_KEYS = ['smart-clipboard', 'smart-clipboard-minutes', 'notification-hub', 'notification-hub-apply', 'perf-recording',
    'privacy-dashboard', 'privacy-history', 'audio-router', 'universal-hud', 'shelf-collections', 'widgets-in-search'];
const WHERE = {
    'smart-clipboard': 'Keep secrets out of the clipboard history', 'notification-hub': 'Apply notification rules', 'audio-router': 'Audio router actions',
    'privacy-dashboard': 'Privacy overview in Search', 'universal-hud': 'On-screen display action', 'shelf-collections': 'Shelf collections', 'widgets-in-search': 'Widgets in Search',
};
const RULE_VERDICTS = ['show', 'silent', 'hide'];
const MAX_RULES = 50;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PROC_FILES = ['/proc/stat', '/proc/meminfo', '/proc/loadavg'];
const KIND_ICON = {volume: 'audio-volume-high-symbolic', brightness: 'display-brightness-symbolic', mic: 'audio-input-microphone-symbolic', media: 'media-playback-start-symbolic',
    battery: 'battery-symbolic', 'power-profile': 'power-profile-balanced-symbolic', bluetooth: 'bluetooth-active-symbolic', network: 'network-wireless-symbolic', custom: 'dialog-information-symbolic'};
// Built-in widgets: manifests for widgetRegistry.js, all reading the one performance sampler ("perf"); `read` turns a sample into text.
// Refresh is manual: Search shows them when asked, nothing here polls.
const WIDGET_SIZE = {min: {w: 1, h: 1}, max: {w: 4, h: 2}, default: {w: 2, h: 1}};
const widget = (id, title, read) => ({manifest: {id, title, size: WIDGET_SIZE, refresh: {policy: 'manual'}, provider: 'perf', permissions: []}, read});
const WIDGETS = [
    widget('system.cpu', 'Processor', sm => Number.isFinite(sm.cpu) ? pct(sm.cpu) : 'no reading yet'),
    widget('system.memory', 'Memory', sm => Number.isFinite(sm.memUsed) ? `${gb(sm.memUsed)} of ${gb(sm.memTotal)}` : 'no reading'),
    widget('system.load', 'Load', sm => Number.isFinite(sm.load1) ? sm.load1.toFixed(2) : 'no reading'),
    widget('system.battery', 'Battery', sm => Number.isFinite(sm.battery) ? `${Math.round(sm.battery)}%` : 'no battery'),
];
const URGENCY = ['low', 'normal', 'high', 'critical'];

// ---- parsing (pure, exported for tests)
export function parseCpu(text) {
    const m = /^cpu\s+(.+)$/m.exec(text ?? '');
    if (!m) return null;
    const n = m[1].trim().split(/\s+/).map(Number);
    if (n.length < 5 || n.some(v => !Number.isFinite(v))) return null;
    return {total: n.slice(0, 8).reduce((a, b) => a + b, 0), idle: n[3] + n[4]};
}

export function parseMem(text) {
    const kb = key => { const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text ?? ''); return m ? Number(m[1]) * 1024 : null; };
    const total = kb('MemTotal'), avail = kb('MemAvailable'), swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
    return {memTotal: total ?? undefined, memUsed: total !== null && avail !== null ? total - avail : undefined,
        swapUsed: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : undefined};
}

const pct = v => `${Math.round(v * 100)}%`;
const gb = b => `${(b / 2 ** 30).toFixed(1)} GB`;
const clock = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** pactl arguments the hub will run, and nothing else: a fixed set of sub-commands with checked values. */
export function safePactl(args) {
    const [cmd, ...rest] = args;
    const num = /^\d{1,9}$/, node = /^[\w.:+@-]{1,200}$/;
    const ok = (cmd === '-f' && rest.length === 3 && rest[0] === 'json' && rest[1] === 'list' && ['sinks', 'sources', 'sink-inputs', 'source-outputs'].includes(rest[2]))
        || (cmd === 'get-default-sink' && rest.length === 0)
        || (cmd === 'set-sink-input-volume' && rest.length === 2 && num.test(rest[0]) && /^\d{1,3}%$/.test(rest[1]))
        || (cmd === 'set-sink-input-mute' && rest.length === 2 && num.test(rest[0]) && ['0', '1', 'toggle'].includes(rest[1]))
        || (cmd === 'move-sink-input' && rest.length === 2 && num.test(rest[0]) && node.test(rest[1]));
    if (!ok) throw new Error('that sound command is not allowed');
    return args;
}

/** Who is recording sound: capture streams that are not level meters and not a speaker's monitor. */
export function micApps(sourceOutputsJson, sourcesJson) {
    let list;
    try { list = JSON.parse(sourceOutputsJson); } catch (_e) { return []; }
    if (!Array.isArray(list)) return [];
    const monitors = new Set(parsePactlDevices(sourcesJson, 'source').filter(d => d.monitor).map(d => d.index));
    return list.filter(o => Number.isInteger(o?.index) && !o.corked && !monitors.has(Number(o.source)))
        .map(o => ({kind: 'mic', app: String(o.properties?.['application.name'] ?? o.properties?.['node.name'] ?? 'Unknown').slice(0, 80)}));
}

// ---- the hub
export function createSystemHub(s) {
    const pref = (k, d = false) => { try { return s.pref(k, d); } catch (_e) { return d; } };
    const on = key => pref(key, false) === true;
    const need = key => () => on(key) ? null : `Off: switch on "${WHERE[key]}" in Niro Control > Search`;
    const loops = new Map();
    const checked = new Set();        // clipboard ids whose text was already looked at (an id, never the text)
    let sweeping = false;
    let ncfg = {rules: [], quiet: null}, nhistory = [], snoozed = {};
    let prevCpu = null, perf = createHistory(360), perfLast = 0, lastOnBattery = false;
    const guard = createLoopGuard();
    let hud = null;
    let privacy = null;
    let shelf = null;
    let widgetHub = null;     // widgetRegistry's hub, alive only while the setting is on (bounded: WIDGETS.length subscriptions)
    let watching = {notifications: false, screen: false};

    // ---- timers: one loop per feature, rescheduled after each run; nothing overlaps
    function startLoop(name, nextMs, fn) {
        if (loops.has(name)) return;
        const st = {id: 0, stopped: false};
        loops.set(name, st);
        const arm = () => {
            if (st.stopped) return;
            const ms = nextMs();
            if (ms === null) { st.id = 0; return; }
            st.id = s.setTimer(ms, () => { st.id = 0; Promise.resolve().then(fn).catch(() => {}).then(arm); });
        };
        arm();
    }
    function stopLoop(name) {
        const st = loops.get(name);
        if (!st) return;
        st.stopped = true;
        if (st.id) s.clearTimer(st.id);
        loops.delete(name);
    }

    // ---- Smart Clipboard
    async function sweep() {
        if (sweeping) return {sensitive: 0, expired: 0, kept: 0, busy: true};
        sweeping = true;
        try {
            const ttl = Math.max(0, Number(pref('smart-clipboard-minutes', 0)) || 0) * MIN;
            const now = s.now();
            const items = await s.clipboard.items();
            const live = new Set(items.map(i => i.id));
            for (const id of checked) if (!live.has(id)) checked.delete(id);
            let sensitive = 0, expired = 0;
            for (const i of items) {
                if (i.pinned) continue;
                let why = null;
                if (isExpired({savedAt: i.at_ms, pinned: false}, now, ttl)) why = 'expired';
                else if ((i.kind === 'text' || i.kind === 'link') && !checked.has(i.id)) {
                    const text = await s.clipboard.text(i.id);
                    checked.add(i.id);
                    if (typeof text === 'string' && sensitiveKind(text)) why = 'sensitive';
                }
                if (!why) continue;
                try { await s.clipboard.remove(i.id); why === 'expired' ? expired++ : sensitive++; } catch (_e) { /* it is still there: next time */ }
            }
            return {sensitive, expired, kept: items.length - sensitive - expired};
        } finally { sweeping = false; }
    }

    // ---- Notification Hub
    function loadRules() {
        try {
            const d = JSON.parse(s.readConfig('notification-rules.json') ?? '');
            ncfg = {
                rules: (Array.isArray(d.rules) ? d.rules : []).filter(r => typeof r?.app === 'string' && r.app && RULE_VERDICTS.includes(r.verdict)).slice(0, MAX_RULES).map(r => ({app: r.app.slice(0, 80), verdict: r.verdict})),
                quiet: d.quiet && HHMM.test(d.quiet.from ?? '') && HHMM.test(d.quiet.to ?? '') ? {from: d.quiet.from, to: d.quiet.to, allow: ['critical']} : null,
            };
        } catch (_e) { ncfg = {rules: [], quiet: null}; }
    }
    const saveRules = () => s.writeConfig('notification-rules.json', JSON.stringify({version: 1, rules: ncfg.rules, quiet: ncfg.quiet && {from: ncfg.quiet.from, to: ncfg.quiet.to}}));

    /** Called by the shell for each notification: metadata only. Returns {verdict, apply} or null when the hub is off. */
    function onNotification(n) {
        if (!on('notification-hub')) return null;
        const now = s.now();
        const appId = String(n?.appId ?? 'unknown').slice(0, 80);
        const urgency = URGENCY.includes(n?.urgency) ? n.urgency : 'normal';
        nhistory = remember(nhistory, {appId, urgency}, now, {max: 200});
        for (const [k, until] of Object.entries(snoozed)) if (until <= now) delete snoozed[k];
        const v = decide({appId, urgency}, {rules: ncfg.rules, quiet: ncfg.quiet, snoozed}, {now: new Date(now)});
        return {verdict: v.verdict, apply: on('notification-hub-apply'), reason: v.reason};
    }

    // ---- Performance Center
    async function readProc() {
        const out = {};
        for (const f of PROC_FILES) out[f] = await s.readProc(f);
        return out;
    }
    async function takeSample() {
        const p = await readProc();
        const sample = {...parseMem(p['/proc/meminfo'])};
        const cpu = parseCpu(p['/proc/stat']);
        if (cpu && prevCpu && cpu.total > prevCpu.total) sample.cpu = Math.min(1, Math.max(0, 1 - (cpu.idle - prevCpu.idle) / (cpu.total - prevCpu.total)));
        if (cpu) prevCpu = cpu;
        const l = /^(\d+(?:\.\d+)?)/.exec(p['/proc/loadavg'] ?? '');
        if (l) sample.load1 = Number(l[1]);
        const st = await s.systemState();
        if (Number.isFinite(st?.battery?.percent)) sample.battery = st.battery.percent;
        lastOnBattery = Boolean(st?.battery) && st.battery.plugged === false;
        return sample;
    }
    async function freshSample() {
        // one reading per moment: while recording, a sample from the last 5 s is reused, not taken again
        if (loops.has('perf') && perfLast && s.now() - perfLast < 5000 && perf.last()) return perf.last();
        if (!prevCpu) { await takeSample(); await s.sleep(300); }
        const sample = await takeSample();
        if (loops.has('perf')) { perf.push(sample); perfLast = s.now(); }
        return sample;
    }

    // ---- Privacy
    async function privacyNow() {
        privacy ??= createPrivacy();
        const live = await s.privacyLive();
        const st = await s.systemState();
        let audio = false, apps = [];
        try {
            const [outs, srcs] = await Promise.all([s.pactl(['-f', 'json', 'list', 'source-outputs']), s.pactl(['-f', 'json', 'list', 'sources'])]);
            audio = true;
            apps = micApps(outs, srcs);
        } catch (_e) { audio = false; }
        privacy.setCapabilities({wayland: live.wayland, audioServer: audio, cameraProbe: st !== null, recorderSignal: live.recorder !== null});
        const active = [...apps];
        if (st?.camera_in_use) active.push({kind: 'camera', app: 'a camera application'});
        for (let i = 0; i < live.screenShares; i++) active.push({kind: 'screen-share', app: 'a screen-sharing application'});
        if (live.recorder) active.push({kind: 'recording', app: 'GNOME screen recorder'});
        return privacy.observe(active, s.now());
    }

    // ---- Audio Router
    async function audioState() {
        const [sinks, sources, inputs] = await Promise.all(['sinks', 'sources', 'sink-inputs'].map(w => s.pactl(['-f', 'json', 'list', w])));
        let def = '';
        try { def = (await s.pactl(['get-default-sink'])).trim(); } catch (_e) { /* not shown */ }
        return {sinks: parsePactlDevices(sinks, 'sink'), sources: parsePactlDevices(sources, 'source').filter(d => !d.monitor), streams: parsePactlStreams(inputs), def};
    }
    async function runCommands(commands) {
        for (const c of commands) {
            if (c[0] !== 'pactl') throw new Error('that sound command is not allowed');
            await s.pactl(safePactl(c.slice(1)));
        }
    }
    const streamsOf = (streams, app) => streams.filter(x => [x.app, x.appId].some(n => n.toLowerCase() === String(app).toLowerCase()));

    // ---- Shelf collections
    const shelfFile = 'shelf-collections.json';
    function openShelf() {
        if (shelf) return shelf;
        // every collection that can be created is kept: only expired ones go on open
        shelf = createShelf({maxUnpinned: SHELF_DEFAULTS.maxCollections});
        try { shelf.load(JSON.parse(s.readConfig(shelfFile) ?? '').collections); } catch (_e) { /* a first run, or a file that is not ours: start empty */ }
        shelf.cleanup(s.now());
        return shelf;
    }
    const saveShelf = () => s.writeConfig(shelfFile, JSON.stringify({version: 1, collections: shelf.snapshot()}));
    const collection = name => openShelf().collections.find(c => c.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
    const uriOf = path => /^\//.test(path) ? `file://${path.split('/').map(encodeURIComponent).join('/')}` : path;

    function register(r) {
        // ---- Smart Clipboard
        r.register({id: 'clipboard.smart.sweep', title: 'Clean the clipboard history', description: 'Removes unpinned clipboard items that look like secrets (and, when set, old ones); says how many, never what', category: 'Clipboard', keywords: ['clipboard', 'secret', 'password', 'sweep', 'forget'],
            permission: 'confirm', confirm: 'Remove secrets and old items from the clipboard history?', available: need('smart-clipboard'),
            run: async () => {
                const o = await sweep();
                if (o.busy) return 'A clean-up is already running';
                return `Removed ${o.sensitive} secret${o.sensitive === 1 ? '' : 's'} and ${o.expired} old item${o.expired === 1 ? '' : 's'}; ${o.kept} kept`;
            }});

        // ---- Notification Hub
        r.register({id: 'notifications.summary', title: 'Notification summary', description: 'How many notifications each application sent since the hub was switched on (names and counts only)', category: 'Notifications', keywords: ['notification', 'summary', 'hub', 'apps'],
            permission: 'none', available: need('notification-hub'),
            run: async () => {
                const sum = summarize(nhistory);
                const lines = sum.slice(0, 10).map(x => `${x.appId}: ${x.count}`);
                const rules = ncfg.rules.length;
                return `${nhistory.length} notification${nhistory.length === 1 ? '' : 's'} seen; ${rules} rule${rules === 1 ? '' : 's'}${ncfg.quiet ? `, quiet ${ncfg.quiet.from} to ${ncfg.quiet.to}` : ''}; ${on('notification-hub-apply') ? 'rules are applied' : 'rules are only counted'}${lines.length ? `\n${lines.join('\n')}` : ''}`;
            }});
        r.register({id: 'notifications.snooze', title: 'Snooze an application', description: 'Silences one application\'s notifications for some minutes (urgent ones still show)', category: 'Notifications', keywords: ['notification', 'snooze', 'mute'],
            params: [{name: 'app', type: 'string', required: true, maxLength: 80}, {name: 'minutes', type: 'number', required: true, min: 1, max: 1440}], permission: 'none', available: need('notification-hub'),
            run: async ({app, minutes}) => {
                if (Object.keys(snoozed).length >= 50 && !(app in snoozed)) throw new Error('at most 50 applications can be snoozed');
                snoozed[app] = s.now() + Math.round(minutes) * MIN;
                return `${app} snoozed for ${Math.round(minutes)} min`;
            }});
        r.register({id: 'notifications.rule', title: 'Notification rule', description: 'Sets what happens to an application\'s notifications: show, silent (no banner) or hide; "remove" deletes the rule; "*" means every application', category: 'Notifications', keywords: ['notification', 'rule', 'hide', 'silent'],
            params: [{name: 'app', type: 'string', required: true, maxLength: 80}, {name: 'verdict', type: 'enum', required: true, enum: [...RULE_VERDICTS, 'remove']}], permission: 'none', available: need('notification-hub'),
            run: async ({app, verdict}) => {
                const rest = ncfg.rules.filter(x => x.app !== app);
                if (verdict === 'remove') { ncfg.rules = rest; saveRules(); return `Rule for ${app} removed`; }
                if (rest.length >= MAX_RULES) throw new Error(`at most ${MAX_RULES} rules`);
                ncfg.rules = [...rest, {app, verdict}];
                saveRules();
                return `${app}: ${verdict}${on('notification-hub-apply') ? '' : ' (counted only: "Hide or silence notifications by rule" is off)'}`;
            }});
        r.register({id: 'notifications.quiet', title: 'Quiet hours', description: 'No banners between two times (HH:MM, 24 hours); "off" in both clears it; urgent notifications still show', category: 'Notifications', keywords: ['notification', 'quiet', 'hours', 'night'],
            params: [{name: 'from', type: 'string', required: true, maxLength: 5}, {name: 'to', type: 'string', required: true, maxLength: 5}], permission: 'none', available: need('notification-hub'),
            run: async ({from, to}) => {
                if (from === 'off' && to === 'off') { ncfg.quiet = null; saveRules(); return 'Quiet hours off'; }
                if (!HHMM.test(from) || !HHMM.test(to)) throw new Error('times are HH:MM, for example 22:00 and 07:00');
                ncfg.quiet = {from, to, allow: ['critical']};
                saveRules();
                return `Quiet hours ${from} to ${to}`;
            }});
        r.register({id: 'notifications.clear', title: 'Forget notification history', description: 'Empties the hub\'s count of notifications and the snoozes', category: 'Notifications', keywords: ['notification', 'clear', 'history'],
            permission: 'none', available: need('notification-hub'),
            run: async () => { nhistory = []; snoozed = {}; return 'Notification history cleared'; }});

        // ---- Performance Center
        r.register({id: 'perf.report', title: 'Performance', description: 'Processor, memory, swap and load now, and the average while recording is on', category: 'System', keywords: ['performance', 'cpu', 'memory', 'ram', 'load', 'perf'],
            permission: 'none',
            run: async () => {
                const sm = await freshSample();
                const parts = [];
                if (Number.isFinite(sm.cpu)) parts.push(`CPU ${pct(sm.cpu)}`);
                if (Number.isFinite(sm.memUsed)) parts.push(`Memory ${gb(sm.memUsed)} of ${gb(sm.memTotal)}`);
                if (Number.isFinite(sm.swapUsed)) parts.push(`Swap ${gb(sm.swapUsed)}`);
                if (Number.isFinite(sm.load1)) parts.push(`Load ${sm.load1.toFixed(2)}`);
                if (Number.isFinite(sm.battery)) parts.push(`Battery ${Math.round(sm.battery)}%`);
                const rec = loops.has('perf') ? `Recording: ${perf.samples().length} of ${perf.capacity()} readings${Number.isFinite(perf.average('cpu')) ? `, average CPU ${pct(perf.average('cpu'))}` : ''}` : 'Recording is off';
                return `${parts.join('  ·  ') || 'No readings'}\n${rec}`;
            }});
        r.register({id: 'perf.export', title: 'Performance export', description: 'A diagnostic report of numbers only (no process names, no commands, no environment), as text you can copy', category: 'System', keywords: ['performance', 'export', 'diagnostic', 'report'],
            permission: 'none',
            run: async () => {
                if (!perf.last()) await freshSample().then(sm => { if (!loops.has('perf')) perf.push(sm); });
                const report = exportDiagnostics(perf, {appVersion: s.version ?? 'unknown', shellVersion: String(s.shellVersion ?? 'unknown'), now: () => new Date(s.now()).toISOString()});
                if (!loops.has('perf')) perf.clear();       // a reading taken just for this report is not kept
                return JSON.stringify(report, null, 1);
            }});

        // ---- Widgets (widgetRegistry.js in Search: the one surface this repo has for them today)
        r.register({id: 'widgets.list', title: 'Widgets', description: 'The built-in widgets and what they read (every one shares the performance sampler)', category: 'System', keywords: ['widgets', 'widget', 'desktop'],
            permission: 'none', available: need('widgets-in-search'),
            run: async () => WIDGETS.map(w => `${w.manifest.id}  ·  ${w.manifest.title}  ·  reads ${w.manifest.provider}${widgetHub?.isErrored(w.manifest.id) ? '  ·  failing' : ''}`).join('\n')});
        r.register({id: 'widgets.show', title: 'Show widgets', description: 'The current value of each widget (or one, by id) from a single performance reading', category: 'System', keywords: ['widgets', 'widget', 'show'],
            params: [{name: 'id', type: 'string', maxLength: 60}], permission: 'none', available: need('widgets-in-search'),
            run: async ({id} = {}) => {
                const picked = WIDGETS.filter(w => !id || w.manifest.id === id);
                if (!picked.length) throw new Error(`no widget called "${id}"`);
                const sm = await freshSample();     // one reading for all of them; shared with Performance, never a second poll
                return picked.map(w => {
                    try { widgetHub?.clearError(w.manifest.id); return `${w.manifest.title}: ${w.read(sm)}`; }
                    catch (_e) { widgetHub?.reportError(w.manifest.id); return `${w.manifest.title}: unavailable`; }
                }).join('\n');
            }});

        // ---- Privacy Dashboard
        r.register({id: 'privacy.status', title: 'Privacy', description: 'Whether the microphone, camera or screen is in use now, and by which application (unknown where GNOME does not say)', category: 'System', keywords: ['privacy', 'microphone', 'camera', 'screen', 'sharing'],
            permission: 'none', available: need('privacy-dashboard'),
            run: async () => {
                const m = await privacyNow();
                const names = {mic: 'Microphone', camera: 'Camera', 'screen-share': 'Screen sharing', recording: 'Screen recording'};
                return Object.entries(m.indicators).map(([k, v]) => `${names[k]}: ${v.state === 'unknown' ? `unknown (${v.explanation})` : v.state === 'active' ? `in use by ${[...new Set(v.apps)].join(', ')}` : 'not in use'}`).join('\n');
            }});
        r.register({id: 'privacy.history', title: 'Privacy history', description: 'Which application used the microphone, camera or screen and when (only while "Remember privacy events" is on)', category: 'System', keywords: ['privacy', 'history', 'microphone', 'camera'],
            permission: 'none', available: need('privacy-dashboard'),
            run: async () => {
                if (!on('privacy-history')) return 'Not remembering: switch on "Remember privacy events" in Niro Control > Search';
                const h = (privacy ?? createPrivacy()).history().slice(-20);
                return h.length ? h.map(e => `${e.kind}  ${e.app}  ${clock(e.start)}${e.end ? ` to ${clock(e.end)}` : ' (still on)'}`).join('\n') : 'Nothing recorded yet';
            }});

        // ---- Audio Router
        r.register({id: 'audio.devices', title: 'Audio devices', description: 'Sound outputs and inputs, with volume; the one in use is marked', category: 'Audio', keywords: ['audio', 'sound', 'devices', 'output', 'speaker'],
            permission: 'none', available: need('audio-router'),
            run: async () => {
                const a = await audioState();
                const line = d => `${d.name === a.def ? '* ' : '  '}${d.description} (${Math.round(d.volume * 100)}%${d.muted ? ', muted' : ''}${d.available ? '' : ', unplugged'})`;
                return `Outputs\n${a.sinks.map(line).join('\n') || '  none'}\nInputs\n${a.sources.map(line).join('\n') || '  none'}`;
            }});
        r.register({id: 'audio.streams', title: 'Audio streams', description: 'Applications playing sound now, their volume and the output each uses', category: 'Audio', keywords: ['audio', 'sound', 'streams', 'apps', 'volume'],
            permission: 'none', available: need('audio-router'),
            run: async () => {
                const a = await audioState();
                const sink = i => a.sinks.find(d => d.index === i)?.description ?? 'unknown output';
                return a.streams.length ? a.streams.map(x => `${x.app}${x.media ? ` (${x.media.slice(0, 40)})` : ''}: ${Math.round(x.volume * 100)}%${x.muted ? ' muted' : ''} on ${sink(x.sinkIndex)}`).join('\n') : 'No application is playing sound';
            }});
        r.register({id: 'audio.stream.volume', title: 'Application volume', description: 'Sets one playing application\'s volume (0 to 100) and/or mutes it; the output\'s own volume is not touched', category: 'Audio', keywords: ['audio', 'volume', 'app', 'mute'],
            params: [{name: 'app', type: 'string', required: true, maxLength: 80}, {name: 'percent', type: 'number', min: 0, max: 100}, {name: 'mute', type: 'enum', enum: ['on', 'off', 'toggle']}],
            permission: 'confirm', ask: ({app, percent, mute}) => `Change the sound of ${app}${percent !== undefined ? ` to ${Math.round(percent)}%` : ''}${mute ? `, mute ${mute}` : ''}?`, confirm: 'Change this application\'s sound?', available: need('audio-router'),
            run: async ({app, percent, mute}) => {
                if (percent === undefined && mute === undefined) throw new Error('give a percent or a mute');
                const mine = streamsOf((await audioState()).streams, app);
                if (!mine.length) throw new Error(`${app} is not playing sound`);
                for (const st of mine)
                    await runCommands(planStreamVolume(st, {...(percent !== undefined ? {volume: percent / 100} : {}), ...(mute ? {mute: mute === 'toggle' ? 'toggle' : mute === 'on'} : {})}).commands);
                return `${mine.length} stream${mine.length === 1 ? '' : 's'} of ${app} changed`;
            }});
        r.register({id: 'audio.stream.move', title: 'Move application sound', description: 'Sends one playing application\'s sound to another output (part of its name is enough); the default output is never changed', category: 'Audio', keywords: ['audio', 'route', 'move', 'output', 'headphones'],
            params: [{name: 'app', type: 'string', required: true, maxLength: 80}, {name: 'output', type: 'string', required: true, maxLength: 120}], permission: 'confirm',
            ask: ({app, output}) => `Move the sound of ${app} to "${output}"?`, confirm: 'Move this application\'s sound?', available: need('audio-router'),
            run: async ({app, output}) => {
                const a = await audioState();
                const want = output.toLowerCase();
                const target = a.sinks.filter(d => !d.monitor && (d.name.toLowerCase().includes(want) || d.description.toLowerCase().includes(want)));
                if (target.length !== 1) throw new Error(target.length ? `"${output}" matches ${target.length} outputs; be more specific` : `no output called "${output}"`);
                const now = s.now();
                const plan = planRules(streamsOf(a.streams, app), a.sinks, [{app, sink: target[0].name}], {guard, now});
                if (!plan.moves.length) {
                    const why = plan.skipped[0]?.reason;
                    throw new Error(why === 'already-there' ? `${app} already plays on ${target[0].description}` : why === 'loop-guard' ? `${app} was moved twice in the last minute; wait a little` : why === 'target-unavailable' ? `${target[0].description} is not available` : `${app} is not playing sound`);
                }
                await runCommands(plan.commands);
                recordMoves(guard, plan, now);
                return `${app} now plays on ${target[0].description}`;
            }});

        // ---- Universal HUD
        r.register({id: 'hud.show', title: 'Show on screen', description: 'Shows a short message and an optional level (0 to 100) in GNOME\'s on-screen display', category: 'System', keywords: ['hud', 'osd', 'display', 'overlay', 'message'],
            params: [{name: 'kind', type: 'enum', required: true, enum: HUD_KINDS}, {name: 'label', type: 'string', maxLength: 80}, {name: 'level', type: 'number', min: 0, max: 100}], permission: 'none', available: need('universal-hud'),
            run: async ({kind, label = '', level}) => {
                hud ??= createHud({});
                const now = s.now();
                const r = hud.show(kind, {value: level === undefined ? undefined : level / 100, label, key: kind === 'custom' ? label : undefined}, now);
                if (r.action === 'dropped') throw new Error('too many messages at once; try again in a moment');
                const view = hud.view(now).items.find(i => i.id === r.id);
                s.osd(KIND_ICON[kind], view?.label ?? label, view?.value ?? null);
                return label || kind;
            }});

        // ---- Shelf collections
        r.register({id: 'collection.list', title: 'Shelf collections', description: 'The collections you keep, or the items of one (give its name)', category: 'Shelf', keywords: ['shelf', 'collection', 'list', 'references'],
            params: [{name: 'name', type: 'string', maxLength: 60}], permission: 'none', available: need('shelf-collections'),
            run: async ({name}) => {
                openShelf();
                if (name) {
                    const c = collection(name);
                    if (!c) throw new Error(`no collection called "${name}"`);
                    return c.items.length ? c.items.map((i, n) => `${n + 1}. ${i.kind === 'text' ? `"${i.text.slice(0, 50).replace(/\s+/g, ' ')}"` : i.uri}`).join('\n') : `${c.name} is empty`;
                }
                const cols = shelf.collections;
                return cols.length ? `${cols.map(c => `${c.name}: ${c.items.length} item${c.items.length === 1 ? '' : 's'}`).join('\n')}\n(Only references: a file is never moved or deleted)` : 'No collections yet';
            }});
        r.register({id: 'collection.create', title: 'New shelf collection', description: 'Makes an empty collection; hours > 0 makes it expire (it is removed with its references, never the files)', category: 'Shelf', keywords: ['shelf', 'collection', 'new', 'create'],
            params: [{name: 'name', type: 'string', required: true, maxLength: 60}, {name: 'hours', type: 'number', min: 1, max: 720}], permission: 'none', available: need('shelf-collections'),
            run: async ({name, hours}) => {
                openShelf();
                const o = shelf.create(name, {now: s.now(), ttlMs: hours ? Math.round(hours * 3600000) : null});
                if (!o.ok) throw new Error(o.reason);
                saveShelf();
                return `Collection "${name.trim()}" created`;
            }});
        r.register({id: 'collection.add', title: 'Add to a collection', description: 'Adds a file path, a web address or a short text to a collection; text that looks like a secret is refused', category: 'Shelf', keywords: ['shelf', 'collection', 'add'],
            params: [{name: 'name', type: 'string', required: true, maxLength: 60}, {name: 'kind', type: 'enum', required: true, enum: ['file', 'url', 'text']}, {name: 'value', type: 'string', required: true, maxLength: 8192}],
            permission: 'none', available: need('shelf-collections'),
            run: async ({name, kind, value}) => {
                const c = collection(name);
                if (!c) throw new Error(`no collection called "${name}"`);
                if (kind === 'text' && sensitiveKind(value)) throw new Error('that text looks like a secret, so it is not kept');
                const o = shelf.add(c.id, kind === 'text' ? {kind, text: value} : {kind, uri: uriOf(value.trim())}, s.now());
                if (!o.ok) throw new Error(o.reason);
                saveShelf();
                return `Added to ${c.name}`;
            }});
        r.register({id: 'collection.remove', title: 'Remove from a collection', description: 'Removes one reference by its number in "collection.list"; the original is never touched', category: 'Shelf', keywords: ['shelf', 'collection', 'remove'],
            params: [{name: 'name', type: 'string', required: true, maxLength: 60}, {name: 'item', type: 'number', required: true, min: 1, max: 100}], permission: 'none', available: need('shelf-collections'),
            run: async ({name, item}) => {
                const c = collection(name);
                const it = c?.items[Math.round(item) - 1];
                if (!c || !it) throw new Error(c ? `${c.name} has no item ${item}` : `no collection called "${name}"`);
                shelf.remove(c.id, it.id);
                saveShelf();
                return `Removed item ${item} from ${c.name}`;
            }});
        r.register({id: 'collection.delete', title: 'Delete a collection', description: 'Deletes a collection and its references; files are never touched', category: 'Shelf', keywords: ['shelf', 'collection', 'delete'],
            params: [{name: 'name', type: 'string', required: true, maxLength: 60}], permission: 'confirm', ask: ({name}) => `Delete the collection "${name}"? Its files stay where they are.`, confirm: 'Delete this collection?', available: need('shelf-collections'),
            run: async ({name}) => {
                const c = collection(name);
                if (!c) throw new Error(`no collection called "${name}"`);
                shelf.removeCollection(c.id);
                saveShelf();
                return `Collection "${c.name}" deleted`;
            }});
        return r;
    }

    /** Starts or stops each timer, watcher and kept state to match the settings. Safe to call at any time, as often as you like. */
    function sync() {
        if (on('smart-clipboard')) { let first = true; startLoop('clipboard', () => { const ms = first ? 3000 : MIN; first = false; return ms; }, sweep); }
        else { stopLoop('clipboard'); checked.clear(); }

        if (on('perf-recording')) {
            startLoop('perf', () => nextInterval({visible: false, recording: true, onBattery: lastOnBattery}),
                async () => { const sm = await takeSample(); perf.push(sm); perfLast = s.now(); });
        } else { stopLoop('perf'); perf.clear(); prevCpu = null; perfLast = 0; }

        const dash = on('privacy-dashboard');
        privacy ??= createPrivacy();
        if (dash && on('privacy-history')) { privacy.setHistory(true); startLoop('privacy', () => 20000, () => privacyNow()); }
        else { stopLoop('privacy'); privacy.setHistory(false); }
        if (watching.screen !== dash) { watching.screen = dash; s.watchScreen?.(dash); }

        const hub = on('notification-hub');
        if (hub && !watching.notifications) loadRules();
        if (!hub) { nhistory = []; snoozed = {}; }
        if (watching.notifications !== hub) { watching.notifications = hub; s.watchNotifications?.(hub); }

        if (!on('universal-hud') && hud) { hud.clear(); hud = null; }
        if (!on('shelf-collections')) shelf = null;

        if (on('widgets-in-search')) {
            if (!widgetHub) {
                widgetHub = createWidgetHub();
                for (const w of WIDGETS) if (validateWidgetManifest(w.manifest).ok) widgetHub.subscribe(w.manifest.id, w.manifest, {visible: false});
            }
        } else widgetHub = null;
    }

    function stop() {
        for (const name of [...loops.keys()]) stopLoop(name);
        checked.clear();
        nhistory = []; snoozed = {};
        perf.clear(); prevCpu = null;
        privacy?.setHistory(false);
        hud?.clear(); hud = null; shelf = null; widgetHub = null;
        if (watching.screen) s.watchScreen?.(false);
        if (watching.notifications) s.watchNotifications?.(false);
        watching = {notifications: false, screen: false};
    }

    return {register, sync, stop, onNotification, sweep, takeSample, _state: () => ({loops: [...loops.keys()], history: nhistory.length, perf: perf.samples().length, widgets: widgetHub?.count() ?? 0, watching: {...watching}})};
}
