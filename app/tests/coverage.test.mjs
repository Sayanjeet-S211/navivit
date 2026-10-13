// 95% drone-guided coverage: arithmetic, the expanded pad network, failure diagnostics and
// observed coverage during a simulated trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Campus } from '../js/campus.js';
import { CONFIG } from '../js/config.js';
import { coverageOf, fmtPercent } from '../js/journey.js';
import { GroundStation } from '../js/sim/groundstation.js';
import { SimulatedWalker } from '../js/sim/walker.js';
import { haversine } from '../js/geo.js';

const RAW = JSON.parse(fs.readFileSync(new URL('../data/campus.v1.json', import.meta.url), 'utf8'));
const PADS = JSON.parse(fs.readFileSync(new URL('../data/pads.v1.json', import.meta.url), 'utf8'));
const campus = new Campus(RAW, CONFIG, PADS);
const at = node => ({ kind: 'place', ll: campus.node(node).ll, nodeId: node });
const plan = (originNode, dest, extra = {}) => campus.plan({ origin: at(originNode), destinationId: dest, defaultPadStatus: 'ready', ...extra });
const GATE = campus.pad('gate').node;
const entrance = id => campus.destination(id).entrances[0];

/** Every qualifying plan must be internally consistent: real segment lengths add up. */
function assertConsistent(p, label) {
  assert.equal(p.availability, 'available', `${label}: ${p.reasons?.map(r => r.text).join(' ')}`);
  const g = p.segments.filter(s => s.kind === 'guided').reduce((a, s) => a + s.lengthM, 0);
  const u = p.segments.filter(s => s.kind === 'unguided').reduce((a, s) => a + s.lengthM, 0);
  assert.ok(Math.abs(g - p.coverage.guidedM) < 1e-6, `${label}: guided metres match segments`);
  assert.ok(Math.abs(u - p.coverage.unguidedM) < 0.01 + p.origin.offGraphM, `${label}: unguided metres match segments`);
  assert.ok(100 * p.coverage.guidedM / p.coverage.totalM >= 95, `${label}: unrounded coverage ≥ 95`);
  assert.ok(p.legs.every(l => l.lengthM <= CONFIG.legLimitM + 1e-9 && l.flightS <= CONFIG.enduranceBudgetS), `${label}: legs within limits`);
  for (let i = 1; i < p.legs.length; i++) assert.equal(p.legs[i].from.id, p.legs[i - 1].to.id, `${label}: legs chain through pads`);
  assert.ok(p.totalM <= p.allowedTotalM + 1e-6, `${label}: within the detour limit`);
  assert.ok(p.legs.every(l => campus.pad(l.from.id)), `${label}: legs launch from real pads`);
}

/* ---------------------------------------------------------------- arithmetic */
test('coverage uses the unrounded ratio; 94.96% fails and is never displayed as 95%', () => {
  const exact = coverageOf(95, 5);
  assert.equal(exact.percent, 95); assert.equal(exact.meets, true); assert.equal(fmtPercent(exact.percent), '95.0%');
  const below = coverageOf(94.96, 5.04);
  assert.ok(Math.abs(below.percent - 94.96) < 1e-9); assert.equal(below.meets, false); assert.equal(fmtPercent(below.percent), '94.9%');
  const hair = coverageOf(94.999, 5.001);
  assert.equal(hair.meets, false); assert.equal(fmtPercent(hair.percent), '94.9%');
  assert.equal(fmtPercent(100), '100.0%');
});

test('zero walking distance: coverage does not apply (no divide by zero, no 100%)', () => {
  const z = coverageOf(0, 0);
  assert.equal(z.applicable, false); assert.equal(z.percent, null); assert.equal(z.meets, null); assert.equal(fmtPercent(z.percent), 'n/a');
});

/* ---------------------------------------------------------------- pad network */
test('pad network: required sites exist, are proposed, and shared entrances are one candidate', () => {
  const serves = id => campus.pads.filter(p => (p.serves || []).includes(id));
  const required = campus.destinations.filter(d => d.id === 'guest-house' || d.id === 'vit-sedaxis' || d.category === 'Hostel' || (d.category === 'Academic' && / Block\b/.test(d.name)));
  for (const d of required) assert.ok(serves(d.id).length, `${d.name} has a pad candidate`);
  for (const id of ['academic-block-1', 'academic-block-2', 'academic-block-3', 'academic-block-4', 'academic-block-5', 'a-block-hostel', 'b-block-hostel', 'c-block-hostel', 'd1-block-hostel', 'd2-block-hostel', 'e-block-hostel']) assert.ok(serves(id).length, id);
  assert.ok(campus.pads.every(p => p.approval === 'proposed' && p.inspection === 'pending'), 'nothing is presented as approved');
  const d1 = serves('d1-block-hostel')[0], d2 = serves('d2-block-hostel')[0];
  assert.equal(d1.id, d2.id, 'D1 and D2 share entrance node 189: one physical candidate');
  assert.ok(d1.shared);
  assert.equal(new Set(campus.pads.map(p => p.node)).size, campus.pads.length, 'no two pad records on the same node');
  for (const p of campus.pads) assert.ok(campus.outsideM(p.ll) <= CONFIG.fenceBufferM, `${p.name} inside the buffered boundary`);
});

