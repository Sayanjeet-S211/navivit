// Campus dataset: validation, routing and trip planning. Shared by browser, server and tests.
import { haversine, localFrame, pointInPolygon, distanceToPolygonEdge, isLatLon, fnv1a, projectOnSegment } from './geo.js';
import { CONFIG, walkingEtaS } from './config.js';
import { planJourney } from './journey.js';

export class CampusError extends Error {
  constructor(errors) { super('Campus data failed validation: ' + errors.slice(0, 3).join('; ')); this.errors = errors; }
}

const edgeKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;

/** Validate raw campus data. Returns errors (fatal) and warnings, plus recomputed statistics. */
export function validateCampus(raw) {
  const errors = [], warnings = [];
  if (!raw || raw.schema !== 'navi-campus/1') errors.push('unknown schema');
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  if (!nodes.length) errors.push('no nodes');
  const byId = new Map();
  for (const n of nodes) {
    if (!Number.isInteger(n.id)) { errors.push(`node with invalid id ${JSON.stringify(n.id)}`); continue; }
    if (byId.has(n.id)) errors.push(`duplicate node ${n.id}`);
    if (!isLatLon([n.lat, n.lon])) errors.push(`node ${n.id} has invalid coordinates`);
    byId.set(n.id, n);
  }
  // Coordinate order: every node should fall near the boundary's bounding box.
  const bnd = Array.isArray(raw?.boundary) ? raw.boundary : [];
  if (bnd.length < 3 || !bnd.every(isLatLon)) errors.push('boundary missing or invalid');
  else {
    const lats = bnd.map(p => p[0]), lons = bnd.map(p => p[1]);
    const box = [Math.min(...lats) - 0.01, Math.max(...lats) + 0.01, Math.min(...lons) - 0.01, Math.max(...lons) + 0.01];
    const outside = nodes.filter(n => !(n.lat >= box[0] && n.lat <= box[1] && n.lon >= box[2] && n.lon <= box[3]));
    if (outside.length) errors.push(`${outside.length} nodes far outside the campus (swapped lat/lon?)`);
  }
  const edges = new Map();
  for (const n of nodes) for (const v of n.adj || []) {
    if (!byId.has(v)) { errors.push(`node ${n.id} references missing node ${v}`); continue; }
    if (v === n.id) { warnings.push(`self-loop at ${n.id} ignored`); continue; }
    if (!(byId.get(v).adj || []).includes(n.id)) warnings.push(`one-way reference ${n.id}→${v}`);
    edges.set(edgeKey(n.id, v), [n.id, v]);
  }
  for (const d of raw?.destinations || []) {
    if (!d.entrances?.length) errors.push(`destination ${d.name} has no entrance`);
    for (const e of d.entrances || []) if (!byId.has(e)) errors.push(`destination ${d.name} entrance ${e} missing`);
  }
  for (const p of raw?.pads || []) if (!byId.has(p.node)) errors.push(`pad ${p.id} node ${p.node} missing`);
  // Connectivity
  let components = 0;
  const seen = new Set();
  const adj = new Map(nodes.map(n => [n.id, []]));
  edges.forEach(([a, b]) => { adj.get(a)?.push(b); adj.get(b)?.push(a); });
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    components++;
    const stack = [n.id];
    while (stack.length) { const u = stack.pop(); if (seen.has(u)) continue; seen.add(u); stack.push(...(adj.get(u) || [])); }
  }
  if (components > 1) warnings.push(`${components} disconnected graph components`);
  let km = 0;
  edges.forEach(([a, b]) => { const A = byId.get(a), B = byId.get(b); km += haversine([A.lat, A.lon], [B.lat, B.lon]); });
  return { errors, warnings, stats: { nodes: nodes.length, segments: edges.size, networkKm: km / 1000, components, destinations: raw?.destinations?.length || 0, pads: raw?.pads?.length || 0 } };
}

/** Validate the pad configuration against the campus graph. */
export function validatePads(padsRaw, raw) {
  const errors = [], ids = new Set(), nodes = new Set((raw.nodes || []).map(n => n.id)), dests = new Set((raw.destinations || []).map(d => d.id));
  if (!padsRaw || padsRaw.schema !== 'navi-pads/1') errors.push('unknown pad schema');
  for (const p of padsRaw?.pads || []) {
    if (!p.id || ids.has(p.id)) errors.push(`pad id ${p.id} missing or duplicated`); ids.add(p.id);
    if (!nodes.has(p.node)) errors.push(`pad ${p.id} node ${p.node} missing`);
    for (const d of p.serves || []) if (!dests.has(d)) errors.push(`pad ${p.id} serves unknown destination ${d}`);
  }
  return errors;
}

