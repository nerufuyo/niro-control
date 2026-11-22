// One frame as a PNG, to look at the film without rendering it. usage: node still.mjs <t seconds> <out.png> [<t> <out.png> ...]
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync, existsSync, statSync, writeFileSync, mkdtempSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
const args = process.argv.slice(2), root = resolve(new URL('../..', import.meta.url).pathname);
const MIME = {'.html': 'text/html', '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf'};
const server = createServer((req, res) => { const p = join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, {'content-type': MIME[extname(p)] ?? 'application/octet-stream'}); res.end(readFileSync(p)); }).listen(0);
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'niro-still-'))}`, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
const wsUrl = await new Promise(r => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) r(m[1]); }); });
const tabs = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json`)).json();
const ws = new WebSocket((tabs.find(t => t.type === 'page') ?? tabs[0]).webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({id: i, method, params})); });
await call('Page.enable'); await call('Runtime.enable'); await call('Emulation.setDeviceMetricsOverride', {width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false});
await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/commercial/v4/film.html`});
for (let i = 0; i < 300; i++) { const r = await call('Runtime.evaluate', {expression: 'window.__ready === true', returnByValue: true}); if (r.result.value) break; await new Promise(r => setTimeout(r, 100)); }
for (let i = 0; i < args.length; i += 2) {
    await call('Runtime.evaluate', {expression: `window.__render(${args[i]}); 0`});
    await call('Runtime.evaluate', {expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true});
    writeFileSync(args[i + 1], Buffer.from((await call('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
}
chrome.kill(); server.close(); process.exit(0);
