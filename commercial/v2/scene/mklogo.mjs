// Turns the word "NIRO." (Inter, the font NIRO's UI uses) into outline commands the 3D scene extrudes into a glass logotype.
import opentype from 'opentype.js';
import {writeFileSync} from 'node:fs';
const f = opentype.loadSync('/usr/share/fonts/truetype/island/InterVariable.ttf');
const p = f.getPath('NIRO.', 0, 0, 1000, {kerning: true}), bb = p.getBoundingBox();
writeFileSync('tex/logo.json', JSON.stringify({bbox: bb, cmds: p.commands}));
console.log(bb, p.commands.length);
