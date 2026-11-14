// Shared by preview.mjs and render.mjs: a local static server (v2/, plus the real captures under /shots) and a Chrome (GPU WebGL) driven over CDP.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync, existsSync, statSync, mkdtempSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root = resolve(new URL('..', import.meta.url).pathname), shots = resolve(root, '../assets/shots');
const MIME = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json'};
export async function openPage(aspect, scale = 1, extra = '') {
  const server = createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); const p = u.startsWith('/shots/') ? join(shots, u.slice(7)) : join(root, u);
    if (!(p.startsWith(root) || p.startsWith(shots)) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': MIME[extname(p)] ?? 'application/octet-stream'}); res.end(readFileSync(p)); }).listen(0);
  const port = server.address().port, W = Math.round((aspect === 'tall' ? 1080 : 3840) * scale), H = Math.round((aspect === 'tall' ? 1920 : 2160) * scale);
  const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--enable-gpu', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'niro3d-'))}`, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  const wsUrl = await new Promise(r => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) r(m[1]); }); });
  const tabs = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json`)).json(), ws = new WebSocket((tabs.find(t => t.type === 'page') ?? tabs[0]).webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r)); let id = 0; const pend = new Map(); const logs = [];
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') logs.push(JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)); else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map(a => a.value ?? a.description).join(' ')); });
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({id: i, method, params})); });
  await call('Page.enable'); await call('Runtime.enable'); await call('Emulation.setDeviceMetricsOverride', {width: W, height: H, deviceScaleFactor: 1, mobile: false});
  await call('Page.navigate', {url: `http://127.0.0.1:${port}/scene/index.html?aspect=${aspect}&scale=${scale}${extra}`});
  for (let i = 0; i < 600; i++) { const r = await call('Runtime.evaluate', {expression: 'window.__ready === true', returnByValue: true}); if (r.result.value) break; if (logs.length) throw new Error(logs.join('\n')); await new Promise(r => setTimeout(r, 100)); if (i === 599) throw new Error('page never became ready ' + logs.join('\n')); }
  return {call, logs, W, H, close() { chrome.kill(); server.close(); }};
}
