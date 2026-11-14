// NIRO — IT JUST FLOWS. 45 s director-led film. A grounded 2.5D desktop built from real, matted captures of NIRO (translucency recovered exactly from
// black/white captures), lit and framed shot by shot; physical 3D glass only where the story needs a material (opening macros, the logotype).
// window.__render(t) draws the frame at t seconds (deterministic). Every number in the SHOTS table is a directing decision, see docs/shotlist.md.
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {BokehPass} from 'three/addons/postprocessing/BokehPass.js';

const Q = new URLSearchParams(location.search), TALL = Q.get('aspect') === 'tall', SC = +(Q.get('scale') ?? 1);
const BASE = TALL ? [1080, 1920] : [3840, 2160], W = Math.round(BASE[0] * SC), H = Math.round(BASE[1] * SC);
const {Vector3: V3, Color} = THREE;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)), lerp = (a, b, k) => a + (b - a) * k;
const sm = (a, b, t) => { const x = clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const ease = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;           // cubic in-out
const eo = k => 1 - Math.pow(1 - clamp(k), 3);                                       // cubic out
const spr = (t, t0, f = 2.4, z = 0.62) => { const x = t - t0; if (x <= 0) return 0; const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + z / Math.sqrt(1 - z * z) * Math.sin(wd * x)); };
const seg = (t, a, b) => clamp((t - a) / (b - a));

