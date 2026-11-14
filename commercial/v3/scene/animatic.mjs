// Low-resolution animatic of the whole film (actual plates, actual camera, actual music excerpt) for review before any final render.
// usage: node scene/animatic.mjs <wide|tall> <scale> <fps> <out.mp4>
import {spawn} from 'node:child_process';
import {openPage} from './lib.mjs';
const [aspect, scale, fps, out] = process.argv.slice(2), F = Number(fps);
const p = await openPage(aspect, Number(scale));
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(F), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', out], {stdio: ['pipe', 'inherit', 'inherit']});
for (let f = 0; f < 45 * F; f++) {
  const r = await p.call('Runtime.evaluate', {expression: `window.__render(${f / F})`, returnByValue: true}); if (r.exceptionDetails) { console.log('ERR t=', f / F, r.exceptionDetails.exception?.description); break; }
  const s = await p.call('Runtime.evaluate', {expression: "document.querySelector('canvas').toDataURL('image/jpeg', 0.9)", returnByValue: true}); if (!ff.stdin.write(Buffer.from(s.result.value.split(',')[1], 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
}
ff.stdin.end(); await new Promise(r => ff.on('close', r)); console.log(p.logs.slice(0, 5).join('\n')); p.close(); console.log('done', out);
