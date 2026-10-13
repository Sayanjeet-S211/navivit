// Journey planning over the expanded pad network: a chain of aircraft-guided legs between pads,
// with any unguided walking (to the first pad, or from the last guided point) measured honestly.
// Shared by the browser, the ground station, the report generator and the tests.
import { walkingEtaS } from './config.js';
import { haversine, fnv1a } from './geo.js';

/**
 * Coverage from walked distances. The threshold is applied to the UNROUNDED ratio; zero walking
 * distance means coverage does not apply (it is never reported as 100%).
 */
export function coverageOf(guidedM, unguidedM, thresholdPct = 95) {
  const g = Math.max(0, guidedM || 0), u = Math.max(0, unguidedM || 0), total = g + u;
  if (!(total > 0)) return { guidedM: g, unguidedM: u, totalM: 0, percent: null, unguidedPercent: null, meets: null, applicable: false, thresholdPct };
  const percent = 100 * g / total;
  return { guidedM: g, unguidedM: u, totalM: total, percent, unguidedPercent: 100 * u / total, meets: percent >= thresholdPct, applicable: true, thresholdPct };
}
/** Display a percentage rounded DOWN to 0.1, so 94.96 % reads 94.9 %, never 95 %. */
export const fmtPercent = p => p == null || !Number.isFinite(p) ? 'n/a' : `${(Math.floor(p * 10 + 1e-9) / 10).toFixed(1)}%`;

export const PAD_APPROVAL_TEXT = { proposed: 'Proposed pad: placement pending inspection', approved: 'Approved pad' };

/** Energy and geometry check for one guided leg. returnM is flown back without the visitor. */
export function legCheck(campus, path, { returnM = 0 } = {}) {
  const c = campus.config, problems = [];
  if (!path) return { ok: false, problems: ['no_path'] };
  if (path.maxEdgeM > c.legLimitM) problems.push('edge_over_limit');
  if (path.lengthM > c.legLimitM) problems.push('over_limit');
  const guidedS = walkingEtaS(path.lengthM, c);
  const flightS = c.takeoffLandingS + guidedS + returnM / c.cruiseMps;
  if (flightS > c.enduranceBudgetS) problems.push('endurance');
  let fence = null;
  if (!problems.length) { fence = campus.routeFenceCheck(path.coords); if (fence.breach) problems.push('fence'); }
  return { ok: !problems.length, problems, flightS, guidedS, fence };
}

/** Feasible pad-to-pad legs, computed once per campus (they depend on geometry and config only). */
function padLegs(campus) {
  if (campus._padLegs) return campus._padLegs;
  const legs = new Map();
  for (const a of campus.pads) {
    const out = [];
    const { dist } = campus.dijkstra(a.node);
    for (const b of campus.pads) {
      if (a === b || !(dist.get(b.node) <= campus.config.legLimitM * 1.01)) continue;
      const p = a.node === b.node ? null : campus.path(a.node, b.node);
      if (!p) continue;
      const chk = legCheck(campus, p);
      if (chk.ok) out.push({ to: b, path: p, flightS: chk.flightS });
    }
    legs.set(a.id, out);
  }
  campus._padLegs = legs;
  return legs;
}

/** Final leg from a pad straight to an entrance; the aircraft flies back along the route to land. */
function finalLeg(campus, pad, entrance) {
  const key = pad.id + '>' + entrance;
  campus._finalLegs ??= new Map();
  if (campus._finalLegs.has(key)) return campus._finalLegs.get(key);
  let r = null;
  if (pad.node !== entrance && campus.dijkstra(pad.node).dist.get(entrance) <= campus.config.legLimitM * 1.01) {
    const p = campus.path(pad.node, entrance), chk = legCheck(campus, p, { returnM: p?.lengthM || 0 });
    if (chk.ok) r = { path: p, flightS: chk.flightS };
  }
  campus._finalLegs.set(key, r);
  return r;
}

/**
 * Search for the journey with the least unguided walking among plans that keep at least
 * minGuidedPercent of the walk guided and stay within the detour limit.
 * opts: { origin, destinationId, padStatus, padHandoff, aircraftAvailable, defaultPadStatus }
 */