// ---------------------------------------------------------------- music-sync map (audio/sync.mjs) and plate geometry
const SY = await (await fetch('/audio/sync.json')).json(), EV = SY.events, ENV = SY.env60, LOW = SY.low60, FLUX = SY.flux60;
const PB = {A: await (await fetch('/tex/plates-A.json')).json(), B: await (await fetch('/tex/plates-B.json')).json()};
const T = EV;   // alias: T.play, T.accent ...
const SHOT_T = [0, T['cut-s02'], T['cut-s03'], T['cursor-in'], T['pullback'], T['cut-s06'], T['cut-s07'], T['cut-s08'], T['cut-s09'], T['cut-s10'], T['cut-s11'], T['cut-s12'], 45];
const shotAt = t => { let i = 0; while (i < SHOT_T.length - 2 && t >= SHOT_T[i + 1]) i++; return i; };   // 0..11 -> S01..S12

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
renderer.setPixelRatio(1); renderer.setSize(W, H, false); document.body.appendChild(renderer.domElement); renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene(); scene.background = new Color(0x000000);
const camera = new THREE.PerspectiveCamera(30, W / H, 0.02, 400);
// focal lengths are given as full-frame equivalents (36 mm sensor width for 16:9, rotated for portrait)
const SENSOR = TALL ? {w: 20.25, h: 36} : {w: 36, h: 20.25};
const vfov = f => 2 * Math.atan(SENSOR.h / 2 / f) * 180 / Math.PI;
function setCam({x = 0, y = 0, z = 0, vw, f = 50, az = 0, el = 0, roll = 0}) {          // vw = world width the frame should see at the target plane
  const d = vw * f / SENSOR.w, a = az * Math.PI / 180, e = el * Math.PI / 180;
  camera.position.set(x + d * Math.sin(a) * Math.cos(e), y + d * Math.sin(e), z + d * Math.cos(a) * Math.cos(e)); camera.up.set(Math.sin(roll), Math.cos(roll), 0); camera.lookAt(x, y, z); camera.fov = vfov(f); camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- assets
const loader = new THREE.TextureLoader(), maxAniso = renderer.capabilities.getMaxAnisotropy();
const raw = t => { t.colorSpace = THREE.NoColorSpace; t.anisotropy = maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; return t; };
const load = u => new Promise((r, e) => loader.load(u, t => r(raw(t)), undefined, () => e(new Error('missing ' + u))));
const img = u => new Promise((r, e) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => e(new Error('missing ' + u)); i.src = u; });
const canvasTex = c => { const t = new THREE.CanvasTexture(c); return raw(t); };
const WALL = await load('/assets/wallpaper3.png');
const wallImg = await img('/assets/wallpaper3.png');
const WALLB = (() => { const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d'); g.filter = 'blur(26px)'; g.drawImage(wallImg, -80, -80, 2080, 1240); return canvasTex(c); })();
const names = ['topbar-paused', 'topbar-playing', 'open-paused', 'open-playing', 'dock-idle', 'dock-files', 'dock-both', 'files', 'editor', 'panel-look'];
const TEX = {A: {}, B: {}}; await Promise.all(['A', 'B'].flatMap(a => names.map(async n => { try { TEX[a][n] = await load(`/tex/${n}-${a}.png`); } catch (e) { TEX[a][n] = null; } })));
const TEXA = {}; await Promise.all(['search-open', 'search-a', 'search-acc', 'search-accent'].map(async n => { try { TEXA[n] = await load(`/tex/${n}-A.png`); } catch (e) { TEXA[n] = null; } }));
const ALBUM = await load('/tex/album.png');
// the two accent captures were taken minutes apart, so their clocks differ; the pill's clock digits are taken from the A capture in both looks (no time jump when the accent changes)
const patchClock = async n => { const [a, b] = await Promise.all([img(`/tex/${n}-A.png`), img(`/tex/${n}-B.png`)]), c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const g = c.getContext('2d'); g.drawImage(b, 0, 0);
  const x0 = Math.round(.27 * c.width), x1 = Math.round(.73 * c.width), y0 = Math.round(.08 * c.height), y1 = Math.round(.92 * c.height); g.clearRect(x0, y0, x1 - x0, y1 - y0); g.drawImage(a, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0); return canvasTex(c); };
TEX.B['topbar-playing'] = await patchClock('topbar-playing'); TEX.B['topbar-paused'] = await patchClock('topbar-paused');
// the open player's right half shows "No lyrics" for the demo track; replace that region with the body gradient so the visualiser sits in the player instead of over a message
const editOpen = async n => { const im = await img(`/tex/${n}-A.png`), c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const x0 = Math.round(.455 * c.width), x1 = Math.round(.945 * c.width), y0 = Math.round(.27 * c.height), y1 = Math.round(.87 * c.height), col = document.createElement('canvas'); col.width = 1; col.height = y1 - y0; col.getContext('2d').drawImage(c, x0, y0, 1, y1 - y0, 0, 0, 1, y1 - y0);
  g.clearRect(x0 + 1, y0, x1 - x0, y1 - y0); g.drawImage(col, 0, 0, 1, y1 - y0, x0 + 1, y0, x1 - x0, y1 - y0); return canvasTex(c); };
// the paused and playing captures were taken seconds apart (1:34 vs 1:29): the elapsed/remaining times and the progress bar are copied from the playing capture, so pressing Play only changes the icon
const editOpenP = async () => { const [p, q] = await Promise.all([img('/tex/open-paused-A.png'), img('/tex/open-playing-A.png')]), c = document.createElement('canvas'); c.width = p.width; c.height = p.height; const g = c.getContext('2d'); g.drawImage(p, 0, 0);
  const x0 = Math.round(.03 * c.width), x1 = Math.round(.52 * c.width), y0 = Math.round(.52 * c.height), y1 = Math.round(.70 * c.height); g.clearRect(x0, y0, x1 - x0, y1 - y0); g.drawImage(q, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; t.getContext('2d').drawImage(c, 0, 0); return t; };
{ const pc = await editOpenP(); const keep = TEX.A['open-paused']; TEX.A['open-playing'] = await editOpen('open-playing'); const im = new Image(); im.src = pc.toDataURL(); await new Promise(r => im.onload = r); const c2 = document.createElement('canvas'); c2.width = im.width; c2.height = im.height; const g2 = c2.getContext('2d'); g2.drawImage(im, 0, 0);
  const x0 = Math.round(.455 * c2.width), x1 = Math.round(.945 * c2.width), y0 = Math.round(.27 * c2.height), y1 = Math.round(.87 * c2.height), col = document.createElement('canvas'); col.width = 1; col.height = y1 - y0; col.getContext('2d').drawImage(c2, x0, y0, 1, y1 - y0, 0, 0, 1, y1 - y0); g2.clearRect(x0 + 1, y0, x1 - x0, y1 - y0); g2.drawImage(col, 0, 0, 1, y1 - y0, x0 + 1, y0, x1 - x0, y1 - y0); TEX.A['open-paused'] = canvasTex(c2); }

// ---------------------------------------------------------------- the glass sprite: a real capture with recovered alpha, composited over the film's own wallpaper with NIRO's backdrop blur
const WALL_SIZE = TALL ? [19.2 * 2.4, 10.8 * 2.4] : [19.2 * 1.6, 10.8 * 1.6];
const wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(...WALL_SIZE), new THREE.MeshBasicMaterial({map: WALL, toneMapped: false, depthWrite: false, depthTest: false})); wallMesh.renderOrder = -10; wallMesh.position.z = -0.02; scene.add(wallMesh);
const waveU = {value: new V3(0, 0, 0)};
const spriteMat = (texA, texB) => new THREE.ShaderMaterial({transparent: true, depthWrite: false, depthTest: false, uniforms: {map: {value: texA}, mapB: {value: texB ?? texA}, wall: {value: WALL}, wallBlur: {value: WALLB}, mixB: {value: 0}, opacity: {value: 1}, glass: {value: 1}, wave: waveU, lens: {value: new THREE.Vector2(0.5, 0)}, wallRect: {value: new THREE.Vector4(0, 0, WALL_SIZE[0], WALL_SIZE[1])}, clipY: {value: 1}, soft: {value: 0}, dim: {value: 1}},
  vertexShader: 'varying vec2 vUv; varying vec2 vW; void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.); vW=w.xy; gl_Position=projectionMatrix*viewMatrix*w; }',
  fragmentShader: `uniform sampler2D map,mapB,wall,wallBlur; uniform float mixB,opacity,glass,clipY,soft,dim; uniform vec3 wave; uniform vec2 lens; uniform vec4 wallRect; varying vec2 vUv; varying vec2 vW;
  void main(){ if(vUv.y < 1.-clipY) discard; vec2 uv=vUv; float dx=uv.x-lens.x; float lg=exp(-dx*dx/.012); uv.x=lens.x+dx/(1.+lens.y*lg); uv.y=.5+(uv.y-.5)/(1.+lens.y*lg*.55); vec4 a=texture2D(map,uv), b=texture2D(mapB,uv); float m=mixB;
    if(wave.z>0.){ float d=distance(vW,wave.xy); m=max(m,1.-smoothstep(wave.z-1.4,wave.z,d)); }
    vec4 c=mix(a,b,m); c.rgb*=dim; vec2 wuv=(vW-wallRect.xy)/wallRect.zw+.5; vec3 sharp=texture2D(wall,wuv).rgb, blur=texture2D(wallBlur,wuv).rgb;
    float t=soft>.5?0.:smoothstep(.12,.45,c.a); vec3 behind=mix(sharp,blur,glass*smoothstep(.3,.9,c.a)); vec3 opq=c.rgb*c.a+behind*(1.-c.a);
    gl_FragColor=vec4(mix(c.rgb,opq,t), mix(c.a,1.,t)*opacity); }`});
class Spr {
  constructor(texA, texB, box, order = 0) { this.box = box; this.w = box[2] / 400; this.h = box[3] / 400; this.mat = spriteMat(texA, texB); this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.w, this.h), this.mat); this.mesh.renderOrder = order; this.mesh.visible = false; scene.add(this.mesh); this.sx = 1; this.sy = 1; this.ax = 0; this.ay = 0; }
  // (x, y) is the sprite centre in the world; the anchor (ax, ay in -1..1) is the point scaling keeps fixed
  put(x, y, z = 0.01, sx = this.sx, sy = this.sy) { this.sx = sx; this.sy = sy; this.mesh.scale.set(sx, sy, 1); this.mesh.position.set(x - this.ax * this.w / 2 * (sx - 1), y - this.ay * this.h / 2 * (sy - 1), z); this.cx = x; this.cy = y; }
  op(o) { this.mat.uniforms.opacity.value = o; this.mesh.visible = o > 0.003; }
  at(fx, fy) { return new V3(this.cx + (fx - 0.5) * this.w * this.sx, this.cy + (0.5 - fy) * this.h * this.sy, 0.2); }   // world position of a point given as fractions of the plate (y down)
}
const EMPTY = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); EMPTY.needsUpdate = true;
const boxOf = (acc, n) => PB[acc][n] ?? [0, 0, 400, 400];
const mk = (n, order, texOverride) => { const A = texOverride ?? TEX.A[n] ?? EMPTY, B = texOverride ? null : (TEX.B[n] ?? A); return new Spr(A, B, boxOf('A', n), order); };
// every element exists in the A look (violet) and the B look (ember); a wave of light turns A into B on the accent click