/* ---------------------------------------------------------------- scenarios */
test('Gate ↔ Guest House and Gate ↔ VIT-SEDAXIS meet 95% both ways', () => {
  for (const d of ['guest-house', 'vit-sedaxis']) {
    assertConsistent(plan(GATE, d), `Gate → ${d}`);
    assertConsistent(plan(entrance(d), 'main-gate'), `${d} → Gate`);
  }
});

test('Gate to every academic block and every hostel meets 95%', () => {
  const targets = campus.destinations.filter(d => d.category === 'Hostel' || (d.category === 'Academic' && / Block\b/.test(d.name)));
  assert.ok(targets.length >= 14);
  for (const d of targets) assertConsistent(plan(GATE, d.id), `Gate → ${d.name}`);
});

test('hostel → academic block trips meet 95%', () => {
  const hostels = campus.destinations.filter(d => d.category === 'Hostel'), blocks = campus.destinations.filter(d => /^academic-block-/.test(d.id));
  for (const h of hostels) for (const b of blocks) {
    const p = plan(h.entrances[0], b.id);
    if (p.availability !== 'at_destination') assertConsistent(p, `${h.name} → ${b.name}`);
  }
});

test('the old six-pad result is not reused: Gate → Gazebo now starts guidance at the gate', () => {
  const p = plan(GATE, 'gazebo');
  assertConsistent(p, 'Gate → Gazebo');
  assert.equal(p.coverage.unguidedM, 0, 'no long independent approach to a remote pad');
});

test('manual and off-graph origins: the walk onto the network counts as unguided', () => {
  const g = campus.node(GATE).ll, pin = [g[0] + 6 / 111320, g[1]];
  const p = campus.plan({ origin: { kind: 'pin', ll: pin }, destinationId: 'guest-house', defaultPadStatus: 'ready' });
  assert.ok(p.origin.offGraphM > 3);
  assert.ok(p.coverage.unguidedM >= p.origin.offGraphM - 1e-9);
  assert.ok(p.coverage.meets);
  const far = campus.plan({ origin: { kind: 'pin', ll: [g[0] - 160 / 111320, g[1]] }, destinationId: 'guest-house', defaultPadStatus: 'ready' });
  assert.equal(far.availability, 'unavailable', 'a 160 m unguided start on a short trip cannot qualify');
  assert.ok(far.reasons.some(r => ['start_transfer', 'origin_outside'].includes(r.code)));
});

test('already at the destination', () => {
  const p = plan(entrance('guest-house'), 'guest-house');
  assert.equal(p.availability, 'at_destination'); assert.equal(p.coverage.applicable, false);
});

/* ---------------------------------------------------------------- failure diagnostics */
test('unavailable aircraft names the cause', () => {
  const p = plan(GATE, 'guest-house', { aircraftAvailable: 0 });
  assert.equal(p.availability, 'unavailable');
  assert.ok(p.reasons.some(r => r.code === 'no_aircraft'));
});

test('missing handoff support blocks multi-leg plans and names the pad', () => {
  const ok = plan(GATE, 'vit-sedaxis');
  assert.ok(ok.legs.length > 1, 'SEDAXIS from the gate needs a handoff');
  const none = Object.fromEntries(campus.pads.map(p => [p.id, false]));
  const p = plan(GATE, 'vit-sedaxis', { padHandoff: none });
  assert.equal(p.availability, 'unavailable');
  assert.ok(p.reasons.some(r => r.code === 'handoff_unsupported'), JSON.stringify(p.reasons));
  assert.equal(plan(GATE, 'guest-house', { padHandoff: none }).availability, 'available', 'single-leg trips need no handoff');
});

test('an unavailable pad on every alternative is reported by name', () => {
  const ok = plan(GATE, 'guest-house');
  const start = ok.startPad.id;
  const p = plan(GATE, 'guest-house', { padStatus: Object.fromEntries(campus.pads.map(x => [x.id, x.id === start ? 'unavailable' : 'ready'])) });
  if (p.availability === 'unavailable') assert.ok(p.reasons.some(r => r.code === 'pad_unavailable' && r.padId === start) || p.reasons.some(r => r.code === 'start_transfer'));
  else assert.ok(!p.pads.some(x => x.id === start));
});

