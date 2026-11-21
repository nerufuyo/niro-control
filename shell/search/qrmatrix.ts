// A QR code as a grid of dark and light cells, for `qr some text` in Search. The encoder is qrcode.ts (vendored, MIT).
import qrcodeLib from './qrcode.js';

declare const TextEncoder: any;
const qrcode: any = qrcodeLib;

/** The cells (true = dark), or null when the text is too long for a code that still scans (about 1,000 bytes). */
export function qrMatrix(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] | null {
    if (!text || new TextEncoder().encode(text).length > 1000) return null;
    qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));
    try {
        const qr = qrcode(0, level);
        qr.addData(text, 'Byte');
        qr.make();
        const n = qr.getModuleCount();
        return Array.from({length: n}, (_, r) => Array.from({length: n}, (_2, c) => qr.isDark(r, c)));
    } catch (_e) {
        return null;
    }
}

/** The grid as RGBA pixels with a four-cell quiet zone, `scale` pixels per cell (for tests and for drawing). */
export function qrPixels(cells: boolean[][], scale = 8): {data: Uint8ClampedArray; size: number} {
    const quiet = 4, n = cells.length, size = (n + quiet * 2) * scale;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const r = Math.floor(y / scale) - quiet, c = Math.floor(x / scale) - quiet;
        if (r >= 0 && c >= 0 && r < n && c < n && cells[r][c]) { const i = (y * size + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    }
    return {data, size};
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A greyscale PNG of the cells (no compression: a code is small), so no image library is needed to write or open it. */
export function qrPng(cells: boolean[][], scale = 8): Uint8Array {
    const {data, size} = qrPixels(cells, scale);
    const raw = new Uint8Array(size * (size + 1));              // each row: a filter byte (0) and the grey values
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw[y * (size + 1) + 1 + x] = data[(y * size + x) * 4];
    const blocks: number[] = [0x78, 0x01];
    for (let i = 0; i < raw.length; i += 65535) {
        const chunk = raw.subarray(i, Math.min(i + 65535, raw.length)), last = i + 65535 >= raw.length;
        blocks.push(last ? 1 : 0, chunk.length & 255, chunk.length >>> 8, ~chunk.length & 255, (~chunk.length >>> 8) & 255, ...chunk);
    }
    let a = 1, b = 0;
    for (const v of raw) { a = (a + v) % 65521; b = (b + a) % 65521; }
    blocks.push(...be32(((b << 16) | a) >>> 0));
    const chunk = (type: string, body: number[]): number[] => {
        const t = [...type].map(ch => ch.charCodeAt(0)), crcInput = Uint8Array.from([...t, ...body]);
        return [...be32(body.length), ...t, ...body, ...be32(crc32(crcInput))];
    };
    return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...be32(size), ...be32(size), 8, 0, 0, 0, 0]), ...chunk('IDAT', blocks), ...chunk('IEND', [])]);
}
