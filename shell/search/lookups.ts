// Search commands that look something up or act on a name: "tr id hello", "define serendipity", "qr some text", "kill firefox",
// "h docker" (terminal history), "fc invoice" (words inside files). Pure: each returns what to do, extension.ts does it.

declare const encodeURIComponent: (s: string) => string;

export const LANGS: Record<string, string> = {
    english: 'en', inggris: 'en', indonesian: 'id', indonesia: 'id', japanese: 'ja', jepang: 'ja', korean: 'ko', korea: 'ko',
    chinese: 'zh', mandarin: 'zh', cina: 'zh', arabic: 'ar', arab: 'ar', german: 'de', jerman: 'de', french: 'fr', prancis: 'fr',
    spanish: 'es', spanyol: 'es', dutch: 'nl', belanda: 'nl', russian: 'ru', rusia: 'ru', portuguese: 'pt', portugis: 'pt',
    italian: 'it', italia: 'it', turkish: 'tr', turki: 'tr', thai: 'th', hindi: 'hi', javanese: 'jv', jawa: 'jv', sundanese: 'su', sunda: 'su',
};
const CODES = new Set(Object.values(LANGS));

const langOf = (w: string): string | null => {
    const k = w.trim().toLowerCase();
    return LANGS[k] ?? (CODES.has(k) ? k : null);
};

export interface Translate {text: string; to: string; url: string}

/** "tr id hello there", "translate good morning to japanese", "terjemah selamat pagi ke inggris". */
export function translateQuery(query: string): Translate | null {
    const q = query.trim();
    let text: string | undefined, to: string | null = null;
    let m = /^(?:tr|translate|terjemah|terjemahkan)\s+([a-z]{2,10})\s+(.+)$/is.exec(q);
    if (m && langOf(m[1])) { to = langOf(m[1]); text = m[2]; }
    if (!to) {
        m = /^(?:tr|translate|terjemah|terjemahkan)\s+(.+?)\s+(?:to|ke|into)\s+([a-z]{2,10})$/is.exec(q);
        if (m && langOf(m[2])) { to = langOf(m[2]); text = m[1]; }
    }
    if (!to || !text) return null;
    text = text.trim().slice(0, 400);
    return {text, to, url: `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=Autodetect|${to}`};
}

/** The translated text out of the service's reply, or null. */
export function translated(json: any): string | null {
    const t = json?.responseData?.translatedText;
    return typeof t === 'string' && t.trim() && json?.responseStatus !== 403 ? t.trim() : null;
}

export interface Define {word: string; url: string}

/** "define serendipity", "def word", "meaning of word". English words. */
export function defineQuery(query: string): Define | null {
    const m = /^(?:define|def|meaning(?: of)?|definition(?: of)?)\s+([a-z][a-z'-]{1,40})$/i.exec(query.trim());
    return m ? {word: m[1].toLowerCase(), url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(m[1].toLowerCase())}`} : null;
}

/** The first few meanings: "noun: …", "verb: …". */
export function definitions(json: any, max = 3): string[] {
    const out: string[] = [];
    if (!Array.isArray(json)) return out;
    for (const entry of json) for (const meaning of entry?.meanings ?? []) for (const d of (meaning?.definitions ?? []).slice(0, 1)) {
        if (typeof d?.definition === 'string' && out.length < max) out.push(`${meaning.partOfSpeech}: ${d.definition}`);
    }
    return out;
}

/** "qr https://example.com" → the text to encode. */
export function qrText(query: string): string | null {
    const m = /^qr(?:code)?\s+(.+)$/is.exec(query.trim());
    return m ? m[1].trim().slice(0, 1000) : null;
}

/** "kill firefox", "matikan zoom" → the name to look for. */
export function killName(query: string): string | null {
    const m = /^(?:kill|matikan|stop|end)\s+([a-z0-9._+-]{2,40})$/i.exec(query.trim());
    return m ? m[1].toLowerCase() : null;
}

export interface Proc {pid: number; name: string}

/** `ps -o pid=,comm=` lines for the person's own processes, filtered by name (never this shell or the session itself), most specific first. */
export function matchProcesses(psOutput: string, needle: string, selfPid: number, limit = 6, extraProtected: string[] = []): Proc[] {
    const PROTECTED = new Set(['gnome-shell', 'gnome-session-b', 'systemd', 'dbus-broker', 'dbus-daemon', 'gdm', 'gdm-wayland-ses', 'pipewire', 'wireplumber', 'Xwayland', 'gjs', 'bash', 'sh']);
    for (const extra of extraProtected) PROTECTED.add(extra.trim());
    const lowerProtected = new Set([...PROTECTED].map(n => n.toLowerCase()));
    const procs: Proc[] = [];
    for (const line of psOutput.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const pid = +m[1], name = m[2];
        if (pid === selfPid || pid <= 1 || lowerProtected.has(name.toLowerCase()) || !name.toLowerCase().includes(needle)) continue;
        procs.push({pid, name});
    }
    return procs.sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)) || a.pid - b.pid).slice(0, limit);
}

/** "h docker", "history git push" → the words to look for in the shell history. */
export function historyNeedle(query: string): string | null {
    const m = /^(?:h|hist|history|riwayat)\s+(\S.*)$/i.exec(query.trim());
    return m ? m[1].trim().slice(0, 80) : null;
}

/** The newest matching commands from bash or zsh history text (zsh's ": 1700000000:0;cmd" prefix removed), without repeats. */
export function historyMatches(text: string, needle: string, limit = 8): string[] {
    const lines = text.split('\n').map(l => l.replace(/^: \d+:\d+;/, '').trim()).filter(l => l && !l.startsWith('#'));
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (lines[i].toLowerCase().includes(needle.toLowerCase()) && !seen.has(lines[i])) { seen.add(lines[i]); out.push(lines[i].slice(0, 300)); }
    }
    return out;
}

/** "fc invoice", "grep error", "isi proposal" → words to look for inside files. */
export function contentNeedle(query: string): string | null {
    const m = /^(?:fc|grep|isi|contents?)\s+(\S.{2,}|\S{3,})$/i.exec(query.trim());
    return m ? m[1].trim().slice(0, 80) : null;
}

/** `grep` arguments (no shell): case-insensitive, fixed string, text files only, first hit per file, not entering hidden or build folders. */
export function grepArgs(needle: string, dirs: string[]): string[] {
    return ['-rIlis', '-m', '1', '--exclude-dir=.*', '--exclude-dir=node_modules', '--exclude-dir=target', '--exclude-dir=build', '--exclude-dir=dist', '--exclude-dir=venv',
        '-F', '-e', needle, '--', ...dirs];
}
