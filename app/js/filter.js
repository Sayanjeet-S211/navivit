// Visitor-position conditioning, shared by the phone client (display) and the ground station
// (authoritative). Raw fixes are validated, implausible jumps are rejected, and accepted fixes are
// matched to the active route with continuity and ambiguity checks.
import { haversine, isLatLon } from './geo.js';
import { projectOnRoute } from './campus.js';
import { CONFIG } from './config.js';

export class SampleFilter {
  constructor(frame, config = CONFIG) {
    this.frame = frame; this.c = config;
    this.route = null; this.reset();
  }
  reset() {
    this.last = null; this.lastSeenTs = -Infinity; this.lastSeq = -Infinity;
    this.progressM = null; this.progressT = null; this.rejectRun = []; this.stats = { accepted: 0, rejected: 0, reasons: {} };
  }
  /** Set the polyline ([lat, lon][]) used for route matching, or null for none. */
  setRoute(coords) { this.route = coords && coords.length > 1 ? coords : null; this.progressM = null; this.progressT = null; }

  _reject(reason, raw) {
    this.stats.rejected++; this.stats.reasons[reason] = (this.stats.reasons[reason] || 0) + 1;
    return { accepted: false, reason, raw, matched: null };
  }

  /**
   * sample: {seq, lat, lon, accuracyM, timestamp (ms, when measured), speed?, heading?}
   * Returns {accepted, reason, raw, quality, matched:{progressM, ll, distM, ambiguous, offRoute}|null, reanchored}
   */
  process(sample) {
    const raw = [sample.lat, sample.lon];
    if (!isLatLon(raw)) return this._reject('invalid_coordinates', raw);
    if (!Number.isFinite(sample.accuracyM) || sample.accuracyM <= 0) return this._reject('invalid_accuracy', raw);
    if (!Number.isFinite(sample.timestamp)) return this._reject('invalid_timestamp', raw);
    if (Number.isFinite(sample.seq) && sample.seq <= this.lastSeq) return this._reject('out_of_order', raw);
    if (sample.timestamp < this.lastSeenTs) return this._reject('out_of_order', raw);
    if (sample.timestamp === this.lastSeenTs) return this._reject('duplicate', raw);
    this.lastSeenTs = sample.timestamp;
    if (Number.isFinite(sample.seq)) this.lastSeq = sample.seq;
    if (sample.accuracyM > this.c.rejectAccuracyM) return this._reject('too_inaccurate', raw);

    let reanchored = false;
    if (this.last) {
      const dt = (sample.timestamp - this.last.t) / 1000;
      const d = haversine(this.last.ll, raw);
      // Subtract a share of both fixes' uncertainty so ordinary noise is not read as motion.
      const effective = Math.max(0, d - 0.5 * (sample.accuracyM + this.last.acc));
      if (effective / dt > this.c.maxPedestrianSpeedMps) {
        this.rejectRun.push({ t: sample.timestamp, ll: raw, acc: sample.accuracyM });
        // Three rejections in a row that agree with each other mean the old anchor was the outlier.
        const run = this.rejectRun.slice(-3);
        const consistent = run.length === 3 && run.every((r, i) => i === 0 || Math.max(0, haversine(run[i - 1].ll, r.ll) - 0.5 * (r.acc + run[i - 1].acc)) / Math.max(0.5, (r.t - run[i - 1].t) / 1000) <= this.c.maxPedestrianSpeedMps);
        if (!consistent) return this._reject('implausible_jump', raw);
        reanchored = true;
      }
    }
    this.rejectRun = [];
    this.last = { t: sample.timestamp, ll: raw, acc: sample.accuracyM };
    this.stats.accepted++;
    const quality = sample.accuracyM > this.c.poorAccuracyM ? 'poor' : 'good';
    return { accepted: true, reason: null, raw, quality, reanchored, matched: this.route ? this._match(raw, sample) : null };
  }

  _match(ll, sample) {
    const { candidates, totalM } = projectOnRoute(this.frame, this.route, ll);
    const limit = Math.max(this.c.offRouteM, 1.5 * sample.accuracyM);
    let best = candidates[0];
    if (this.progressM != null) {
      const dt = Math.max(0, (sample.timestamp - this.progressT) / 1000);
      const lo = this.progressM - 20, hi = this.progressM + this.c.maxPedestrianSpeedMps * dt + 20;
      const inWindow = candidates.find(c => c.progressM >= lo && c.progressM <= hi && c.distM <= limit);
      if (inWindow) best = inWindow;
    }
    if (!best || best.distM > limit) return { progressM: this.progressM, ll: null, distM: best?.distM ?? Infinity, ambiguous: false, offRoute: true, totalM };
    // Ambiguity: another projection about as close but far along the route (loops, parallel paths).
    const rival = candidates.find(c => c !== best && Math.abs(c.distM - best.distM) < this.c.ambiguityM && Math.abs(c.progressM - best.progressM) > this.c.ambiguityProgressM);
    if (rival && this.progressM == null) return { progressM: null, ll: null, distM: best.distM, ambiguous: true, offRoute: false, totalM };
    if (rival && Math.abs(best.progressM - this.progressM) > this.c.ambiguityProgressM) return { progressM: this.progressM, ll: null, distM: best.distM, ambiguous: true, offRoute: false, totalM };
    this.progressM = best.progressM; this.progressT = sample.timestamp;
    return { progressM: best.progressM, ll: best.ll, distM: best.distM, ambiguous: !!rival, offRoute: false, totalM };
  }
}

/** Ages of independent data streams. A healthy socket never makes an old location fresh. */
export class Freshness {
  constructor() { this.t = {}; }
  mark(kind, t) { if (Number.isFinite(t) && t > (this.t[kind] ?? -Infinity)) this.t[kind] = t; }
  ageS(kind, now) { return this.t[kind] == null ? Infinity : Math.max(0, (now - this.t[kind]) / 1000); }
  clear(kinds) { if (kinds) for (const k of kinds) delete this.t[k]; else this.t = {}; }
}

/** Least-squares speed (m/s) from [{t ms, s metres}] samples within a window. */
export function regressionSpeed(points, windowS = 6, now = points.at(-1)?.t) {
  const w = points.filter(p => now - p.t <= windowS * 1000);
  if (w.length < 3) return null;
  const mt = w.reduce((a, p) => a + p.t, 0) / w.length, ms = w.reduce((a, p) => a + p.s, 0) / w.length;
  const num = w.reduce((a, p) => a + (p.t - mt) * (p.s - ms), 0), den = w.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  return den ? num / den * 1000 : null;
}