// ---------------------------------------------------------------- desktop elements (world units: 1 unit = 100 logical px; screen = 19.2 x 10.8)
const SCREEN = {w: 19.2, h: 10.8};
const worldPos = (acc, n) => { const b = boxOf(acc, n); return [(b[0] + b[2] / 2 - 3840) / 400, (2160 - (b[1] + b[3] / 2)) / 400]; };   // where the capture put it on the 7680x4320 screen
const el = {
  pillP: mk('topbar-paused', 30), pillL: mk('topbar-playing', 31), openP: mk('open-paused', 32), openL: mk('open-playing', 33),
  dockI: mk('dock-idle', 20), dockF: mk('dock-files', 21), dockB: mk('dock-both', 22),
  files: mk('files', 10), editor: mk('editor', 12), panel: mk('panel-look', 14),
  sA: TEXA['search-open'] ? new Spr(TEXA['search-open'], null, PB.A['search-open'], 40) : null, sB: TEXA['search-a'] ? new Spr(TEXA['search-a'], null, PB.A['search-a'], 41) : null,
  sC: TEXA['search-acc'] ? new Spr(TEXA['search-acc'], null, PB.A['search-acc'], 42) : null, sD: TEXA['search-accent'] ? new Spr(TEXA['search-accent'], null, PB.A['search-accent'], 43) : null,
};
const alive = Object.values(el).filter(Boolean);
// the capture's own placement of each element is the desktop's natural placement (pill top centre, dock bottom centre)
const HOME = {}; for (const k of Object.keys(el)) if (el[k]) { const n = {pillP: 'topbar-paused', pillL: 'topbar-playing', openP: 'open-paused', openL: 'open-playing', dockI: 'dock-idle', dockF: 'dock-files', dockB: 'dock-both', files: 'files', editor: 'editor', panel: 'panel-look', sA: 'search-open', sB: 'search-a', sC: 'search-acc', sD: 'search-accent'}[k]; HOME[k] = worldPos('A', n); }
// layout of the finished desktop (director's placement, free of where the capture happened to put the windows)
for (const k of ['dockI', 'dockF', 'dockB']) if (HOME[k]) HOME[k][1] += 0.34;   // the dock floats a little above the bottom edge
const LAYOUT = {files: [-3.7, 0.15], editor: [3.55, -0.85], panel: [0, 0.15]}, WSC = 1.08;

// ---------------------------------------------------------------- the Island's visualiser: bars drawn into the empty half of the open player, from the supplied track's measured amplitude
const vc = document.createElement('canvas'); vc.width = 1600; vc.height = 700; const vg = vc.getContext('2d'); const vtex = canvasTex(vc);
const peak = ENV.reduce((a, b) => Math.max(a, b), 0.001);
function drawViz(t, k) {
  vg.clearRect(0, 0, vc.width, vc.height); const N = 28, f0 = Math.round(t * 60), bw = vc.width / N, mid = vc.height * 0.56; vg.shadowColor = 'rgba(180,200,255,.55)'; vg.shadowBlur = 26;
  for (let i = 0; i < N; i++) { const d = Math.abs(i - (N - 1) / 2), idx = clamp(f0 - Math.round(d * 2.1), 0, 2699), e = ENV[idx] / peak, lo = LOW[idx] / 120, fl = FLUX[clamp(f0 - Math.round(d * 1.5), 0, 2699)] / 25;
    const a = clamp(Math.pow(e, 1.35) * 0.85 + clamp(lo, 0, 1) * 0.25 + clamp(fl, 0, 1) * 0.3, 0, 1) * (1 - d / N * 0.5), hh = (10 + a * vc.height * 0.4) * k, x = i * bw + bw / 2;
    const gr = vg.createLinearGradient(0, mid - hh, 0, mid + hh); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(210,220,255,.7)'); vg.fillStyle = gr; vg.beginPath(); vg.roundRect(x - bw * 0.27, mid - hh, bw * 0.54, hh * 2, bw * 0.27); vg.fill(); }
  vtex.needsUpdate = true;
}
const vizMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 1.44), new THREE.MeshBasicMaterial({map: vtex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, opacity: 0})); vizMesh.renderOrder = 34; scene.add(vizMesh);

// ---------------------------------------------------------------- cursor
const cc = document.createElement('canvas'); cc.width = cc.height = 160; { const g = cc.getContext('2d'); g.translate(30, 14); g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 8; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 88); g.lineTo(21, 69); g.lineTo(35, 100); g.lineTo(51, 93); g.lineTo(37, 62); g.lineTo(64, 60); g.closePath(); g.lineWidth = 6; g.strokeStyle = '#000'; g.stroke(); g.fillStyle = '#fff'; g.fill(); }
const cursor = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({map: canvasTex(cc), transparent: true, depthWrite: false, depthTest: false, toneMapped: false, opacity: 0})); cursor.renderOrder = 100; scene.add(cursor);
cursor.geometry.translate(0.25 - 0.09, -0.25 + 0.04, 0);   // hot spot at the arrow tip
let curTarget = null;
function moveCursor(path, t, vis = 1) {   // path: [[t, V3], ...]; eased between points, with a click dip at the points flagged click
  let p = null; if (t >= path[0][0] && t <= path.at(-1)[0]) { let i = 0; while (i < path.length - 2 && t > path[i + 1][0]) i++; const a = path[i], b = path[i + 1]; p = a[1].clone().lerp(b[1], ease(seg(t, a[0], b[0]))); }
  let dip = 0; for (const [tc] of path.filter(q => q[2])) dip = Math.max(dip, Math.exp(-Math.pow((t - tc) / 0.06, 2)));
  if (p) { cursor.position.copy(p); cursor.scale.setScalar((1 - 0.16 * dip) * (TALL ? 1.5 : 1)); cursor.material.opacity = vis; curTarget = p; } else cursor.material.opacity = 0;
}

// ---------------------------------------------------------------- physical glass for the opening and the logotype (colour-managed path)
const envScene = new THREE.Scene(); envScene.background = new Color(0x02030a);
{ const box = (w, h, col, k, pos) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({color: new Color(col).multiplyScalar(k), side: THREE.DoubleSide})); m.position.set(...pos); m.lookAt(0, 0, 0); envScene.add(m); };
  box(16, 5, 0x6aa8ff, 4.5, [-13, 9, 9]); box(3, 18, 0xa78bff, 4, [15, 1, -3]); box(24, .4, 0xffffff, 14, [0, 15, 3]); box(12, 3, 0x2a48ff, 1.5, [0, -13, 7]); box(2, 12, 0xffffff, 3, [-15, -1, -7]); box(10, .3, 0xbfd8ff, 8, [9, -8, 10]); box(14, 2.4, 0xdfe9ff, 5, [0, 3, 14]); box(3, 10, 0x8fb0ff, 3.5, [6, 0, 12]); }
