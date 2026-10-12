// NAVI — 3D CAD viewers (scroll-driven inspection + interactive exploded atelier).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARTS, LAYERS, TEAM } from './data.js';
import { announce } from './main.js';

const MODEL_URL = 'navi_f450.glb';
const EXPLODED_URL = 'navi_f450_exploded.glb';
const D2R = Math.PI / 180;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const layerOf = id => LAYERS.find(l => l.id === id);
const partById = id => PARTS.find(p => p.id === id);
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const lerp = (a, b, t) => a + (b - a) * t;

// Used only if the exploded GLB cannot be read: CAD Z offsets (mm) per node-name prefix.
const FALLBACK_EXPLODE = [
  ['bottom_plate', -45], ['top_plate', 40], ['arm_', 0], ['prop_1045_', 200], ['prop_adapter_', 125], ['motor_', 125],
  ['esc_30A_', -30], ['battery_', -105], ['gear_', -175], ['', 75]
];
// ArduPilot Quad X spin direction seen from above: +1 CCW (M1, M2), -1 CW (M3, M4).
const SPIN = { prop_1045_315: 1, prop_1045_135: 1, prop_1045_45: -1, prop_1045_225: -1 };

/* ---------------- Loading ---------------- */
function setProgress(f) { $$('.loading .bar i').forEach(i => { i.style.width = Math.round(f * 100) + '%'; }); }

// Read only the JSON chunk of a GLB (ranged request), falling back to the whole file.
async function readGlbJson(url) {
  const parse = buf => {
    const dv = new DataView(buf);
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  };
  let r = await fetch(url, { headers: { Range: 'bytes=0-19' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  let buf = await r.arrayBuffer();
  if (r.status !== 206) return parse(buf);
  const len = new DataView(buf).getUint32(12, true);
  r = await fetch(url, { headers: { Range: `bytes=20-${19 + len}` } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const body = await r.arrayBuffer();
  return r.status === 206 ? JSON.parse(new TextDecoder().decode(body)) : parse(body);
}

function nodeCenters(json) {
  const out = new Map();
  for (const n of json.nodes) {
    if (n.mesh === undefined || !n.name) continue;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of json.meshes[n.mesh].primitives) {
      const a = json.accessors[p.attributes.POSITION];
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a.min[k]); mx[k] = Math.max(mx[k], a.max[k]); }
    }
    out.set(n.name, mn.map((v, k) => (v + mx[k]) / 2));
  }
  return out;
}

async function explodeVectors(assembledJson) {
  try {
    const a = nodeCenters(assembledJson), b = nodeCenters(await readGlbJson(EXPLODED_URL));
    const out = new Map();
    a.forEach((c, name) => { const e = b.get(name); if (e) out.set(name, e.map((v, k) => v - c[k])); });
    if (out.size < a.size * 0.9) throw new Error('node names differ');
    return { vectors: out, source: 'navi_f450_exploded.glb' };
  } catch (err) {
    console.warn('Using built-in explode vectors:', err);
    return { vectors: null, source: 'built-in table' };
  }
}

function fallbackVector(name) {
  const hit = FALLBACK_EXPLODE.find(([p]) => name.startsWith(p));
  return [0, 0, hit ? hit[1] : 0];
}

// Build one processed template: one merged mesh per CAD node, tagged with its part and layer.
function buildTemplate(gltf, vectors) {
  const root = gltf.scene.children[0];
  const nodes = [...root.children];
  for (const node of nodes) {
    const name = node.userData.name || node.name;
    const meshes = [];
    node.traverse(o => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length) continue;
    const geos = meshes.map(m => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', m.geometry.getAttribute('position'));
      g.setAttribute('normal', m.geometry.getAttribute('normal'));
      g.setIndex(m.geometry.index ? m.geometry.index : [...Array(m.geometry.getAttribute('position').count).keys()]);
      if (!m.matrix.equals(new THREE.Matrix4())) g.applyMatrix4(m.matrix);
      return g;
    });
    const geo = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    geo.computeBoundingBox();
    const mat = meshes[0].material;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    const part = PARTS.find(p => p.nodes.some(pre => name.startsWith(pre)));
    const isProp = name.startsWith('prop_1045_');
    const base = new THREE.Vector3();
    if (isProp) { geo.boundingBox.getCenter(base); geo.translate(-base.x, -base.y, -base.z); geo.computeBoundingBox(); }
    mesh.position.copy(base);
    const v = vectors?.get(name) || fallbackVector(name);
    mesh.userData = { name, part: part?.id, layer: part?.layer, base: base.clone(), delta: new THREE.Vector3(...v), isProp, spin: SPIN[name] || 0 };
    root.remove(node);
    root.add(mesh);
  }
  // Material tune-up: matte finish and lifted near-blacks so dark parts read on a dark stage.
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh || seen.has(o.material)) return;
    seen.add(o.material);
    const m = o.material;
    m.metalness = 0.12; m.roughness = 0.58;
    const hsl = {}; m.color.getHSL(hsl, THREE.SRGBColorSpace);
    if (hsl.l < 0.22) m.color.setHSL(hsl.h, Math.min(hsl.s, 0.25), 0.22, THREE.SRGBColorSpace);
  });
  return root;
}