export function planJourney(campus, opts) {
  const c = campus.config, { origin, destinationId } = opts;
  const dest = campus.destination(destinationId);
  if (!dest) throw new Error('Unknown destination: ' + destinationId);
  if (!origin || !Array.isArray(origin.ll)) throw new Error('Invalid origin');
  const status = id => opts.padStatus?.[id] ?? opts.defaultPadStatus ?? 'unknown';
  const handoffOk = p => opts.padHandoff?.[p.id] ?? p.support?.handoff ?? false;
  const aircraft = opts.aircraftAvailable ?? 1;

  const snap = origin.nodeId != null && campus.nodes.has(origin.nodeId) ? { id: origin.nodeId, distM: haversine(origin.ll, campus.node(origin.nodeId).ll) } : campus.nearestNode(origin.ll);
  const outsideM = campus.outsideM(origin.ll);
  const o = { ...origin, nodeId: snap.id, offGraphM: snap.distM, outsideM, outside: outsideM > c.fenceBufferM };
  const base = { version: campus.version, padsVersion: campus.padsVersion, origin: o, destination: { id: dest.id, name: dest.name, category: dest.category }, notes: [], reasons: [], suggestions: [], inspection: campus.classified ? 'classified' : 'pending', thresholdPct: c.minGuidedPercent };
  if (!campus.classified) base.notes.push('Footpath and road classification is not in the campus data yet, so route inspection is pending.');

  // Shortest eligible walking route: the reference for the detour limit and for walking-only directions.
  let direct = null;
  for (const e of dest.entrances) { const p = campus.path(o.nodeId, e); if (p && (!direct || p.lengthM < direct.lengthM)) direct = { ...p, entrance: e }; }
  if (!direct) return finish({ ...base, availability: 'unavailable', reasons: [{ code: 'no_walking_route', text: 'There is no connected walking route between these points in the campus graph.' }] });
  direct = { ...direct, lengthM: direct.lengthM + o.offGraphM };
  direct.etaS = walkingEtaS(direct.lengthM, c);
  base.direct = direct;
  if (direct.lengthM <= c.atDestinationM) return finish({ ...base, availability: 'at_destination', coverage: coverageOf(0, 0, c.minGuidedPercent) });
  if (o.outside) base.reasons.push({ code: 'origin_outside', text: 'Your starting point is outside the campus boundary.' });

  const allowedTotalM = Math.max(direct.lengthM * c.maxDetourRatio, direct.lengthM + c.maxDetourExtraM);
  const search = (usable, canHandoff) => bestJourney(campus, o, dest, usable, canHandoff, allowedTotalM);
  const usableNow = p => ['ready', 'unknown'].includes(status(p.id));
  const res = search(usableNow, handoffOk);
  let pick = res.qualifying[0];

  if (aircraft < 1) base.reasons.push({ code: 'no_aircraft', text: 'No guide aircraft is available right now.' });
  if (pick && !base.reasons.length) {
    const plan = build(campus, base, pick, status, allowedTotalM);
    plan.availability = pick.pads.some(p => status(p.id) === 'unknown') ? 'unknown' : 'available';
    if (plan.availability === 'unknown') plan.notes.push('Readiness of at least one pad on this route is unknown.');
    return finish(plan);
  }

  // Diagnose: would the network qualify with every pad ready and staffed? Then name what is missing.
  if (!pick && !base.reasons.length) {
    const ideal = search(() => true, () => true).qualifying[0];
    if (ideal) {
      const down = ideal.pads.filter(p => !usableNow(p));
      const noHandoff = ideal.pads.slice(1, -1).filter((p, i) => ideal.handoffs.includes(p) && !handoffOk(p));
      for (const p of down) base.reasons.push({ code: 'pad_unavailable', text: `${p.name} is not available.`, padId: p.id });
      for (const p of ideal.handoffs.filter(h => !handoffOk(h))) base.reasons.push({ code: 'handoff_unsupported', text: `No staffed handoff (battery swap) at ${p.name}.`, padId: p.id });
      void noHandoff;
      if (!base.reasons.length) base.reasons.push({ code: 'no_qualifying_plan', text: 'No combination of available pads keeps 95% of this walk guided.' });
    } else {
      const best = res.best || search(() => true, () => true).best;
      structuralReasons(campus, base, best, o, dest, allowedTotalM);
    }
  }
  const fallback = pick || res.best;
  const plan = fallback ? build(campus, base, fallback, status, allowedTotalM) : { ...base };
  plan.availability = 'unavailable';
  plan.unavailableText = '95% drone-guided navigation is currently unavailable for this route.';
  return finish(plan);

  function finish(p) {
    p.routeId = 'r' + fnv1a([campus.version, campus.padsVersion, destinationId, o.nodeId, Math.round(o.offGraphM), (p.segments || []).map(s => s.kind + ':' + s.nodes.join(',')).join('|'), p.availability].join('#'));
    p.guideNeeded = p.availability !== 'at_destination';
    return p;
  }
}

