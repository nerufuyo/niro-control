// NIRO 45 s launch film, v2: a real three.js scene (geometry, physical glass, lit by an image-based environment, a virtual camera that
// flies through it), rendered frame by frame. UI plates are the real captures from capture/steps-*.sh, mapped onto slabs of glass.
// window.__render(t) draws the frame at t seconds; everything is a pure function of t (deterministic, so chunks can render in parallel).
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
const sm5 = (a, b, t) => { const x = clamp((t - a) / (b - a)); return x * x * x * (x * (x * 6 - 15) + 10); };
// damped spring step response: 0 -> 1 starting at t0 (f = natural frequency in Hz, z = damping ratio)
const spr = (t, t0, f = 2.2, z = 0.55) => { const x = t - t0; if (x <= 0) return 0; const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + z / Math.sqrt(1 - z * z) * Math.sin(wd * x)); };
const mix3 = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));

// ---------------------------------------------------------------- audio analysis (music-sync map from analysis/choose.mjs)
const A = await (await fetch('/audio/analysis.json')).json();
const E = A.events, ENV = A.envelope60, FLUX = A.flux60, LOW = A.low60;
const strongOn = A.onsets.filter(o => o.s > 1.0).map(o => o.t);
const snap = (t, tol = 0.2) => { let b = null; for (const o of strongOn) { const d = Math.abs(o - t); if (d <= tol && (!b || d < b.d)) b = {t: o, d}; } return b ? b.t : t; };
const pulses = A.onsets.filter(o => o.s > 1.6).map(o => ({t: o.t, s: Math.min(1, o.s / 4)}));
const pulseAt = t => { let p = 0; for (const o of pulses) { const d = t - o.t; if (d >= 0 && d < 1) p += o.s * Math.exp(-d / 0.16); } return Math.min(1.2, p); };
const envAt = (t, back = 0) => ENV[clamp(Math.round((t - back) * 60), 0, 2699)] ?? 0;
const T = {
  morph0: 4.35, morph1: E.islandBirth + 1.7, pillClick: snap(9.15), play: E.playClick, waves: E.wavesStart, pass: E.passThrough,
  dock: E.dockRise, launch: E.appLaunch, editor: snap(22.5), world: E.glassWorld, sOpen: E.searchOpen, sRes: E.searchResult,
  shift: E.appearanceShift, profile: E.profileSwitch, logo: E.logoReveal,
};

// ---------------------------------------------------------------- renderer
const D = 14.8, FOV0 = 40, comp = z => (D - z) / D;   // canonical camera: z = D, fov 40 -> the z = 0 plane is the 1920x1080 desktop (19.2 x 10.8 units)
const renderer = new THREE.WebGLRenderer({antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
renderer.setPixelRatio(1); renderer.setSize(W, H, false); document.body.appendChild(renderer.domElement);
renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene(); scene.background = new Color(0x010208);
const camera = new THREE.PerspectiveCamera(FOV0, W / H, 0.05, 200);

// image-based environment: dark studio with softboxes, so glass edges pick up blue key / violet rim / thin white strips
function makeEnv() {
  const s = new THREE.Scene(); s.background = new Color(0x02030a);
  const box = (w, h, col, k, pos) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({color: new Color(col).multiplyScalar(k), side: THREE.DoubleSide})); m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m); };
  box(16, 5, 0x6aa8ff, 5, [-13, 9, 9]); box(3, 18, 0xa78bff, 4.5, [15, 1, -3]); box(24, .5, 0xffffff, 16, [0, 15, 3]); box(12, 3, 0x2a48ff, 1.8, [0, -13, 7]);
  box(2, 12, 0xffffff, 3, [-15, -1, -7]); box(8, 8, 0x1a2a66, 1.1, [0, 2, -16]); box(10, .4, 0xbfd8ff, 10, [9, -8, 10]);
  const pm = new THREE.PMREMGenerator(renderer); const t = pm.fromScene(s, 0.015).texture; pm.dispose(); return t;
}
scene.environment = makeEnv(); scene.environmentIntensity = 1.0;

const loader = new THREE.TextureLoader(), maxAniso = renderer.capabilities.getMaxAnisotropy();
const load = u => new Promise(r => loader.load(u, t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; r(t); }));
const img = u => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const TX = {}; await Promise.all(['files', 'editor', 'dock', 'search-open', 'search-fire', 'search-calc', 'search-setting', 'panel-look', 'panel-e-0', 'panel-e-dialog', 'album'].map(async n => TX[n] = await load(`/tex/${n}.png`)));
TX.wall = await load('/tex/wallpaper.jpg');
const PL = {}; await Promise.all(['g-pill-paused', 'g-pill-playing', 'g-open-paused', 'g-open-playing'].map(async n => PL[n] = await img(`/tex/${n}.png`)));
// the accent / glass variants of the Look page are cropped in-page from the same real captures
const lookImgs = {}; await Promise.all(['c-look-a', 'c-look-accent', 'c-look-crystal'].map(async n => lookImgs[n] = await img(`/shots/${n}.jpg`)));
const cropTex = (im, x, y, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, x, y, w, h, 0, 0, w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; return t; };
TX['look-a'] = cropTex(lookImgs['c-look-a'], 770, 352, 2271, 1458); TX['look-b'] = cropTex(lookImgs['c-look-accent'], 770, 352, 2271, 1458); TX['look-c'] = cropTex(lookImgs['c-look-crystal'], 770, 352, 2271, 1458);

// ---------------------------------------------------------------- geometry helpers
function rr(w, h, r) { const s = new THREE.Shape(), x = -w / 2, y = -h / 2; r = Math.max(0.001, Math.min(r, w / 2, h / 2)); const P = Math.PI;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -P / 2, 0, false); s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, P / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, P / 2, P, false); s.lineTo(x, y + r); s.absarc(x + r, y + r, r, P, 1.5 * P, false); return s; }
function slabGeo(w, h, r, d, b) { b = Math.min(b, d / 2 - 0.001, w / 2 - 0.01, h / 2 - 0.01); const g = new THREE.ExtrudeGeometry(rr(w - 2 * b * 0, h, r), {depth: Math.max(0.002, d - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 6, curveSegments: 28});
  g.translate(0, 0, -(d - 2 * b) / 2); return g; }
function uiGeo(w, h, r, u0 = 0, u1 = 1, v0 = 0, v1 = 1) { const g = new THREE.ShapeGeometry(rr(w, h, r), 28), p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, lerp(u0, u1, p.getX(i) / w + 0.5), lerp(v0, v1, p.getY(i) / h + 0.5)); return g; }
const swap = (m, g) => { m.geometry.dispose(); m.geometry = g; };

// ---------------------------------------------------------------- materials
const glassMat = () => new THREE.MeshPhysicalMaterial({color: 0xffffff, metalness: 0, roughness: 0.04, transmission: 1, ior: 1.5, thickness: 0.6, attenuationColor: new Color(0x9ec2ff), attenuationDistance: 1.4, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 1, envMapIntensity: 1.6, dispersion: 0.25});
const darkMat = () => new THREE.MeshPhysicalMaterial({color: 0x070a14, metalness: 0.15, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 2.0, transparent: true});
const uiMat = (map, op = 1) => new THREE.MeshBasicMaterial({map, transparent: true, opacity: op, toneMapped: false, depthWrite: true});
const glossMat = () => new THREE.MeshPhysicalMaterial({color: 0x000000, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.12, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false});
const sheenMat = () => new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {ph: {value: -1}, k: {value: 0}, tint: {value: new Color(0.55, 0.7, 1)}},
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'varying vec2 vUv; uniform float ph,k; uniform vec3 tint; void main(){float d=vUv.x*0.8-vUv.y*0.6-ph; float s=exp(-d*d*38.)*0.9+exp(-pow(d+.18,2.)*220.)*0.5; gl_FragColor=vec4(tint*s*k,1.);}'});