/* ---------------- Viewer base ---------------- */
class Viewer {
  constructor(canvas, template) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xd8eeff, 0x15252c, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(500, 900, 400); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x95e5c9, 0.9); rim.position.set(-600, 250, -500); this.scene.add(rim);
    this.camera = new THREE.PerspectiveCamera(30, 1, 5, 20000);
    this.root = template.clone(true);
    this.meshes = [];
    this.root.traverse(o => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.envMapIntensity = 0.85;
      o.userData = { ...o.userData, baseColor: o.material.color.clone(), opacity: 1, target: 1 };
      this.meshes.push(o);
    });
    this.scene.add(this.root);
    this.root.updateMatrixWorld(true);
    this.explode = 0;
    this.addShadow();
    this.addPropDiscs();
    this.visible = false;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }, { rootMargin: '100px' }).observe(canvas);
  }
  addShadow() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(760, 760), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadow);
  }
  addPropDiscs() {
    this.discs = [];
    for (const m of this.meshes.filter(m => m.userData.isProp)) {
      const tint = m.userData.baseColor.clone().lerp(new THREE.Color(0xdfe9ec), 0.55);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(127, 48), new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      disc.userData.prop = m;
      this.root.add(disc);
      this.discs.push(disc);
    }
  }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.width = r.width; this.height = r.height;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }
  fit(ex) {
    const R = 330 + 250 * ex, vf = this.camera.fov * D2R;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    return R / Math.sin(Math.min(vf, hf) / 2) * (this.camera.aspect < 1 ? 1.12 : 0.98);
  }
  setExplode(t) {
    this.explode = t;
    for (const m of this.meshes) {
      const { base, delta } = m.userData;
      m.position.set(base.x + delta.x * t, base.y + delta.y * t, base.z + delta.z * t);
    }
    const gear = this.meshes.find(m => m.userData.name.startsWith('gear_skid'));
    this.shadow.position.y = -160 + (gear ? gear.userData.delta.z * t : 0);
  }
  // World-space top-centre of a mesh, following the current explode offset.
  anchorOf(mesh, out = new THREE.Vector3()) {
    const bb = mesh.geometry.boundingBox;
    out.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z).add(mesh.position);
    return this.root.localToWorld(out);
  }
  centerOf(mesh, out = new THREE.Vector3()) {
    mesh.geometry.boundingBox.getCenter(out).add(mesh.position);
    return this.root.localToWorld(out);
  }
  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) / 2 * this.width, y: (1 - p.y) / 2 * this.height, on: p.z < 1 && Math.abs(p.x) < 1.15 && Math.abs(p.y) < 1.15 };
  }
  tickMaterials(dt, spinning) {
    const k = 1 - Math.exp(-dt * 9);
    for (const m of this.meshes) {
      const u = m.userData, mat = m.material;
      u.opacity += (u.target - u.opacity) * k;
      if (Math.abs(u.target - u.opacity) < 0.002) u.opacity = u.target;
      mat.opacity = u.opacity;
      mat.depthWrite = u.opacity > 0.98;
      m.renderOrder = u.opacity > 0.98 ? 0 : 1;
      m.visible = u.opacity > 0.01;
      if (u.isProp && spinning) m.rotation.z += u.spin * dt * 9;
    }
    for (const d of this.discs) {
      const p = d.userData.prop;
      d.position.copy(p.position);
      d.material.opacity = spinning ? 0.09 * p.userData.opacity : 0;
      d.visible = d.material.opacity > 0.005;
    }
  }
  render() { this.renderer.render(this.scene, this.camera); }
}