test('a disconnected graph is reported, not planned around', () => {
  const raw = JSON.parse(JSON.stringify(RAW));
  const target = campus.destination('guest-house').entrances[0];
  const n = raw.nodes.find(x => x.id === target);
  for (const v of n.adj) { const m = raw.nodes.find(x => x.id === v); m.adj = m.adj.filter(x => x !== target); }
  n.adj = [];
  const c = new Campus(raw, CONFIG, PADS);
  const p = c.plan({ origin: at(GATE), destinationId: 'guest-house', defaultPadStatus: 'ready' });
  assert.equal(p.availability, 'unavailable');
  assert.equal(p.reasons[0].code, 'no_walking_route');
});

test('the detour limit stops a huge guided detour from inflating the percentage', () => {
  const strict = new Campus(RAW, { ...CONFIG, maxDetourRatio: 1, maxDetourExtraM: 0 }, PADS);
  const p = strict.plan({ origin: at(GATE), destinationId: 'vit-sedaxis', defaultPadStatus: 'ready' });
  if (p.availability === 'available') assert.ok(p.totalM <= p.direct.lengthM + 1e-6);
  else assert.ok(p.reasons.length);
});

/* ---------------------------------------------------------------- observed coverage */
function run(dest, { interrupt = false, crewMissing = false } = {}) {
  let t = 1e12; const now = () => t;
  const gs = new GroundStation({ campus, now });
  const events = []; gs.on((sid, ev) => events.push(ev));
  const { sessionId } = gs.createSession(); const s = gs.session(sessionId);
  const p = gs.previewRoute(s, { origin: at(GATE), destinationId: dest });
  gs.requestGuide(s, { routeId: p.routeId, idempotencyKey: 'k' });
  const w = new SimulatedWalker({ frame: campus.frame, now });
  const path = []; for (const part of [[p.startPad.ll], ...p.legs.map(l => l.coords)]) for (const c of part) if (!path.length || haversine(path.at(-1), c) > 0.01) path.push(c);
  w.setPath(path);
  let interrupted = false, blocked = null;
  for (let i = 0; i < 20 * 3600; i++) {
    t += 50; const m = s.mission;
    if (interrupt && m?.phase === 'LEADING' && m.sa > 60 && !interrupted) { interrupted = true; gs.rcTakeover(s, true); }
    const lim = m ? m.simVisitorLimitM() : 0;
    // During the interruption the visitor keeps walking 40 m on their own.
    w.setLimit(interrupted && m?.rc ? m.legStart[m.legIdx] + m.sa + 40 : (lim == null ? w.s : lim));
    if (interrupted && m?.rc && w.s >= m.legStart[m.legIdx] + m.sa + 38) gs.rcTakeover(s, false);
    if (crewMissing && m?.phase === 'HANDOFF' && !blocked) { blocked = m.leg.to.id; gs.setHandoff(blocked, false); }
    if (blocked && m?.phase === 'HANDOFF' && t - m.timers.handoff > 300e3) gs.setHandoff(blocked, true);
    if (s.request?.state === 'MEET_AT_PAD' || m) { w.step(0.05); const x = w.sample(); if (x) gs.ingestSample(s, x); }
    gs.tick(0.05);
    if (m?.phase === 'LANDED') break;
  }
  return { p, m: s.mission, events };
}

test('a multi-leg demo trip lands at each handoff, waits, then arrives with observed coverage close to plan', () => {
  const { p, m, events } = run('vit-sedaxis');
  assert.equal(m.outcome, 'arrived');
  const handoffs = events.filter(e => e.type === 'alert' && e.code === 'handoff');
  assert.equal(handoffs.length, p.legs.length - 1);
  const obs = coverageOf(m.obs.guidedM, m.obs.unguidedM);
  assert.ok(obs.percent >= 95, `observed ${obs.percent}`);
  assert.ok(m.obs.guidedM <= p.coverage.guidedM + 1);
});

test('interrupted guidance lowers observed coverage below the plan', () => {
  const { p, m } = run('vit-sedaxis', { interrupt: true });
  assert.ok(m.obs.unguidedM > 25, `unguided ${m.obs.unguidedM}`);
  assert.ok(coverageOf(m.obs.guidedM, m.obs.unguidedM).percent < p.coverage.percent);
});

test('a missing handoff crew interrupts guidance; the next leg waits for it', () => {
  const { events, m } = run('vit-sedaxis', { crewMissing: true });
  const blocked = events.find(e => e.type === 'alert' && e.code === 'handoff_blocked');
  assert.ok(blocked, 'handoff blocked reported');
  assert.ok(events.some(e => e.type === 'mission' && e.status === 'interrupted'));
  const next = events.find(e => e.type === 'alert' && e.code === 'leg_started' && e.serverTime > blocked.serverTime);
  assert.ok(next && next.serverTime - blocked.serverTime >= 290e3, 'the next leg started only after the crew was back');
  assert.equal(m.outcome, 'arrived');
});