function cachedPath(campus, a, b) {
  campus._paths ??= new Map();
  const k = a + '>' + b;
  if (!campus._paths.has(k)) campus._paths.set(k, campus.path(a, b));
  return campus._paths.get(k);
}

function bestJourney(campus, o, dest, usable, canHandoff, allowedTotalM) {
  const c = campus.config, legs = padLegs(campus), pads = campus.pads.filter(usable);
  const qualifying = [], all = [];
  const { dist: fromOrigin } = campus.dijkstra(o.nodeId);
  const starts = pads.map(p => ({ p, t0: (fromOrigin.get(p.node) ?? Infinity) + o.offGraphM })).filter(x => Number.isFinite(x.t0) && x.t0 <= allowedTotalM).sort((a, b) => a.t0 - b.t0).slice(0, 10);
  const usableIds = new Set(pads.map(p => p.id));
  for (const { p: S, t0 } of starts) {
    // Dijkstra over pads by guided metres (ties: fewer legs). Relaunching needs handoff support.
    const best = new Map([[S.id, { g: 0, n: 0, prev: null, pad: S, leg: null }]]), done = new Set(), q = [best.get(S.id)];
    while (q.length) {
      let bi = 0; for (let i = 1; i < q.length; i++) if (q[i].g < q[bi].g || (q[i].g === q[bi].g && q[i].n < q[bi].n)) bi = i;
      const cur = q.splice(bi, 1)[0];
      if (done.has(cur.pad.id)) continue; done.add(cur.pad.id);
      if (cur.g + t0 > allowedTotalM) continue;
      if (cur.pad !== S && !canHandoff(cur.pad)) continue;
      for (const L of legs.get(cur.pad.id) || []) {
        if (!usableIds.has(L.to.id)) continue;
        const g = cur.g + L.path.lengthM, n = cur.n + 1, prev = best.get(L.to.id);
        if (!prev || g < prev.g - 1e-6 || (Math.abs(g - prev.g) < 1e-6 && n < prev.n)) { const node = { g, n, prev: cur, pad: L.to, leg: L }; best.set(L.to.id, node); q.push(node); }
      }
    }
    for (const node of best.values()) {
      const chain = []; for (let x = node; x; x = x.prev) chain.unshift(x);
      const legsUsed = chain.slice(1).map(x => ({ from: x.prev.pad, to: x.pad, path: x.leg.path, flightS: x.leg.flightS, final: false }));
      const handoffs = chain.slice(1, -1).map(x => x.pad);
      const consider = (extraLeg, approach, entrance) => {
        const allLegs = extraLeg ? [...legsUsed, extraLeg] : legsUsed;
        if (!allLegs.length) return;
        const guidedM = allLegs.reduce((s, l) => s + l.path.lengthM, 0), unguidedM = t0 + (approach?.lengthM || 0);
        const totalM = guidedM + unguidedM, pct = 100 * guidedM / totalM;
        const cand = { start: S, t0, legs: allLegs, handoffs: extraLeg && legsUsed.length ? [...handoffs, node.pad] : handoffs, approach, entrance, guidedM, unguidedM, totalM, pct, detourOk: totalM <= allowedTotalM + 1e-6, flightS: allLegs.reduce((s, l) => s + l.flightS, 0), pads: [S, ...allLegs.map(l => l.to).filter(Boolean)] };
        if (extraLeg && legsUsed.length && !canHandoff(node.pad)) return;
        all.push(cand);
        if (cand.detourOk && pct >= c.minGuidedPercent) qualifying.push(cand);
      };
      for (const e of dest.entrances) {
        const f = finalLeg(campus, node.pad, e);
        if (f) consider({ from: node.pad, to: null, entrance: e, path: f.path, flightS: f.flightS, final: true, returnTo: node.pad }, null, e);
        if (legsUsed.length) { const a = cachedPath(campus, node.pad.node, e); if (a) consider(null, a.lengthM > 0.5 ? a : null, e); }
      }
    }
  }
  const rank = (a, b) => (a.unguidedM - b.unguidedM) || (a.totalM - b.totalM) || (a.legs.length - b.legs.length) || (a.flightS - b.flightS);
  qualifying.sort(rank);
  const best = all.filter(x => x.detourOk).sort((a, b) => b.pct - a.pct || rank(a, b))[0] || all.sort((a, b) => b.pct - a.pct)[0] || null;
  return { qualifying, best };
}

