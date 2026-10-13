#!/usr/bin/env node
// Origin–destination coverage report for the expanded pad network, recomputed from the data.
//   node tools/coverage-report.mjs   → docs/coverage-report.md and docs/coverage-report.csv
// Resource states are simulated (every proposed pad ready and staffed, one aircraft) unless a
// scenario says otherwise. Nothing here describes approved or inspected sites.
import fs from 'node:fs';
import { Campus } from '../js/campus.js';
import { CONFIG } from '../js/config.js';
import { coverageOf, fmtPercent } from '../js/journey.js';

const ROOT = new URL('..', import.meta.url).pathname;
const RAW = JSON.parse(fs.readFileSync(ROOT + 'data/campus.v1.json', 'utf8'));
const PADS = JSON.parse(fs.readFileSync(ROOT + 'data/pads.v1.json', 'utf8'));
const campus = new Campus(RAW, CONFIG, PADS);
const GATE = campus.pad('gate').node;
const nodeName = new Map();
for (const p of campus.pads) nodeName.set(p.node, p.name.replace(/ pad$/, ''));
for (const d of campus.destinations) d.entrances.forEach((e, i) => nodeName.set(e, d.name + (d.entrances.length > 1 ? ` (entrance ${i + 1})` : '')));
nodeName.set(GATE, 'Main Gate (Gate Pad)');
const at = node => ({ kind: 'place', ll: campus.node(node).ll, nodeId: node, label: nodeName.get(node) });
const m = x => (x == null ? '' : Math.round(x));

const rows = [];
function row(group, originLabel, origin, dest, opts = {}, c = campus) {
  const p = c.plan({ origin, destinationId: dest, defaultPadStatus: 'ready', ...opts });
  const cov = p.coverage;
  rows.push({
    group, origin: originLabel, destination: c.destination(dest).name,
    total: cov?.applicable ? cov.totalM : p.direct?.lengthM ?? null, guided: cov?.guidedM ?? null, unguided: cov?.unguidedM ?? null,
    pct: cov?.applicable ? cov.percent : null, legs: p.legs?.length ?? 0,
    pads: p.availability === 'available' || p.availability === 'unknown' ? (p.pads || []).map(x => x.name.replace(/ pad$/, '')).join(' → ') : '',
    handoffs: p.handoffs?.length ?? 0, waitS: p.waitS ?? 0,
    result: p.availability === 'available' ? 'qualifies' : p.availability === 'at_destination' ? 'already at destination' : 'unavailable',
    reason: p.availability === 'unavailable' ? p.reasons.map(r => r.text).join(' ') : p.availability === 'at_destination' ? 'Coverage not applicable' : ''
  });
  return p;
}

// Required scenarios.
row('Gate ↔ Guest House', 'Main Gate (Gate Pad)', at(GATE), 'guest-house');
row('Gate ↔ Guest House', 'Guest House', at(campus.destination('guest-house').entrances[0]), 'main-gate');
row('Gate ↔ VIT-SEDAXIS', 'Main Gate (Gate Pad)', at(GATE), 'vit-sedaxis');
row('Gate ↔ VIT-SEDAXIS', 'VIT-SEDAXIS', at(campus.destination('vit-sedaxis').entrances[0]), 'main-gate');
const blocks = campus.destinations.filter(d => d.category === 'Academic' && / Block\b/.test(d.name));
const hostels = campus.destinations.filter(d => d.category === 'Hostel');
for (const d of [...blocks, ...hostels]) row('Gate → academic blocks and hostels', 'Main Gate (Gate Pad)', at(GATE), d.id);
for (const h of hostels) for (const b of blocks.filter(x => /^academic-block-/.test(x.id))) row('Hostel → academic block', h.name, at(h.entrances[0]), b.id);
// Manual, off-graph and zero-distance origins.
const g = campus.node(GATE).ll;
row('Manual / off-graph origins', 'Pin 6 m north of the gate', { kind: 'pin', ll: [g[0] + 6 / 111320, g[1]] }, 'guest-house');
row('Manual / off-graph origins', 'Pin 160 m south of the gate (off campus)', { kind: 'pin', ll: [g[0] - 160 / 111320, g[1]] }, 'guest-house');
row('Manual / off-graph origins', 'Pin 25 m off the path near Gazebo', { kind: 'pin', ll: [campus.node(campus.destination('gazebo').entrances[0]).ll[0] + 25 / 111320, campus.node(campus.destination('gazebo').entrances[0]).ll[1]] }, 'academic-block-1');
row('Manual / off-graph origins', 'Guest House entrance', at(campus.destination('guest-house').entrances[0]), 'guest-house');
// Failure cases.
const sx = campus.plan({ origin: at(GATE), destinationId: 'vit-sedaxis', defaultPadStatus: 'ready' });
row('Failure cases', 'Main Gate — no aircraft available', at(GATE), 'guest-house', { aircraftAvailable: 0 });
row('Failure cases', 'Main Gate — no handoff crew anywhere', at(GATE), 'vit-sedaxis', { padHandoff: Object.fromEntries(campus.pads.map(p => [p.id, false])) });
row('Failure cases', `Main Gate — ${sx.handoffs[0]?.name || 'first handoff pad'} unavailable`, at(GATE), 'vit-sedaxis', { padStatus: sx.handoffs[0] ? { [sx.handoffs[0].id]: 'unavailable' } : {} });
row('Failure cases', 'Main Gate — Gate Pad unavailable', at(GATE), 'guest-house', { padStatus: { gate: 'unavailable', 'p-main-gate-e2': 'unavailable' } });
row('Failure cases', 'Main Gate — leg limit set to 60 m', at(GATE), 'vit-sedaxis', {}, new Campus(RAW, { ...CONFIG, legLimitM: 60 }, PADS));
{
  const raw = JSON.parse(JSON.stringify(RAW)), target = campus.destination('guest-house').entrances[0], n = raw.nodes.find(x => x.id === target);
  for (const v of n.adj) { const q = raw.nodes.find(x => x.id === v); q.adj = q.adj.filter(x => x !== target); } n.adj = [];
  row('Failure cases', 'Main Gate — Guest House entrance disconnected from the graph', at(GATE), 'guest-house', {}, new Campus(raw, CONFIG, PADS));
}

