// NAVI campus graph: the same Haversine, Dijkstra and leg-splitting rules as navi_app.
let cache = null;

const R = 6371000, rad = d => d * Math.PI / 180;
export function metres(a, b) {
  const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function loadCampus() {
  if (!cache) cache = fetch('assets/data/campus.json').then(r => {
    if (!r.ok) throw new Error('campus.json HTTP ' + r.status);
    return r.json();
  }).then(build);
  return cache;
}

function build(D) {
  const N = {}, ADJ = {};
  D.nodes.forEach(([id, lat, lon, cs]) => { N[id] = [lat, lon]; ADJ[id] = cs.filter(v => v !== id); });
  for (const id in ADJ) ADJ[id] = ADJ[id].filter(v => N[v]);

  function dijkstra(src) {
    const dist = { [src]: 0 }, prev = {}, seen = new Set(), pq = [[0, src]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      for (const v of ADJ[u] || []) {
        const nd = d + metres(N[u], N[v]);
        if (nd < (dist[v] ?? Infinity)) { dist[v] = nd; prev[v] = u; pq.push([nd, v]); }
      }
    }
    return { dist, prev };
  }
  const pathOf = (prev, s, t) => { const p = [t]; while (p[0] !== s) { if (!(p[0] in prev)) return null; p.unshift(prev[p[0]]); } return p; };
  const pathLen = p => { let m = 0; for (let i = 1; i < p.length; i++) m += metres(N[p[i - 1]], N[p[i]]); return m; };
  function splitLegs(p, limit = D.legLimit) {
    const out = []; let leg = [p[0]], run = 0;
    for (let i = 1; i < p.length; i++) {
      const st = metres(N[p[i - 1]], N[p[i]]);
      if (run + st > limit && leg.length > 1) { out.push({ nodes: [...leg], m: run }); leg = [p[i - 1]]; run = 0; }
      leg.push(p[i]); run += st;
    }
    out.push({ nodes: leg, m: run });
    return out;
  }

  const runs = {};
  const from = id => (runs[id] ||= dijkstra(id));
  const GATE = D.pads[0][0];
  const pads = D.pads.map(([id, name]) => ({ id, name, pos: N[id] }));
  const dests = D.dests.map(([name, ents, cat]) => {
    let best = { d: Infinity, pad: pads[0], ent: ents[0] };
    for (const p of pads) for (const e of ents) { const d = from(p.id).dist[e]; if (d != null && d < best.d) best = { d, pad: p, ent: e }; }
    let gate = { d: Infinity, ent: ents[0] };
    for (const e of ents) { const d = from(GATE).dist[e]; if (d != null && d < gate.d) gate = { d, ent: e }; }
    return { name, ents, cat, pad: best.pad, ent: best.ent, fromPad: best.d, gateEnt: gate.ent, fromGate: gate.d };
  }).sort((a, b) => a.name.localeCompare(b.name));

  function route(dest, origin = 'pad') {
    const s = origin === 'gate' ? GATE : dest.pad.id, t = origin === 'gate' ? dest.gateEnt : dest.ent;
    const p = pathOf(from(s).prev, s, t) || [s];
    return { nodes: p, coords: p.map(id => N[id]), m: pathLen(p), legs: splitLegs(p) };
  }

  // Local metric frame (x east, y north) anchored at the boundary's first vertex.
  const LAT0 = 12.8425, KLAT = 110574, KLON = 111320 * Math.cos(rad(LAT0));
  const o = D.boundary[0];
  const xy = p => [(p[1] - o[1]) * KLON, (p[0] - o[0]) * KLAT];
  const BP = D.boundary.map(xy);
  function inFence(pt) {
    const [x, y] = xy(pt); let c = false;
    for (let i = 0, n = BP.length; i < n; i++) {
      const [x1, y1] = BP[i], [x2, y2] = BP[(i + 1) % n];
      if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
  }
  function fenceDist(pt) {
    const [x, y] = xy(pt); let b = Infinity;
    for (let i = 0, n = BP.length; i < n; i++) {
      const [x1, y1] = BP[i], [x2, y2] = BP[(i + 1) % n];
      const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
      const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L));
      b = Math.min(b, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
    return b;
  }
  const edges = [];
  const seen = new Set();
  for (const id in ADJ) for (const v of ADJ[id]) {
    const k = Math.min(id, v) + '-' + Math.max(id, v);
    if (!seen.has(k)) { seen.add(k); edges.push([+id, v]); }
  }
  const riskNodes = D.nodes.filter(([, la, lo]) => inFence([la, lo]) && fenceDist([la, lo]) < 25).map(([id]) => id);
  const networkKm = edges.reduce((s, [a, b]) => s + metres(N[a], N[b]), 0) / 1000;

  return { D, N, ADJ, edges, pads, dests, route, splitLegs, xy, inFence, fenceDist, riskNodes, networkKm, GATE };
}