const pmrem = new THREE.PMREMGenerator(renderer); const ENVTEX = pmrem.fromScene(envScene, 0.015).texture; pmrem.dispose();
scene.environment = ENVTEX; scene.environmentIntensity = 1.0;   // only the physical-glass shots use it (the UI sprites are unlit)
function rr(w, h, r) { const s = new THREE.Shape(), x = -w / 2, y = -h / 2, P = Math.PI; r = Math.max(0.001, Math.min(r, w / 2, h / 2));
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -P / 2, 0, false); s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, P / 2, false); s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, P / 2, P, false); s.lineTo(x, y + r); s.absarc(x + r, y + r, r, P, 1.5 * P, false); return s; }
const slabGeo = (w, h, r, d, b) => { b = Math.min(b, d / 2 - 0.001); const g = new THREE.ExtrudeGeometry(rr(w, h, r), {depth: Math.max(0.002, d - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 8, curveSegments: 36}); g.translate(0, 0, -(d - 2 * b) / 2); return g; };
const PILL = {w: 1.5, h: 0.28, r: 0.105};
const pbr = new THREE.Group(); scene.add(pbr); pbr.visible = false;
const capGeo = new THREE.CapsuleGeometry(PILL.h / 2, PILL.w - PILL.h, 24, 64); capGeo.rotateZ(Math.PI / 2); capGeo.scale(1, 1, 0.62);
const capsule = new THREE.Mesh(capGeo, new THREE.MeshPhysicalMaterial({color: 0xffffff, metalness: 0, roughness: 0.05, transmission: 1, ior: 1.45, thickness: 0.35, attenuationColor: new Color(0x10204a), attenuationDistance: 0.35, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 4, specularIntensity: 1})); pbr.add(capsule);
const sheetMat = new THREE.MeshPhysicalMaterial({color: 0xffffff, metalness: 0, roughness: 0.03, transmission: 1, ior: 1.5, thickness: 0.5, attenuationColor: new Color(0x9ec2ff), attenuationDistance: 1.6, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 3.2, dispersion: 0.2});
const sheet = new THREE.Mesh(slabGeo(3.2, 1.1, 0.5, 0.3, 0.1), sheetMat); pbr.add(sheet);
const backGlow = new THREE.Mesh(new THREE.PlaneGeometry(14, 8), new THREE.ShaderMaterial({ uniforms: {k: {value: 0}, c: {value: new THREE.Vector2(0.5, 0.5)}},
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'varying vec2 vUv; uniform float k; uniform vec2 c; void main(){ vec2 p=(vUv-c)*vec2(1.7,1.); float a=exp(-dot(p,p)*9.); float b=exp(-pow(length(p-vec2(.26,-.08)),2.)*28.); float d=exp(-pow(length(p+vec2(.3,.1)),2.)*34.); float e=smoothstep(0.,.18,vUv.x)*smoothstep(1.,.82,vUv.x)*smoothstep(0.,.18,vUv.y)*smoothstep(1.,.82,vUv.y); gl_FragColor=vec4((vec3(.16,.26,.8)*a+vec3(.5,.32,1.)*b+vec3(.22,.5,1.)*d)*k*e+vec3(.004,.006,.02),1.);}'})); backGlow.position.z = -2.5; pbr.add(backGlow);
const beam = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.04), new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {k: {value: 0}}, vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'varying vec2 vUv; uniform float k; void main(){ float a=1.-abs(vUv.y-.5)*2.; float b=exp(-pow((vUv.x-.5)*2.6,2.)*3.); gl_FragColor=vec4(vec3(.8,.9,1.)*a*a*b*k*3.,1.);}'})); beam.position.z = 0.35; pbr.add(beam);
const key = new THREE.PointLight(0xcfe0ff, 0, 20, 1.5); pbr.add(key);
// logotype: Inter, extruded
const logoData = await (await fetch('/tex/logo.json')).json(); const logo = new THREE.Group(); logo.visible = false; scene.add(logo);
{ const sp = new THREE.ShapePath(); for (const c of logoData.cmds) { if (c.type === 'M') sp.moveTo(c.x, -c.y); else if (c.type === 'L') sp.lineTo(c.x, -c.y); else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y); else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y); }
  const g = new THREE.ExtrudeGeometry(sp.toShapes(false), {depth: 150, bevelEnabled: true, bevelThickness: 30, bevelSize: 22, bevelSegments: 8, curveSegments: 14}); g.computeBoundingBox(); const bb = g.boundingBox, k = 5.2 / (bb.max.x - bb.min.x); g.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, -75); g.scale(k, k, k);
  const m = sheetMat.clone(); m.thickness = 1.4; m.attenuationColor = new Color(0xc4d4ff); m.attenuationDistance = 3.5; m.dispersion = 0.45; m.envMapIntensity = 3.0; m.roughness = 0; m.emissive = new Color(0.38, 0.5, 0.95); m.emissiveIntensity = 0.75; logo.add(new THREE.Mesh(g, m)); }
const textTex = (txt, w, h, px, weight = 300, ls = 8) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.font = `${weight} ${px}px "Inter Variable", Inter, sans-serif`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = ls + 'px'; g.fillText(txt, w / 2, h / 2); return canvasTex(c); };
const tagMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.5), new THREE.MeshBasicMaterial({map: textTex('Make Linux Feel Different.', 2048, 160, 82), transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false})); tagMesh.renderOrder = 60; scene.add(tagMesh);
const yoursMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 0.55), new THREE.MeshBasicMaterial({map: textTex('Make it yours.', 1760, 220, 118), transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false})); yoursMesh.renderOrder = 60; scene.add(yoursMesh);
const keyMeshes = ['Super', 'Space'].map(l => { const c = document.createElement('canvas'); c.width = 360; c.height = 200; const g = c.getContext('2d'); g.fillStyle = 'rgba(14,18,40,.78)'; g.beginPath(); g.roundRect(6, 6, 348, 188, 40); g.fill(); g.strokeStyle = 'rgba(190,210,255,.55)'; g.lineWidth = 4; g.stroke(); g.fillStyle = '#fff'; g.font = '500 78px "Inter Variable", Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(l, 180, 102);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.61), new THREE.MeshBasicMaterial({map: canvasTex(c), transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false})); m.renderOrder = 61; scene.add(m); return m; });

// dust, very restrained (opening only)
// ---------------------------------------------------------------- post
const rt = new THREE.WebGLRenderTarget(W, H, {type: THREE.HalfFloatType, samples: 4}); const composer = new EffectComposer(renderer, rt); composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera)); const bokeh = new BokehPass(scene, camera, {focus: 5, aperture: 0, maxblur: 0}); composer.addPass(bokeh);
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.0, 0.5, 1.0); composer.addPass(bloom);
const grade = new ShaderPass({uniforms: {tDiffuse: {value: null}, fade: {value: 1}, grain: {value: 0.004}, vig: {value: 0.3}, seed: {value: 0}, asp: {value: W / H}},
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float fade,grain,vig,seed,asp; varying vec2 vUv; float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+seed)*43758.5453);} void main(){ vec2 c=vUv-.5; float r2=dot(c*vec2(asp,1.),c*vec2(asp,1.)); vec3 col=texture2D(tDiffuse,vUv).rgb; col*=1.-vig*smoothstep(.2,1.,r2*1.6); col+=(h(vUv*vec2(1731.,1093.))-.5)*grain; gl_FragColor=vec4(max(col*fade,0.),1.); }'});
composer.addPass(grade); const outPass = new OutputPass(); composer.addPass(outPass);