/* ---------------- Scroll-driven inspection ---------------- */
const CHAPTERS = [
  { name: 'ASSEMBLED', t: [0, -10, 0], az: 35, el: 20, k: 1.0, ex: 0, focus: null, spin: true },
  { name: 'L1 · STRUCTURAL', t: [0, -40, 0], az: 62, el: 10, k: 0.98, ex: 0.55, focus: 'structure', spin: false },
  { name: 'L2 · PROPULSION', t: [150, 40, -150], az: -38, el: 20, k: 0.5, ex: 0, focus: 'propulsion', spin: true },
  { name: 'L3 · AVIONICS', t: [0, 52, 0], az: 28, el: 48, k: 0.42, ex: 0.4, focus: 'avionics', spin: false },
  { name: 'L4 · SENSOR MAST & TELEMETRY', t: [-35, 78, -5], az: -140, el: 12, k: 0.6, ex: 0, focus: 'sensors', spin: false },
  { name: 'L5 · POWER BAY', t: [0, -50, 0], az: 50, el: -22, k: 0.56, ex: 0.35, focus: 'power', spin: false },
  { name: 'EXPLODED · ALL LAYERS', t: [0, -30, 0], az: 38, el: 15, k: 1.0, ex: 1.0, focus: null, spin: false }
];

