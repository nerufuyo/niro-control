// Niro the slime drawn with Cairo: every mood onto a surface, and what the pixels say. With NIRO_SLIME_SHEET=<file.png> a contact
// sheet of the moods is written, to look at.
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {MOODS, Slime} from '../../shell/island/build/src/slime.js';
import {drawSlime} from '../../shell/island/build/src/slimeDraw.js';

const fail = message => { printerr(`FAIL slimeDraw: ${message}`); imports.system.exit(1); };
const SIZE = 240;

function render(mood, seed, seconds) {
    const slime = new Slime(seed);
    slime.setMood(mood);
    slime.step(seconds);
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, SIZE, SIZE);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGBA(0, 0, 0, 1);
    cr.paint();
    drawSlime(cr, slime.frame(), SIZE);
    cr.$dispose();
    return surface;
}

/** The pixels of a surface, through a PNG file (Cairo's own data is not reachable from GJS). */
function pixels(surface) {
    const [fd, file] = GLib.file_open_tmp('slime-XXXXXX.png');
    GLib.close(fd);
    surface.writeToPNG(file);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
    GLib.unlink(file);
    return {data: pixbuf.get_pixels(), stride: pixbuf.get_rowstride(), n: pixbuf.get_n_channels()};
}

const at = (img, x, y) => [0, 1, 2].map(c => img.data[y * img.stride + x * img.n + c]);
const lit = img => { let n = 0; for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { const [r, g, b] = at(img, x, y); if (r + g + b > 30) n++; } return n; };

const shots = [];
for (const mood of MOODS) {
    const surface = render(mood, 7, 2.5);
    const img = pixels(surface);
    const n = lit(img);
    // A body fills a fair part of the square, and never all of it.
    if (n < 6000 || n > 50000) fail(`${mood}: ${n} lit pixels`);
    // Its middle is blue (the body), not black; its corners are black.
    const [r, g, b] = at(img, 120, 150);
    if (!(b > g && g > r && b > 150)) fail(`${mood}: the body is not blue at its middle (${r},${g},${b})`);
    const corner = at(img, 4, 4);
    if (corner.some(v => v > 20)) fail(`${mood}: the corner is not black (${corner})`);
    shots.push(surface);
}

// The calm slime has dark eyes where eyes belong, and an alert one a red rim.
const idle = pixels(render('idle', 7, 2.5));
const [er, eg, eb] = at(idle, 90, 146);
if (!(er < 60 && eg < 60 && eb < 90)) fail(`no eye at (90,146): ${er},${eg},${eb}`);
const alert = pixels(render('alert', 7, 2.5));
let reds = 0;
for (let y = 60; y < 215; y++) for (let x = 20; x < 220; x++) { const [r, g, b] = at(alert, x, y); if (r > 150 && r > b + 40 && r > g + 40) reds++; }
if (reds < 150) fail(`an alert shows too little red (${reds})`);

const sheet = GLib.getenv('NIRO_SLIME_SHEET');
if (sheet) {
    const out = new Cairo.ImageSurface(Cairo.Format.ARGB32, 4 * SIZE, 3 * SIZE);
    const cr = new Cairo.Context(out);
    shots.forEach((s, i) => { cr.setSourceSurface(s, (i % 4) * SIZE, Math.floor(i / 4) * SIZE); cr.paint(); });
    out.writeToPNG(sheet);
    cr.$dispose();
}
print('slimeDraw: ok');
