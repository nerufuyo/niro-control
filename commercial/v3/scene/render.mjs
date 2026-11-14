// usage: node scene/render.mjs <wide|tall> <from> <to> <out.mp4> [crf]   -- renders frames [from, to) of the WebGL film at 60 fps straight into ffmpeg (no frame files)
import {spawn} from 'node:child_process';
import {openPage} from './lib.mjs';
const [aspect, from, to, out, crf = '12'] = process.argv.slice(2), FPS = 60;
const p = await openPage(aspect, 1);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(FPS), out], {stdio: ['pipe', 'inherit', 'inherit']});
const t0 = Date.now();
for (let f = Number(from); f < Number(to); f++) {
  const r = await p.call('Runtime.evaluate', {expression: `window.__render(${f / FPS})`, returnByValue: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  const s = await p.call('Runtime.evaluate', {expression: "document.querySelector('canvas').toDataURL('image/jpeg', 0.95)", returnByValue: true});
  if (!ff.stdin.write(Buffer.from(s.result.value.split(',')[1], 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
  if ((f - from) % 120 === 0) console.log(`frame ${f} (${((Date.now() - t0) / 1000 / (f - from + 1)).toFixed(2)} s/frame)`);
}
ff.stdin.end(); await new Promise(r => ff.on('close', r)); p.close(); console.log('done', out);
