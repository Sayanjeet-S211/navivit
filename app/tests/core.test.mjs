// Core behaviour tests: dataset, planning, filtering, ground-station state and safety rules.
// Run: cd app && node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Campus, CampusError, validateCampus } from '../js/campus.js';
import { CONFIG, walkingEtaS, fmtDuration } from '../js/config.js';
import { SampleFilter, Freshness } from '../js/filter.js';
import { GroundStation } from '../js/sim/groundstation.js';
import { SimulatedWalker } from '../js/sim/walker.js';
import { haversine } from '../js/geo.js';
import { pointAlong } from '../js/campus.js';

const RAW = JSON.parse(fs.readFileSync(new URL('../data/campus.v1.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(RAW));
const campus = new Campus(RAW, CONFIG);
const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/* ---------------------------------------------------------------- 1. dataset */
test('imports all 36 destinations, 6 pads and the 260-node graph', () => {
  const v = validateCampus(RAW);
  assert.deepEqual(v.errors, []);
  assert.equal(v.stats.nodes, 260);
  assert.equal(v.stats.destinations, 36);
  assert.equal(v.stats.pads, 6);
  assert.equal(v.stats.components, 1);
  assert.ok(Math.abs(v.stats.networkKm - 6.98) < 0.05, `network ${v.stats.networkKm}`);
  for (const d of campus.destinations) for (const e of d.entrances) assert.ok(campus.nodes.has(e), `${d.name} entrance ${e}`);
});

test('pads keep their source nodes and coordinates', () => {
  const expected = { gate: [111, 12.840649, 80.153159], central: [50, 12.843086, 80.154410], east: [40, 12.841788, 80.155996], 'north-west': [7, 12.843654, 80.152814], south: [27, 12.840475, 80.154658], 'e-block': [68, 12.844735, 80.160818] };
  for (const [id, [node, lat, lon]] of Object.entries(expected)) {
    const p = campus.pad(id);
    assert.equal(p.node, node, id);
    assert.ok(haversine(p.ll, [lat, lon]) < 1, `${id} within 1 m of the source table`);
  }
});

test('invalid graph data is a recoverable, reported error', () => {
  const missing = clone(); missing.nodes[0].adj.push(99999);
  assert.throws(() => new Campus(missing), CampusError);
  const swapped = clone(); swapped.nodes = swapped.nodes.map(n => ({ ...n, lat: n.lon, lon: n.lat }));
  assert.throws(() => new Campus(swapped), e => e instanceof CampusError && e.errors.some(x => /swapped|invalid coordinates/.test(x)));
  const badEntrance = clone(); badEntrance.destinations[0].entrances = [123456];
  assert.ok(validateCampus(badEntrance).errors.some(x => /entrance/.test(x)));
  assert.throws(() => campus.plan({ origin: { ll: campus.pad('gate').ll }, destinationId: 'no-such-place' }), /Unknown destination/);
});

/* ---------------------------------------------------------------- 5. ETA, fence, routing */
test('walking ETA is distance / 0.8 × 1.15 (350 m ≈ 8 min 23 s)', () => {
  assert.ok(Math.abs(walkingEtaS(350) - 503.125) < 1e-9);
  assert.equal(fmtDuration(walkingEtaS(350)), '8 min 23 s');
});

test('fence distances are in metres, not degrees', () => {
  const inside = campus.pad('central').ll;
  assert.equal(campus.outsideM(inside), 0);
  // ~100 m north of the northernmost boundary vertex
  const north = campus.boundary.reduce((a, b) => (b[0] > a[0] ? b : a));
  const out = [north[0] + 100 / 111320, north[1]];
  const d = campus.outsideM(out);
  assert.ok(d > 90 && d <= 101, `outside by ${d}`);
  assert.ok(campus.breach(out), 'beyond the 40 m buffer is a breach');
  const edge = [north[0] + 20 / 111320, north[1]];
  assert.ok(!campus.breach(edge), 'within the 40 m buffer is not a breach');
});

test('route checks cover the whole route, not just the end points', () => {
  const a = campus.pad('gate').ll, b = campus.pad('central').ll;
  const north = campus.boundary.reduce((x, y) => (y[0] > x[0] ? y : x));
  const detour = [north[0] + 200 / 111320, north[1]];
  const r = campus.routeFenceCheck([a, detour, b]);
  assert.ok(r.breach && r.maxOutsideM > 150);
});

test('plans Gate → Gazebo via the South Pad within the provisional 350 m leg', () => {
  const g = campus.pad('gate');
  const p = campus.plan({ origin: { kind: 'pad', ll: g.ll, nodeId: g.node }, destinationId: 'gazebo', padStatus: { south: 'ready', gate: 'ready', central: 'ready', east: 'ready', 'north-west': 'ready', 'e-block': 'ready' } });
  assert.equal(p.pad.id, 'south');
  assert.ok(p.guided.lengthM <= 350 && p.guided.withinLimit);
  assert.equal(p.availability, 'available');
  assert.ok(p.transfer.needed, 'the visitor walks to the meeting pad first');
  assert.equal(p.inspection, 'pending', 'no footpath classification in the data');
});

test('pad readiness: unknown stays unknown, unavailable pads are skipped', () => {
  const g = campus.pad('gate'), origin = { kind: 'pad', ll: g.ll, nodeId: g.node };
  assert.equal(campus.plan({ origin, destinationId: 'gazebo', padStatus: {} }).availability, 'unknown');
  const p = campus.plan({ origin, destinationId: 'gazebo', padStatus: { south: 'unavailable', east: 'ready', central: 'ready' } });
  assert.notEqual(p.pad.id, 'south');
  assert.ok(p.notes.some(n => /South Pad is unavailable/.test(n)));
});

test('a destination at the pad needs no guided leg', () => {
  const g = campus.pad('gate');
  const p = campus.plan({ origin: { kind: 'pad', ll: g.ll, nodeId: g.node }, destinationId: 'main-gate', padStatus: { gate: 'ready' } });
  assert.equal(p.availability, 'not_needed');
  assert.equal(p.guideNeeded, false);
});

test('over-limit legs never become a feasible mission', () => {
  const tight = new Campus(RAW, { ...CONFIG, legLimitM: 60 });
  const g = tight.pad('gate');
  const p = tight.plan({ origin: { kind: 'pad', ll: g.ll, nodeId: g.node }, destinationId: 'vit-sedaxis', padStatus: Object.fromEntries(tight.pads.map(x => [x.id, 'ready'])) });
  assert.equal(p.availability, 'unavailable');
  assert.equal(p.reasons[0].code, 'leg_over_limit');
});

test('forbidden edges are excluded; penalties only change preference', () => {
  const g = campus.pad('gate'), dst = campus.destination('gazebo');
  const base = campus.path(g.node, dst.entrances[0]);
  const k = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const firstEdge = k(base.nodes[0], base.nodes[1]);
  const fRaw = clone(); fRaw.edgeMeta = { forbidden: [firstEdge], penalty: {}, classified: false };
  const f = new Campus(fRaw).path(g.node, dst.entrances[0]);
  assert.ok(!f || !f.nodes.some((n, i) => i && k(f.nodes[i - 1], n) === firstEdge), 'forbidden edge never used');
  const pRaw = clone(); pRaw.edgeMeta = { forbidden: [], penalty: { [firstEdge]: 1.01 }, classified: false };
  const pp = new Campus(pRaw).path(g.node, dst.entrances[0]);
  assert.ok(Math.abs(pp.lengthM - base.lengthM) < 1e-6, 'a small penalty keeps the route and its true length');
});

/* ---------------------------------------------------------------- 3/4. filtering and freshness */
const frame = campus.frame;
const at = (ll, dx, dy) => { const p = frame.toXY(ll); return frame.toLL([p[0] + dx, p[1] + dy]); };
const smp = (seq, ll, t, acc = 8) => ({ seq, lat: ll[0], lon: ll[1], accuracyM: acc, timestamp: t });

test('sample filter rejects invalid, duplicate, out-of-order and inaccurate fixes', () => {
  const f = new SampleFilter(frame, CONFIG), o = campus.pad('central').ll;
  assert.equal(f.process(smp(1, [999, 80], 1000)).reason, 'invalid_coordinates');
  assert.equal(f.process({ ...smp(1, o, 1000), accuracyM: -1 }).reason, 'invalid_accuracy');
  assert.ok(f.process(smp(2, o, 2000)).accepted);
  assert.equal(f.process(smp(2, o, 3000)).reason, 'out_of_order', 'repeated sequence');
  assert.equal(f.process(smp(3, o, 1500)).reason, 'out_of_order', 'older timestamp');
  assert.equal(f.process(smp(4, o, 2000)).reason, 'duplicate', 'same measurement retransmitted');
  assert.equal(f.process(smp(5, o, 4000, 150)).reason, 'too_inaccurate');
});

test('velocity filter: noise is not motion, jumps are rejected, a consistent new position re-anchors', () => {
  const f = new SampleFilter(frame, CONFIG), o = campus.pad('central').ll;
  assert.ok(f.process(smp(1, o, 0)).accepted);
  assert.ok(f.process(smp(2, at(o, 9, 0), 1000)).accepted, '9 m in 1 s with ±8 m fixes is noise, not a sprint');
  assert.equal(f.process(smp(3, at(o, 80, 0), 2000)).reason, 'implausible_jump');
  assert.equal(f.process(smp(4, at(o, 81, 0), 3000)).reason, 'implausible_jump');
  const r = f.process(smp(5, at(o, 82, 0), 4000));
  assert.ok(r.accepted && r.reanchored, 'three agreeing fixes move the anchor');
});

test('route matching flags off-route and keeps progress continuous', () => {
  const g = campus.pad('south'), p = campus.plan({ origin: { kind: 'pad', ll: g.ll, nodeId: g.node }, destinationId: 'gazebo', padStatus: { south: 'ready' } });
  const f = new SampleFilter(frame, CONFIG); f.setRoute(p.guided.coords);
  let t = 0, last = -1;
  for (let s = 0; s <= 60; s += 1.2) { const r = f.process(smp(s * 10 + 1, pointAlong(frame, p.guided.coords, s).ll, (t += 1000))); assert.ok(r.accepted); assert.ok(r.matched.progressM >= last - 1); last = r.matched.progressM; }
  const far = pointAlong(frame, p.guided.coords, 62), off = at(far.ll, 0, 0);
  const g2 = new SampleFilter(frame, CONFIG); g2.setRoute(p.guided.coords);
  const offXY = frame.toXY(off), n = [-far.dir[1], far.dir[0]];
  const r = g2.process(smp(1, frame.toLL([offXY[0] + n[0] * 60, offXY[1] + n[1] * 60]), 1000));
  assert.ok(r.matched.offRoute, '60 m from the route is off-route, not snapped');
});

test('freshness: an older sample never makes the position fresher', () => {
  const fr = new Freshness();
  fr.mark('valid', 10_000); fr.mark('valid', 5_000);
  assert.equal(fr.ageS('valid', 40_000), 30);
  fr.mark('ground', 39_000);
  assert.equal(fr.ageS('valid', 40_000), 30, 'a ground heartbeat does not refresh the location');
  fr.clear(['valid']);
  assert.equal(fr.ageS('valid', 40_000), Infinity);
  assert.equal(fr.ageS('ground', 40_000), 1);
});

/* ---------------------------------------------------------------- 6/7/8. ground station */
function rig({ dest = 'gazebo', from = 'south', autoApprove = true } = {}) {
  let t = 1e12; const now = () => t;
  const gs = new GroundStation({ campus, now, random: seeded(), autoApprove });
  const events = []; gs.on((sid, ev) => events.push(ev));
  const { sessionId, token } = gs.createSession(); const s = gs.session(sessionId, token);
  const pad = campus.pad(from);
  const plan = gs.previewRoute(s, { origin: { kind: 'pad', ll: pad.ll, nodeId: pad.node }, destinationId: dest });
  const w = new SimulatedWalker({ frame, now, random: seeded(3) });
  w.setPath([...(plan.transfer?.coords?.length > 1 ? plan.transfer.coords : [plan.pad.ll]), ...plan.guided.coords.slice(1)]);
  const T = plan.transfer?.needed ? plan.transfer.lengthM : 0;
  const step = (sec, { walk = true } = {}) => {
    for (let i = 0; i < sec * 20; i++) {
      t += 50; const m = s.mission;
      w.setLimit(!m || ['MEET', 'PREFLIGHT', 'TAKEOFF'].includes(m.phase) ? T : T + m.sa - 3);
      if (walk && (s.request?.state === 'MEET_AT_PAD' || m)) { w.step(0.05); const x = w.sample(); if (x) gs.ingestSample(s, x); }
      gs.tick(0.05);
    }
  };
  return { gs, s, plan, w, step, events, now: () => t, token, sessionId };
}

test('guide requests are idempotent and a second active request is refused', () => {
  const { gs, s, plan } = rig();
  const a = gs.requestGuide(s, { routeId: plan.routeId, idempotencyKey: 'k1' });
  const b = gs.requestGuide(s, { routeId: plan.routeId, idempotencyKey: 'k1' });
  assert.equal(a.requestId, b.requestId);
  assert.equal(gs.requestGuide(s, { routeId: plan.routeId, idempotencyKey: 'k2' }).error, 'request_active');
  assert.equal(gs.requestGuide(s, { routeId: plan.routeId }).error, 'idempotency_key_required');
  const { gs: gs2, s: s2 } = rig();
  assert.equal(gs2.requestGuide(s2, { routeId: 'r-not-previewed', idempotencyKey: 'x' }).state, 'UNAVAILABLE');
});

test('dispatch passes through the operator states; decline is terminal', () => {
  const { gs, s, plan, step, events } = rig({ autoApprove: false });
  gs.requestGuide(s, { routeId: plan.routeId, idempotencyKey: 'k' });
  step(2, { walk: false });
  assert.equal(s.request.state, 'AWAITING_OPERATOR');
  gs.decide(s.request.id, false, 'Pad crew unavailable');
  assert.equal(s.request.state, 'DECLINED');
  assert.deepEqual(events.filter(e => e.type === 'dispatch').map(e => e.state), ['QUEUED', 'AWAITING_OPERATOR', 'DECLINED']);
});

const leading = r => { r.gs.requestGuide(r.s, { routeId: r.plan.routeId, idempotencyKey: 'k' }); for (let i = 0; i < 400 && r.s.mission?.phase !== 'LEADING'; i++) r.step(1); assert.equal(r.s.mission.phase, 'LEADING'); };

test('pause/resume: accepted first, confirmed only when the aircraft has done it', () => {
  const r = rig(); leading(r); r.step(15);
  const p = r.gs.action(r.s, { commandId: 'c1', type: 'pause' });
  assert.ok(['accepted', 'executing'].includes(p.state), 'the click result is never "confirmed"');
  r.step(3);
  const states = r.events.filter(e => e.type === 'command' && e.commandId === 'c1').map(e => e.state);
  assert.equal(states[0], 'accepted');
  assert.equal(states.at(-1), 'confirmed');
  assert.equal(r.s.mission.phase, 'PAUSED');
  assert.equal(r.gs.action(r.s, { commandId: 'c1', type: 'pause' }).state, 'confirmed', 'a retried command id is not executed twice');
  r.step(2);
  const res = r.gs.action(r.s, { commandId: 'c2', type: 'resume' });
  assert.notEqual(res.state, 'rejected');
  r.step(5);
  assert.notEqual(r.s.mission.phase, 'PAUSED');
});

test('resume needs a fresh visitor position', () => {
  const r = rig(); leading(r); r.step(10);
  r.gs.action(r.s, { commandId: 'p', type: 'pause' }); r.step(3);
  r.w.dropout = true; r.step(12);
  const res = r.gs.action(r.s, { commandId: 'q', type: 'resume' });
  r.step(1);
  const last = r.events.filter(e => e.type === 'command' && e.commandId === 'q').at(-1);
  assert.equal(last.state, 'rejected'); assert.equal(last.reason, 'position_not_fresh');
  assert.equal(r.s.mission.phase, 'PAUSED'); void res;
});

test('stale position: no hold at 30 s, hold just after 30 s, return after 60 s', () => {
  const r = rig({ dest: 'vit-sedaxis', from: 'east' }); leading(r); r.step(20);
  r.w.dropout = true;
  const lastAccepted = r.s.lastAccepted;
  while (r.now() - lastAccepted < 29_500) r.step(0.05);
  assert.ok(!/No visitor position/.test(r.s.mission.hold || ''), 'still not stale at 29.5 s');
  while (r.now() - lastAccepted < 30_600) r.step(0.05);
  assert.equal(r.s.mission.phase, 'WAITING');
  assert.match(r.s.mission.hold, /No visitor position for over 30 s/);
  while (r.now() - lastAccepted < 60_600) r.step(0.05);
  assert.equal(r.s.mission.phase, 'RETURNING');
});

test('emergency stop is confirmed only by landing; during telemetry loss it is not reported done', () => {
  const r = rig({ dest: 'vit-sedaxis', from: 'east' }); leading(r); r.step(15);
  r.gs.fault(r.s, 'aircraft_link', true); r.step(1);
  const a = r.gs.action(r.s, { commandId: 'abort-1', type: 'abort' });
  assert.equal(a.state, 'accepted');
  r.step(5);
  const st = () => r.events.filter(e => e.type === 'command' && e.commandId === 'abort-1').map(e => e.state);
  assert.ok(!st().includes('confirmed'), 'no confirmation while the aircraft cannot be heard');
  r.gs.fault(r.s, 'aircraft_link', false);
  for (let i = 0; i < 200 && r.s.mission.phase !== 'LANDED'; i++) r.step(1);
  assert.equal(r.s.mission.phase, 'LANDED');
  assert.equal(st().at(-1), 'confirmed');
});

test('operator handover rejects the old source; RC takeover does not substitute a position', () => {
  const r = rig(); leading(r); r.step(10);
  r.gs.rcTakeover(r.s, true); r.step(2);
  assert.equal(r.s.mission.phase, 'OPERATOR_ASSISTING');
  assert.equal(r.s.source, 'visitor', 'RC takeover leaves the position source alone');
  r.gs.rcTakeover(r.s, false);
  r.gs.handover(r.s, 'operator-device');
  const x = r.w.sample() || (r.step(1.1, { walk: false }), r.w.step(1), r.w.sample());
  const ack = r.gs.ingestSample(r.s, { ...x, seq: x.seq + 1000 });
  assert.equal(ack.accepted, false); assert.equal(ack.reason, 'source_handed_over');
  const op = r.gs.ingestSample(r.s, { ...x, seq: 1, timestamp: x.timestamp + 10, source: 'operator-device' }, { asOperator: true });
  assert.equal(op.accepted, true);
});

test('session tokens are long, random and checked', () => {
  const { gs, sessionId, token } = rig();
  assert.ok(token.length >= 40);
  assert.equal(gs.session(sessionId, 'x'.repeat(40)), null);
  assert.equal(gs.session(sessionId, token).id, sessionId);
});

test('closing a session mid-flight sends the aircraft home rather than dropping it', () => {
  const r = rig(); leading(r); r.step(10);
  const c = r.gs.closeSession(r.sessionId);
  assert.ok(c.closed && c.recovering);
  r.step(1);
  assert.equal(r.s.mission.phase, 'RETURNING');
  assert.equal(r.gs.ingestSample(r.s, { seq: 1e6, lat: 12.84, lon: 80.155, accuracyM: 5, timestamp: r.now() }).reason, 'sharing_stopped');
});

test('a normal trip arrives, then landing is confirmed at the pad', () => {
  const r = rig(); leading(r);
  for (let i = 0; i < 600 && r.s.mission.phase !== 'LANDED'; i++) r.step(1);
  const codes = r.events.filter(e => e.type === 'alert').map(e => e.code);
  assert.ok(codes.indexOf('destination_reached') < codes.indexOf('landed'));
  const landed = r.events.find(e => e.type === 'alert' && e.code === 'landed');
  assert.equal(landed.confirmed, true); assert.equal(landed.padId, 'south');
});