export class Campus {
  constructor(raw, config = CONFIG, padsRaw = null) {
    const v = validateCampus(raw);
    if (v.errors.length) throw new CampusError(v.errors);
    this.raw = raw; this.config = config; this.version = raw.version; this.stats = v.stats; this.warnings = v.warnings;
    this.nodes = new Map(raw.nodes.map(n => [n.id, { id: n.id, ll: [n.lat, n.lon], adj: n.adj.filter(x => x !== n.id) }]));
    this.forbidden = new Set(raw.edgeMeta?.forbidden || []);
    this.penalty = raw.edgeMeta?.penalty || {};
    this.classified = !!raw.edgeMeta?.classified;
    this.edges = [];
    const seen = new Set();
    for (const n of this.nodes.values()) for (const b of n.adj) {
      const k = edgeKey(n.id, b);
      if (seen.has(k)) continue; seen.add(k);
      this.edges.push({ a: n.id, b, key: k, lengthM: haversine(n.ll, this.nodes.get(b).ll) });
    }
    this.edgeLen = new Map(this.edges.map(e => [e.key, e.lengthM]));
    this.boundary = raw.boundary;
    this.frame = localFrame(raw.centre || raw.boundary[0]);
    this.boundaryXY = raw.boundary.map(this.frame.toXY);
    if (padsRaw) { const pe = validatePads(padsRaw, raw); if (pe.length) throw new CampusError(pe); }
    // Without a pad configuration only the six source pads are known (no handoff support recorded).
    const padList = padsRaw ? padsRaw.pads : raw.pads.map(p => ({ ...p, kind: 'source', approval: 'proposed', serves: [], support: { handoff: false } }));
    this.padsVersion = padsRaw?.version || 'source-6';
    this.pads = padList.map(p => ({ ...p, ll: this.nodes.get(p.node).ll }));
    this.destinations = raw.destinations.map(d => ({ ...d, entranceLL: d.entrances.map(e => this.nodes.get(e).ll) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.categories = [...new Set(this.destinations.map(d => d.category))].sort();
    this._dij = new Map();
  }

  node(id) { return this.nodes.get(id); }
  destination(id) { return this.destinations.find(d => d.id === id); }
  pad(id) { return this.pads.find(p => p.id === id); }

  nearestNode(ll, maxM = Infinity) {
    let best = null;
    for (const n of this.nodes.values()) { const d = haversine(ll, n.ll); if (d < (best?.distM ?? Infinity)) best = { id: n.id, distM: d }; }
    return best && best.distM <= maxM ? best : null;
  }

  /** Dijkstra from a source node. Penalties change route choice only; forbidden edges are excluded. */
  dijkstra(src) {
    if (this._dij.has(src)) return this._dij.get(src);
    const dist = new Map([[src, 0]]), prev = new Map(), done = new Set(), pq = [[0, src]];
    while (pq.length) {
      let bi = 0; for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
      const [d, u] = pq.splice(bi, 1)[0];
      if (done.has(u)) continue; done.add(u);
      for (const v of this.nodes.get(u).adj) {
        const k = edgeKey(u, v);
        if (this.forbidden.has(k)) continue;
        const nd = d + this.edgeLen.get(k) * (this.penalty[k] || 1);
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); pq.push([nd, v]); }
      }
    }
    const r = { dist, prev };
    this._dij.set(src, r);
    return r;
  }

  path(src, dst) {
    if (!this.nodes.has(src) || !this.nodes.has(dst)) return null;
    const { prev, dist } = this.dijkstra(src);
    if (src !== dst && !prev.has(dst)) return null;
    const nodes = [dst];
    while (nodes[0] !== src) nodes.unshift(prev.get(nodes[0]));
    const coords = nodes.map(id => this.nodes.get(id).ll);
    let lengthM = 0, maxEdgeM = 0;
    for (let i = 1; i < nodes.length; i++) { const l = this.edgeLen.get(edgeKey(nodes[i - 1], nodes[i])); lengthM += l; maxEdgeM = Math.max(maxEdgeM, l); }
    return { nodes, coords, lengthM, costM: dist.get(dst), maxEdgeM };
  }

  inFence(ll) { return pointInPolygon(this.frame.toXY(ll), this.boundaryXY); }
  fenceEdgeDistance(ll) { return distanceToPolygonEdge(this.frame.toXY(ll), this.boundaryXY); }
  /** Metres outside the boundary polygon (0 when inside). */
  outsideM(ll) { return this.inFence(ll) ? 0 : this.fenceEdgeDistance(ll); }
  breach(ll) { return this.outsideM(ll) > this.config.fenceBufferM; }

  /** Check every route edge, sampled every 5 m, against the boundary and buffer. */
  routeFenceCheck(coords) {
    let maxOutsideM = 0, firstBreach = null;
    for (let i = 1; i < coords.length; i++) {
      const a = this.frame.toXY(coords[i - 1]), b = this.frame.toXY(coords[i]);
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
      for (let k = 0; k <= n; k++) {
        const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
        const out = pointInPolygon(p, this.boundaryXY) ? 0 : distanceToPolygonEdge(p, this.boundaryXY);
        if (out > maxOutsideM) maxOutsideM = out;
        if (!firstBreach && out > this.config.fenceBufferM) firstBreach = this.frame.toLL(p);
      }
    }
    return { maxOutsideM, breach: !!firstBreach, firstBreach, insideBoundary: maxOutsideM === 0 };
  }

  /** Shapes whose union is the boundary buffered outward by fenceBufferM (Minkowski sum with a disc). */
  bufferShapes(r = this.config.fenceBufferM) {
    const P = this.boundaryXY, rects = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L * r, ny = dx / L * r;
      rects.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]].map(this.frame.toLL));
    }
    return { rects, circles: this.boundary.map(c => ({ center: c, radiusM: r })) };
  }

  /** Places a visitor can choose as a starting point. */
  places() {
    const out = this.pads.filter(p => p.kind === 'source').map(p => ({ kind: 'pad', id: 'pad:' + p.id, name: p.name, sub: p.approval === 'approved' ? 'Launch pad' : 'Proposed launch pad', nodeId: p.node, ll: p.ll }));
    for (const d of this.destinations) d.entrances.forEach((e, i) => out.push({ kind: 'place', id: `place:${d.id}:${i}`, name: d.name, sub: d.entrances.length > 1 ? `${d.category} · entrance ${i + 1}` : d.category, nodeId: e, ll: this.nodes.get(e).ll }));
    return out;
  }

  straightLineM(ll, dest) { return Math.min(...dest.entranceLL.map(e => haversine(ll, e))); }

  /**
   * Plan a trip. origin: {kind:'measured'|'pin'|'place'|'pad', ll, nodeId?, accuracyM?, label}
   * padStatus: {[padId]: 'ready'|'unavailable'|'unknown'|'busy'}; padHandoff: {[padId]: boolean};
   * aircraftAvailable: number. See journey.js.
   */
  plan(opts) { return planJourney(this, opts); }
}

