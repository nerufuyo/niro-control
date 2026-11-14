// usage: node scene/preview.mjs <wide|tall> <scale> <outdir> t1 t2 ...   -> PNG stills of the real WebGL scene at those times
import {writeFileSync, mkdirSync} from 'node:fs';
import {openPage} from './lib.mjs';
const [aspect, scale, out, ...ts] = process.argv.slice(2); mkdirSync(out, {recursive: true});
const p = await openPage(aspect, Number(scale));
for (const t of ts) { const r = await p.call('Runtime.evaluate', {expression: `window.__render(${t})`, returnByValue: true}); if (r.exceptionDetails) { console.log('ERR at', t, r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); continue; }
  const s = await p.call('Runtime.evaluate', {expression: "document.querySelector('canvas').toDataURL('image/png')", returnByValue: true}); writeFileSync(`${out}/${aspect}-${String(Math.round(t*100)).padStart(5, "0")}.png`, Buffer.from(s.result.value.split(',')[1], 'base64')); }
if (p.logs.length) console.log(p.logs.slice(0, 5).join('\n')); p.close();
