// Ground-station core: session, dispatch, pacing and recovery logic. It is the authority for mission
// state. The aircraft here is SIMULATED: in the browser demo and in the mock server alike, nothing
// talks to real hardware. A MAVLink adapter would replace SimAircraft for live operation.
import { pointAlong, polylineLengthM } from '../campus.js';
import { SampleFilter, regressionSpeed } from '../filter.js';
import { CONFIG, walkingEtaS } from '../config.js';
import { haversine, bearing } from '../geo.js';

export const DISPATCH_STATES = ['QUEUED', 'AWAITING_OPERATOR', 'APPROVED', 'MEET_AT_PAD', 'READY', 'DECLINED', 'UNAVAILABLE', 'CANCELLED'];
const TERMINAL = new Set(['DECLINED', 'UNAVAILABLE', 'CANCELLED']);
const FLYING = new Set(['TAKEOFF', 'LEADING', 'WAITING', 'PAUSED', 'DEST_HOLD', 'OPERATOR_ASSISTING', 'RETURNING', 'EMERGENCY_LAND', 'LANDING', 'LEG_LANDING']);
const OCV = [[0, 3.3], [0.05, 3.5], [0.1, 3.62], [0.2, 3.7], [0.5, 3.82], [0.8, 3.98], [1, 4.2]];
const ocv = soc => { for (let i = 1; i < OCV.length; i++) if (soc <= OCV[i][0]) { const [a, va] = OCV[i - 1], [b, vb] = OCV[i]; return va + (vb - va) * (soc - a) / (b - a); } return 4.2; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Hex id. Uses the platform CSPRNG when there is one (session tokens are bearer credentials). */
const randomId = (rand, n = 16) => {
  const c = globalThis.crypto;
  if (c?.getRandomValues) { const b = new Uint8Array(Math.ceil(n / 2)); c.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, n); }
  return Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
};
const sameToken = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class GroundStation {
  constructor({ campus, config = CONFIG, now = () => Date.now(), random = Math.random, autoApprove = true, aircraftSource = 'simulated' }) {
    this.campus = campus; this.c = config; this.now = now; this.random = random;
    this.autoApprove = autoApprove; this.aircraftSource = aircraftSource;
    this.sessions = new Map();
    // Simulated resource state: every proposed pad starts ready (demo / mock only), handoff support
    // as recorded in the pad configuration, and one aircraft.
    this.padStatus = Object.fromEntries(campus.pads.map(p => [p.id, 'ready']));
    this.padHandoff = Object.fromEntries(campus.pads.map(p => [p.id, !!p.support?.handoff]));
    this.aircraftAvailable = 1;
    this.listeners = new Set();
  }

  /* ---------- events ---------- */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(s, ev) { ev = { ...ev, sessionId: s.id, serverTime: this.now() }; s.lastEvent = ev.serverTime; for (const fn of this.listeners) fn(s.id, ev); }

  /* ---------- sessions ---------- */
  createSession() {
    const s = { id: 'v' + randomId(this.random, 12), token: randomId(this.random, 40), created: this.now(), lastSeen: this.now(), plans: new Map(), request: null, mission: null, commands: new Map(), faults: new Set(), source: 'visitor' };
    this.sessions.set(s.id, s);
    return { sessionId: s.id, token: s.token, expiresInS: 7200 };
  }
  session(id, token) {
    const s = this.sessions.get(id);
    if (!s || (token !== undefined && !sameToken(token, s.token))) return null;
    s.lastSeen = this.now();
    return s;
  }
  closeSession(id) {
    const s = this.sessions.get(id); if (!s) return { closed: false };
    // Sharing stops; an airborne aircraft must still recover safely, so a flight is ended rather than dropped.
    if (s.mission && FLYING.has(s.mission.phase)) s.mission._startReturn_('Visitor closed the session');
    else if (s.mission?.phase === 'HANDOFF') s.mission.endOnGround('Visitor closed the session');
    s.closed = true; s.source = 'none';
    if (!s.mission || !FLYING.has(s.mission.phase)) this.sessions.delete(id);
    return { closed: true, recovering: !!s.mission && FLYING.has(s.mission.phase) };
  }

  /* ---------- planning & dispatch ---------- */
  pads() { return this.campus.pads.map(p => ({ id: p.id, name: p.name, kind: p.kind, node: p.node, ll: p.ll, serves: p.serves || [], approval: p.approval, status: this.padStatus[p.id], handoff: this.padHandoff[p.id], meet: p.meet })); }
  resources() { return { aircraftAvailable: this.aircraftAvailable, padStatus: { ...this.padStatus }, padHandoff: { ...this.padHandoff } }; }

  previewRoute(s, { origin, destinationId }) {
    const plan = this.campus.plan({ origin, destinationId, padStatus: this.padStatus, padHandoff: this.padHandoff, aircraftAvailable: this.aircraftAvailable });
    s.plans.set(plan.routeId, plan);
    return { ...plan, approved: plan.availability === 'available' };
  }

  requestGuide(s, { routeId, idempotencyKey }) {
    if (!idempotencyKey) return { error: 'idempotency_key_required' };
    if (s.request && s.request.key === idempotencyKey) return this._requestView(s);
    if (s.request && !TERMINAL.has(s.request.state) && !(s.mission && s.mission.phase === 'ENDED')) return { error: 'request_active', request: this._requestView(s) };
    const plan = s.plans.get(routeId);
    s.request = { id: 'q' + randomId(this.random, 10), key: idempotencyKey, routeId, at: this.now(), state: 'QUEUED', reason: null, plan };
    s.mission = null;
    if (!plan) this._dispatch(s, 'UNAVAILABLE', 'This route was not previewed with the ground station.');
    else if (plan.availability !== 'available') this._dispatch(s, 'UNAVAILABLE', plan.availability === 'at_destination' ? 'You are already at the destination.' : [plan.unavailableText, plan.reasons[0]?.text].filter(Boolean).join(' '));
    else if (!this._resourcesStillOk(plan)) this._dispatch(s, 'UNAVAILABLE', 'Pads or aircraft changed since the preview. Preview the route again.');
    else this._dispatch(s, 'QUEUED');
    return this._requestView(s);
  }
  /** Re-check every pad and the aircraft at request time; a preview is not a reservation. */
  _resourcesStillOk(plan) {
    if (this.aircraftAvailable < 1) return false;
    if (plan.pads.some(p => this.padStatus[p.id] !== 'ready')) return false;
    return plan.handoffs.every(h => this.padHandoff[h.id]);
  }
  _requestView(s) { const r = s.request; return r ? { requestId: r.id, state: r.state, reason: r.reason, routeId: r.routeId, padId: r.plan?.pad?.id } : null; }
  _dispatch(s, state, reason = null) {
    s.request.state = state; s.request.reason = reason; s.request.stateAt = this.now();
    if (state === 'MEET_AT_PAD') { this.padStatus[s.request.plan.startPad.id] = 'busy'; this.aircraftAvailable--; s.holdsAircraft = true; }
    this.emit(s, { type: 'dispatch', ...this._requestView(s) });
  }
  cancel(s) {
    if (!s.request || TERMINAL.has(s.request.state)) return { error: 'nothing_to_cancel' };
    if (s.mission && FLYING.has(s.mission.phase)) return { error: 'in_flight_use_end' };
    if (s.request.plan?.startPad && this.padStatus[s.request.plan.startPad.id] === 'busy') this.padStatus[s.request.plan.startPad.id] = 'ready';
    this._releaseAircraft(s);
    s.mission = null;
    this._dispatch(s, 'CANCELLED', 'Cancelled by the visitor.');
    return this._requestView(s);
  }
  decide(requestId, approve, reason) {
    const s = [...this.sessions.values()].find(x => x.request?.id === requestId);
    if (!s || s.request.state !== 'AWAITING_OPERATOR') return { error: 'not_awaiting_operator' };
    if (approve) this._approve(s); else this._dispatch(s, 'DECLINED', reason || 'The operator declined this request.');
    return this._requestView(s);
  }
  _approve(s) {
    this._dispatch(s, 'APPROVED');
    this._dispatch(s, 'MEET_AT_PAD');
    const plan = s.request.plan;
    s.mission = new Mission(this, s, plan);
  }
  _releaseAircraft(s) { if (s.holdsAircraft) { s.holdsAircraft = false; this.aircraftAvailable++; } }
  setHandoff(padId, on) { if (!(padId in this.padHandoff)) return { error: 'invalid_pad' }; this.padHandoff[padId] = !!on; return { id: padId, handoff: !!on }; }
  setAircraft(n) { this.aircraftAvailable = Math.max(0, Math.min(4, Math.round(+n || 0))); return { aircraftAvailable: this.aircraftAvailable }; }
  setPad(padId, status) { if (!(padId in this.padStatus) || !['ready', 'unavailable', 'unknown'].includes(status)) return { error: 'invalid_pad' }; this.padStatus[padId] = status; return { id: padId, status }; }

  /* ---------- samples ---------- */
  ingestSample(s, sample, { asOperator = false } = {}) {
    const ack = (accepted, reason, extra = {}) => ({ type: 'sampleAck', seq: sample?.seq, accepted, reason, receivedAt: this.now(), ...extra });
    if (!sample || typeof sample !== 'object') return ack(false, 'invalid_sample');
    const src = asOperator ? 'operator-device' : 'visitor';
    if (s.source === 'none') return ack(false, 'sharing_stopped');
    if (s.source !== src) return ack(false, s.source === 'operator-device' ? 'source_handed_over' : 'not_active_source');
    if (!s.filter) s.filter = new SampleFilter(this.campus.frame, this.c);
    const m = s.mission;
    const route = m ? (m.stage === 'transfer' ? m.transferCoords : m.guidedCoords) : null;
    if (route !== s.filterRoute) { s.filter.setRoute(route); s.filterRoute = route; }
    const r = s.filter.process(sample);
    if (!r.accepted) return ack(false, r.reason);
    s.lastAccepted = this.now(); s.lastFix = { ll: r.raw, acc: sample.accuracyM, t: sample.timestamp };
    if (m) m.onSample(r);
    return ack(true, null, { matched: r.matched ? { progressM: r.matched.progressM, offRoute: r.matched.offRoute, ambiguous: r.matched.ambiguous } : null, quality: r.quality });
  }

  handover(s, source) {
    if (!['visitor', 'operator-device'].includes(source)) return { error: 'invalid_source' };
    s.source = source; s.filter = null; s.filterRoute = null; // reject samples from the old source from now on
    this.emit(s, { type: 'source', source });
    return { source };
  }
  rcTakeover(s, on) { if (!s.mission) return { error: 'no_mission' }; s.mission.rc = !!on; this.emit(s, { type: 'alert', code: on ? 'rc_takeover' : 'rc_released' }); return { rc: !!on }; }
  fault(s, name, on) {
    const ok = ['aircraft_link', 'gps_ekf', 'low_battery', 'geofence', 'rc_link'];
    if (!ok.includes(name)) return { error: 'unknown_fault' };
    on ? s.faults.add(name) : s.faults.delete(name);
    if (s.mission) s.mission.onFault(name, on);
    return { fault: name, on };
  }

  /* ---------- commands ---------- */
  action(s, { commandId, type }) {
    if (!commandId || !['pause', 'resume', 'end', 'abort'].includes(type)) return { commandId, state: 'rejected', reason: 'invalid_command' };
    const prev = s.commands.get(commandId);
    if (prev) return { commandId, type: prev.type, state: prev.state, reason: prev.reason };
    const cmd = { commandId, type, state: 'accepted', reason: null, at: this.now() };
    s.commands.set(commandId, cmd);
    const m = s.mission;
    const reject = reason => { cmd.state = 'rejected'; cmd.reason = reason; this._cmd(s, cmd); return { commandId, type, state: cmd.state, reason }; };
    if (type === 'end' && (!m || m.phase === 'MEET' || m.phase === 'PREFLIGHT')) { if (s.request && !TERMINAL.has(s.request.state)) this.cancel(s); cmd.state = 'confirmed'; this._cmd(s, cmd); return { commandId, type, state: 'confirmed' }; }
    if (m && m.phase === 'HANDOFF' && (type === 'end' || type === 'abort')) { m.endOnGround(type === 'abort' ? 'Emergency stop during handoff' : 'Guidance ended by the visitor'); cmd.state = 'confirmed'; this._cmd(s, cmd); return { commandId, type, state: 'confirmed' }; }
    if (m && m.phase === 'HANDOFF' && type === 'pause') return reject('handoff_in_progress');
    if (!m || !FLYING.has(m.phase)) return reject('no_active_guidance');
    if (m.aircraftLinkLost && type !== 'abort') return reject('aircraft_link_lost');
    this._cmd(s, cmd);
    m.command(cmd);
    return { commandId, type, state: cmd.state, reason: cmd.reason };
  }
  _cmd(s, cmd) { this.emit(s, { type: 'command', commandId: cmd.commandId, command: cmd.type, state: cmd.state, reason: cmd.reason }); }

  snapshot(s) {
    return { type: 'snapshot', request: this._requestView(s), mission: s.mission?.status(), aircraft: s.mission?.lastTelemetry || null, source: s.source, commands: [...s.commands.values()].slice(-10).map(c => ({ commandId: c.commandId, command: c.type, state: c.state, reason: c.reason })) };
  }

  /* ---------- operator ---------- */
  /** What the operator console shows: resources, requests, mission and telemetry diagnostics. */
  operatorView() {
    const now = this.now();
    return {
      autoApprove: this.autoApprove, aircraftAvailable: this.aircraftAvailable, pads: this.pads(),
      sessions: [...this.sessions.values()].map(s => {
        const m = s.mission, st = m?.status(), t = m?.lastTelemetry;
        return {
          sessionId: s.id, createdAt: s.created, lastSeenAgeS: (now - s.lastSeen) / 1000, closed: !!s.closed, source: s.source,
          request: s.request ? { requestId: s.request.id, state: s.request.state, reason: s.request.reason, destination: s.request.plan?.destination?.name, pad: s.request.plan?.startPad?.name, legs: s.request.plan?.legs?.length, plannedCoveragePct: s.request.plan?.coverage?.percent ?? null, guidedM: s.request.plan?.coverage?.guidedM } : null,
          mission: st ? { status: st.status, holdReason: st.holdReason, legIndex: st.legIndex, legCount: st.legCount, handoffPadId: st.handoffPadId, observed: st.observed, leadM: st.leadM, visitorProgressM: st.visitorProgressM, guidedLengthM: st.guidedLengthM, lastAcceptedAgeS: st.lastAcceptedAgeS, rc: !!m.rc } : null,
          aircraft: t ? { mode: t.mode, altM: t.altM, batteryV: t.batteryV, batteryPct: t.batteryPct, ekf: t.ekf, sats: t.sats, hdop: t.hdop, rssiDbm: t.rssiDbm, ageS: (now - t.measuredAt) / 1000 } : null,
          lastFix: s.lastFix ? { accuracyM: s.lastFix.acc, ageS: (now - s.lastFix.t) / 1000 } : null,
          faults: [...s.faults]
        };
      })
    };
  }
  /** Operator actions by path, mirroring the server's /api/operator routes (used by the demo). */
  operatorCall(path, body = {}) {
    let m;
    if (path === 'operator/sessions') return this.operatorView();
    if (path === 'operator/auto-approve') { this.autoApprove = !!body.on; return { autoApprove: this.autoApprove }; }
    if (path === 'operator/aircraft') return this.setAircraft(body.available);
    if ((m = path.match(/^operator\/pads\/([^/]+)$/))) { if (typeof body.handoff === 'boolean') return this.setHandoff(m[1], body.handoff); return this.setPad(m[1], body.status); }
    if ((m = path.match(/^operator\/requests\/([^/]+)\/decision$/))) return this.decide(m[1], !!body.approve, null);
    if ((m = path.match(/^operator\/sessions\/([^/]+)\/(rc|faults|handover)$/))) {
      const s = this.sessions.get(m[1]); if (!s) return { error: 'unknown_session' };
      if (m[2] === 'rc') return this.rcTakeover(s, !!body.on);
      if (m[2] === 'faults') return this.fault(s, body.name, !!body.on);
      return this.handover(s, body.source);
    }
    return { error: 'not_found' };
  }

  /* ---------- time ---------- */
  tick(dt) {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const r = s.request;
      if (r && r.state === 'QUEUED' && now - r.stateAt > 1200) this._dispatch(s, 'AWAITING_OPERATOR');
      else if (r && r.state === 'AWAITING_OPERATOR' && this.autoApprove && now - r.stateAt > 2500) this._approve(s);
      if (s.mission) s.mission.tick(dt);
      if (s.closed && (!s.mission || !FLYING.has(s.mission.phase))) this.sessions.delete(s.id);
      else if (now - s.lastSeen > 7200e3 && !(s.mission && FLYING.has(s.mission.phase))) this.sessions.delete(s.id);
    }
  }
}

