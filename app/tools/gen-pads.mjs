#!/usr/bin/env node
// Generates data/pads.v1.json: the expanded, PROPOSED pad network for >= 95% guided walking.
//   node tools/gen-pads.mjs [--no-junctions]
// 1. Keeps the six source pads (Project Summary greedy cover).
// 2. Adds a candidate at the outdoor entrance node of the Guest House, VIT-SEDAXIS, every
//    academic block, every hostel and every gate entrance. One physical candidate per node:
//    destinations sharing an entrance node share a candidate (they can be split after inspection).
// 3. Adds junction candidates greedily, only where origin–destination trips would otherwise fall
//    below 95% guided walking under the 350 m per-leg limit. No count is fixed in advance.
// Every pad is "proposed: placement pending inspection"; nothing here is an approved landing site.
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Campus } from '../js/campus.js';
import { CONFIG } from '../js/config.js';

const ROOT = new URL('..', import.meta.url).pathname;
const raw = JSON.parse(fs.readFileSync(ROOT + 'data/campus.v1.json', 'utf8'));
const byNode = new Map(raw.nodes.map(n => [n.id, n]));
const dests = raw.destinations;
const degree = id => byNode.get(id).adj.length;

const pads = [];
const atNode = new Map();
const base = (p) => ({ approval: 'proposed', inspection: 'pending', support: { handoff: true, handoffNote: 'Staffed battery swap proposed; crew not yet assigned' }, ...p, lat: byNode.get(p.node).lat, lon: byNode.get(p.node).lon });
function add(p) {
  if (atNode.has(p.node)) { const q = atNode.get(p.node); for (const d of p.serves || []) if (!q.serves.includes(d)) q.serves.push(d); q.shared = q.serves.length > 1; return q; }
  const q = base(p); pads.push(q); atNode.set(p.node, q); return q;
}

// 1. source pads
for (const p of raw.pads) add({ id: p.id, name: p.name, kind: 'source', node: p.node, serves: dests.filter(d => d.entrances.includes(p.node)).map(d => d.id), meet: p.meet, placement: 'Source pad node from the project summary (greedy set cover, 350 m)', provenance: 'NAVI Project Summary §10 pad table' });

// 2. destination entrance candidates
const required = dests.filter(d => d.id === 'guest-house' || d.id === 'vit-sedaxis' || d.category === 'Hostel' || (d.category === 'Academic' && / Block\b/i.test(d.name)));
for (const d of required) for (const e of d.entrances.slice(0, 1)) {
  const shared = dests.filter(x => x.entrances.includes(e) && required.includes(x));
  add({ id: 'p-' + (shared.length > 1 ? shared.map(x => x.id.replace(/-block-hostel$/, '')).join('-') + '-block-hostel' : d.id), name: (shared.length > 1 ? shared.map(x => x.name.replace(/ Block Hostel$/, '')).join(' / ') + ' Block Hostel' : d.name) + ' pad', kind: 'destination', node: e, serves: shared.map(x => x.id), meet: `Outdoor area at the ${d.name} entrance`, placement: 'Destination entrance node (outdoor entrance area, not the building or roof)', provenance: 'Entrance node from the VIT Chennai Way Finder destination data' });
}
// gates: every entrance of the main gate and the 2nd gate
for (const d of dests.filter(x => /gate/i.test(x.name))) d.entrances.forEach((e, i) => add({ id: 'p-' + d.id + (i ? '-' + (i + 1) : ''), name: d.name + (d.entrances.length > 1 ? ` (entrance ${i + 1})` : '') + ' pad', kind: 'gate', node: e, serves: [d.id], meet: `At the ${d.name}${d.entrances.length > 1 ? ` entrance ${i + 1}` : ''}, outside the vehicle lane`, placement: 'Gate entrance node', provenance: 'Entrance node from the VIT Chennai Way Finder destination data' }));
for (const p of pads) p.shared = (p.serves || []).length > 1;