// Full matrix: every pad and destination entrance as an origin, every destination.
const origins = new Map();
for (const p of campus.pads) origins.set(p.node, nodeName.get(p.node));
for (const d of campus.destinations) for (const e of d.entrances) origins.set(e, nodeName.get(e));
let q = 0, un = 0, here = 0, minPct = 100; const failures = [];
for (const [node, label] of origins) for (const d of campus.destinations) {
  const p = campus.plan({ origin: at(node), destinationId: d.id, defaultPadStatus: 'ready' });
  if (p.availability === 'available') { q++; minPct = Math.min(minPct, p.coverage.percent); }
  else if (p.availability === 'at_destination') here++;
  else { un++; failures.push(`${label} → ${d.name}: ${p.reasons.map(r => r.text).join(' ')}`); }
}

// Before / after: the previous planner chose the source pad nearest the DESTINATION and attached
// the walk to it as unguided transfer.
const SOURCE = ['gate', 'central', 'east', 'north-west', 'south', 'e-block'].map(id => campus.pad(id));
function legacy(originNode, destId) {
  const dest = campus.destination(destId);
  const cands = SOURCE.map(p => { const best = dest.entrances.map(e => campus.path(p.node, e)).filter(Boolean).sort((a, b) => a.lengthM - b.lengthM)[0]; return best && best.lengthM <= CONFIG.legLimitM ? { p, g: best.lengthM } : null; }).filter(Boolean).sort((a, b) => a.g - b.g);
  const pick = cands[0]; if (!pick) return null;
  const t = campus.path(originNode, pick.p.node)?.lengthM ?? 0, guided = pick.g > CONFIG.padArrivalM ? pick.g : 0;
  return { pad: pick.p.name, transfer: t, guided, cov: coverageOf(guided, t + (guided ? 0 : pick.g)) };
}
const compare = campus.destinations.map(d => {
  const old = legacy(GATE, d.id), now = campus.plan({ origin: at(GATE), destinationId: d.id, defaultPadStatus: 'ready' });
  return { d: d.name, old, now };
}).filter(x => x.now.availability !== 'at_destination');

/* ------------------------------------------------------------------ write */
const esc = s => String(s).replace(/\|/g, '\\|');
const kinds = k => campus.pads.filter(p => p.kind === k).length;
let md = `# NAVI guided-coverage report

Generated by \`tools/coverage-report.mjs\` from \`data/campus.v1.json\` (${campus.version}) and \`data/pads.v1.json\` (${campus.padsVersion}).
Requirement: at least **${CONFIG.minGuidedPercent}%** of the visitor's walking distance drone-guided (unrounded), legs of at most **${CONFIG.legLimitM} m** (provisional) and one battery (${CONFIG.enduranceBudgetS} s budget incl. ${CONFIG.takeoffLandingS} s launch/landing and any return flight at ${CONFIG.cruiseMps} m/s), walk no longer than max(${CONFIG.maxDetourRatio} × shortest route, shortest + ${CONFIG.maxDetourExtraM} m).
Resource states are **simulated**: every proposed pad ready with a staffed battery-swap handoff (${CONFIG.handoffSwapS} s estimate) and one aircraft, unless a row says otherwise. **All pads are proposed: placement pending inspection.**

## Pad network

${campus.pads.length} proposed pads: ${kinds('source')} source pads (project summary), ${kinds('destination')} building-entrance pads, ${kinds('gate')} gate pads, ${kinds('junction')} path-junction pads. The count is an output of \`tools/gen-pads.mjs\`, not a target.

| ID | Name | Kind | Serves | Node | Lat, lon | Status |
| --- | --- | --- | --- | ---: | --- | --- |
${campus.pads.map(p => `| \`${p.id}\` | ${esc(p.name)} | ${p.kind} | ${esc((p.serves || []).map(id => campus.destination(id)?.name).join(', ') || '—')}${p.shared ? ' (shared entrance)' : ''} | ${p.node} | ${p.ll[0].toFixed(6)}, ${p.ll[1].toFixed(6)} | proposed, inspection pending |`).join('\n')}

