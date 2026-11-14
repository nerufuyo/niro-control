// renders tools/wallpaper.html to ../assets/wallpaper3.png (3840x2160)
import {writeFileSync} from 'node:fs';
import {openPage} from '../scene/lib.mjs';
const p = await openPage('wide', 1, '', '/tools/wallpaper.html');
const s = await p.call('Runtime.evaluate', {expression: "document.getElementById('c').toDataURL('image/png')", returnByValue: true});
writeFileSync(new URL('../../assets/wallpaper3.png', import.meta.url).pathname, Buffer.from(s.result.value.split(',')[1], 'base64')); console.log(p.logs.join('\n') || 'ok'); p.close();