// ---------------------------------------------------------------- scene objects
class Elem { // canonical-desktop placement: (cx, cy) is where it sits on the real 1920x1080 desktop, z is how far it floats toward / away from the viewer
  constructor(cx, cy, z) { this.root = new THREE.Group(); this.inner = new THREE.Group(); this.root.add(this.inner); this.cx = cx; this.cy = cy; this.z = z; scene.add(this.root); }
  apply() { const c = this.free ? 1 : comp(this.z); this.root.position.set(this.cx * c, this.cy * c, this.z); this.root.scale.setScalar(c); }   // free: world units, no canonical-desktop compensation
}
// wallpaper: the real wallpaper, far behind everything
const wall = new THREE.Mesh(new THREE.PlaneGeometry(19.2 * 3, 10.8 * 3), new THREE.MeshBasicMaterial({map: TX.wall, transparent: true, opacity: 0, toneMapped: false, depthWrite: false}));
{ const c = comp(-16); wall.scale.setScalar(c); wall.position.z = -16; wall.renderOrder = -10; scene.add(wall); }

class Win extends Elem { // a window as a thick slab of glass: dark body with beveled edges, the real UI capture on its face, glossy skin, a travelling sheen
  constructor(tex, w, h, r, cx, cy, z, depth = 0.2) { super(cx, cy, z); this.w = w; this.h = h; this.r = r; this.d = depth;
    this.body = new THREE.Mesh(slabGeo(w, h, r, depth, 0.05), darkMat()); this.inner.add(this.body);
    const fz = depth / 2 + 0.004; this.ui = new THREE.Mesh(uiGeo(w - 0.1, h - 0.1, r - 0.04), uiMat(tex)); this.ui.position.z = fz; this.inner.add(this.ui);
    this.gloss = new THREE.Mesh(uiGeo(w - 0.1, h - 0.1, r - 0.04), glossMat()); this.gloss.position.z = fz + 0.003; this.inner.add(this.gloss);
    this.sheen = new THREE.Mesh(uiGeo(w - 0.1, h - 0.1, r - 0.04), sheenMat()); this.sheen.position.z = fz + 0.006; this.inner.add(this.sheen); this.inner.visible = false; }
  set opacity(o) { this.body.material.opacity = o; this.ui.material.opacity = o; this.gloss.material.opacity = o; this.inner.visible = o > 0.003; }
  setTex(t) { this.ui.material.map = t; }
}
const pxU = 1 / 200;     // 3840 px = 19.2 units
const files = new Win(TX.files, 1700 * pxU, 1100 * pxU, 0.12, -3.4, -0.9, -7.5); files.free = true;
const editor = new Win(TX.editor, 1500 * pxU, 1050 * pxU, 0.12, 3.6, 0.5, -11); editor.free = true;
const panel = new Win(TX['look-a'], 2271 * pxU, 1458 * pxU, 0.12, -0.075, -0.005, -0.2);   // the real Control Panel at its real position
const dock = new Win(TX.dock, 570 * pxU, 100 * pxU, 0.25, 0.0, -3.2, -3.5, 0.12); dock.free = true;
// dock: magnify the icons under the pointer (a lens on the UVs)
dock.ui.material = new THREE.ShaderMaterial({transparent: true, depthWrite: true, uniforms: {map: {value: TX.dock}, cx: {value: 0.5}, amt: {value: 0}, op: {value: 1}},
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'varying vec2 vUv; uniform sampler2D map; uniform float cx,amt,op; void main(){ vec2 uv=vUv; float dx=uv.x-cx; float g=exp(-dx*dx/0.006); uv.x=cx+dx/(1.+amt*g*0.9); uv.y=0.5+(uv.y-0.5)/(1.+amt*g*0.35); vec4 c=texture2D(map,uv); gl_FragColor=vec4(c.rgb,c.a*op);\n#include <colorspace_fragment>\n}'});
dock.ui.material.map = TX.dock;
Object.defineProperty(dock, 'opacity', {get() { return this._o ?? 0; }, set(o) { this._o = o; this.body.material.opacity = o * 0.95; this.ui.material.uniforms.op.value = o; this.gloss.material.opacity = o; this.inner.visible = o > 0.003; }});

// search: a pane of glass whose height follows the palette's state
const SEARCH = {open: [678, 854], fire: [678, 357], calc: [678, 357], setting: [678, 458]};
const sw = 678 * pxU, search = new Elem(0, 0, 0.8); search.cy = 2.78; let searchH = 357 * pxU;
search.body = new THREE.Mesh(slabGeo(sw, searchH, 0.34, 0.16, 0.05), glassMat()); search.inner.add(search.body);
search.uis = {}; for (const k of Object.keys(SEARCH)) { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), uiMat(TX['search-' + k], 0)); m.position.z = 0.09; search.inner.add(m); search.uis[k] = m; }
search.inner.visible = false;