// accent wave: a thin ring of ember light travelling over the desktop, and a soft ember glow once the desktop has turned
const ring = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 160), new THREE.MeshBasicMaterial({color: new Color(1, 0.42, 0.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false})); ring.renderOrder = 90; scene.add(ring);
const glowC = document.createElement('canvas'); glowC.width = glowC.height = 512; { const g = glowC.getContext('2d'), r = g.createRadialGradient(256, 256, 0, 256, 256, 256); r.addColorStop(0, 'rgba(255,120,60,.9)'); r.addColorStop(.4, 'rgba(255,90,50,.35)'); r.addColorStop(1, 'rgba(255,80,40,0)'); g.fillStyle = r; g.fillRect(0, 0, 512, 512); }
const glowE = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.MeshBasicMaterial({map: canvasTex(glowC), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false})); glowE.renderOrder = 5; glowE.position.set(1.2, 0.8, -0.01); scene.add(glowE);
// ---------------------------------------------------------------- shot helpers
const hideAll = () => { for (const e of alive) { e.op(0); e.mat.uniforms.soft.value = 0; e.mat.uniforms.dim.value = 1; e.mat.uniforms.lens.value.set(0.5, 0); } wallMesh.material.color.setRGB(1, 1, 1); ring.material.opacity = 0; glowE.material.opacity = 0; vizMesh.material.opacity = 0; cursor.material.opacity = 0; pbr.visible = false; logo.visible = false; tagMesh.material.opacity = 0; yoursMesh.material.opacity = 0; for (const k of keyMeshes) k.material.opacity = 0; wallMesh.visible = true; };
const showWall = (x = 0, y = 0) => { wallMesh.visible = true; wallMesh.position.set(0, 0, -0.02); };
const MODE = {ui: THREE.LinearSRGBColorSpace, pbr: THREE.SRGBColorSpace};
function ui(mode) { renderer.outputColorSpace = MODE[mode]; }
const accentWave = t => { const k = seg(t, T.accent, T.accent + 1.6); waveU.value.set(0, 0.2, k > 0 ? lerp(0.2, 17.5, eo(k)) : 0); return k; };

// ---------------------------------------------------------------- the shots
// Each shot sets everything it shows; nothing else is visible. t is film time. See docs/shotlist.md for the intent behind every number.
const S = [];
// S01 — macro glass highlight (0 -> cut-s02): a bevelled glass edge, a precise light sweep, nothing else
S[0] = t => { ui('pbr'); pbr.visible = true; wallMesh.visible = false; capsule.visible = false; sheet.visible = true; sheet.position.set(0, 0, 0); sheet.rotation.set(0.1, -0.32, 0.05); backGlow.material.uniforms.k.value = 0.5 * sm(0, 1.2, t); backGlow.material.uniforms.c.value.set(0.34, 0.5);
  const sw = seg(t, 0.35, T.sweep + 0.7); beam.visible = true; beam.position.set(lerp(-4.5, 4.5, ease(sw)), 0.12, 0.45); beam.rotation.z = -0.08; beam.material.uniforms.k.value = Math.sin(clamp(sw) * Math.PI); key.position.set(beam.position.x, 0.5, 0.9); key.intensity = beam.material.uniforms.k.value * 260;
  setCam({x: 0.6 + 0.05 * t, y: 0.18, vw: 2.4, f: 100, az: -8 + 1.4 * t, el: 3}); bloom.strength = 0.25 + 0.25 * beam.material.uniforms.k.value; bokeh.uniforms.focus.value = camera.position.length(); bokeh.uniforms.aperture.value = 0.0012; bokeh.uniforms.maxblur.value = 0.006; };
// S02 — 3/4 macro (65 mm): a limited arc around the Island's glass body
S[1] = t => { ui('pbr'); pbr.visible = true; wallMesh.visible = false; sheet.visible = false; capsule.visible = true; capsule.rotation.set(0, 0, 0); beam.visible = false; key.intensity = 0; backGlow.material.uniforms.k.value = 0.42; backGlow.material.uniforms.c.value.set(0.55, 0.45);
  const k = seg(t, T['cut-s02'], T['cut-s03']); setCam({x: 0, y: 0, vw: 2.2, f: 65, az: lerp(-34, -6, ease(k)), el: lerp(7, 3, k)}); bloom.strength = 0.3; bokeh.uniforms.focus.value = camera.position.length(); bokeh.uniforms.aperture.value = 0.0008; bokeh.uniforms.maxblur.value = 0.004; };
// S03 — frontal Island, 50 mm: a clear pause on the real pill, before anything happens
S[2] = t => { ui('ui'); showWall(); const [px, py] = HOME.pillP; el.pillP.put(px, py, 0.1); el.pillP.op(1); setCam({x: 0, y: py - 0.05, vw: TALL ? 3.4 : 5.2, f: 50}); bloom.strength = 0; bokeh.uniforms.aperture.value = 0; bokeh.uniforms.maxblur.value = 0; };