/**
 * One guided journey (simulated aircraft): optional unguided walk to the first pad, then guided
 * legs. Between legs the aircraft lands at a handoff pad and the visitor waits during a staffed
 * battery swap; the next leg starts only once the pad confirms support and the visitor is there.
 * Observed guided/unguided distance is accumulated from accepted visitor movement.
 */
class Mission {
  constructor(gs, s, plan) {
    this.gs = gs; this.s = s; this.c = gs.c; this.plan = plan;
    this.frame = gs.campus.frame;
    this.legs = plan.legs;
    this.transferCoords = plan.transfer?.needed && plan.transfer.coords?.length > 1 ? plan.transfer.coords : null;
    this.approachCoords = plan.finalApproach?.coords?.length > 1 ? plan.finalApproach.coords : null;
    // Offsets of each part along the visitor's whole route (used by the simulated visitor).
    this.transferLen = this.transferCoords ? polylineLengthM(this.frame, this.transferCoords) : 0;
    this.legStart = []; let acc = this.transferLen;
    for (const l of this.legs) { this.legStart.push(acc); acc += polylineLengthM(this.frame, l.coords); }
    this.routeLen = acc + (this.approachCoords ? polylineLengthM(this.frame, this.approachCoords) : 0);
    this.legIdx = 0; this._setLeg(0);
    this.stage = this.transferCoords ? 'transfer' : 'leg';
    this.phase = 'MEET';
    this.alt = 0; this.va = 0; this.xt = 0; this.xtTarget = 0; this.breached = false;
    this.mAh = 0; this.I = 0.6; this.V = 12.6;
    this.hold = null; this.rc = false; this.aircraftLinkLost = false; this.linkLostAt = null; this.ekfAt = null;
    this.timers = {}; this.lastStatusEmit = 0; this.lastTelemetryEmit = 0; this.pending = [];
    this.lastTelemetry = null; this.arrivedEmitted = false;
    this.obs = { guidedM: 0, unguidedM: 0 }; this.obsLast = null;
  }
  _setLeg(i) {
    this.legIdx = i; this.leg = this.legs[i];
    this.guidedCoords = this.leg.coords; this.L = polylineLengthM(this.frame, this.guidedCoords);
    this.sa = 0; this.sv = null; this.pts = []; this.vEst = 0; this.still = 0; this.moving = 0; this.obsLast = null;
  }
  get now() { return this.gs.now(); }
  get routeCoords() { return this.stage === 'transfer' ? this.transferCoords : this.stage === 'approach' ? this.approachCoords : this.guidedCoords; }
  log(code, extra = {}) { this.gs.emit(this.s, { type: 'alert', code, ...extra }); }
  guidanceActive() { return ['LEADING', 'WAITING', 'PAUSED', 'DEST_HOLD', 'LEG_LANDING'].includes(this.phase) && !this.rc && !this.aircraftLinkLost && this.ekfAt == null; }