// Island (also the glass capsule of scene 1): one body that morphs capsule -> pill -> open Island
const LAY = TALL ? {OW: 3.9, OH: 3.74, cw: 1500, ch: 1456, s: 0.0026, vizR: [60, 840, 1380, 1380]} : {OW: 7.2, OH: 2.045, cw: 2806, ch: 796, s: 0.002566, vizR: [1278, 150, 2760, 770]};
const PILL = {w: 2.6, h: 0.49, r: 0.245};
const isl = new Elem(0, 5.25, 3.0), S = LAY.s;
const islBody = new THREE.Mesh(slabGeo(1.5, 0.62, 0.31, 0.4, 0.19), glassMat()); isl.inner.add(islBody);
// composed open-Island plates: the real captures, with the (empty) lyrics panel region replaced by the body gradient so the visualiser has a clean home
function openPlate(srcImg) { const c = document.createElement('canvas'); c.width = LAY.cw; c.height = LAY.ch; const g = c.getContext('2d');
  if (!TALL) { g.drawImage(srcImg, 0, 0); const col = g.getImageData(1236, 0, 4, 796); const strip = document.createElement('canvas'); strip.width = 1; strip.height = 796; const sg = strip.getContext('2d'); const a = g.getImageData(1238, 0, 1, 796); sg.putImageData(a, 0, 0); g.drawImage(strip, 0, 150, 1, 646, 1244, 150, 1536, 646); }
  else { g.drawImage(srcImg, 0, 0, 1500, 796, 0, 0, 1500, 796); const strip = document.createElement('canvas'); strip.width = 1500; strip.height = 1; strip.getContext('2d').drawImage(c, 0, 700, 1500, 1, 0, 0, 1500, 1); g.drawImage(strip, 0, 0, 1500, 1, 0, 796, 1500, 660); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; return t; }
const plateT = {paused: openPlate(PL['g-open-paused']), playing: openPlate(PL['g-open-playing'])};
const pillT = {paused: new THREE.CanvasTexture(PL['g-pill-paused']), playing: new THREE.CanvasTexture(PL['g-pill-playing'])}; for (const t of Object.values(pillT)) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; }
const FR = 0.07; // z of the front face above the body centre, set per-frame
const pill = {paused: new THREE.Mesh(uiGeo(PILL.w - 0.04, PILL.h - 0.04, PILL.r - 0.02, 0.0, 602 / 628, 0, 1), uiMat(pillT.paused)), playing: new THREE.Mesh(uiGeo(PILL.w - 0.04, PILL.h - 0.04, PILL.r - 0.02, 0.0, 602 / 628, 0, 1), uiMat(pillT.playing))};
for (const m of Object.values(pill)) isl.inner.add(m);
const open = {paused: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), uiMat(plateT.paused, 0)), playing: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), uiMat(plateT.playing, 0))}; for (const m of Object.values(open)) isl.inner.add(m);
const P = (px, py) => new V3((px - LAY.cw / 2) * S, -py * S, 0);   // plate pixel -> island-local position (anchor = top centre)
// album art lifts off the glass when the music starts
const album = new THREE.Mesh(new THREE.ShapeGeometry(rr(256 * S, 256 * S, 40 * S), 24), uiMat(TX.album, 0)); { const g = album.geometry, p = g.attributes.position, uv = g.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (256 * S) + .5, p.getY(i) / (256 * S) + .5); } isl.inner.add(album);
// visualiser card inside the Island (drawn from the real amplitude envelope)
const vc = document.createElement('canvas'); vc.width = 1024; vc.height = Math.round(1024 * (LAY.vizR[3] - LAY.vizR[1]) / (LAY.vizR[2] - LAY.vizR[0])); const vg = vc.getContext('2d');
const vtex = new THREE.CanvasTexture(vc); vtex.colorSpace = THREE.SRGBColorSpace; vtex.anisotropy = maxAniso;
const vizW = (LAY.vizR[2] - LAY.vizR[0]) * S, vizH = (LAY.vizR[3] - LAY.vizR[1]) * S;
const viz = new THREE.Mesh(uiGeo(vizW, vizH, 0.16), uiMat(vtex, 0)); isl.inner.add(viz); viz.position.copy(P((LAY.vizR[0] + LAY.vizR[2]) / 2, (LAY.vizR[1] + LAY.vizR[3]) / 2));
function drawViz(t, k) {
  const w = vc.width, h = vc.height; vg.clearRect(0, 0, w, h);
  const bg = vg.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, 'rgba(8,12,28,.88)'); bg.addColorStop(1, 'rgba(14,24,52,.78)'); vg.fillStyle = bg; vg.beginPath(); vg.roundRect(0, 0, w, h, 54); vg.fill();
  vg.strokeStyle = 'rgba(170,200,255,.16)'; vg.lineWidth = 2; vg.beginPath(); vg.roundRect(1, 1, w - 2, h - 2, 54); vg.stroke();
  const N = TALL ? 24 : 34, f0 = Math.round(t * 60), bw = (w - 120) / N, mid = h * 0.5;
  const peak = ENV.reduce((a, b) => Math.max(a, b), 0.001);
  for (let i = 0; i < N; i++) { // the centre is "now"; bars to either side are the recent past of the real envelope (+ low-band punch)
    const d = Math.abs(i - (N - 1) / 2), e = ENV[clamp(f0 - Math.round(d * 2.2), 0, 2699)] / peak, lo = LOW[clamp(f0 - Math.round(d * 2.2), 0, 2699)] / 120, fl = FLUX[clamp(f0 - Math.round(d * 1.6), 0, 2699)] / 20;
    const a = clamp(Math.pow(e, 1.4) * 0.9 + clamp(lo, 0, 1) * 0.25 + clamp(fl, 0, 1) * 0.35, 0, 1) * (1 - d / N * 0.55), hh = (14 + a * h * 0.6) * k, x = 60 + i * bw + bw * 0.5;
    const gr = vg.createLinearGradient(0, mid - hh, 0, mid + hh); gr.addColorStop(0, 'rgba(170,222,255,.98)'); gr.addColorStop(.5, 'rgba(140,150,255,.98)'); gr.addColorStop(1, 'rgba(170,222,255,.7)');
    vg.fillStyle = gr; vg.beginPath(); vg.roundRect(x - bw * 0.3, mid - hh, bw * 0.6, hh * 2, bw * 0.3); vg.fill(); }
  vtex.needsUpdate = true; }
// rim light that runs around the Island's border, and a ripple on musical accents
const rimMat = new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {head: {value: 0}, k: {value: 0}, base: {value: 0}, col: {value: new Color(0.55, 0.75, 1)}},
  vertexShader: 'varying float vA; void main(){vA=atan(position.y,position.x)/6.2831853+.5; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'varying float vA; uniform float head,k,base; uniform vec3 col; void main(){ float d=abs(fract(vA-head+.5)-.5); float s=exp(-d*d*180.)*k + base; gl_FragColor=vec4(col*s*2.2,1.);}'});
const rim = new THREE.Mesh(new THREE.BufferGeometry(), rimMat); isl.inner.add(rim);
function rimGeo(w, h, r) { const o = rr(w + 0.025, h + 0.025, r + 0.0125), hole = rr(w - 0.01, h - 0.01, r - 0.005); o.holes.push(new THREE.Path(hole.getPoints(40).reverse())); return new THREE.ShapeGeometry(o, 40); }
const ripple = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 96), new THREE.MeshBasicMaterial({color: new Color(0.5, 0.7, 1), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false})); isl.inner.add(ripple);

// cursor
const cc = document.createElement('canvas'); cc.width = cc.height = 128; { const g = cc.getContext('2d'); g.translate(24, 12); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 74); g.lineTo(18, 58); g.lineTo(30, 86); g.lineTo(44, 80); g.lineTo(32, 52); g.lineTo(56, 50); g.closePath(); g.lineWidth = 6; g.strokeStyle = '#000'; g.stroke(); g.fillStyle = '#fff'; g.fill(); }
const ct = new THREE.CanvasTexture(cc); ct.colorSpace = THREE.SRGBColorSpace;
const cursor = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), new THREE.MeshBasicMaterial({map: ct, transparent: true, toneMapped: false, depthTest: false, opacity: 0})); cursor.renderOrder = 100; scene.add(cursor);
const ccGeo = cursor.geometry; ccGeo.translate(0.21 - 0.075, -0.21 + 0.03, 0);   // hotspot at the arrow tip

// logotype: "NIRO." in Inter, extruded, glass
const logoData = await (await fetch('/tex/logo.json')).json();
const logo = new THREE.Group(); scene.add(logo);
{ const sp = new THREE.ShapePath(); for (const c of logoData.cmds) { if (c.type === 'M') sp.moveTo(c.x, -c.y); else if (c.type === 'L') sp.lineTo(c.x, -c.y); else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y); else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y); else if (c.type === 'Z') { /* contour closes by itself */ } }
  const shapes = sp.toShapes(false), g = new THREE.ExtrudeGeometry(shapes, {depth: 150, bevelEnabled: true, bevelThickness: 34, bevelSize: 26, bevelSegments: 8, curveSegments: 14});
  g.computeBoundingBox(); const bb = g.boundingBox, k = 7.6 / (bb.max.x - bb.min.x); g.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, -75); g.scale(k, k, k);
  const m = glassMat(); m.thickness = 1.6; m.attenuationColor = new Color(0xb9ccff); m.attenuationDistance = 3.5; m.dispersion = 0.5; m.envMapIntensity = 3.2; m.roughness = 0.0; m.emissive = new Color(0.42, 0.55, 1.0); m.emissiveIntensity = 0.9; m.ior = 1.45; const lm = new THREE.Mesh(g, m); logo.add(lm); logo.userData.mesh = lm; }
