// Smart Clipboard core (vNext S17): transforms that return a NEW string (the clipboard is never changed until the person picks the result),
// a sensitive-content check, and expiry. Pure.

export const CASES = ['upper', 'lower', 'title', 'snake', 'camel', 'kebab'];

const words = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);

export function convertCase(text, kind) {
    if (!CASES.includes(kind))
        throw new Error(`unknown case "${kind}"`);
    switch (kind) {
    case 'upper': return text.toUpperCase();
    case 'lower': return text.toLowerCase();
    case 'title': return text.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase());
    case 'snake': return words(text).map(w => w.toLowerCase()).join('_');
    case 'kebab': return words(text).map(w => w.toLowerCase()).join('-');
    default: return words(text).map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('');
    }
}

/** Plain text from simple rich text: tags and common entities removed, runs of blank lines collapsed. */
export function removeFormatting(text) {
    return text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Pretty JSON, or {error} with the parser's message. */
export function formatJson(text, indent = 2) {
    try {
        return {text: JSON.stringify(JSON.parse(text), null, indent)};
    } catch (e) {
        return {error: e.message};
    }
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|_hsenc|_hsmi|ref_src)$/i;

/**
 * The URL without tracking parameters; text that is not an http(s) URL comes back unchanged. Written without the `URL` class on purpose:
 * GNOME Shell's JavaScript (GJS) has no global `URL`, so code that needs one silently takes its "not a URL" branch there.
 */
export function cleanUrl(text) {
    const m = /^(https?:\/\/[^\s?#]+)(\?[^\s#]*)?(#\S*)?$/i.exec(String(text).trim());
    if (!m)
        return text;
    const keep = (m[2] ?? '').slice(1).split('&').filter(p => {
        if (!p)
            return false;
        let key = p.split('=')[0];
        try { key = decodeURIComponent(key); } catch (_e) { /* the raw key is matched */ }
        return !TRACKING.test(key);
    });
    const base = /^https?:\/\/[^/]+$/i.test(m[1]) ? `${m[1]}/` : m[1];
    return base + (keep.length ? `?${keep.join('&')}` : '') + (m[3] ?? '');
}

const luhn = digits => {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = Number(digits[i]);
        if (alt && (d *= 2) > 9)
            d -= 9;
        sum += d;
        alt = !alt;
    }
    return sum % 10 === 0;
};

/** Why `text` looks like a secret ('private-key', 'token', 'jwt', 'card', 'password-line', 'long-secret'), or null. Errs toward flagging. */
export function sensitiveKind(text) {
    const t = text.trim();
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t))
        return 'private-key';
    if (/\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abp]-[A-Za-z0-9-]{10,}\b|\bsk-[A-Za-z0-9_-]{20,}\b/.test(t))
        return 'token';
    if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/.test(t))
        return 'jwt';
    const digits = t.replace(/[ -]/g, '');
    if (/^\d{13,19}$/.test(digits) && /^[\d -]+$/.test(t) && luhn(digits))
        return 'card';
    if (/^\s*(password|passwd|pwd|passphrase|secret|api[_-]?key|token)\s*[:=]\s*\S+/im.test(t))
        return 'password-line';
    if (!/\s/.test(t) && t.length >= 32 && /[A-Za-z]/.test(t) && /\d/.test(t) && /^[A-Za-z0-9+/_=-]+$/.test(t))
        return 'long-secret';
    return null;
}

/** True when an item stored at `savedAt` (ms) is past its time to live; pinned items never expire. ttlMs <= 0 means keep. */
export function isExpired(item, nowMs, ttlMs) {
    return !item.pinned && ttlMs > 0 && nowMs - item.savedAt >= ttlMs;
}

/** The history to keep: sensitive items dropped (unless `keepSensitive`), expired items dropped. */
export function prune(items, nowMs, {ttlMs = 0, keepSensitive = false} = {}) {
    return items.filter(i => !isExpired(i, nowMs, ttlMs) && (keepSensitive || i.pinned || !sensitiveKind(i.text ?? '')));
}