// ---- shared state of the desktop over time (what is open, what is playing, which accent) so every shot agrees with the story
const PT = {play: [0.205, 0.78], pillC: [0.5, 0.5], dockFiles: [0.235, 0.5], notes: [0.762, 0.205], editorTitle: [0.5, 0.045], ember: [0.338, 0.442], panelTone: [0.5, 0.455], vizX: 1.79, vizY: -0.1};   // calibrated from the plates (fractions, y down)
const LAYOUT_T = {files: [-0.2, -2.7], editor: [0.6, 2.25], panel: [0, 0.15]};
const LY = TALL ? LAYOUT_T : LAYOUT;
const ED = [0, 0];   // where the editor is dragged to (over the bright part of the wallpaper) and where it stays
const accentK = t => seg(t, T.accent, T.accent + 1.6);
// the Island: pill that opens into the player (S04/S05), shown by whichever shot needs it
function island(t, {openK = 0, playing = false, ghost = 1}) {
  const [px, py] = HOME.pillP, [ox, oy] = HOME.openL; const pl = playing ? 1 : 0, pk = 1 - sm(0, 0.35, openK);
  el.pillP.put(px, py, 0.1); el.pillL.put(px, py, 0.1); el.pillP.op(ghost * pk * (1 - pl)); el.pillL.op(ghost * pk * pl);
  for (const [k, e] of [['openP', el.openP], ['openL', el.openL]]) { e.ax = 0; e.ay = 1; const topY = oy + e.h / 2; e.put(ox, topY - e.h / 2 * 0, 0.12, lerp(0.216, 1, openK), lerp(0.139, 1, openK)); e.mesh.position.y = topY - e.h * e.sy / 2 * 1; }
  const o = ghost * sm(0.05, 0.5, openK); el.openP.op(o * (1 - pl)); el.openL.op(o * pl);
  return o;
}
const dockAt = (t, rise = 1) => { const [dx, dy] = HOME.dockB; for (const k of ['dockI', 'dockF', 'dockB']) el[k].put(dx, dy - (1 - rise) * 0.9, 0.1); };
const setMix = (t, list) => { const m = TALL ? 0 : 0; const wk = accentK(t); for (const e of list) { e.mat.uniforms.mixB.value = t >= T.accent + 1.7 ? 1 : 0; } waveU.value.set(0, 0, 0); if (t >= T.accent && t < T.accent + 1.7) { const [wx, wy] = [LY.panel[0] + (PT.ember[0] - 0.5) * el.panel.w, LY.panel[1] + (0.5 - PT.ember[1]) * el.panel.h]; waveU.value.set(wx, wy, lerp(0.2, 22, eo(wk))); } };
const deskState = t => ({files: t >= T['cut-s07'] - 0.15, editor: t >= T['editor-open']});
const S04Y = TALL ? 0.9 : 2.95;   // wide: the top of the Island sits on the top edge of the frame, as it does on the real screen
// S04 — locked medium close-up (50 mm): the Island opens, Play is pressed, the music answers
S[3] = t => { ui('ui'); showWall(); const k = spr(t, T['pill-click'], 1.9, 0.78); const o = island(t, {openK: k, playing: t >= T.play}); const [ox, oy] = HOME.openL;
  const vk = sm(T.play + 0.25, T.play + 0.9, t) * sm(0.8, 1, k); vizMesh.position.set(ox + (PT.vizX ?? 1.62), oy + (PT.vizY ?? -0.02), 0.3); vizMesh.material.opacity = vk; if (vk > 0) drawViz(t, 0.35 + 0.65 * vk);
  setCam({x: 0, y: S04Y, vw: TALL ? 8.6 : 9.0, f: 50});
  const pc = el.pillP.at(...PT.pillC), pp = new V3(el.openL.cx + (PT.play[0] - 0.5) * el.openL.w, el.openL.cy + el.openL.h / 2 - PT.play[1] * el.openL.h, 0.3); const away = pc.clone().add(new V3(1.6, -1.1, 0));
  const playPos = new V3(ox + (PT.play[0] - 0.5) * el.openL.w, 5.4 - PT.play[1] * el.openL.h, 0.3);
  moveCursor([[T['cursor-in'], away], [T['pill-click'] - 0.02, pc, true], [T['pill-click'] + 0.45, pc], [T.play - 0.04, playPos, true], [T.play + 0.9, playPos.clone().add(new V3(0.5, -0.4, 0))]], t, sm(T['cursor-in'], T['cursor-in'] + 0.3, t) * (1 - sm(T.play + 0.6, T.play + 1.1, t)));
  bloom.strength = 0; bokeh.uniforms.aperture.value = 0; };
// S05 — controlled pull-back (50 -> 35 mm): from the player to the whole desktop; the dock arrives, the Island settles back into the top of the screen
S[4] = t => { ui('ui'); showWall(); const k = ease(seg(t, T.pullback, T['cut-s06'])); const closeK = sm(15.7, 16.4, t);
  const o = island(t, {openK: 1 - closeK * 0.999, playing: true}); const [ox, oy] = HOME.openL; vizMesh.position.set(ox + (PT.vizX ?? 1.62), oy + (PT.vizY ?? -0.02), 0.3); vizMesh.material.opacity = (1 - sm(15.6, 16.0, t)); drawViz(t, 1);
  const rise = spr(t, T['dock-in'], 1.5, 0.75); dockAt(t, rise); const dop = sm(T['dock-in'] - 0.05, T['dock-in'] + 0.25, t); el.dockI.op(dop);
  const a = {y: S04Y, vw: TALL ? 8.6 : 9.0, f: 50}, b = {y: 0.0, vw: TALL ? 11.4 : 19.4, f: 35}; setCam({x: 0, y: lerp(a.y, b.y, k), vw: lerp(a.vw, b.vw, k), f: lerp(a.f, b.f, k)});
  const playPos = new V3(ox + (PT.play[0] - 0.5) * el.openL.w, 5.4 - PT.play[1] * el.openL.h, 0.3), [dx, dy] = HOME.dockB;
  moveCursor([[T.pullback - 0.4, playPos.clone().add(new V3(0.5, -0.4, 0))], [15.9, new V3(0.6, 1.2, 0.3)], [T['cut-s06'] - 0.2, new V3(dx - 0.6, dy + 0.5, 0.3)]], t, 1 - sm(T['cut-s06'] - 0.5, T['cut-s06'] - 0.1, t)); bloom.strength = 0; };
