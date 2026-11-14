// Renders chosen times of the film to PNG for inspection: node preview.mjs <wide|tall> <outdir> t1 t2 ...
import {spawn} from 'node:child_process'; import {createServer} from 'node:http'; import {readFileSync, existsSync, statSync, mkdirSync, writeFileSync, mkdtempSync} from 'node:fs'; import {extname, join, resolve} from 'node:path'; import {tmpdir} from 'node:os';
const [aspect, outdir, ...times] = process.argv.slice(2); mkdirSync(outdir, {recursive: true});
const A = aspect === 'tall' ? {w: 1080, h: 1920, dsf: 1} : {w: 1920, h: 1080, dsf: 1};   // previews at 1x: fast
const root = resolve(new URL('..', import.meta.url).pathname), MIME = {'.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json'};
const server = createServer((req, res) => { const p = join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, {'content-type': MIME[extname(p)] ?? 'application/octet-stream'}); res.end(readFileSync(p)); }).listen(0);
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nf-'))}`, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
const wsUrl = await new Promise(r => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) r(m[1]); }); });
const tabs = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json`)).json(); const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({id: i, method, params})); });
await call('Page.enable'); await call('Runtime.enable'); await call('Emulation.setDeviceMetricsOverride', {width: A.w, height: A.h, deviceScaleFactor: A.dsf, mobile: false});
await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/film/film.html?aspect=${aspect}`});
for (let i = 0; i < 300; i++) { const r = await call('Runtime.evaluate', {expression: 'window.__ready === true', returnByValue: true}); if (r.result.value) break; await new Promise(r => setTimeout(r, 100)); }
for (const t of times) { await call('Runtime.evaluate', {expression: `window.__render(${t}); 0`}); await call('Runtime.evaluate', {expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true}); const shot = await call('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(outdir, `t${String(t).replace('.', '_')}.png`), Buffer.from(shot.data, 'base64')); }
chrome.kill(); server.close(); process.exit(0);
