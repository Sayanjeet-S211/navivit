// Demo-only simulated visitor. Produces geolocation-shaped samples along a walking path with
// slowly varying (correlated) error, the way phone positioning behaves. Never used in live mode.
import { pointAlong, polylineLengthM } from '../campus.js';

const gauss = r => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export class SimulatedWalker {
  constructor({ frame, now, random = Math.random }) {
    this.frame = frame; this.now = now; this.random = random;
    this.behaviour = 'walk'; // walk | stop | slow
    this.dropout = false; this.offRoute = false; this.spike = false;
    this.s = 0; this.v = 0; this.seq = 0; this.bias = [0, 0]; this.lastEmit = -Infinity; this.limit = 0;
    this.path = null; this.L = 0;
  }
  setPath(coords) { this.path = coords; this.L = polylineLengthM(this.frame, coords); this.s = 0; }
  /** Allow walking up to this distance along the path (e.g. stay behind the aircraft). */
  setLimit(m) { this.limit = Math.max(0, Math.min(this.L, m)); }
  truePosition() {
    if (!this.path) return null;
    const p = pointAlong(this.frame, this.path, this.s), n = [-p.dir[1], p.dir[0]], off = this.offRoute ? 45 : 0;
    return this.frame.toLL([p.xy[0] + n[0] * off, p.xy[1] + n[1] * off]);
  }
  step(dt) {
    if (!this.path) return;
    let target = this.behaviour === 'stop' ? 0 : this.behaviour === 'slow' ? 0.4 : 0.8 * (1 + 0.06 * Math.sin(this.now() / 3100));
    const room = this.limit - this.s;
    if (room < 3) target = Math.min(target, Math.max(0, room * 0.25));
    this.v += Math.max(-0.8 * dt, Math.min(0.5 * dt, target - this.v));
    this.s = Math.min(this.L, this.s + Math.max(0, this.v) * dt);
  }
  /** A fix once per second unless the phone has stopped reporting. */
  sample() {
    const t = this.now();
    if (this.dropout || !this.path || t - this.lastEmit < 1000) return null;
    this.lastEmit = t;
    this.bias = this.bias.map(b => Math.max(-6, Math.min(6, 0.93 * b + gauss(this.random) * 0.7)));
    const xy = this.frame.toXY(this.truePosition());
    let x = xy[0] + this.bias[0] + gauss(this.random) * 0.8, y = xy[1] + this.bias[1] + gauss(this.random) * 0.8;
    if (this.spike) { x += 28; y -= 20; this.spike = false; }
    const ll = this.frame.toLL([x, y]);
    return { seq: ++this.seq, lat: ll[0], lon: ll[1], accuracyM: Math.round(7 + this.random() * 6), timestamp: t, speed: null, heading: null, source: 'demo-simulated' };
  }
}
