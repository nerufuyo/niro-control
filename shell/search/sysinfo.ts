// Readings and parsing for the system actions (battery, VPN, network, autostart): text in, text or numbers out, so tests can run them.

export interface BatteryReading {fullNow: number; fullDesign: number; now: number; rate: number; status: string; cycles: number | null}

/** "Health 91%, 214 cycles, discharging, about 3 h 12 min left" from the sysfs numbers (energy in µWh or charge in µAh, rate in µW or µA). */
export function batteryReport(b: BatteryReading): string {
    const parts: string[] = [];
    if (b.fullDesign > 0 && b.fullNow > 0) parts.push(`Health ${Math.min(100, Math.round((b.fullNow / b.fullDesign) * 100))}%`);
    if (b.cycles !== null && b.cycles >= 0) parts.push(`${b.cycles} cycles`);
    const status = (b.status || 'unknown').toLowerCase();
    parts.push(status);
    if (b.rate > 0) {
        const hours = status === 'charging' ? (b.fullNow - b.now) / b.rate : status === 'discharging' ? b.now / b.rate : 0;
        if (hours > 0 && hours < 48) parts.push(`about ${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min ${status === 'charging' ? 'to full' : 'left'}`);
    }
    return parts.join(', ');
}

export interface Vpn {name: string; type: string; active: boolean}

/** `nmcli -t -f NAME,TYPE,DEVICE connection show`: the VPN and WireGuard connections (a device means it is up). */
export function parseVpns(out: string): Vpn[] {
    const vpns: Vpn[] = [];
    for (const line of out.split('\n')) {
        const m = /^(.*?[^\\]):(vpn|wireguard):(.*)$/.exec(line.trim());
        if (m) vpns.push({name: m[1].replace(/\\:/g, ':'), type: m[2], active: m[3].trim().length > 0});
    }
    return vpns;
}

/** Bytes received and sent by every interface but the loopback, from /proc/net/dev. */
export function netTotals(text: string): {rx: number; tx: number} {
    let rx = 0, tx = 0;
    for (const line of text.split('\n')) {
        const m = /^\s*([^:\s]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/.exec(line);
        if (m && m[1] !== 'lo') { rx += +m[2]; tx += +m[3]; }
    }
    return {rx, tx};
}

export function formatRate(bytesPerSecond: number): string {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let v = Math.max(0, bytesPerSecond), i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export interface Neighbour {ip: string; mac: string; state: string}

/** `ip -4 neigh`: the other devices this computer has talked to lately. */
export function parseNeighbours(out: string): Neighbour[] {
    const list: Neighbour[] = [];
    for (const line of out.split('\n')) {
        const m = /^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})\s+(\w+)/i.exec(line.trim());
        if (m && !/^(FAILED|INCOMPLETE)$/i.test(m[3])) list.push({ip: m[1], mac: m[2].toLowerCase(), state: m[3]});
    }
    return list;
}

export interface DesktopEntry {name: string; hidden: boolean; exec: string}

/** The few keys of an autostart .desktop file that matter here. */
export function parseDesktop(text: string): DesktopEntry | null {
    const group = /\[Desktop Entry\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? '';
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(group)?.[1]?.trim();
    const name = get('Name');
    if (!name) return null;
    return {name, exec: get('Exec') ?? '', hidden: /^true$/i.test(get('Hidden') ?? '') || /^false$/i.test(get('X-GNOME-Autostart-enabled') ?? '')};
}

/** An autostart file that turns the entry off (or back on) without touching the system's own copy. */
export function autostartOverride(original: string, off: boolean): string {
    const rest = original.split('\n').filter(l => !/^(Hidden|X-GNOME-Autostart-enabled)=/.test(l)).join('\n').trimEnd();
    return off ? rest.replace(/^(\[Desktop Entry\]\s*)$/m, '$1\nHidden=true') + '\n' : `${rest}\n`;
}