  onSample(r) {
    const m = r.matched;
    // Observed coverage: forward movement along the current part of the route, classified by
    // whether confirmed guidance was active at that moment. Off-route movement is unguided.
    if (m && !m.offRoute && m.progressM != null && !m.ambiguous) {
      if (this.obsLast != null) {
        const d = Math.max(0, m.progressM - this.obsLast);
        if (d > 0) { if (this.stage === 'leg' && this.guidanceActive()) this.obs.guidedM += d; else this.obs.unguidedM += d; }
      }
      this.obsLast = this.obsLast == null ? m.progressM : Math.max(this.obsLast, m.progressM);
    } else if (m?.offRoute && this.prevRaw) {
      this.obs.unguidedM += Math.max(0, haversine(this.prevRaw, r.raw) - 10);
    }
    this.prevRaw = r.raw;

    if (this.stage === 'transfer') {
      if (haversine(r.raw, this.leg.from.ll) <= this.c.padArrivalM && this.phase === 'MEET') this._switchStage('leg');
      return;
    }
    if (this.stage !== 'leg') return;
    if (m && !m.offRoute && m.progressM != null && !m.ambiguous) {
      this.sv = this.sv == null ? m.progressM : this.sv + 0.4 * (m.progressM - this.sv);
      this.pts.push({ t: this.now, s: m.progressM });
      if (this.pts.length > 20) this.pts.shift();
      const v = regressionSpeed(this.pts, 8, this.now);
      if (v != null) this.vEst = clamp(0.5 * this.vEst + 0.5 * v, 0, 2.5);
    }
    this.offRoute = !!m?.offRoute;
  }
  _switchStage(stage) {
    this.stage = stage; this.obsLast = null;
    const route = this.routeCoords;
    this.s.filter?.setRoute(route); this.s.filterRoute = route;
  }