// 3. junction candidates
const doc = () => ({ schema: 'navi-pads/1', version: '2026-10-13.1', generated: 'tools/gen-pads.mjs', note: 'Proposed pads only. Placement pending inspection; no pad is approved for flight.', pads: pads.map(({ lat, lon, ...p }) => ({ ...p, lat, lon })) });
const origins = () => {
  const o = new Map();
  for (const p of pads.filter(p => p.kind !== 'junction')) o.set(p.node, p.name);
  for (const d of dests) for (const e of d.entrances) o.set(e, d.name);
  return [...o];
};
// One campus holding every candidate; unselected candidates are masked as 'unavailable', so leg
// geometry is computed once per worker. Adding a pad never removes a qualifying plan, so only
// failing trips are re-evaluated. Candidates are scored on a sample of the failing trips across
// worker threads; the chosen one is then checked against every failing trip.
const entranceNodes = new Set(dests.flatMap(d => d.entrances));
// Phase 1 considers junctions (degree ≠ 2) and destination entrances; if that stalls, phase 2 also
// considers ordinary path nodes, e.g. a node part-way along a long corridor to an isolated building.
const candidateNodes = raw.nodes.map(n => n.id).filter(id => !atNode.has(id));
const phase1 = id => degree(id) !== 2 || entranceNodes.has(id);
const entranceOf = id => dests.filter(d => d.entrances.includes(id));
const junction = id => {
  const ds = entranceOf(id);
  if (ds.length) return base({ id: 'p-' + ds[0].id + (ds[0].entrances.indexOf(id) > 0 ? '-e' + (ds[0].entrances.indexOf(id) + 1) : ''), name: ds.map(d => d.name).join(' / ') + ' pad', kind: 'destination', node: id, serves: ds.map(d => d.id), meet: `Outdoor area at the ${ds[0].name} entrance`, placement: 'Destination entrance node, added by tools/gen-pads.mjs where trips starting or ending here needed it', provenance: 'Entrance node from the VIT Chennai Way Finder destination data' });
  const jn = degree(id) !== 2;
  return base({ id: 'j-' + id, name: `${jn ? 'Junction' : 'Path'} ${id} pad`, kind: 'junction', node: id, serves: [], meet: jn ? `Beside the path junction at graph node ${id}, clear of the walkway` : `Beside the path at graph node ${id}, clear of the walkway`, placement: `${jn ? 'Path junction' : 'Existing path'} node chosen by tools/gen-pads.mjs to connect guided legs (a surveyed graph node, not an invented split point)`, provenance: 'Generated from the campus graph' });
};
const allCands = candidateNodes.map(junction);
// The evaluation campus holds the selected pads plus the candidates of the current phase.
const bigDoc = phase => ({ ...doc(), pads: [...doc().pads, ...allCands.filter(j => !atNode.has(j.node) && (phase === 2 || phase1(j.node)))] });
const candIds = new Set(allCands.map(j => j.id));
function evaluator(padsDoc) {
  const big = new Campus(raw, CONFIG, padsDoc);
  return (pairs, selectedIds) => {
    const sel = new Set(selectedIds), st = Object.fromEntries(big.pads.map(p => [p.id, !candIds.has(p.id) || sel.has(p.id) ? 'ready' : 'unavailable']));
    let unguided = 0; const fail = [];
    for (const [node, d] of pairs) {
      const pl = big.plan({ origin: { kind: 'place', ll: big.node(node).ll, nodeId: node }, destinationId: d, padStatus: st });
      if (pl.availability === 'available') unguided += pl.coverage.unguidedM; else if (pl.availability !== 'at_destination') fail.push([node, d]);
    }
    return { fail, unguided };
  };
}
if (!isMainThread) {
  const ev = evaluator(workerData.padsDoc);
  parentPort.on('message', ({ pairs, selected, cands }) => parentPort.postMessage(cands.map(id => ({ id, ...ev(pairs, [...selected, id]) })).map(r => ({ id: r.id, fails: r.fail.length, unguided: r.unguided }))));
} else {
  let evaluate = evaluator(bigDoc(1));
  const selected = [];
  const allPairs = origins().flatMap(([node]) => dests.map(d => [node, d.id]));
  var ev = evaluate(allPairs, selected);
  console.log(`without junctions: ${allPairs.length - ev.fail.length} pass or already there, ${ev.fail.length} below 95%`);
  if (!process.argv.includes('--no-junctions')) {
    let workers = Array.from({ length: 4 }, () => new Worker(new URL(import.meta.url), { workerData: { padsDoc: bigDoc(1) } }));
    const ask = (w, msg) => new Promise(r => { w.once('message', r); w.postMessage(msg); });
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let phase = 1;
    for (let iter = 0; ev.fail.length && iter < 80; iter++) {
      const sample = ev.fail.length <= 120 ? ev.fail : [...ev.fail].sort(() => rnd() - 0.5).slice(0, 120);
      const t0 = Date.now();
      const cands = allCands.filter(j => phase === 2 || phase1(j.node)).map(j => j.id).filter(id => !selected.includes(id));
      const chunks = workers.map((_, i) => cands.filter((_, k) => k % workers.length === i));
      const results = (await Promise.all(workers.map((w, i) => ask(w, { pairs: sample, selected, cands: chunks[i] })))).flat();
      results.sort((a, b) => a.fails - b.fails || a.unguided - b.unguided);
      const best = results[0];
      if (!best || best.fails >= sample.length) {
        if (phase === 2) break;
        phase = 2; console.log('phase 2: ordinary path nodes');
        workers.forEach(w => w.terminate());
        // Selected junctions are now part of doc(); rebuild with every remaining node as a candidate.
        workers = Array.from({ length: 4 }, () => new Worker(new URL(import.meta.url), { workerData: { padsDoc: bigDoc(2) } }));
        evaluate = evaluator(bigDoc(2)); iter--; continue;
      }
      selected.push(best.id); add(allCands.find(j => j.id === best.id));
      ev = evaluate(ev.fail, selected);
      console.log(`+ ${best.id}: ${ev.fail.length} trips still below 95% (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    workers.forEach(w => w.terminate());
  }
fs.writeFileSync(ROOT + 'data/pads.v1.json', JSON.stringify(doc(), null, 1) + '\n');
console.log(`wrote ${pads.length} pads (${pads.filter(p => p.kind === 'junction').length} junctions); remaining failing trips: ${ev.fail.length}`);
if (ev.fail.length) console.log(ev.fail.slice(0, 60).map(([n, d]) => `${n}→${d}`).join(', '));
fs.writeFileSync(ROOT + 'tools/.gen-pads-remaining.json', JSON.stringify(ev.fail));
}