/** Progress (metres along) and distance of a point from a polyline, with every candidate projection. */
export function projectOnRoute(frame, coords, ll) {
  const p = frame.toXY(ll), pts = coords.map(frame.toXY), cands = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const r = projectOnSegment(p, pts[i - 1], pts[i]);
    cands.push({ progressM: acc + r.t * seg, distM: r.d, ll: frame.toLL(r.q), seg: i - 1 });
    acc += seg;
  }
  return { totalM: acc, candidates: cands.sort((a, b) => a.distM - b.distM) };
}

/** Point at a given distance along a polyline (local metres), plus local direction. */
export function pointAlong(frame, coords, s) {
  const pts = coords.map(frame.toXY);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= s || i === pts.length - 1) {
      const t = seg ? Math.max(0, Math.min(1, (s - acc) / seg)) : 0;
      const q = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      const dir = seg ? [(pts[i][0] - pts[i - 1][0]) / seg, (pts[i][1] - pts[i - 1][1]) / seg] : [1, 0];
      return { ll: frame.toLL(q), xy: q, dir };
    }
    acc += seg;
  }
  return { ll: coords[0], xy: pts[0], dir: [1, 0] };
}

export function polylineLengthM(frame, coords) {
  let L = 0; const pts = coords.map(frame.toXY);
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
