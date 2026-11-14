// Renders frames [from, to) of film.html to an ffmpeg segment, driven by a deterministic timeline: window.__render(t) draws the frame at t seconds.
// usage: node render.mjs <aspect: wide|tall> <from> <to> <out.mp4> [fps=60]
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync, existsSync, statSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync} from 'node:fs';

const [aspect, from, to, out, fpsArg] = process.argv.slice(2);
const FPS = Number(fpsArg ?? 60), A = aspect === 'tall' ? {w: 1080, h: 1920, dsf: 1} : {w: 1920, h: 1080, dsf: 2};
const root = resolve(new URL('..', import.meta.url).pathname);
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2'};
const server = createServer((req, res) => {
    const p = join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': MIME[extname(p)] ?? 'application/octet-stream'}); res.end(readFileSync(p));
}).listen(0);
const port = server.address().port;
const profile = mkdtempSync(join(tmpdir(), 'niro-film-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu-vsync', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-gpu-rasterization', '--ignore-gpu-blocklist', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
const wsUrl = await new Promise(r => { let buf = ''; chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) r(m[1]); }); });
const port2 = new URL(wsUrl).port;
const tabs = await (await fetch(`http://127.0.0.1:${port2}/json`)).json();
const ws = new WebSocket((tabs.find(t => t.type === 'page') ?? tabs[0]).webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({id: i, method, params})); });
await call('Page.enable'); await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', {width: A.w, height: A.h, deviceScaleFactor: A.dsf, mobile: false});
await call('Page.navigate', {url: `http://127.0.0.1:${port}/film/film.html?aspect=${aspect}`});
for (let i = 0; i < 200; i++) { const r = await call('Runtime.evaluate', {expression: 'window.__ready === true', returnByValue: true}); if (r.result.value) break; await new Promise(r => setTimeout(r, 100)); }
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', out], {stdio: ['pipe', 'inherit', 'inherit']});
const t0 = Date.now();
for (let f = Number(from); f < Number(to); f++) {
    await call('Runtime.evaluate', {expression: `window.__render(${f / FPS}); 0`, awaitPromise: false});
    await call('Runtime.evaluate', {expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true});
    const shot = await call('Page.captureScreenshot', {format: 'jpeg', quality: 94, optimizeForSpeed: true});
    if (!ff.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
}
ff.stdin.end(); await new Promise(r => ff.on('close', r));
console.error(`frames ${from}-${to}: ${((Date.now() - t0) / 1000 / (to - from)).toFixed(2)} s/frame`);
chrome.kill(); server.close(); process.exit(0);