  onFault(name, on) {
    if (name === 'aircraft_link') {
      this.aircraftLinkLost = on; this.linkLostAt = on ? this.now : null;
      if (!on && this.deferred) { const d = this.deferred; this.deferred = null; d.reason = null; if (this.ekfAt != null) this._emergency('Emergency stop with degraded GPS: landing in place'); else this._startReturn_('Emergency stop requested'); d.state = 'executing'; this.gs._cmd(this.s, d); }
    }
    if (name === 'gps_ekf') this.ekfAt = on ? this.now : null;
    if (name === 'geofence' && on) { this.xtTarget = 46; this.breached = false; }
    if (name === 'low_battery' && on) this.mAh = Math.max(this.mAh, 3300 * (1 - 0.23));
  }

  command(cmd) {
    const ph = this.phase, gs = this.gs, s = this.s;
    const fail = reason => { cmd.state = 'rejected'; cmd.reason = reason; gs._cmd(s, cmd); };
    const exec = () => { cmd.state = 'executing'; gs._cmd(s, cmd); this.pending.push(cmd); };
    if (cmd.type === 'pause') {
      if (!['LEADING', 'WAITING', 'TAKEOFF'].includes(ph)) return fail('not_leading');
      this.phase = 'PAUSED'; this.hold = 'Visitor asked NAVI to wait'; this.pausedAt = this.now; exec();
    } else if (cmd.type === 'resume') {
      const age = (this.now - (this.s.lastAccepted ?? -Infinity)) / 1000;
      if (!['PAUSED', 'WAITING'].includes(ph)) return fail('not_paused');
      if (!(age <= this.c.freshForResumeS)) return fail('position_not_fresh');
      if (this.offRoute) return fail('visitor_off_route');
      this.phase = 'LEADING'; this.hold = null; this.still = 0; exec();
    } else if (cmd.type === 'end') {
      this._startReturn_('Guidance ended by the visitor'); exec();
    } else if (cmd.type === 'abort') {
      if (this.aircraftLinkLost) { cmd.reason = 'awaiting_aircraft_link'; gs._cmd(s, cmd); this.deferred = cmd; this.pending.push(cmd); return; }
      if (this.ekfAt != null) this._emergency('Emergency stop with degraded GPS: landing in place');
      else this._startReturn_('Emergency stop requested');
      exec();
    }
  }
  _startReturn_(why) {
    if (this.phase === 'LEG_LANDING') { this.hold = why; this.endAfterLanding = why; return; } // already landing at a pad
    if (!['RETURNING', 'LANDING', 'EMERGENCY_LAND', 'LANDED', 'ENDED', 'HANDOFF'].includes(this.phase)) { this.phase = 'RETURNING'; this.hold = why; this.log('returning', { reason: why }); }
  }
  _emergency(why) { if (!['EMERGENCY_LAND', 'LANDED', 'ENDED', 'HANDOFF'].includes(this.phase)) { this.phase = 'EMERGENCY_LAND'; this.hold = why; this.log('emergency_land', { reason: why }); } }
  /** End while the aircraft is already on a pad (during a handoff). */
  endOnGround(why) {
    this.hold = why; this.outcome = 'ended_at_handoff';
    const pad = this.leg.to;
    this.phase = 'LANDED'; this._release(pad.id);
    this.log('landed', { where: 'pad', padId: pad.id, confirmed: true, legIndex: this.legIdx });
    this.gs.emit(this.s, this.status());
  }

