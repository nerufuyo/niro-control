import {openPage} from './lib.mjs';
const [aspect, scale, t0, n] = process.argv.slice(2); const p = await openPage(aspect, Number(scale));
const t = Date.now(); let bytes = 0;
for (let i = 0; i < Number(n); i++) { await p.call('Runtime.evaluate', {expression: `window.__render(${Number(t0) + i / 60})`, returnByValue: true});
  const s = await p.call('Runtime.evaluate', {expression: "document.querySelector('canvas').toDataURL('image/jpeg', 0.93)", returnByValue: true}); bytes += s.result.value.length; }
console.log(aspect, scale, ((Date.now() - t) / n / 1000).toFixed(2), 's/frame', (bytes / n / 1e6).toFixed(2), 'MB/frame (b64)'); p.close();