const FILES_ICON = () => el.dockI.at(...PT.dockFiles);
// S06 — low 3/4 on the Dock (45 mm): the pointer slides along, icons magnify, Files launches (a running dot appears)
S[5] = t => { ui('ui'); showWall(); const [px, py] = HOME.pillP; el.pillL.put(px, py, 0.1); el.pillL.op(1); const [dx, dy] = HOME.dockB; dockAt(t, 1); const ic = FILES_ICON();
  const run = sm(T.launch, T.launch + 0.18, t); el.dockI.op(1 - run); el.dockF.op(run); el.dockI.mat.uniforms.opacity.value = 1 - run;
  const a = new V3(ic.x + 1.55, ic.y + 0.02, 0.3), b = ic.clone(); const cx = ic.x - (el.dockI.cx - el.dockI.w / 2); const u = clamp((lerp(a.x, b.x, ease(seg(t, T['cut-s06'] + 0.3, T.launch - 0.1))) - (el.dockI.cx - el.dockI.w / 2)) / el.dockI.w);
  for (const k of ['dockI', 'dockF']) { el[k].mat.uniforms.lens && (el[k].mat.uniforms.lens.value.set(u, 0.9 * sm(T['cut-s06'] + 0.4, T['cut-s06'] + 0.9, t) * (1 - sm(T.launch + 0.2, T.launch + 0.5, t)))); }
  const az = lerp(-30, -24, seg(t, T['cut-s06'], T['cut-s07'])); setCam({x: ic.x + 0.35, y: dy + 0.02, vw: TALL ? 3.4 : 3.2, f: 45, az: TALL ? -22 : az, el: -9});
  moveCursor([[T['cut-s06'] + 0.1, a], [T.launch - 0.04, b, true], [T['cut-s07'], b.clone().add(new V3(0.1, 0.3, 0))]], t, sm(T['cut-s06'] + 0.1, T['cut-s06'] + 0.4, t)); bloom.strength = 0; };
// S07 — front-facing workflow (50 mm): Files, a file, an editor that opens because of it
S[6] = t => { ui('ui'); showWall(); const [px, py] = HOME.pillP; el.pillL.put(px, py, 0.1); el.pillL.op(1); dockAt(t, 1); el.dockF.op(t >= T['editor-open'] ? 0 : 1); el.dockB.op(t >= T['editor-open'] ? 1 : 0);
  const fo = sm(T['cut-s07'] - 0.15, T['cut-s07'] + 0.1, t) * 0 + 1, settle = 0.965 + 0.035 * eo(seg(t, T['cut-s07'], T['cut-s07'] + 0.3)); el.files.put(LY.files[0], LY.files[1], 0.1, settle * WSC, settle * WSC); el.files.op(1);
  const eo2 = seg(t, T['editor-open'], T['editor-open'] + 0.3), es = 0.94 + 0.06 * eo(eo2); el.editor.put(LY.editor[0], LY.editor[1], 0.14, es * WSC, es * WSC); el.editor.op(sm(T['editor-open'], T['editor-open'] + 0.18, t));
  setCam(TALL ? {x: 0.2, y: -0.1, vw: 10.2, f: 50} : {x: -0.45, y: 0, vw: 15.6, f: 50});
  const n = el.files.at(...PT.notes), start = new V3(n.x + 2.4, n.y - 2.2, 0.3); moveCursor([[T['cut-s07'] + 0.2, start], [T['file-click'] - 0.05, n, true], [T['editor-open'] - 0.2, n], [T['editor-open'] - 0.12, n, true], [T['editor-open'] - 0.0, n, true], [T['cut-s08'] - 0.1, n.clone().add(new V3(0.5, -0.5, 0))]], t, sm(T['cut-s07'] + 0.1, T['cut-s07'] + 0.4, t)); bloom.strength = 0; };
// S08 — 3/4 glass detail (85 mm): the Files window slides down under the Dock; the Dock's real glass lets it show through, at a slight angle so the layers read as depth
S[7] = t => { ui('ui'); showWall(); const [px, py] = HOME.pillP; el.pillL.put(px, py, 0.1); el.pillL.op(1); const [dx, dy] = HOME.dockB; for (const k of ['dockI', 'dockF', 'dockB']) el[k].put(dx, dy, 0.5); el.dockB.op(1); el.dockB.mat.uniforms.soft.value = 1;
  const d = ease(seg(t, T['cut-s08'] + 0.05, T['cut-s08'] + 1.1)) - ease(seg(t, T['cut-s09'] - 1.5, T['cut-s09'] - 0.25)), fy = LY.files[1] - (TALL ? 3.2 : 3.5) * d; el.files.put(LY.files[0], fy, 0.1, WSC, WSC); el.files.op(1); el.editor.put(LY.editor[0], LY.editor[1], 0.14, WSC, WSC); el.editor.op(1);
  const k = seg(t, T['cut-s08'], T['cut-s09']), ic = new V3(dx - 0.2, dy, 0); setCam(TALL ? {x: dx - 0.2, y: dy + 0.7, vw: 3.8, f: 65, az: 18, el: -4} : {x: dx - 0.2 - 0.5 * k, y: dy + 0.85, vw: 5.0, f: 85, az: 25 - 5 * k, el: -4}); bloom.strength = 0; };
// S09 — centred Search (50 mm): Super+Space, a query, one result, one action
S[8] = t => { ui('ui'); showWall(); const [px, py] = HOME.pillL ? HOME.pillL : HOME.pillP; el.pillL.put(px, py, 0.1); el.pillL.op(1); dockAt(t, 1); el.dockB.op(1); el.files.put(LY.files[0], LY.files[1], 0.1, WSC, WSC); el.files.op(1); el.editor.put(LY.editor[0], LY.editor[1], 0.14, WSC, WSC); el.editor.op(1); el.files.mat.uniforms.dim.value = 0.5; el.editor.mat.uniforms.dim.value = 0.5;
  const so = sm(T['search-open'], T['search-open'] + 0.14, t) * (1 - sm(T.enter + 0.05, T.enter + 0.35, t)), sc = 0.965 + 0.035 * eo(seg(t, T['search-open'], T['search-open'] + 0.28)) - 0.03 * sm(T.enter + 0.05, T.enter + 0.35, t);
  const stages = [[el.sA, T['search-open'], T.type], [el.sB, T.type, T.type + 0.3], [el.sC, T.type + 0.3, T.type + 0.6], [el.sD, T.type + 0.6, 99]];
  for (const [e, a, b] of stages) { if (!e) continue; const [hx, hy] = [(e.box[0] + e.box[2] / 2 - 3840) / 400, 0]; const topY = (2160 - 578) / 400; e.ax = 0; e.ay = 1; e.put(hx, topY - e.h / 2, 0.2, sc, sc); e.mesh.position.y = topY - e.h * sc / 2; e.op(so * sm(a, a + 0.08, t) * (1 - (b < 99 ? sm(b, b + 0.08, t) : 0))); }
  const cx = 0.55 * (1 - 0); const kk = seg(t, T['cut-s09'], T['cut-s10']); setCam({x: 0, y: TALL ? 1.2 : 1.6, vw: (TALL ? 3.3 : 5.6) * (1 - 0.07 * kk), f: 50});
  const kc = ['Super', 'Space'].map((_, i) => keyMeshes[i]); const ka = sm(T['search-open'] - 0.5, T['search-open'] - 0.3, t) * (1 - sm(T['search-open'] + 0.1, T['search-open'] + 0.35, t)); kc[0].position.set(-0.7, -1.9, 0.6); kc[1].position.set(0.75, -1.9, 0.6); kc[0].quaternion.copy(camera.quaternion); kc[1].quaternion.copy(camera.quaternion); for (const m of kc) m.material.opacity = ka * 0.95; bloom.strength = 0; };