Shared candidates: ${campus.pads.filter(p => p.shared).map(p => `${p.name} serves ${p.serves.map(id => campus.destination(id).name).join(' and ')} because they share entrance node ${p.node}; it counts as one physical site and can be split after inspection.`).join(' ') || 'none.'}

## Required scenarios

| Group | Origin | Destination | Total walk m | Guided m | Unguided m | Planned coverage | Legs | Pads used | Handoffs (wait) | Result / reason |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
${rows.map(r => `| ${esc(r.group)} | ${esc(r.origin)} | ${esc(r.destination)} | ${m(r.total)} | ${m(r.guided)} | ${m(r.unguided)} | ${r.pct == null ? 'n/a' : `${r.pct.toFixed(2)}% (shown ${fmtPercent(r.pct)})`} | ${r.legs} | ${esc(r.pads)} | ${r.handoffs}${r.handoffs ? ` (${Math.round(r.waitS / 60)} min)` : ''} | ${esc(r.result)}${r.reason ? ': ' + esc(r.reason) : ''} |`).join('\n')}

## Whole-network matrix

Every pad and every destination entrance (${origins.size} origins) to every destination (${campus.destinations.length}): **${q} trips qualify**, ${here} are already at the destination, **${un} do not qualify**. Lowest planned coverage among qualifying trips: ${minPct.toFixed(2)}%.
${failures.length ? `\nTrips that do not qualify (each shows the planner's own diagnosis):\n\n${failures.map(f => `- ${esc(f)}`).join('\n')}\n` : ''}
## Before and after (from the Main Gate)

The previous planner used only the six source pads and chose the pad nearest the destination, so a visitor walked alone to that pad first. The screenshot that accompanied the edit request was not available in this session, so its destination is not guessed; the app's own earlier preview, **Main Gate → Gazebo**, showed exactly that pattern and appears in the table.

| Destination | Before: pad | Before: unguided m | Before: guided m | Before: coverage | After: legs | After: unguided m | After: guided m | After: coverage |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${compare.map(x => `| ${esc(x.d)} | ${x.old ? esc(x.old.pad) : '—'} | ${x.old ? m(x.old.transfer) : '—'} | ${x.old ? m(x.old.guided) : '—'} | ${x.old ? fmtPercent(x.old.cov.percent) : '—'} | ${x.now.legs?.length ?? 0} | ${m(x.now.coverage?.unguidedM)} | ${m(x.now.coverage?.guidedM)} | ${x.now.availability === 'available' ? fmtPercent(x.now.coverage.percent) : 'unavailable'} |`).join('\n')}

Before: ${compare.filter(x => x.old?.cov.meets).length} of ${compare.length} destinations from the gate reached 95%. After: ${compare.filter(x => x.now.availability === 'available').length} of ${compare.length}.

## Still needed before live use

- Inspect every proposed site (outdoor entrance areas, clearance of about ${CONFIG.padClearanceM} m × ${CONFIG.padClearanceM} m, overhead obstructions, pedestrian flow) and record approval in \`data/pads.v1.json\`.
- Staff handoff pads (battery swap crew) or add aircraft with acknowledged handovers; the planner reads availability and handoff support from the ground station.
- Measure endurance and replace the provisional ${CONFIG.legLimitM} m leg and ${CONFIG.enduranceBudgetS} s budget; re-run \`tools/gen-pads.mjs\` and this report.
- Add footpath/road classification so legs avoid carriageways.
`;
fs.mkdirSync(ROOT + 'docs', { recursive: true });
fs.writeFileSync(ROOT + 'docs/coverage-report.md', md);
const csv = ['group,origin,destination,total_m,guided_m,unguided_m,planned_coverage_pct,legs,pads,handoffs,result,reason', ...rows.map(r => [r.group, r.origin, r.destination, r.total?.toFixed(1) ?? '', r.guided?.toFixed(1) ?? '', r.unguided?.toFixed(1) ?? '', r.pct?.toFixed(4) ?? '', r.legs, r.pads, r.handoffs, r.result, r.reason].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
fs.writeFileSync(ROOT + 'docs/coverage-report.csv', csv + '\n');
console.log(`rows ${rows.length}; matrix ${q} qualify, ${here} at destination, ${un} do not; before ${compare.filter(x => x.old?.cov.meets).length}/${compare.length}, after ${compare.filter(x => x.now.availability === 'available').length}/${compare.length}`);
