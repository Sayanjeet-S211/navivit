// Demo provider: the ground-station core runs inside the page with simulated network latency.
// The aircraft and (by default) the visitor are simulated. Nothing here can reach real hardware.
import { GroundStation } from '../sim/groundstation.js';
import { SimulatedWalker } from '../sim/walker.js';
import { Emitter } from './emitter.js';

export class DemoProvider extends Emitter {
  constructor(campus, { speed = 1 } = {}) {
    super();
    this.kind = 'demo'; this.campus = campus; this.speed = speed;
    this.simT = Date.now();
    this.now = () => this.simT;
    this.gs = new GroundStation({ campus, now: this.now, autoApprove: true });
    this.walker = null; this.linkDown = false; this.session = null;
    this.gs.on((sid, ev) => { if (sid === this.session?.sessionId) this._deliver(ev); });
    this._timer = setInterval(() => this._tick(0.1), 100);
    this.info = { kind: 'demo', label: 'Demo', aircraftSource: 'simulated', connected: true };
  }
  destroy() { clearInterval(this._timer); this.walker = null; }
  setSpeed(x) { this.speed = x; }

  _latency() { return 60 + Math.random() * 120; }
  /** Deliver with simulated latency but in order, as a single WebSocket stream would. */
  _deliver(ev) {
    if (this.linkDown) return;
    const copy = JSON.parse(JSON.stringify(ev)), t = performance.now();
    this._lastAt = Math.max(t + this._latency(), (this._lastAt || 0) + 1);
    setTimeout(() => !this.linkDown && this.emit('event', copy), this._lastAt - t);
  }
  _call(fn) {
    return new Promise((resolve, reject) => {
      if (this.linkDown) { setTimeout(() => reject(new Error('network')), 4000); return; }
      setTimeout(() => {
        if (this.linkDown) return reject(new Error('network'));
        try { resolve(JSON.parse(JSON.stringify(fn()))); } catch (e) { reject(e); }
      }, this._latency());
    });
  }
  _s() { const s = this.gs.session(this.session?.sessionId); if (!s) throw new Error('no_session'); return s; }

  async connect() { return this._call(() => ({ service: 'navi-demo', aircraftSource: 'simulated', campusVersion: this.campus.version })); }
  async createSession() { this.session = await this._call(() => this.gs.createSession()); return this.session; }
  async pads() { return this._call(() => this.gs.pads()); }
  async previewRoute(body) { return this._call(() => this.gs.previewRoute(this._s(), body)); }
  async requestGuide(body) { return this._call(() => this.gs.requestGuide(this._s(), body)); }
  async cancel() { return this._call(() => this.gs.cancel(this._s())); }
  async action(type, commandId) { return this._call(() => this.gs.action(this._s(), { commandId, type })); }
  async closeSession() {
    if (!this.session) return { closed: true };
    const r = await this._call(() => this.gs.closeSession(this.session.sessionId)).catch(() => ({ closed: false }));
    this.session = null; this.stopSimulatedVisitor();
    return r;
  }
  sendSample(sample) {
    if (this.linkDown || !this.session) return false;
    const copy = { ...sample };
    setTimeout(() => {
      if (this.linkDown) return;
      const s = this.gs.session(this.session?.sessionId);
      if (s) this._deliver(this.gs.ingestSample(s, copy));
    }, this._latency());
    return true;
  }

  /* ---------- simulated visitor (demo only) ---------- */
  startSimulatedVisitor(plan) {
    this.walker = new SimulatedWalker({ frame: this.campus.frame, now: this.now });
    const t = plan.transfer?.coords?.length > 1 ? plan.transfer.coords : [plan.pad.ll];
    this.walker.setPath([...t, ...plan.guided.coords.slice(1)]);
    this.walker.transferM = plan.transfer?.needed ? plan.transfer.lengthM - (plan.origin.offGraphM || 0) : 0;
  }
  stopSimulatedVisitor() { this.walker = null; }
  visitor(patch) { if (this.walker) Object.assign(this.walker, patch); }

  /* ---------- demo operator controls ---------- */
  setAutoApprove(on) { this.gs.autoApprove = on; }
  pending() { const s = this.gs.session(this.session?.sessionId); return s?.request?.state === 'AWAITING_OPERATOR' ? s.request.id : null; }
  decide(approve) { const id = this.pending(); return id ? this.gs.decide(id, approve, approve ? null : 'Declined by the operator (demo).') : null; }
  setPad(id, status) { return this.gs.setPad(id, status); }
  padStatus() { return { ...this.gs.padStatus }; }
  fault(name, on) { const s = this.gs.session(this.session?.sessionId); return s ? this.gs.fault(s, name, on) : null; }
  faults() { return [...(this.gs.session(this.session?.sessionId)?.faults || [])]; }
  rcTakeover(on) { const s = this.gs.session(this.session?.sessionId); return s ? this.gs.rcTakeover(s, on) : null; }
  handover(source) { const s = this.gs.session(this.session?.sessionId); return s ? this.gs.handover(s, source) : null; }
  setLinkDown(on) { this.linkDown = on; this.emit('link', { state: on ? 'down' : 'up' }); }

  _tick(realDt) {
    const dt = realDt * this.speed;
    // Sub-step so high demo speeds keep the controller stable.
    const steps = Math.max(1, Math.ceil(dt / 0.1));
    for (let i = 0; i < steps; i++) {
      this.simT += dt / steps * 1000;
      this.gs.tick(dt / steps);
      this._walk(dt / steps);
    }
  }
  _walk(dt) {
    const w = this.walker; if (!w) return;
    const s = this.gs.session(this.session?.sessionId), m = s?.mission;
    const ph = m?.phase;
    const atPad = !m || ['MEET', 'PREFLIGHT', 'TAKEOFF'].includes(ph);
    w.setLimit(atPad ? w.transferM : ['RETURNING', 'EMERGENCY_LAND', 'LANDED'].includes(ph) && !m.arrivedEmitted ? w.s : w.transferM + Math.max(0, m.sa - 3));
    if (s?.request && ['MEET_AT_PAD', 'READY'].includes(s.request.state) || m) w.step(dt);
    const smp = w.sample();
    if (!smp) return;
    if (s?.source === 'operator-device') {
      // The accompanying operator's device reports instead; the visitor phone keeps producing fixes
      // that the ground station now rejects.
      this.gs.ingestSample(s, { ...smp, seq: smp.seq + 1e6, source: 'operator-device' }, { asOperator: true });
    }
    this.emit('simSample', smp);
  }
}