const tagC = document.createElement('canvas'); tagC.width = 2048; tagC.height = 160; const tagT = new THREE.CanvasTexture(tagC); tagT.colorSpace = THREE.SRGBColorSpace;
{ const g = tagC.getContext('2d'); g.font = '300 82px "Inter Variable", Inter, sans-serif'; g.fillStyle = 'rgba(222,234,255,.95)'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = '12px'; g.fillText('Make Linux Feel Different.', 1024, 80); tagT.needsUpdate = true; }
const tag = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 0.5625), new THREE.MeshBasicMaterial({map: tagT, transparent: true, opacity: 0, toneMapped: false, depthWrite: false})); scene.add(tag);
const makTxt = (txt, w = 2048) => { const c = document.createElement('canvas'); c.width = w; c.height = 200; const g = c.getContext('2d'); g.font = '300 110px "Inter Variable", Inter, sans-serif'; g.fillStyle = 'rgba(235,242,255,.96)'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = '8px'; g.fillText(txt, w / 2, 100); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
const mio = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 0.547), new THREE.MeshBasicMaterial({map: makTxt('Make it yours.'), transparent: true, opacity: 0, toneMapped: false, depthWrite: false})); scene.add(mio);

// light streams that join the glass edges in the finale, and atmosphere
const stream = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: {k: {value: 0}, ph: {value: 0}},
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'varying vec2 vUv; uniform float k,ph; void main(){ float e=1.-abs(vUv.y-.5)*2.; float s=smoothstep(0.,1.,e); float run=smoothstep(.0,.12,fract(vUv.x-ph)) * (1.-smoothstep(.12,.5,fract(vUv.x-ph)))*1.4+.25; gl_FragColor=vec4(vec3(.55,.72,1.)*s*s*run*k*1.8,1.);}'})); scene.add(stream);
function ribbon(pts, wd) { const pos = [], uv = [], idx = []; const n = pts.length; for (let i = 0; i < n; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], tg = b.clone().sub(a).normalize(), nm = new V3(-tg.y, tg.x, 0).multiplyScalar(wd / 2); const p = pts[i]; pos.push(p.x + nm.x, p.y + nm.y, p.z, p.x - nm.x, p.y - nm.y, p.z); uv.push(i / (n - 1), 0, i / (n - 1), 1); if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return g; }
const beam = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.05), new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {k: {value: 0}}, vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'varying vec2 vUv; uniform float k; void main(){ float a=1.-abs(vUv.y-.5)*2.; float b=exp(-pow((vUv.x-.5)*2.4,2.)*3.); gl_FragColor=vec4(vec3(.7,.85,1.)*a*a*b*k*3.,1.);}'})); scene.add(beam);
const keyLight = new THREE.PointLight(0xbfd8ff, 0, 30, 1.6); scene.add(keyLight); const rimLight = new THREE.PointLight(0x9a7bff, 0, 40, 1.4); scene.add(rimLight);
const glow = new THREE.Mesh(new THREE.PlaneGeometry(9, 5), new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {k: {value: 0}}, vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'varying vec2 vUv; uniform float k; void main(){ vec2 p=(vUv-.5)*vec2(1.7,1.); float a=exp(-dot(p,p)*7.); float b=exp(-pow(length(p-vec2(.28,-.1)),2.)*30.); float c=exp(-pow(length(p+vec2(.3,.12)),2.)*36.); float e=smoothstep(0.,.2,vUv.x)*smoothstep(1.,.8,vUv.x)*smoothstep(0.,.2,vUv.y)*smoothstep(1.,.8,vUv.y); gl_FragColor=vec4((vec3(.18,.3,.85)*a+vec3(.55,.35,1.)*b+vec3(.25,.55,1.)*c)*k*.55*e,1.);}'})); scene.add(glow);
const logoGlow = new THREE.Mesh(new THREE.PlaneGeometry(9, 5), glow.material.clone()); scene.add(logoGlow);
// dust
const NP = 700, pp = new Float32Array(NP * 3), ps = new Float32Array(NP); { let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647; for (let i = 0; i < NP; i++) { pp.set([(rnd() - .5) * 34, (rnd() - .5) * 18, rnd() * 22 - 14], i * 3); ps[i] = 0.4 + rnd() * 1.4; } }
const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3)); pg.setAttribute('sz', new THREE.BufferAttribute(ps, 1));
const dust = new THREE.Points(pg, new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: {k: {value: 0.5}, t: {value: 0}, col: {value: new Color(0.6, 0.75, 1)}, px: {value: H / 1080}},
  vertexShader: 'attribute float sz; uniform float t,px; varying float vA; void main(){ vec3 p=position; p.x+=sin(t*.15+p.y*.7)*.35; p.y+=sin(t*.11+p.x*.5)*.3+t*.03; p.y=mod(p.y+9.,18.)-9.; vec4 mv=modelViewMatrix*vec4(p,1.); gl_PointSize=sz*px*26./(-mv.z); vA=smoothstep(30.,4.,-mv.z)*smoothstep(0.1,1.5,-mv.z); gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'uniform float k; uniform vec3 col; varying float vA; void main(){ float r=length(gl_PointCoord-.5)*2.; float a=smoothstep(1.,0.,r); gl_FragColor=vec4(col*a*a*vA*k,1.);}'})); scene.add(dust);

// ---------------------------------------------------------------- post: bloom, then grade (vignette, grain, flash, fade, lens warp)
const rt = new THREE.WebGLRenderTarget(W, H, {type: THREE.HalfFloatType, samples: 4});
const composer = new EffectComposer(renderer, rt); composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, {focus: 5, aperture: 0.0, maxblur: 0.0}); composer.addPass(bokeh);
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.32, 0.55, 1.0); composer.addPass(bloom);
const grade = new ShaderPass({uniforms: {tDiffuse: {value: null}, fade: {value: 1}, flash: {value: 0}, warp: {value: 0}, grain: {value: 0.0035}, vig: {value: 0.55}, seed: {value: 0}, tint: {value: new Color(0, 0, 0)}, asp: {value: W / H}},
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float fade,flash,warp,grain,vig,seed,asp; uniform vec3 tint; varying vec2 vUv;
  float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+seed)*43758.5453);}
  void main(){ vec2 c=vUv-.5; float r2=dot(c*vec2(asp,1.),c*vec2(asp,1.)); vec2 uv=.5+c*(1.-warp*r2*1.6);
    float ca=0.0012+warp*0.004; vec3 col=vec3(texture2D(tDiffuse,uv+c*ca).r,texture2D(tDiffuse,uv).g,texture2D(tDiffuse,uv-c*ca).b);
    col+=tint*(.5+.5*col); col+=flash*vec3(.8,.9,1.)*exp(-r2*2.2); col*=1.-vig*smoothstep(.15,1.,r2*1.7);
    col+=(h(vUv*vec2(1731.,1093.))-.5)*grain; col*=fade; gl_FragColor=vec4(max(col,0.),1.); }`});
composer.addPass(grade); composer.addPass(new OutputPass());

// ---------------------------------------------------------------- camera keyframes (world space; island sits at z=3, windows between z=-3.4 and 0.5)
const CAMK = TALL ? [
  [0, [-2.0, 4.15, 8.0], [0, 3.95, 3], 32], [2.5, [1.4, 3.9, 8.0], [0, 4.0, 3], 32], [5, [1.8, 4.2, 8.6], [0, 4.0, 3], 34], [7, [0.4, 4.2, 10.5], [0, 3.9, 3], 38],
  [9, [0, 4.0, 11.5], [0, 3.7, 3], 40], [9.9, [0, 2.9, 13.0], [0, 2.7, 3], 38], [10.4, [0.8, 2.7, 12.6], [0, 2.7, 3], 38], [14, [-0.9, 2.8, 12.4], [0.1, 2.7, 3], 38], [16, [-1.4, 2.7, 7.5], [-1.4, 2.6, 3], 42],
  [17, [-1.3, 2.4, 3.0], [-0.8, 1.2, -3], 44], [17.8, [-1.5, 1.0, 2.0], [-1.0, -0.8, -7], 50], [18.6, [-0.9, -0.6, 2.4], [-0.2, -2.0, -6], 52], [20.6, [-0.7, -0.7, 2.6], [-0.7, -2.3, -6], 52],
  [22.0, [0.2, 0.0, 4.0], [-0.6, -1.2, -8], 52], [24.0, [1.6, 0.8, 5.0], [0.0, -0.5, -9], 52], [25.4, [4.8, 0.8, 1.5], [-1.8, -0.7, -8.5], 54], [27.6, [2.6, 0.5, -8.0], [1.5, -0.3, -12], 50],
  [29.4, [2.2, 0.7, -2.0], [0.8, 0.2, -11], 50], [30.6, [0.3, 1.9, 8.2], [0, 1.6, -2], 42], [31.3, [0, 2.2, 9.6], [0, 2.2, 0.8], 40], [34.5, [0, 2.2, 9.5], [0, 2.2, 0.8], 40], [35.6, [0, 0.3, 19.6], [0, 0, 0], 48],
  [38, [0.3, 0.2, 19.0], [0, 0, 0], 48], [40, [0, 0.8, 22], [0, 0.6, -0.5], 48], [41, [0, 0.9, 23], [0, 0.9, 0], 44], [45, [0, 0.9, 21], [0, 0.9, 0], 42],
] : [
  [0, [-1.5, 4.25, 5.6], [0, 3.95, 3], 30], [2.5, [0.9, 3.9, 5.2], [0, 4.0, 3], 30], [5, [1.5, 4.2, 5.8], [0, 4.0, 3], 32], [7, [0.3, 4.4, 8.5], [0, 3.8, 3], 34],
  [9, [0, 4.1, 10.6], [0, 3.7, 3], 34], [10.4, [0.9, 3.9, 9.6], [0, 3.5, 3], 34], [14, [-1.2, 3.7, 8.8], [0.2, 3.4, 3], 34], [16, [-3.3, 3.7, 6.0], [-3.2, 3.5, 3], 40],
  [17, [-2.6, 3.6, 3.0], [-2.0, 2.0, -3], 40], [17.8, [-2.2, 1.4, 1.8], [-1.2, -0.6, -7], 46], [18.6, [-1.2, -0.4, 2.0], [-0.2, -2.5, -6], 46], [20.6, [-0.8, -0.5, 2.2], [-0.6, -2.7, -6], 46],
  [22.0, [0.6, 0.2, 3.2], [-0.5, -1.5, -8], 46], [24.0, [2.0, 1.2, 4.0], [0.2, -0.6, -9], 46], [25.4, [6.0, 1.0, 0.0], [-1.5, -0.7, -8.5], 46], [27.6, [3.2, 0.5, -9.0], [1.0, -0.3, -12], 44],
  [29.4, [2.4, 0.6, -3.0], [0.8, 0.2, -11], 44], [30.6, [0.3, 1.8, 7.4], [0, 1.5, -2], 38], [31.3, [0, 1.7, 7.0], [0, 1.2, 0.8], 36], [32.2, [0, 1.5, 5.4], [0, 1.9, 0.8], 36], [34.5, [0, 1.5, 5.2], [0, 2.0, 0.8], 36], [35.6, [0, -0.7, 13.2], [0, -0.9, 0], 40],
  [38, [0.3, -0.7, 13.0], [0, -0.9, 0], 40], [40, [0, 0.8, 14], [0, 0.6, -0.5], 44], [41, [0, 1, 15], [0, 1, 0], 38], [45, [0, 1, 13], [0, 1, 0], 36],
];
function camAt(t) { const K = CAMK; let i = 0; while (i < K.length - 2 && t > K[i + 1][0]) i++; const a = K[i], b = K[i + 1], p = K[i - 1] ?? a, n = K[i + 2] ?? b, h = b[0] - a[0], u = clamp((t - a[0]) / h);
  const her = (f) => { const v0 = a[0] === p[0] ? new V3(0, 0, 0) : new V3(...f(b)).sub(new V3(...f(p))).multiplyScalar(h / (b[0] - p[0])), v1 = n[0] === b[0] ? new V3(0, 0, 0) : new V3(...f(n)).sub(new V3(...f(a))).multiplyScalar(h / (n[0] - a[0])); const A0 = new V3(...f(a)), B0 = new V3(...f(b)); const u2 = u * u, u3 = u2 * u;
    return A0.clone().multiplyScalar(2 * u3 - 3 * u2 + 1).add(v0.multiplyScalar(u3 - 2 * u2 + u)).add(B0.clone().multiplyScalar(-2 * u3 + 3 * u2)).add(v1.multiplyScalar(u3 - u2)); };
  const pos = her(k => k[1]), look = her(k => k[2]); let fov = lerp(a[3], b[3], u * u * (3 - 2 * u));
  return {pos, look, fov}; }

// ---------------------------------------------------------------- the director
const st = {};
function render(t) {
  const f = Math.round(t * 60), env = envAt(t), pul = pulseAt(t);
  // ---- Island: capsule -> pill -> open, with the music hero
  const mk = sm5(T.morph0, T.morph1, t), mSpr = spr(t, T.morph0 + 0.5, 1.5, 0.6) * sm(T.morph0, T.morph0 + 0.4, t) * (1 - sm(T.morph1 + 1, T.morph1 + 1.1, t)) + (t >= T.morph1 + 1 ? 1 : 0) * 0;
  const mm = t < T.morph0 ? 0 : clamp(1 - Math.pow(1 - clamp((t - T.morph0) / (T.morph1 - T.morph0)), 3)) ;
  const settle = 1 + 0.07 * Math.sin((t - T.morph1) * 9) * Math.exp(-(t - T.morph1) * 3.2) * (t > T.morph1 ? 1 : 0);
  const eOpen = spr(t, T.pillClick + 0.05, 1.7, 0.72) * (1 - sm(17.2, 17.9, t));
  let w = lerp(1.5, PILL.w, mm) * settle, h = lerp(0.62, PILL.h, mm), r = lerp(0.31, PILL.r, mm), d = lerp(0.4, 0.12, mm), bev = lerp(0.19, 0.045, mm);
  w = lerp(w, LAY.OW, eOpen); h = lerp(h, LAY.OH, eOpen); r = lerp(r, 0.28, eOpen); d = lerp(d, 0.15, eOpen); bev = Math.min(bev, 0.05);
  swap(islBody, slabGeo(w, h, r, d, bev)); islBody.position.y = -h / 2;
  // material: clear glass -> dark glass
  const dark = sm(5.0, 6.3, t); const gm = islBody.material, dk = darkMat();
  if (!islBody.userData.dm) { islBody.userData.gm = gm; islBody.userData.dm = dk; }
  const useDark = dark > 0.5; islBody.material = useDark ? islBody.userData.dm : islBody.userData.gm;
  const g0 = islBody.userData.gm; g0.thickness = lerp(0.9, 0.2, dark); g0.transmission = lerp(1, 0.7, dark); g0.roughness = lerp(0.03, 0.2, dark); g0.attenuationColor.set(0x9ec2ff).lerp(new Color(0x101a3a), dark); g0.emissive = new Color(0.25, 0.3, 0.9); g0.emissiveIntensity = (0.05 + 0.05 * Math.sin(t * 3.1)) * (1 - dark) + 0.22 * Math.exp(-Math.pow(t - 3.6, 2) * 2);
  islBody.userData.dm.opacity = 1;
  const fz = d / 2 + 0.006;
  // pill / open plates
  const pillOp = sm(T.morph1 - 0.5, T.morph1 + 0.3, t) * (1 - sm(T.pillClick, T.pillClick + 0.3, t) * (1 - sm(17.2, 17.9, t)));
  const pillOpF = pillOp;
  const playing = sm(T.play - 0.01, T.play + 0.1, t);
  pill.paused.material.opacity = pillOpF * (1 - playing) + 0; pill.playing.material.opacity = pillOpF * playing; for (const m of Object.values(pill)) { m.position.set(0, -h / 2, fz); m.visible = m.material.opacity > 0.003; }
  const oOp = sm(T.pillClick + 0.15, T.pillClick + 0.6, t) * (1 - sm(17.2, 17.8, t));
  for (const [k, m] of Object.entries(open)) { swap(m, uiGeo(Math.max(0.01, w - 0.06), Math.max(0.01, h - 0.06), Math.max(0.01, r - 0.03), 0.5 - (w - 0.06) / 2 / (LAY.cw * S), 0.5 + (w - 0.06) / 2 / (LAY.cw * S), 1 - (h - 0.06) / (LAY.ch * S), 1)); m.position.set(0, -h / 2, fz); m.material.opacity = oOp * (k === 'playing' ? playing : 1 - playing); m.visible = m.material.opacity > 0.003; }
  // album art lift, visualiser, rim
  const lift = sm(T.play, T.play + 0.6, t) * eOpen; album.position.copy(P(206, 292)); album.position.z = fz + 0.01 + 0.2 * lift; album.scale.setScalar(1 + 0.05 * lift + 0.03 * env * lift); album.material.opacity = oOp * lift * (eOpen > .9 ? 1 : 0) * sm(0.9, 1, eOpen);
  const vk = sm(T.waves, T.waves + 0.7, t) * eOpen; viz.visible = vk > 0.003; viz.material.opacity = vk; viz.position.z = fz + 0.01 + 0.07 * vk; if (vk > 0.003) drawViz(t, 0.6 + 0.4 * vk);
  swap(rim, rimGeo(w, h, r)); rim.position.set(0, -h / 2, fz + 0.012);
  rimMat.uniforms.head.value = ((t - T.play) * 0.55) % 1; rimMat.uniforms.k.value = sm(T.play - 0.05, T.play + 0.1, t) * (1 - sm(T.play + 1.4, T.play + 2.6, t)) * 1.3 + sm(T.waves, T.waves + 1, t) * (1 - sm(T.pass, T.pass + 0.5, t)) * (pul * 0.8);
  rimMat.uniforms.base.value = (sm(T.waves, T.waves + 1, t) * (0.08 + 0.3 * pul) + 0.05 * sm(6, 7, t)) * (1 - sm(17.5, 18, t));
  rim.visible = t > 5.5 && t < 18;
  const rp = clamp((t - T.waves - 0.6) / 1.2); ripple.position.set(0, -h / 2, fz + 0.02); ripple.scale.set(lerp(1, 1.5, rp) * w / 2, lerp(1, 1.9, rp) * h / 2, 1); ripple.material.opacity = 0;
  isl.cy = 5.25; isl.z = 3.0; isl.apply();
  // tilt the Island a little while it is born, so the 3D body reads
  const tilt = (1 - sm(T.morph0 + 1, T.morph1 + 0.5, t)) * 0.55; isl.inner.rotation.set(0.12 * (1 - sm(5, 8, t)), Math.sin(t * 0.7) * tilt + (1 - sm(T.morph0 + 0.5, T.morph1, t)) * 0.6, 0);
  isl.inner.position.y = (1 - eOpen) * (h / 2 - PILL.h / 2);   // the capsule's centre stays where the pill's centre will be
  isl.root.visible = t < 18.2 || t > 39.0;
  // ---- wallpaper, dust, lights
  wall.material.opacity = Math.max(0.16 * sm(0.0, 1.0, t) * (1 - sm(4.0, 5.0, t)), sm(5.0, 8.0, t)); wall.material.color.setScalar(lerp(0.45, 0.62, sm(5.0, 8.0, t))); st.wallK = wall.material.opacity;
  glow.material.uniforms.k.value = (0.55 + 0.3 * Math.sin(t * 1.3)) * (1 - sm(5.5, 7.5, t)) * sm(0, 1, t); glow.position.set(0.0, 3.9, 1.6); glow.scale.setScalar(1 + 0.15 * Math.sin(t)); logoGlow.material.uniforms.k.value = sm(T.logo - 0.2, T.logo + 1.4, t) * 1.3 * (1 - sm(44.4, 45, t)); logoGlow.position.set(0, 0.55, -2.0); logoGlow.scale.setScalar(1.8);
  dust.material.uniforms.t.value = t; dust.material.uniforms.k.value = 0.55 + 0.25 * sm(0, 1, t);
  const bx = lerp(-7, 7, sm(0.35, 2.4, t)); beam.position.set(bx, 4.1 + 0.05 * Math.sin(t * 2), 3.1); beam.material.uniforms.k.value = Math.sin(clamp((t - 0.3) / 2.2) * Math.PI) * 1.0 * (t < 3 ? 1 : 0); beam.rotation.z = -0.04;
  keyLight.position.set(bx, 4.4, 5.2); keyLight.intensity = beam.material.uniforms.k.value * 40;
  rimLight.position.set(5, 5, 4); rimLight.intensity = (t < 18 ? 6 + 14 * sm(T.waves, T.waves + 1, t) * pul : 0);
  scene.environmentRotation.y = 0.5 + t * 0.045 + 0.35 * sm(T.world - 1, T.world + 3, t);
  // ---- cursor schedule (world positions are derived from the plates, so it lands on the real buttons)
  const islWorld = (px, py) => P(px, py).applyMatrix4(isl.inner.matrixWorld).clone();
  isl.root.updateMatrixWorld(true);
  let cur = null, curK = 0, click = 0;
  const pillCentre = new V3(0, -PILL.h / 2, fz).applyMatrix4(isl.inner.matrixWorld), playBtn = islWorld(542, 624);
  if (t > 8.1 && t < T.play + 1.4) { const a = new V3(2.2, -1.6, 0.3).add(pillCentre), a1 = pillCentre.clone(), u1 = sm5(8.1, T.pillClick - 0.05, t), u2 = sm5(T.pillClick + 0.45, T.play - 0.12, t);
    cur = t < T.pillClick + 0.4 ? a.lerp(a1, u1) : pillCentre.clone().lerp(playBtn, u2); cur.z += 0.05; curK = sm(8.1, 8.6, t) * (1 - sm(T.play + 0.9, T.play + 1.4, t)); click = Math.max(Math.exp(-Math.pow((t - T.pillClick) / 0.07, 2)), Math.exp(-Math.pow((t - T.play) / 0.07, 2))); }
  // ---- desktop windows
  const wk = sm(7.4, 9.4, t) * 0.0;
  // Editor lives at depth from the first reveal; Files launches out of the dock; panel and search come later
  const reveal = sm(T.pass - 0.4, T.pass + 0.8, t);
  editor.opacity = reveal * (1 - sm(T.shift - 0.4, T.shift + 0.6, t)) + sm(39.8, 41, t) * 0.9 * (1 - sm(41.1, 42.2, t)) * 0;
  { const inn = sm5(T.editor, T.editor + 1.4, t); editor.z = lerp(-14, -11, inn); editor.cx = lerp(6.0, 3.6, inn); editor.inner.position.set(0, 0, 0); editor.inner.rotation.set(0, lerp(-0.45, 0, inn) + 0.22 * sm(T.world - 0.5, T.world + 3, t) * (1 - sm(T.world + 3, T.world + 5.5, t)), 0);
    editor.opacity = lerp(0.55, 1, inn) * reveal * (1 - sm(T.shift - 0.2, T.shift + 0.7, t)); editor.apply(); }
  { const L = spr(t, T.launch, 1.8, 0.62), L2 = spr(t, T.launch, 1.2, 0.8); const from = new V3(-0.7 - files.cx, -3.2 - files.cy, 0); files.inner.position.set(lerp(from.x, 0, L), lerp(from.y, 0, L), lerp(4.0, 0, L)); files.inner.scale.set(lerp(0.06, 1, L2), lerp(0.04, 1, L), 1);
    files.inner.rotation.set(0, 0.34 * sm(T.world - 0.5, T.world + 2.2, t) * (1 - sm(T.world + 2.2, T.world + 5.5, t)) + 0.05 * (1 - L), 0); files.opacity = sm(T.launch - 0.02, T.launch + 0.25, t) * (1 - sm(T.shift - 0.2, T.shift + 0.7, t)); files.apply(); }
  const dockRise = spr(t, T.dock, 1.6, 0.7); dock.cy = lerp(-4.6, -3.2, dockRise); dock.cx = 0; dock.z = -3.5;
  const dockHide = sm(T.profile + 0.3, T.profile + 1.2, t); dock.cy -= 1.4 * dockHide; dock.opacity = sm(T.dock - 0.1, T.dock + 0.4, t) * (1 - sm(T.shift - 0.6, T.shift, t) * 0 ) * (t > T.shift && t < T.profile ? 0 : 1) * (1 - sm(T.profile + 1.0, T.profile + 1.6, t)); dock.apply();
  { const hv = sm(T.dock + 0.9, T.dock + 1.6, t) * (1 - sm(T.launch + 0.5, T.launch + 1.2, t)); const x = lerp(0.35, 0.2, sm(T.dock + 1, T.launch, t)) ; dock.ui.material.uniforms.cx.value = x; dock.ui.material.uniforms.amt.value = hv + 0.0; }
  // glass-world sheen
  const sp = sm(T.world - 0.3, T.world + 4.6, t); for (const wn of [files, editor]) { wn.sheen.material.uniforms.ph.value = lerp(-0.4, 1.4, sp); wn.sheen.material.uniforms.k.value = Math.sin(sp * Math.PI) * 0.22; }
  const wl = sm(T.world - 0.5, T.world + 0.8, t) * (1 - sm(T.world + 5.4, T.world + 6, t));
  // ---- dock cursor
  if (t > T.dock + 0.5 && t < T.launch + 1.0) { dock.root.updateMatrixWorld(true); const to = new V3((-0.7 - dock.cx) * 1, 0, 0.1), p0 = new V3(0.9, 0, 0.1); const u = sm5(T.dock + 0.6, T.launch - 0.1, t); const q = p0.lerp(to, u).add(new V3(0, 0, 0)); const lp = new V3(q.x, q.y + 0.06, q.z); cur = lp.applyMatrix4(dock.inner.matrixWorld); curK = sm(T.dock + 0.5, T.dock + 0.9, t) * (1 - sm(T.launch + 0.5, T.launch + 1.0, t)); click = Math.exp(-Math.pow((t - T.launch) / 0.07, 2)); }
  // ---- search
  { const sk = sm(T.sOpen - 0.9, T.sOpen - 0.1, t) * (1 - sm(T.shift - 0.5, T.shift + 0.4, t)); const state = t < T.sOpen + 0.85 ? 'open' : t < T.sRes - 1.5 ? 'fire' : t < T.sRes + 0.9 ? 'calc' : 'setting';
    const targetH = SEARCH[state][1] * pxU, key = {open: T.sOpen + 0.15, fire: T.sOpen + 0.85, calc: T.sRes - 1.5, setting: T.sRes + 0.9}[state];
    // glass slab that arrives first, becomes the palette
    const sfly = spr(t, T.sOpen - 0.9, 1.3, 0.78); search.z = lerp(3.4, 0.8, sfly); search.cy = lerp(1.2, 2.78 - (targetH - 357 * pxU) / 2, sfly) * 1; search.cx = 0;
    // height tracks the state (springs)
    const hs = {open: 854, fire: 357, calc: 357, setting: 458}, hp = (name) => hs[name] * pxU; let hh;
    const seq = [['open', T.sOpen + 0.15], ['fire', T.sOpen + 0.85], ['calc', T.sRes - 1.5], ['setting', T.sRes + 0.9]]; hh = hp('open'); for (let i = 1; i < seq.length; i++) hh = lerp(hh, hp(seq[i][0]), spr(t, seq[i][1], 1.6, 0.85)); if (t < T.sOpen + 0.15) hh = hp('open');
    swap(search.body, slabGeo(sw, hh, 0.34, 0.16, 0.05)); const top = 5.0 - 2.78 + 0; search.root.visible = sk > 0.003; search.body.position.y = 0; search.inner.rotation.set(0.35 * (1 - sfly) + 0.0, -0.6 * (1 - sfly) + 0.12 * Math.sin(t * 0.5) * 0, 0);
    const tex = {}, order = ['open', 'fire', 'calc', 'setting'];
    for (const k of order) { const m = search.uis[k]; const [pw, ph] = SEARCH[k]; m.scale.set(pw * pxU - 0.08, ph * pxU - 0.08, 1); m.position.y = (hh - ph * pxU) / 2; let a = 0; const idx = order.indexOf(k); const t0 = seq[idx][1]; const t1 = idx < 3 ? seq[idx + 1][1] : 1e9; a = sm(t0, t0 + 0.25, t) * (1 - sm(t1, t1 + 0.25, t)); if (k === 'open') a = sm(T.sOpen - 0.2, T.sOpen + 0.25, t) * (1 - sm(t1, t1 + 0.25, t)); m.material.opacity = a * sk; m.visible = a * sk > 0.003; swap(m, uiGeo(pw * pxU - 0.08, ph * pxU - 0.08, 0.3)); m.scale.set(1, 1, 1); m.position.y = (hh - ph * pxU) / 2 - 0; }
    search.body.material.transmission = lerp(1, 0.55, sm(T.sOpen, T.sOpen + 0.6, t)); search.body.material.thickness = lerp(0.5, 0.18, sm(T.sOpen, T.sOpen + 0.6, t));
    search.apply(); search.inner.visible = sk > 0.003; }
  // ---- Control Panel (appearance + profile)
  { const pin = spr(t, T.shift - 0.4, 1.4, 0.8), pk = pin * (1 - sm(T.profile + 1.2, T.profile + 2.0, t)); panel.cx = -0.075; panel.cy = -0.005; panel.z = lerp(2.6, -0.4, pin); panel.inner.rotation.set(0, lerp(0.55, 0, pin), 0); panel.opacity = sm(T.shift - 0.4, T.shift + 0.2, t) * (1 - sm(T.profile + 1.2, T.profile + 2.0, t));
    const swapA = sm(T.shift + 0.7, T.shift + 0.95, t), swapB = sm(T.shift + 1.9, T.shift + 2.15, t), pf = sm(T.profile - 1.2, T.profile - 0.95, t), dg = sm(T.profile - 0.2, T.profile + 0.05, t);
    panel.setTex(dg > 0.5 ? TX['panel-e-dialog'] : pf > 0.5 ? TX['panel-e-0'] : swapB > 0.5 ? TX['look-c'] : swapA > 0.5 ? TX['look-b'] : TX['look-a']); panel.apply(); st.pk = pk; }
  // pointer on the panel (accent, then glass opacity, then profile apply)
  { const pxy = (x, y) => new V3((x - 2271 / 2) * pxU, -(y - 1458 / 2) * pxU, 0.12).applyMatrix4(panel.inner.matrixWorld);
    if (t > T.shift + 0.2 && t < T.profile + 1.0) { panel.root.updateMatrixWorld(true); const wp = [[T.shift + 0.2, pxy(1700, 380)], [T.shift + 0.7, pxy(1017, 670)], [T.shift + 1.9, pxy(1860, 1340)], [T.profile - 1.6, pxy(150, 1290)], [T.profile - 1.1, pxy(150, 1290)], [T.profile - 0.5, pxy(1500, 1000)], [T.profile, pxy(1500, 1000)]];
      let i = 0; while (i < wp.length - 2 && t > wp[i + 1][0]) i++; const u = sm5(wp[i][0], wp[i + 1][0], t); cur = wp[i][1].clone().lerp(wp[i + 1][1], u); curK = sm(T.shift + 0.2, T.shift + 0.5, t) * (1 - sm(T.profile + 0.3, T.profile + 0.7, t)); click = [T.shift + 0.7, T.shift + 1.9, T.profile - 1.0, T.profile - 0.02].reduce((a, c) => Math.max(a, Math.exp(-Math.pow((t - c) / 0.07, 2))), 0); } }
  if (cur) { cursor.position.copy(cur); cursor.scale.setScalar((1 - 0.14 * click) * (1 + 0.0)); cursor.material.opacity = curK; cursor.quaternion.copy(camera.quaternion); } else cursor.material.opacity = 0;
  // ---- typography + environment colour wave
  const wave = sm(T.shift, T.shift + 1.4, t);   // light travelling through the glass: icy blue -> soft violet
  mio.position.set(0, -4.75, 1.5); mio.scale.setScalar(1.3); mio.quaternion.copy(camera.quaternion); mio.material.opacity = sm(35.6, 36.5, t) * (1 - sm(40.3, 40.9, t)) * 0.95;
  st.violet = wave * (1 - sm(T.logo - 0.5, T.logo + 0.8, t) * 0.0);
  // ---- finale: the layout comes together, light joins the glass edges, then NIRO.
  const fin = sm(T.logo - 2.6, T.logo - 0.2, t), lg = sm(T.logo, T.logo + 1.0, t);
  if (t > T.profile + 1.3) { const q = sm5(T.profile + 1.3, T.logo - 0.3, t); files.opacity = q * (1 - sm(T.logo - 1.0, T.logo + 0.1, t)); files.inner.position.set(0, 0, 0); files.inner.scale.set(1, 1, 1); files.inner.rotation.set(0, 0.25 * (1 - q), 0); files.cx = lerp(-3.4, -5.4, lg); files.cy = lerp(-0.9, -1.3, lg); files.z = lerp(-7.5, -9.5, lg); files.apply();
    editor.opacity = q * (1 - sm(T.logo - 1.0, T.logo + 0.1, t)); editor.inner.position.set(0, 0, 0); editor.inner.scale.set(1, 1, 1); editor.inner.rotation.set(0, -0.25 * (1 - q), 0); editor.apply();
    isl.root.visible = true; }
  dock.opacity = Math.max(dock.opacity, sm(T.profile + 1.6, T.profile + 2.4, t) * (1 - sm(T.logo - 1.0, T.logo + 0.1, t))) ; if (t > T.profile + 1.5) { dock.cy = lerp(-4.6, -3.2, spr(t, T.profile + 1.6, 1.6, 0.7)); dock.apply(); }
  // logotype
  logo.visible = lg > 0.003; { const s = lerp(0.88, 1, sm5(T.logo, T.logo + 2.2, t)); logo.position.set(0, 0.55, 0); logo.scale.setScalar(s); logo.rotation.set(0.12 * (1 - sm5(T.logo, T.logo + 2.2, t)), lerp(-0.5, 0, sm5(T.logo, T.logo + 2.2, t)) + 0.05 * Math.sin(t * 0.8), 0); logo.userData.mesh.material.opacity = 1; }
  tag.position.set(0, -2.05, 0.2); tag.material.opacity = sm(T.logo + 1.3, T.logo + 2.3, t) * (1 - sm(44.6, 45, t) * 0);
  // ---- camera
  const cm = camAt(t); camera.position.copy(cm.pos); camera.up.set(0, 1, 0); camera.lookAt(cm.look); camera.fov = cm.fov; camera.updateProjectionMatrix();
  // logo and tag always face the camera's rest view at the end
  if (t > T.logo) { tag.quaternion.copy(camera.quaternion); }
  // camera passing through the Island glass: refraction flash
  const through = Math.exp(-Math.pow((t - T.pass) / 0.16, 2));
  grade.uniforms.flash.value = through * 0.12 + 0.1 * Math.exp(-Math.pow((t - T.logo) / 0.16, 2)); grade.uniforms.warp.value = through * 0.5 + 0.015 * pul; grade.uniforms.seed.value = (f % 97) * 0.37;
  grade.uniforms.fade.value = sm(0, 0.6, t) * (1 - sm(44.3, 45, t)); grade.uniforms.tint.value.setRGB(0.012 * st.violet, 0, 0.022 * st.violet); if (t > 5) wall.material.color.setRGB(lerp(0.62, 0.86, st.violet), lerp(0.62, 0.5, st.violet), lerp(0.62, 1.0, st.violet));
  // violet light replaces icy blue in the room
  rimLight.color.set(0x9a7bff).lerp(new Color(0xd48bff), st.violet); keyLight.color.set(0xbfd8ff).lerp(new Color(0xc9b2ff), st.violet);
  dust.material.uniforms.col.value.setRGB(...mix3([0.6, 0.75, 1.0], [0.78, 0.62, 1.0], st.violet));
  bloom.strength = 0.3 + 0.2 * pul + 0.4 * through;
  // depth of field only for the macro opening and the pass-through (UI stays sharp)
  const dofK = (1 - sm(5.0, 7.2, t)) * sm(0.2, 1.0, t) + through * 0.8; bokeh.uniforms.focus.value = camera.position.distanceTo(new V3(0, 4.1, 3.0)); bokeh.uniforms.aperture.value = 0.0045 * dofK; bokeh.uniforms.maxblur.value = 0.012 * dofK; bokeh.enabled = dofK > 0.01;
  composer.render();
}
window.__render = t => { render(t); return true; };
window.__ready = true;