function structuralReasons(campus, base, best, o, dest, allowedTotalM) {
  const c = campus.config;
  if (!best) {
    base.reasons.push({ code: 'no_leg_chain', text: `No chain of guided legs of at most ${c.legLimitM} m connects a pad near you with ${dest.name}.` });
    base.suggestions.push(suggestPad(campus, o.nodeId, 'near your starting point'));
    return;
  }
  const share = m => 100 * m / best.totalM;
  if (!best.detourOk) base.reasons.push({ code: 'detour', text: `The only guided chain is a ${Math.round(best.totalM)} m walk, more than the allowed ${Math.round(allowedTotalM)} m for this trip.` });
  if (best.t0 > 0.5 && share(best.t0) > 100 - c.minGuidedPercent - 1e-9) {
    base.reasons.push({ code: 'start_transfer', text: `The nearest usable pad, ${best.start.name}, is ${Math.round(best.t0)} m away: walking there alone is ${share(best.t0).toFixed(1)}% of the trip.` });
    base.suggestions.push(suggestPad(campus, o.nodeId, 'near your starting point'));
  }
  if (best.approach && share(best.approach.lengthM) > 0.5) {
    base.reasons.push({ code: 'final_approach', text: `The last ${Math.round(best.approach.lengthM)} m to the ${dest.name} entrance would be unguided.` });
    base.suggestions.push(suggestPad(campus, best.entrance, `at the ${dest.name} entrance`));
  }
  if (!base.reasons.length) base.reasons.push({ code: 'coverage', text: `Best available plan keeps ${best.pct.toFixed(2)}% of the walk guided, below ${c.minGuidedPercent}%.` });
}
function suggestPad(campus, nodeId, where) {
  const n = campus.node(nodeId);
  return { nodeId, ll: n.ll, text: `A proposed pad ${where} (graph node ${nodeId}) would close this gap. It would need inspection and approval.` };
}

function build(campus, base, cand, status, allowedTotalM) {
  const c = campus.config, segs = [];
  const padInfo = p => ({ id: p.id, name: p.name, node: p.node, ll: p.ll, approval: p.approval, status: status(p.id), meet: p.meet, kind: p.kind });
  if (cand.t0 > 0.5) {
    const t = campus.path(base.origin.nodeId, cand.start.node);
    segs.push({ kind: 'unguided', role: 'transfer', nodes: t.nodes, coords: [base.origin.ll, ...t.coords].filter((x, i, a) => i === 0 || x !== a[i - 1]), lengthM: cand.t0, etaS: walkingEtaS(cand.t0, c), to: padInfo(cand.start) });
  }
  const legs = cand.legs.map((l, i) => {
    const leg = { index: i, from: padInfo(l.from), to: l.to ? padInfo(l.to) : null, entrance: l.final ? l.entrance : null, nodes: l.path.nodes, coords: l.path.coords, lengthM: l.path.lengthM, etaS: walkingEtaS(l.path.lengthM, c), flightS: l.flightS, final: !!l.final, landPadId: l.to ? l.to.id : l.from.id, returnM: l.final ? l.path.lengthM : 0 };
    segs.push({ kind: 'guided', role: 'leg', legIndex: i, nodes: leg.nodes, coords: leg.coords, lengthM: leg.lengthM, etaS: leg.etaS });
    return leg;
  });
  if (cand.approach) segs.push({ kind: 'unguided', role: 'final', nodes: cand.approach.nodes, coords: cand.approach.coords, lengthM: cand.approach.lengthM, etaS: walkingEtaS(cand.approach.lengthM, c) });
  const handoffs = cand.handoffs.map(p => ({ ...padInfo(p), waitS: c.handoffSwapS }));
  const coverage = coverageOf(cand.guidedM, cand.unguidedM, c.minGuidedPercent);
  const startPad = padInfo(cand.start);
  const transfer = segs.find(s => s.role === 'transfer');
  return {
    ...base, segments: segs, legs, handoffs, coverage, allowedTotalM,
    startPad, pad: startPad,
    transfer: transfer ? { ...transfer, needed: transfer.lengthM > c.padArrivalM } : { coords: [startPad.ll], lengthM: cand.t0, etaS: walkingEtaS(cand.t0, c), needed: false },
    finalApproach: cand.approach ? segs.at(-1) : null,
    pads: cand.pads.map(padInfo),
    landingPadId: legs.at(-1).landPadId,
    totalM: cand.totalM, totalEtaS: walkingEtaS(cand.totalM, c), waitS: handoffs.length * c.handoffSwapS,
    proposedPads: cand.pads.filter(p => p.approval !== 'approved').length
  };
}