  remainingTotalM() {
    const leg = Math.max(0, this.L - (this.sv ?? 0));
    const later = this.legs.slice(this.legIdx + 1).reduce((a, l) => a + l.lengthM, 0);
    const before = this.stage === 'transfer' ? this.legs[0].lengthM - leg : 0; void before;
    const tail = this.plan.finalApproach?.lengthM || 0;
    if (['HANDOFF', 'LEG_LANDING'].includes(this.phase) || (this.phase === 'LANDED' && this.leg.to)) return later + tail;
    return (this.stage === 'transfer' ? (this.plan.transfer?.lengthM || 0) + this.L : leg) + later + tail;
  }
  status() {
    const now = this.now, age = this.s.lastAccepted ? (now - this.s.lastAccepted) / 1000 : null;
    const lead = this.sv == null ? null : this.sa - this.sv;
    const air = this.aircraftLL(), vis = this.s.lastFix?.ll;
    const sep = air && vis ? Math.hypot(haversine(air, vis), this.alt) : null;
    const crewMissing = this.phase === 'HANDOFF' && this.handoffBlocked;
    const map = { MEET: 'meet', PREFLIGHT: 'preflight', TAKEOFF: 'takeoff', LEADING: 'leading', WAITING: 'waiting', PAUSED: 'paused', DEST_HOLD: 'leading', OPERATOR_ASSISTING: 'operator', RETURNING: 'returning', EMERGENCY_LAND: 'operator', LANDING: 'landing', LEG_LANDING: this.legIdx === this.legs.length - 1 ? 'landing' : 'handoff', HANDOFF: crewMissing ? 'interrupted' : 'handoff', LANDED: 'landed', ENDED: 'ended' };
    const remaining = this.remainingTotalM();
    return {
      type: 'mission', phase: this.phase, status: this.rc ? 'operator' : map[this.phase], holdReason: this.hold,
      stage: this.stage, legIndex: this.legIdx, legCount: this.legs.length,
      handoffPadId: ['LEG_LANDING', 'HANDOFF'].includes(this.phase) ? this.leg.to?.id : null,
      handoffRemainingS: this.phase === 'HANDOFF' && this.timers.handoff ? Math.max(0, this.c.handoffSwapS - (now - this.timers.handoff) / 1000) : null,
      leadM: lead, separationM: sep, visitorProgressM: this.sv, aircraftProgressM: this.sa, guidedLengthM: this.L,
      remainingM: remaining, legRemainingM: this.sv == null ? this.L : Math.max(0, this.L - this.sv), etaS: walkingEtaS(remaining, this.c),
      visitorSpeedMps: this.vEst, lastAcceptedAgeS: age, destinationReached: this.arrivedEmitted,
      landingPad: this.landingPadId || this.leg.landPadId, outcome: this.outcome || null,
      observed: { guidedM: this.obs.guidedM, unguidedM: this.obs.unguidedM }, guidanceActive: this.guidanceActive()
    };
  }
  aircraftLL() {
    if (['MEET', 'PREFLIGHT'].includes(this.phase)) return this.leg.from.ll;
    if (['HANDOFF'].includes(this.phase) || (this.phase === 'LANDED' && this.landedAt)) return this.landedAt || this.leg.to?.ll;
    const p = pointAlong(this.frame, this.guidedCoords, this.sa);
    const n = [-p.dir[1], p.dir[0]];
    return this.frame.toLL([p.xy[0] + n[0] * this.xt, p.xy[1] + n[1] * this.xt]);
  }
  /** Simulation helper: how far along the whole visitor route a cooperative visitor would walk now. */
  simVisitorLimitM() {
    const i = this.legIdx, start = this.legStart[i];
    switch (this.phase) {
      case 'MEET': return this.transferLen;
      case 'PREFLIGHT': case 'TAKEOFF': return start;
      case 'LEADING': case 'WAITING': case 'PAUSED': case 'OPERATOR_ASSISTING': return start + Math.max(0, this.sa - 3);
      case 'DEST_HOLD': case 'LEG_LANDING': case 'HANDOFF': return start + this.L;
      default: return this.arrivedEmitted || this.outcome === 'arrived' ? this.routeLen : null; // null: stay where you are
    }
  }