class ScrollViewer extends Viewer {
  constructor(canvas, template) {
    super(canvas, template);
    this.steps = $$('#scrolly .chapter');
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    canvas.parentElement.appendChild(this.overlay);
    this.tags = PARTS.map(p => {
      const el = document.createElement('div');
      el.className = 'tag'; el.textContent = p.short; el.hidden = true;
      el.style.borderColor = layerOf(p.layer).color;
      this.overlay.appendChild(el);
      return { part: p, el, mesh: this.meshes.find(m => m.userData.name.startsWith(p.anchor)) };
    });
    $('#sc-dots').innerHTML = CHAPTERS.map(() => '<i></i>').join('');
    this.cur = this.stateAt(0);
    this.activeIdx = -1;
    this.spinning = true;
  }
  progress() {
    const anchor = innerHeight * 0.5;
    const c = this.steps.map(s => { const r = s.getBoundingClientRect(); return r.top + r.height / 2; });
    if (anchor <= c[0]) return 0;
    for (let i = 0; i < c.length - 1; i++) if (anchor <= c[i + 1]) return i + (anchor - c[i]) / (c[i + 1] - c[i]);
    return c.length - 1;
  }
  stateAt(p) {
    const i = Math.min(CHAPTERS.length - 2, Math.floor(p)), f = ease(Math.min(1, Math.max(0, p - i)));
    const a = CHAPTERS[i], b = CHAPTERS[i + 1];
    let daz = b.az - a.az; if (daz > 180) daz -= 360; if (daz < -180) daz += 360;
    const w = {};
    LAYERS.forEach(l => {
      const wa = !a.focus || a.focus === l.id ? 1 : 0, wb = !b.focus || b.focus === l.id ? 1 : 0;
      w[l.id] = lerp(wa, wb, f);
    });
    return { t: a.t.map((v, k) => lerp(v, b.t[k], f)), az: a.az + daz * f, el: lerp(a.el, b.el, f), k: lerp(a.k, b.k, f), ex: lerp(a.ex, b.ex, f), w };
  }
  tick(dt) {
    const p = this.progress(), tgt = this.stateAt(p), s = this.cur;
    const k = reduced ? 1 : 1 - Math.exp(-dt * 5);
    s.t = s.t.map((v, i) => lerp(v, tgt.t[i], k));
    s.az = lerp(s.az, tgt.az, k); s.el = lerp(s.el, tgt.el, k); s.k = lerp(s.k, tgt.k, k); s.ex = lerp(s.ex, tgt.ex, k);
    for (const id in tgt.w) s.w[id] = tgt.w[id];
    const idx = Math.round(p);
    if (idx !== this.activeIdx) {
      this.activeIdx = idx;
      this.steps.forEach((el, i) => el.classList.toggle('is-active', i === idx));
      $$('#sc-dots i').forEach((el, i) => el.classList.toggle('on', i === idx));
      $('#sc-count').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(CHAPTERS.length).padStart(2, '0')}`;
      $('#sc-layer').textContent = CHAPTERS[idx].name;
      this.spinning = CHAPTERS[idx].spin && !reduced;
    }
    this.setExplode(s.ex);
    for (const m of this.meshes) m.userData.target = 0.07 + 0.93 * (s.w[m.userData.layer] ?? 1);
    const target = new THREE.Vector3(...s.t), r = this.fit(s.ex) * s.k, az = s.az * D2R, el = s.el * D2R;
    this.camera.position.set(target.x + r * Math.cos(el) * Math.cos(az), target.y + r * Math.sin(el), target.z + r * Math.cos(el) * Math.sin(az));
    this.camera.lookAt(target);
    this.tickMaterials(dt, this.spinning);
    const focus = CHAPTERS[idx].focus;
    const v = new THREE.Vector3();
    for (const t of this.tags) {
      const show = focus && t.part.layer === focus && t.mesh && (s.w[focus] ?? 0) > 0.85;
      if (!show) { t.el.hidden = true; continue; }
      const p2 = this.project(this.anchorOf(t.mesh, v));
      t.el.hidden = !p2.on;
      t.el.style.transform = `translate(${p2.x.toFixed(1)}px,${(p2.y - 14).toFixed(1)}px) translate(-50%,-50%)`;
    }
    this.render();
  }
}

/* ---------------- Interactive atelier ---------------- */
const VIEWS = { iso: { az: 35, el: 24 }, top: { az: 180, el: 89 }, front: { az: 0, el: 5 }, side: { az: 90, el: 5 } };

class Atelier extends Viewer {
  constructor(canvas, template, source) {
    super(canvas, template);
    this.state = { selected: 'fc', hidden: new Set(), soloPart: false, soloLayer: null, colors: false, spin: false, hotspots: true, dims: false };
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.minDistance = 160;
    this.controls.maxDistance = 4000;
    this.controls.autoRotateSpeed = 1.1;
    if (coarse) canvas.style.touchAction = 'pan-y';
    canvas.addEventListener('pointerdown', () => { this.controls.enableZoom = true; });
    canvas.addEventListener('pointerleave', () => { if (!coarse) this.controls.enableZoom = false; });
    this.controls.addEventListener('start', () => { this.tween = null; });
    this.overlay = $('#atelier-overlay');
    this.raycaster = new THREE.Raycaster();
    this.buildDims();
    this.buildHotspots();
    this.buildPanel();
    this.bindUI(source);
    this.setView('iso', true);
    this.select(window.naviPendingPart || 'fc', { focus: !!window.naviPendingPart, quiet: true });
    this.applyVisibility();
  }
  /* --- UI construction --- */
  buildPanel() {
    $('#part-count').textContent = `${PARTS.length} parts`;
    $('#layer-list').innerHTML = LAYERS.map(l => `
      <div class="layer-group" data-layer="${l.id}">
        <div class="layer-head"><span class="swatch" style="background:${l.color}"></span>
          <button class="layer-toggle name" data-solo-layer="${l.id}" aria-pressed="false" style="border:0;text-align:left;padding:0;font:inherit;letter-spacing:inherit;text-decoration:none" title="Isolate this layer">${l.n} · ${esc(l.name)}</button>
          <button class="layer-toggle" data-layer-toggle="${l.id}" aria-pressed="true" aria-label="Show ${esc(l.name)} layer">ON</button></div>
        ${PARTS.filter(p => p.layer === l.id).map(p => `<button class="part-button" data-select="${p.id}"><span class="num">${p.n}</span><span><strong>${esc(p.short)}</strong></span></button>`).join('')}
      </div>`).join('');
  }
  buildHotspots() {
    this.hotspots = PARTS.map(p => {
      const b = document.createElement('button');
      b.className = 'hotspot'; b.textContent = p.n; b.dataset.select = p.id;
      b.style.setProperty('--hs', layerOf(p.layer).color);
      b.setAttribute('aria-label', `${p.n} ${p.name}`);
      b.title = p.name;
      this.overlay.appendChild(b);
      return { part: p, el: b, mesh: this.meshes.find(m => m.userData.name.startsWith(p.anchor)) };
    });
    this.hoverTag = document.createElement('div');
    this.hoverTag.className = 'tag'; this.hoverTag.hidden = true;
    this.overlay.appendChild(this.hoverTag);
  }
  buildDims() {
    const mat = new THREE.LineBasicMaterial({ color: 0xedc18a, depthTest: false, transparent: true, opacity: 0.9 });
    this.dimGroup = new THREE.Group(); this.dimGroup.visible = false; this.dimGroup.renderOrder = 5;
    this.root.add(this.dimGroup);
    const line = () => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), mat); l.renderOrder = 5; this.dimGroup.add(l); return l; };
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * Math.PI * 2) * 127, Math.sin(i / 64 * Math.PI * 2) * 127, 0))), mat);
    ring.renderOrder = 5; this.dimGroup.add(ring);
    this.dims = { wheel: line(), gear: line(), ring, labels: ['450 mm wheelbase', 'Ø254 mm prop', '150 mm gear', '138 × 43 × 25 mm'].map(t => { const el = document.createElement('div'); el.className = 'tag dim'; el.textContent = t; el.hidden = true; this.overlay.appendChild(el); return el; }) };
  }
  bindUI(source) {
    $('#atelier').querySelector('.scene-footer span:last-child').innerHTML = `Explode vectors from <span class="mono">${esc(source)}</span>`;
    const ex = $('#explode');
    ex.addEventListener('input', () => this.setExplodeUI(ex.value / 100));
    $$('.camera').forEach(b => b.addEventListener('click', () => this.setView(b.dataset.view)));
    const toggle = (id, key, fn) => $(id).addEventListener('click', e => {
      this.state[key] = !this.state[key];
      e.currentTarget.setAttribute('aria-pressed', String(this.state[key]));
      fn?.();
    });
    toggle('#tg-hotspots', 'hotspots');
    toggle('#tg-dims', 'dims', () => { this.dimGroup.visible = this.state.dims; });
    toggle('#tg-colors', 'colors', () => this.applyColors());
    toggle('#tg-spin', 'spin');
    $('#tg-orbit').addEventListener('click', e => {
      this.controls.autoRotate = !this.controls.autoRotate;
      e.currentTarget.setAttribute('aria-pressed', String(this.controls.autoRotate));
    });
    $('#at-reset').addEventListener('click', () => this.reset());
    document.addEventListener('click', e => {
      const sel = e.target.closest('[data-select]');
      if (sel && $('#atelier').contains(sel)) { this.select(sel.dataset.select, { focus: sel.classList.contains('part-button') }); return; }
      const lt = e.target.closest('[data-layer-toggle]');
      if (lt) {
        const id = lt.dataset.layerToggle;
        this.state.hidden.has(id) ? this.state.hidden.delete(id) : this.state.hidden.add(id);
        this.state.soloLayer = null;
        this.applyVisibility();
        return;
      }
      const sl = e.target.closest('[data-solo-layer]');
      if (sl) {
        const id = sl.dataset.soloLayer;
        this.state.soloLayer = this.state.soloLayer === id ? null : id;
        this.state.hidden.clear(); this.state.soloPart = false;
        this.applyVisibility();
      }
    });
    window.addEventListener('navi:select-part', e => this.select(e.detail.id, { focus: true }));
    // Click-to-pick on the canvas (ignoring drags).
    let down = null;
    this.canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    this.canvas.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 6 && performance.now() - down.t < 500) { const hit = this.pick(e); if (hit) this.select(hit, { focus: false }); }
      down = null;
    });
    let lastPick = 0;
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' || e.buttons) { this.hoverTag.hidden = true; return; }
      if (e.timeStamp - lastPick < 40) return;
      lastPick = e.timeStamp;
      const hit = this.pick(e);
      this.canvas.style.cursor = hit ? 'pointer' : '';
      if (hit) {
        const r = this.canvas.getBoundingClientRect();
        this.hoverTag.textContent = partById(hit).name;
        this.hoverTag.style.transform = `translate(${e.clientX - r.left}px,${e.clientY - r.top - 22}px) translate(-50%,-50%)`;
        this.hoverTag.hidden = false;
      } else this.hoverTag.hidden = true;
    });
    this.canvas.addEventListener('pointerleave', () => { this.hoverTag.hidden = true; });
  }
  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes.filter(m => m.visible && m.userData.target > 0.5), false);
    return hits[0]?.object.userData.part || null;
  }
  /* --- State --- */
  isShown(m) {
    const { layer, part } = m.userData, s = this.state;
    if (s.soloLayer) return layer === s.soloLayer;
    return !s.hidden.has(layer);
  }
  applyVisibility() {
    const s = this.state;
    for (const m of this.meshes) {
      const shown = this.isShown(m);
      m.userData.target = !shown ? 0 : (s.soloPart && m.userData.part !== s.selected ? 0.07 : 1);
    }
    $$('[data-layer-toggle]').forEach(b => {
      const on = !s.hidden.has(b.dataset.layerToggle) && (!s.soloLayer || s.soloLayer === b.dataset.layerToggle);
      b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'ON' : 'OFF';
    });
    $$('[data-solo-layer]').forEach(b => b.setAttribute('aria-pressed', String(s.soloLayer === b.dataset.soloLayer)));
    $$('.part-button').forEach(b => {
      const p = partById(b.dataset.select);
      b.classList.toggle('off', s.hidden.has(p.layer) || (s.soloLayer && s.soloLayer !== p.layer));
    });
    const shownLayers = LAYERS.filter(l => s.soloLayer ? l.id === s.soloLayer : !s.hidden.has(l.id)).length;
    const pct = Math.round(this.explode * 100);
    $('#at-caption').textContent = `${pct ? `EXPLODED ${pct}%` : 'ASSEMBLED'} · ${shownLayers === LAYERS.length ? 'ALL LAYERS' : `${shownLayers} OF ${LAYERS.length} LAYERS`}${s.soloPart ? ' · PART ISOLATED' : ''}`;
    const solo = $('#solo'); if (solo) solo.setAttribute('aria-pressed', String(s.soloPart));
  }
  applyColors() {
    for (const m of this.meshes) {
      const l = layerOf(m.userData.layer);
      m.material.color.copy(this.state.colors && l ? new THREE.Color(l.color) : m.userData.baseColor);
    }
  }
  setExplodeUI(t) {
    const prev = this.fit(this.explode), dist = this.camera.position.distanceTo(this.controls.target);
    this.setExplode(t);
    const next = this.fit(t);
    if (!this.tween) {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(dir, dist * next / prev);
    } else this.tween.r = this.tween.r * next / prev;
    $('#explode-value').textContent = Math.round(t * 100) + '%';
    $('#explode').value = Math.round(t * 100);
    this.applyVisibility();
  }
  setView(name, instant = false, opts = {}) {
    const v = VIEWS[name] || VIEWS.iso;
    $$('.camera').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    this.flyTo({ target: opts.target || new THREE.Vector3(0, -10 - 20 * this.explode, 0), az: v.az, el: v.el, r: opts.r || this.fit(this.explode) }, instant);
  }
  flyTo({ target, az, el, r }, instant) {
    const from = { p: this.camera.position.clone(), t: this.controls.target.clone() };
    this.tween = { from, target, az, el, r, t: instant || reduced ? 1 : 0 };
    if (this.tween.t >= 1) this.stepTween(0);
  }
  stepTween(dt) {
    const tw = this.tween; if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / 0.9);
    const f = ease(tw.t), a = tw.az * D2R, e = tw.el * D2R;
    const end = new THREE.Vector3(tw.target.x + tw.r * Math.cos(e) * Math.cos(a), tw.target.y + tw.r * Math.sin(e), tw.target.z + tw.r * Math.cos(e) * Math.sin(a));
    this.controls.target.lerpVectors(tw.from.t, tw.target, f);
    this.camera.position.lerpVectors(tw.from.p, end, f);
    if (tw.t >= 1) this.tween = null;
  }
  select(id, { focus = false, quiet = false } = {}) {
    const p = partById(id); if (!p) return;
    this.state.selected = id;
    if (this.state.hidden.has(p.layer) || (this.state.soloLayer && this.state.soloLayer !== p.layer)) { this.state.hidden.delete(p.layer); this.state.soloLayer = null; }
    $$('.part-button').forEach(b => b.classList.toggle('active', b.dataset.select === id));
    this.hotspots.forEach(h => h.el.classList.toggle('active', h.part.id === id));
    const l = layerOf(p.layer);
    $('#at-eyebrow').textContent = `${l.n} · ${l.name.toUpperCase()}`;
    $('#at-title').textContent = p.name;
    $('#at-sub').textContent = p.envelope;
    this.renderInspector(p);
    this.applyVisibility();
    if (focus) this.focusPart(id);
    if (!quiet) announce(`${p.name} selected`);
  }
  focusPart(id) {
    const ms = this.meshes.filter(m => m.userData.part === id);
    if (!ms.length) return;
    const box = new THREE.Box3();
    ms.forEach(m => { m.updateMatrixWorld(); box.expandByObject(m); });
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const az = Math.atan2(dir.z, dir.x) / D2R, el = Math.asin(Math.max(-1, Math.min(1, dir.y))) / D2R;
    const vf = this.camera.fov * D2R;
    this.flyTo({ target: c, az, el: Math.max(10, el), r: Math.max(260, size * 0.75 / Math.tan(vf / 2)) });
    $$('.camera').forEach(b => b.classList.remove('active'));
  }
  reset() {
    Object.assign(this.state, { hidden: new Set(), soloPart: false, soloLayer: null, colors: false, spin: false, hotspots: true, dims: false });
    this.controls.autoRotate = false;
    [['#tg-hotspots', true], ['#tg-dims', false], ['#tg-colors', false], ['#tg-spin', false], ['#tg-orbit', false]].forEach(([id, v]) => $(id).setAttribute('aria-pressed', String(v)));
    this.dimGroup.visible = false;
    this.applyColors();
    this.setExplodeUI(0);
    this.setView('iso');
    this.select('fc', { quiet: true });
  }
  renderInspector(p) {
    const l = layerOf(p.layer);
    const owner = TEAM.find(t => t.name === p.owner);
    const rows = p.pinout
      ? `<div class="section-label">Wiring &amp; port map</div><table class="pin-table"><tbody>${p.pinout.map(r => `<tr><td>${esc(r[0])}</td><td><b>${esc(r[1])}</b><small>${esc(r[2])}</small></td></tr>`).join('')}</tbody></table>${p.pinNote ? `<p class="fine" style="margin:8px 0 0">${esc(p.pinNote)}</p>` : ''}`
      : `<div class="section-label">Interfaces</div><table class="pin-table"><tbody>${p.iface.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</tbody></table>`;
    $('#inspector').innerHTML = `
      <label class="sr-only" for="jump">Jump to part</label>
      <select id="jump" class="btn sm" style="width:100%;margin-bottom:16px;text-align:left">${PARTS.map(q => `<option value="${q.id}" ${q.id === p.id ? 'selected' : ''}>${q.n} · ${esc(q.name)}</option>`).join('')}</select>
      <span class="part-index">${p.n}</span>
      <span class="eyebrow"><span class="layer-key" style="background:${l.color}"></span>${esc(l.name.toUpperCase())} / COMPONENT</span>
      <h3>${esc(p.name)}</h3>
      <span class="pill">${esc(p.status)}</span>
      <div class="spec-grid"><div><small>Envelope</small><b>${esc(p.envelope)}</b></div><div><small>Budget allocation</small><b class="money">${esc(p.budget)}</b></div></div>
      <div class="row"><button class="btn" id="solo" aria-pressed="${this.state.soloPart}">Isolate part</button><button class="btn" id="focus-cam">Focus camera</button></div>
      <div class="section-label">What it does</div><p class="detail-text">${esc(p.does)}</p>
      <div class="section-label">Why this part</div><p class="detail-text">${esc(p.why)}</p>
      ${rows}
      <div class="note" style="margin-top:16px"><b>Verify before flight</b><br>${esc(p.verify)}</div>
      ${owner ? `<div class="owner"><span class="avatar">${owner.initials}</span><span>Owner · <b style="color:var(--text);font-weight:500">${esc(owner.name)}</b><br>${owner.school} · ${esc(owner.role)}</span></div>` : ''}`;
    $('#jump').addEventListener('change', e => this.select(e.target.value, { focus: true }));
    $('#solo').addEventListener('click', () => { this.state.soloPart = !this.state.soloPart; this.applyVisibility(); });
    $('#focus-cam').addEventListener('click', () => this.focusPart(p.id));
  }
  /* --- Frame --- */
  tick(dt, now) {
    this.stepTween(dt);
    this.controls.update();
    this.tickMaterials(dt, this.state.spin && !reduced);
    const pulse = 0.22 + 0.12 * Math.sin(now / 320);
    for (const m of this.meshes) m.material.emissive.setRGB(...(m.userData.part === this.state.selected ? [0.58 * pulse, 0.9 * pulse, 0.79 * pulse] : [0, 0, 0]));
    const v = new THREE.Vector3();
    for (const h of this.hotspots) {
      const shown = this.state.hotspots && h.mesh && h.mesh.userData.opacity > 0.5;
      if (!shown) { h.el.hidden = true; continue; }
      const p = this.project(this.anchorOf(h.mesh, v));
      h.el.hidden = !p.on;
      h.el.style.transform = `translate(${p.x.toFixed(1)}px,${(p.y - 6).toFixed(1)}px)`;
    }
    if (this.state.dims) this.updateDims();
    else this.dims.labels.forEach(l => { l.hidden = true; });
    this.render();
  }
  updateDims() {
    const get = n => this.meshes.find(m => m.userData.name === n || m.userData.name.startsWith(n));
    const local = (m, z) => { const bb = m.geometry.boundingBox; return new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, z === 'top' ? bb.max.z : z === 'bot' ? bb.min.z : (bb.min.z + bb.max.z) / 2).add(m.position); };
    const setLine = (line, a, b) => { line.geometry.setFromPoints([a, b]); };
    const m45 = get('motor_45'), m225 = get('motor_225'), prop = get('prop_1045_315'), skid = get('gear_skid_-1'), plate = get('bottom_plate'), bat = get('battery_3S');
    const a = local(m225, 'top'), b = local(m45, 'top');
    setLine(this.dims.wheel, a, b);
    this.dims.ring.position.copy(prop.position).add(new THREE.Vector3(0, 0, 1));
    const gearOK = this.explode < 0.02;
    const gTop = new THREE.Vector3(120, -105, plate.position.z), gBot = new THREE.Vector3(120, -105, -150 + skid.position.z);
    setLine(this.dims.gear, gTop, gBot); this.dims.gear.visible = gearOK;
    const pts = [a.clone().lerp(b, 0.5), prop.position.clone().add(new THREE.Vector3(0, -127, 0)), gTop.clone().lerp(gBot, 0.5), local(bat, 'bot')];
    pts.forEach((pt, i) => {
      const el = this.dims.labels[i];
      if (i === 2 && !gearOK) { el.hidden = true; return; }
      const p = this.project(this.root.localToWorld(pt.clone()));
      el.hidden = !p.on || (i === 3 && bat.userData.opacity < 0.5);
      el.style.transform = `translate(${p.x.toFixed(1)}px,${(p.y + (i === 3 ? 16 : 0)).toFixed(1)}px) translate(-50%,-50%)`;
    });
  }
}

/* ---------------- Boot ---------------- */
function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); }
  catch { return false; }
}

export async function initCad() {
  if (!webglAvailable()) {
    $$('.loading').forEach(l => { l.innerHTML = ''; l.insertAdjacentHTML('afterend', '<div class="webgl-error">3D rendering needs WebGL, which is unavailable in this browser. The specifications, budget and wiring for every part remain available below.</div>'); l.remove(); });
    return;
  }
  const gltf = await new Promise((res, rej) => new GLTFLoader().load(MODEL_URL, res, e => { if (e.total) setProgress(e.loaded / e.total); }, rej));
  const { vectors, source } = await explodeVectors(gltf.parser.json);
  const template = buildTemplate(gltf, vectors);
  const scroller = new ScrollViewer($('#scrolly-canvas'), template);
  const atelier = new Atelier($('#atelier-canvas'), template, source);
  $$('.loading').forEach(l => l.remove());
  const viewers = [scroller, atelier];
  let last = performance.now();
  const loop = now => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!document.hidden) for (const v of viewers) if (v.visible) v.tick(dt, now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
