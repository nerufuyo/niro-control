// Connectivity, the logic without a screen. This page is deliberately small and says what it cannot do. Search (org.niro.Search) offers
// exactly three actions for connections: system.wifi.toggle, system.bluetooth.toggle and system.vpn.toggle. They FLIP the state and answer
// with a sentence ("Wi-Fi off"); Search has no action that only READS whether Wi-Fi, Bluetooth or a VPN is on. So the page cannot show a live
// state and does not guess one: it shows whether each action can run on this machine (Search's own Availability), runs it after a
// confirmation (turning a radio off can cut the connection you are using), and shows the answer, which is the only state it ever learns.
// No networks, devices, addresses or VPN names are listed here, and nothing is stored. No GTK or GLib: node tests it with a fake backend.

export interface ConnItem { id: string; actionId: string; title: string; icon: string; what: string; warning: string; }

export const ITEMS: ConnItem[] = [
    {id: 'wifi', actionId: 'system.wifi.toggle', title: 'Wi-Fi', icon: 'network-wireless-symbolic', what: 'Turns the Wi-Fi radio off, or on again.',
        warning: 'If this computer is online over Wi-Fi, turning it off ends that connection.'},
    {id: 'bluetooth', actionId: 'system.bluetooth.toggle', title: 'Bluetooth', icon: 'bluetooth-symbolic', what: 'Turns Bluetooth off, or on again.',
        warning: 'Connected devices such as a keyboard, mouse or headphones may disconnect.'},
    {id: 'vpn', actionId: 'system.vpn.toggle', title: 'VPN', icon: 'network-vpn-symbolic', what: 'Turns the first VPN set up in NetworkManager on, or the active one off.',
        warning: 'Turning a VPN off can expose your traffic to the network you are on.'},
];

export const LIMITS = [
    'This page flips each connection; Search has no read-only action, so the current state is not shown until you flip one.',
    'Wi-Fi networks, paired Bluetooth devices and VPN profiles are not listed or configured here: use GNOME Settings for those.',
    'Each toggle asks you here first, and Search may ask again on its own screen when "Ask before other programs use Search actions" is on.',
];

export interface Availability { available: boolean; reason: string | null; }
export interface Outcome { ok: boolean; message: string; code: string; error: string; }
export interface ConnBackend {
    availability(actionId: string): Promise<Availability>;
    run(actionId: string): Promise<Outcome>;
}

const text = (v: any) => String(v ?? '');
export function parseAvailability(raw: any): Availability {
    let v: any;
    try { v = JSON.parse(String(raw)); } catch (_e) { return {available: false, reason: 'Search sent an unreadable answer.'}; }
    return {available: v?.available === true, reason: v?.available === true ? null : text(v?.reason) || 'not available'};
}
export function parseOutcome(raw: any): Outcome {
    let v: any;
    try { v = JSON.parse(String(raw)); } catch (_e) { return {ok: false, message: '', code: 'error', error: 'Search sent an unreadable answer.'}; }
    return {ok: v?.ok === true, message: text(v?.message), code: text(v?.code), error: text(v?.error)};
}

export interface RowState { item: ConnItem; available: boolean; reason: string | null; last: string | null; lastOk: boolean | null; }
export type ConnView = 'loading' | 'ready' | 'unavailable';

/** `confirm(item)` resolves true when the user agrees on screen; without it nothing is ever run. */
export function createConnectivityFlow(backend: ConnBackend, confirm: (item: ConnItem) => Promise<boolean>) {
    const listeners = new Set<() => void>();
    const rows: RowState[] = ITEMS.map(item => ({item, available: false, reason: null, last: null, lastOk: null}));
    const s: {view: ConnView; message: string; busy: string | null; rows: RowState[]} = {view: 'loading', message: '', busy: null, rows};
    const emit = () => listeners.forEach(f => f());

    async function refresh() {
        s.view = 'loading'; s.message = ''; emit();
        try {
            for (const r of rows) {
                const a = await backend.availability(r.item.actionId);
                r.available = a.available; r.reason = a.reason;
            }
            s.view = 'ready';
        } catch (e: any) {
            s.view = 'unavailable';
            s.message = /ServiceUnknown|NameHasNoOwner|no owner|Timeout|NoReply|Could not connect/i.test(String(e?.message ?? e))
                ? 'Niro Search is not running, so connections cannot be reached from here.' : text(e?.message) || 'Search did not answer.';
        }
        emit();
    }

    async function toggle(id: string) {
        const r = rows.find(x => x.item.id === id);
        if (!r || s.busy || !r.available) return false;
        let yes = false;
        try { yes = await confirm(r.item); } catch (_e) { yes = false; }
        if (!yes) return false;
        s.busy = id; emit();
        try {
            const o = await backend.run(r.item.actionId);
            r.lastOk = o.ok;
            r.last = o.ok ? (o.message || 'Done.') : o.code === 'declined' ? 'Cancelled: nothing changed.' : (o.error || 'Search refused it.');
        } catch (e: any) { r.lastOk = false; r.last = text(e?.message) || 'Search did not answer.'; }
        s.busy = null; emit();
        return r.lastOk === true;
    }

    return {state: s, refresh, toggle, subscribe(f: () => void) { listeners.add(f); return () => listeners.delete(f); }};
}