  tick(dt) {
    const c = this.c, now = this.now, f = this.s.faults;
    const age = this.s.lastAccepted ? (now - this.s.lastAccepted) / 1000 : Infinity;
    const lead = this.sv == null ? 0 : this.sa - this.sv;
    if (this.vEst < c.stillSpeedMps) { this.still += dt; this.moving = 0; } else { this.moving += dt; this.still = 0; }
    if (age > 3 && this.pts.length && now - this.pts.at(-1).t > 3000) this.vEst = Math.max(0, this.vEst - 0.3 * dt);

    switch (this.phase) {
      case 'MEET':
        if (this.stage === 'leg' && age <= c.freshForResumeS) {
          this.phase = 'PREFLIGHT'; this.timers.pre = now;
          this.gs._dispatch(this.s, 'READY');
          this.log('preflight', { legIndex: 0 });
        }
        break;
      case 'PREFLIGHT':
        if (now - this.timers.pre > 3000) { this.phase = 'TAKEOFF'; this.log('takeoff', { legIndex: this.legIdx }); }
        break;
      case 'TAKEOFF':
        this.alt = Math.min(c.planningAltitudeM, this.alt + 1.5 * dt);
        if (this.alt >= c.planningAltitudeM) { this.phase = 'LEADING'; this.log('leading', { legIndex: this.legIdx }); }
        break;
      case 'HANDOFF': {
        // The next leg starts only when the swap is done, the pad crew confirms support and the
        // visitor is at the pad with a fresh position. Otherwise the visitor keeps waiting.
        const pad = this.leg.to;
        const crewOk = this.gs.padHandoff[pad.id] && this.gs.padStatus[pad.id] !== 'unavailable';
        const atPad = this.s.lastFix && haversine(this.s.lastFix.ll, pad.ll) <= c.padArrivalM * 1.5 && age <= c.freshForResumeS;
        this.handoffBlocked = !crewOk;
        if (!crewOk && this.hold !== `No handoff crew at ${pad.name}`) { this.hold = `No handoff crew at ${pad.name}`; this.log('handoff_blocked', { padId: pad.id, reason: this.hold }); }
        if (crewOk && now - this.timers.handoff >= c.handoffSwapS * 1000 && atPad) {
          this.mAh = 0; this.hold = null;
          this._setLeg(this.legIdx + 1); this._switchStage('leg');
          this.phase = 'PREFLIGHT'; this.timers.pre = now;
          this.log('leg_started', { legIndex: this.legIdx, fromPadId: this.leg.from.id });
          this.log('preflight', { legIndex: this.legIdx });
        }
        break;
      }
    }

    // Recovery precedence: failsafe > geofence > stale data > pacing.
    if (FLYING.has(this.phase) && !['RETURNING', 'EMERGENCY_LAND', 'LANDING', 'TAKEOFF', 'LEG_LANDING'].includes(this.phase)) {
      const soc = 1 - this.mAh / 3300;
      if (f.has('rc_link')) this._startReturn_('RC link lost');
      else if (soc < 0.25) this._startReturn_('Battery below reserve');
      else if (this.ekfAt != null && now - this.ekfAt > 6000) this._emergency('GPS/EKF unusable: landing in place');
      else if (this.aircraftLinkLost && now - this.linkLostAt > c.telemetryLossRtlS * 1000) this._startReturn_('Aircraft telemetry lost');
      else if (age > c.staleRtlS && this.phase !== 'PAUSED') this._startReturn_(`No visitor position for over ${c.staleRtlS} s`);
      else if (this.phase === 'PAUSED' && now - this.pausedAt > 300e3) this._startReturn_('Paused for over 5 minutes');
    }

    if (['LEADING', 'WAITING', 'DEST_HOLD'].includes(this.phase) || this.phase === 'OPERATOR_ASSISTING') {
      let reason = null;
      if (this.rc) reason = 'Operator has manual control';
      else if (this.ekfAt != null) reason = 'GPS degraded: holding position';
      else if (this.aircraftLinkLost) reason = 'Aircraft telemetry lost: holding';
      else if (this.xt > c.fenceBufferM) { reason = 'Geofence: halting and holding'; this.breached = true; this.xtTarget = 0; }
      else if (this.breached) reason = 'Returning inside the campus corridor';
      else if (age > c.staleWarnS) reason = `No visitor position for over ${c.staleWarnS} s`;
      if (this.rc) this.phase = 'OPERATOR_ASSISTING';
      else if (this.phase === 'OPERATOR_ASSISTING') { this.phase = 'WAITING'; this.hold = 'Operator handed back'; }
      let kind = reason ? 'safety' : null;
      if (!reason && this.phase === 'LEADING') {
        if (lead > c.holdGapM) reason = `Visitor ${Math.round(lead)} m behind`;
        else if (this.still > c.holdDwellS && this.sv != null && this.sv > 2) reason = 'Visitor stopped';
        if (reason) kind = 'pacing';
      }
      if (!reason && this.phase === 'WAITING') {
        const caughtUp = lead < c.resumeGapM && (this.moving >= c.resumeDwellS || lead < 8);
        if (this.holdKind === 'pacing' && !caughtUp) { reason = this.hold; kind = 'pacing'; }
        else if (this.holdKind === 'safety' && lead > c.holdGapM) { reason = `Visitor ${Math.round(lead)} m behind`; kind = 'pacing'; }
      }
      if (reason && this.phase !== 'OPERATOR_ASSISTING' && this.phase !== 'DEST_HOLD') {
        if (this.phase !== 'WAITING' || this.hold !== reason) { this.phase = 'WAITING'; this.hold = reason; this.holdKind = kind; this.log('hold', { reason }); }
      } else if (reason && this.phase === 'DEST_HOLD' && kind === 'safety' && this.hold !== reason) { this.hold = reason; this.log('hold', { reason }); }
      else if (!reason && this.phase === 'WAITING') { this.phase = 'LEADING'; this.hold = null; this.holdKind = null; this.log('resume'); }
      if (this.breached && this.xt < 3) { this.breached = false; this.s.faults.delete('geofence'); }
    }

    // Aircraft motion.
    let vCmd = 0;
    if (this.phase === 'LEADING') vCmd = clamp(this.vEst + 0.25 * (c.leadTargetM - lead), 0, 3);
    if (this.phase === 'LEADING' && this.sa >= this.L - 0.3) { this.phase = 'DEST_HOLD'; this.log('dest_hold', { legIndex: this.legIdx }); }
    if (this.phase === 'DEST_HOLD' && this.sv != null && this.L - this.sv < c.arrivalM) this._legEnd();
    if (this.phase === 'RETURNING' || this.phase === 'LANDING') {
      this.xtTarget = 0;
      if (this.sa > 0.3) { this.alt = Math.min(c.planningAltitudeM, this.alt + 1.5 * dt); this.va = Math.min(3, this.va + 1 * dt); this.sa = Math.max(0, this.sa - this.va * dt); }
      else { this.va = 0; this.alt = Math.max(0, this.alt - 1.0 * dt); if (this.alt <= 0.05) this._landed('pad', this.leg.from); }
    } else if (this.phase === 'LEG_LANDING') {
      this.xtTarget = 0; this.va = 0; this.alt = Math.max(0, this.alt - 1.0 * dt);
      if (this.alt <= 0.05) this._legLanded();
    } else if (this.phase === 'EMERGENCY_LAND') {
      this.va = Math.max(0, this.va - 1.5 * dt); this.sa += this.va * dt;
      this.alt = Math.max(0, this.alt - 0.8 * dt); if (this.alt <= 0.05) this._landed('in_place');
    } else if (FLYING.has(this.phase)) {
      this.va += clamp(vCmd - this.va, -1.2 * dt, 1 * dt);
      this.sa = clamp(this.sa + this.va * dt, 0, this.L);
    }
    this.xt += clamp(this.xtTarget - this.xt, -6 * dt, 12 * dt);

    const airborne = this.alt > 0.2 || this.phase === 'TAKEOFF';
    this.I = airborne ? 13.6 + 1.2 * Math.abs(this.va) : this.phase === 'PREFLIGHT' ? 2 : 0.4;
    this.mAh += this.I * dt / 3.6;
    this.V = 3 * ocv(clamp(1 - this.mAh / 3300, 0, 1)) - this.I * 0.025;

    for (const cmd of [...this.pending]) {
      const done = cmd.type === 'pause' ? this.phase === 'PAUSED' && this.va < 0.1
        : cmd.type === 'resume' ? this.phase === 'LEADING'
          : ['LANDED', 'ENDED'].includes(this.phase);
      const fail = cmd.type === 'pause' && !['PAUSED'].includes(this.phase) && ['RETURNING', 'EMERGENCY_LAND'].includes(this.phase);
      if (done || fail) { cmd.state = done ? 'confirmed' : 'failed'; cmd.reason = fail ? 'superseded_by_recovery' : null; this.gs._cmd(this.s, cmd); this.pending.splice(this.pending.indexOf(cmd), 1); }
    }

    if (now - this.lastStatusEmit > 1000 || this._lastPhase !== this.phase) { this.lastStatusEmit = now; this._lastPhase = this.phase; this.gs.emit(this.s, this.status()); }
    if (now - this.lastTelemetryEmit > 500) {
      this.lastTelemetryEmit = now;
      const ll = this.aircraftLL(), next = pointAlong(this.frame, this.guidedCoords, Math.min(this.L, this.sa + 5)).ll;
      this.lastTelemetry = {
        type: 'aircraft', source: this.gs.aircraftSource, ll, altM: this.alt, altRef: 'relative to launch pad (simulated)',
        groundSpeedMps: Math.abs(this.va), headingDeg: bearing(ll, next), mode: this._mode(),
        batteryV: this.V, batteryPct: Math.round(clamp(1 - this.mAh / 3300, 0, 1) * 100),
        ekf: this.ekfAt != null ? 'DEGRADED' : 'OK', sats: this.ekfAt != null ? 4 : 13, hdop: this.ekfAt != null ? 9.9 : 0.8,
        rssiDbm: -62 - Math.round(this.random() * 6), measuredAt: now, legIndex: this.legIdx
      };
      if (!this.aircraftLinkLost) this.gs.emit(this.s, this.lastTelemetry);
    }
  }
  /** The visitor reached the end of the current leg. */
  _legEnd() {
    const last = this.legIdx === this.legs.length - 1;
    if (this.leg.final) {
      // Final leg ends at the destination entrance: arrival, then the aircraft flies back to land.
      this.arrivedEmitted = true; this.outcome = 'arrived';
      this.log('destination_reached', { legIndex: this.legIdx });
      this.phase = 'LANDING'; this.hold = null;
      return;
    }
    // The leg ends at a pad: land there (handoff, or end of guidance before an unguided approach).
    this.phase = 'LEG_LANDING'; this.hold = null;
    this.log(last ? 'last_leg_landing' : 'handoff_landing', { legIndex: this.legIdx, padId: this.leg.to.id });
  }
  _legLanded() {
    const last = this.legIdx === this.legs.length - 1, pad = this.leg.to;
    this.alt = 0; this.va = 0; this.landedAt = pad.ll;
    if (last || this.endAfterLanding) {
      if (last && !this.endAfterLanding) {
        this.outcome = 'arrived';
        if (!this.plan.finalApproach) { this.arrivedEmitted = true; this.log('destination_reached', { legIndex: this.legIdx }); }
        else this.log('guided_section_complete', { padId: pad.id, approachM: this.plan.finalApproach.lengthM });
      }
      return this._landed('pad', pad);
    }
    this.phase = 'HANDOFF'; this.timers.handoff = this.now; this.hold = null;
    this.log('handoff', { legIndex: this.legIdx, padId: pad.id, waitS: this.c.handoffSwapS });
  }
  _release(landPadId) {
    this.landingPadId = landPadId;
    const sp = this.plan.startPad.id;
    if (this.gs.padStatus[sp] === 'busy') this.gs.padStatus[sp] = 'ready';
    this.gs._releaseAircraft(this.s);
  }
  random() { return this.gs.random(); }
  _mode() {
    if (this.rc) return 'MANUAL';
    return { MEET: 'GUIDED', PREFLIGHT: 'GUIDED', TAKEOFF: 'AUTO', LEADING: 'GUIDED', DEST_HOLD: 'GUIDED', WAITING: 'LOITER', PAUSED: 'LOITER', OPERATOR_ASSISTING: 'MANUAL', RETURNING: 'RTL', LANDING: 'RTL', LEG_LANDING: 'LAND', HANDOFF: 'DISARMED', EMERGENCY_LAND: 'LAND', LANDED: 'LAND', ENDED: 'LAND' }[this.phase] || 'GUIDED';
  }
  _landed(where = 'pad', pad = null) {
    this.phase = 'LANDED'; this.alt = 0; this.va = 0;
    if (pad) this.landedAt = pad.ll;
    if (this.outcome !== 'arrived') this.outcome = where === 'in_place' ? 'landed_in_place' : 'returned';
    this._release(pad?.id || null);
    this.log('landed', { where, padId: where === 'pad' ? pad?.id : null, confirmed: true, legIndex: this.legIdx });
    this.gs.emit(this.s, this.status());
  }
}
