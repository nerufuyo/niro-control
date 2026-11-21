// Finding what to hide in a screenshot from tesseract's TSV output: e-mail addresses, phone and card numbers, long keys and tokens.
// Pure (text in, boxes out) so tests can run it; niro-snip.ts runs tesseract and turns the boxes into pixelate marks.

export interface OcrWord {text: string; left: number; top: number; width: number; height: number; line: string}

/** The words of `tesseract <image> stdout tsv`: level 5 rows, with their position and the line they are on. */
export function parseTsv(tsv: string): OcrWord[] {
    const words: OcrWord[] = [];
    for (const row of tsv.split('\n')) {
        const c = row.split('\t');
        if (c.length < 12 || c[0] !== '5') continue;
        const text = c.slice(11).join('\t').trim();
        const [left, top, width, height] = c.slice(6, 10).map(Number);
        if (!text || ![left, top, width, height].every(Number.isFinite)) continue;
        words.push({text, left, top, width, height, line: `${c[2]}.${c[3]}.${c[4]}`});
    }
    return words;
}

const digits = (s: string) => (s.match(/\d/g) ?? []).length;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const WORD_SECRET = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_\-+/=]{24,}$/;      // an API key or token: long, letters and digits mixed
const PHONE = /^\+?[\d().\- ]{8,}$/;

export type Box = [number, number, number, number];

/** Boxes (x1, y1, x2, y2, a little padded) over the words that look private. */
export function sensitiveBoxes(words: OcrWord[], pad = 3): Box[] {
    const hit = new Set<number>();
    words.forEach((w, i) => {
        const t = w.text.replace(/^[<("'\[]+|[>)"'\],.;:]+$/g, '');
        if (EMAIL.test(t) || WORD_SECRET.test(t) || (PHONE.test(t) && digits(t) >= 8) || digits(t) >= 9) hit.add(i);
    });
    // a card number or a phone number split by spaces ("4242 4242 4242 4242", "0812 3456 7890"): runs of digit groups on one line
    for (let i = 0; i < words.length; i++) {
        if (!/^\d{3,5}$/.test(words[i].text)) continue;
        let j = i;
        while (j + 1 < words.length && words[j + 1].line === words[i].line && /^\d{3,5}$/.test(words[j + 1].text)) j++;
        if (j > i && words.slice(i, j + 1).reduce((n, w) => n + w.text.length, 0) >= 10) for (let k = i; k <= j; k++) hit.add(k);
        i = j;
    }
    // a phone number's country code is its own word ("+62 812-3456-7890"; OCR often reads the + as t): it goes with the number
    for (const i of [...hit]) {
        const prev = words[i - 1];
        if (i > 0 && prev.line === words[i].line && /^[+t]?\(?\d{1,4}\)?$/.test(prev.text) && PHONE.test(words[i].text)) hit.add(i - 1);
    }
    return [...hit].sort((a, b) => a - b).map(i => {
        const w = words[i];
        return [w.left - pad, w.top - pad, w.left + w.width + pad, w.top + w.height + pad] as Box;
    });
}