// S10 — the Control Panel (locked, whole desktop): choosing an accent turns the glass of the whole desktop with a travelling wave
S[9] = t => { ui('ui'); showWall(); const pk = accentK(t); const mixList = [el.pillL, el.dockB, el.files, el.editor, el.panel]; const [px, py] = HOME.pillP; el.pillL.put(px, py, 0.1); el.pillL.op(1); dockAt(t, 1); el.dockB.op(1); el.files.put(LY.files[0], LY.files[1], 0.1, WSC, WSC); el.files.op(1); el.editor.put(LY.editor[0], LY.editor[1], 0.14, WSC, WSC); el.editor.op(1);
  const open = 0.965 + 0.035 * eo(seg(t, T['cut-s10'] - 0.3, T['cut-s10'] + 0.1)); el.panel.put(LY.panel[0], LY.panel[1], 0.3, open, open); el.panel.op(1); setMix(t, mixList); el.files.mat.uniforms.dim.value = 0.5; el.editor.mat.uniforms.dim.value = 0.5;
  { const k2 = sm(T.accent, T.accent + 1.8, t); wallMesh.material.color.setRGB(1, 1 - 0.1 * k2, 1 - 0.18 * k2); glowE.material.opacity = 0.16 * k2; const wk = accentK(t); if (wk > 0 && wk < 1) { ring.position.set(waveU.value.x, waveU.value.y, 0.6); ring.scale.setScalar(Math.max(0.05, waveU.value.z)); ring.material.opacity = 0.7 * (1 - wk); } }
  setCam(TALL ? {x: -1.2, y: 0.4, vw: 7.4, f: 50} : {x: 0, y: 0.1, vw: 19.8, f: 50});
  const ember = new V3(LY.panel[0] + (PT.ember[0] - 0.5) * el.panel.w, LY.panel[1] + (0.5 - PT.ember[1]) * el.panel.h, 0.5), from = ember.clone().add(new V3(3.2, -2.4, 0)); moveCursor([[T['cut-s10'] + 0.3, from], [T.accent - 0.05, ember, true], [T.accent + 0.9, ember.clone().add(new V3(1.2, -1.4, 0))]], t, sm(T['cut-s10'] + 0.3, T['cut-s10'] + 0.7, t));
  yoursMesh.position.set(0, 4.55, 0.6); yoursMesh.scale.setScalar(TALL ? 1.45 : 1.7); yoursMesh.quaternion.copy(camera.quaternion); yoursMesh.material.opacity = sm(T.yours, T.yours + 0.6, t) * (1 - sm(T['cut-s11'] - 0.35, T['cut-s11'] - 0.05, t)); bloom.strength = 0; };
// S11 — the finished desktop, wide (35 mm), a held composition
S[10] = t => { ui('ui'); showWall(); const [px, py] = HOME.pillP; el.pillL.put(px, py, 0.1); el.pillL.op(1); dockAt(t, 1); el.dockB.op(1); el.files.put(LY.files[0], LY.files[1], 0.1, WSC, WSC); el.files.op(1); el.editor.put(LY.editor[0], LY.editor[1], 0.14, WSC, WSC); el.editor.op(1);
  for (const e of [el.pillL, el.dockB, el.files, el.editor]) e.mat.uniforms.mixB.value = 1; waveU.value.set(0, 0, 0); const k = seg(t, T['cut-s11'], T['cut-s12']); wallMesh.material.color.setRGB(1, 0.9, 0.82); glowE.material.opacity = 0.2; glowE.position.set(0.8, 0.9, -0.01);
  setCam(TALL ? {x: 0, y: 0, vw: 11.6 - 0.2 * k, f: 35} : {x: 0, y: 0.12, vw: 19.4 - 0.35 * k, f: 35}); bloom.strength = 0; };
// S12 — NIRO. (centred, clean dark, a minimal halo)
S[11] = t => { ui('pbr'); pbr.visible = true; wallMesh.visible = false; capsule.visible = false; sheet.visible = false; beam.visible = false; key.intensity = 0; backGlow.material.uniforms.k.value = 0.22 * sm(T['cut-s12'], T['cut-s12'] + 1.4, t); backGlow.material.uniforms.c.value.set(0.5, 0.48); backGlow.position.set(0, 0.3, -1.6); backGlow.scale.set(TALL ? 2.2 : 1, TALL ? 2.6 : 1, 1); logo.visible = true;
  const k = ease(seg(t, T['cut-s12'], T['cut-s12'] + 1.8)); logo.position.set(0, 0.45, 0); logo.rotation.set(0.04 * (1 - k), lerp(-0.22, 0.0, k), 0); logo.scale.setScalar(lerp(0.96, 1, k));
  tagMesh.position.set(0, -0.95, 0); tagMesh.scale.setScalar(TALL ? 0.5 : 1); tagMesh.material.opacity = sm(T['cut-s12'] + 0.9, T['cut-s12'] + 1.7, t); tagMesh.quaternion.identity();
  setCam({x: 0, y: 0.25, vw: TALL ? 7.8 : 8.4, f: 50}); bloom.strength = 0.35; bokeh.uniforms.aperture.value = 0; bokeh.uniforms.maxblur.value = 0; };
window.__shots = S;
window.__render = t => { const i = shotAt(t); hideAll(); S[i](t); grade.uniforms.fade.value = sm(0, 0.3, t) * (1 - sm(44.3, 45, t)); grade.uniforms.seed.value = (Math.round(t * 60) % 97) * 0.37; grade.uniforms.vig.value = i < 2 || i === 11 ? 0.5 : 0.28; composer.render(); return true; };
window.__ready = true;
