// contact sheet of one still per shot at its representative moments: node scene/shots.mjs <wide|tall> <scale> <outdir> t...
import {writeFileSync, mkdirSync} from 'node:fs';
import {openPage} from './lib.mjs';
const [aspect, scale, out, ...ts] = process.argv.slice(2); mkdirSync(out, {recursive: true}); const p = await openPage(aspect, Number(scale));
for (const t of ts) { const r = await p.call('Runtime.evaluate', {expression: `window.__render(${t})`, returnByValue: true}); if (r.exceptionDetails) { console.log('ERR', t, r.exceptionDetails.exception?.description); continue; }
  const s = await p.call('Runtime.evaluate', {expression: "document.querySelector('canvas').toDataURL('image/png')", returnByValue: true}); writeFileSync(`${out}/${String(Math.round(t * 100)).padStart(5, '0')}.png`, Buffer.from(s.result.value.split(',')[1], 'base64')); }
console.log(p.logs.slice(0, 6).join('\n')); p.close();
