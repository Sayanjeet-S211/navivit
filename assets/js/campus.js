// NAVI — campus map, live route planner, destination chart and leg-limit calculator.
import { loadCampus, metres } from './graph.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const titleCase = s => s.replace(/(^|\s)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
export const fmtT = s => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
const C = { gate: '#8f7ff0', pad: '#22a37b', mint: '#95e5c9', gold: '#edc18a', coral: '#f08a8a', line: '#3a535d', text: '#e8f0ed', muted: '#9cafb5' };

let G, state = { dest: null, origin: 'pad' };

export async function initCampus() {
  G = await loadCampus();
  G.dests.forEach(d => { d.label = titleCase(d.name); });
  state.dest = G.dests.find(d => d.name === 'Gazebo') || G.dests[0];
  buildMap();
  buildPlanner();
  buildChart();
  buildCalculator();
  buildTables();
  select(state.dest.name);
}

/* ---------------- Map ---------------- */
let proj, scale;
function buildMap() {
  const svg = $('#campus-map');
  const pts = [...G.D.boundary, ...G.D.nodes.map(n => [n[1], n[2]])].map(G.xy);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const pad = 60, minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const W = 760; scale = W / (maxX - minX); const H = Math.round((maxY - minY) * scale);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  proj = ll => { const [x, y] = G.xy(ll); return [((x - minX) * scale).toFixed(1), ((maxY - y) * scale).toFixed(1)]; };
  const P = ll => proj(ll).join(',');
  const boundary = G.D.boundary.map(P).join(' ');
  const grid = []; for (let gx = Math.ceil(minX / 100) * 100; gx < maxX; gx += 100) grid.push(`<line x1="${((gx - minX) * scale).toFixed(1)}" y1="0" x2="${((gx - minX) * scale).toFixed(1)}" y2="${H}"/>`);
  for (let gy = Math.ceil(minY / 100) * 100; gy < maxY; gy += 100) grid.push(`<line x1="0" y1="${((maxY - gy) * scale).toFixed(1)}" x2="${W}" y2="${((maxY - gy) * scale).toFixed(1)}"/>`);
  const edges = G.edges.map(([a, b]) => `M${P(G.N[a])}L${P(G.N[b])}`).join('');
  const risk = G.riskNodes.map(id => { const [x, y] = proj(G.N[id]); return `<circle cx="${x}" cy="${y}" r="2.6"><title>Node ${id} · ${G.fenceDist(G.N[id]).toFixed(1)} m from the boundary</title></circle>`; }).join('');
  const dests = G.dests.flatMap(d => d.ents.map(e => { const [x, y] = proj(G.N[e]); return `<circle class="ent" data-dest="${esc(d.name)}" cx="${x}" cy="${y}" r="4" tabindex="0" role="button" aria-label="${esc(d.label)}"><title>${esc(d.label)} · ${esc(d.cat)}</title></circle>`; })).join('');
  const pads = G.pads.map((p, i) => { const [x, y] = proj(p.pos); return `<g class="pad" data-pad="${p.id}" transform="translate(${x},${y})"><rect x="-8" y="-8" width="16" height="16" rx="3"/><text y="4">${i + 1}</text><title>${esc(p.name)} · node ${p.id}</title></g>`; }).join('');
  const bar = 100 * scale;
  svg.innerHTML = `
    <g stroke="#16252c" stroke-width="1">${grid.join('')}</g>
    <polygon points="${boundary}" fill="none" stroke="${C.coral}" stroke-opacity=".07" stroke-width="${(80 * scale).toFixed(1)}" stroke-linejoin="round"/>
    <polygon points="${boundary}" fill="rgba(149,229,201,.025)" stroke="${C.coral}" stroke-width="1.4" stroke-dasharray="6 5"/>
    <path d="${edges}" fill="none" stroke="${C.line}" stroke-width="1.8" stroke-linecap="round"/>
    <g fill="${C.gold}" opacity=".85">${risk}</g>
    <path id="cm-route" fill="none" stroke="${C.mint}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <g id="cm-legs"></g>
    <g fill="#0c171d" stroke="${C.text}" stroke-width="1.6" style="cursor:pointer">${dests}</g>
    <g id="cm-sel"></g>
    <g fill="#272923" stroke="${C.gold}" stroke-width="1.4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">${pads}</g>
    <g font-family="Consolas,monospace" font-size="10" fill="${C.muted}">
      <line x1="20" y1="${H - 22}" x2="${(20 + bar).toFixed(1)}" y2="${H - 22}" stroke="${C.text}" stroke-width="1.5"/>
      <line x1="20" y1="${H - 26}" x2="20" y2="${H - 18}" stroke="${C.text}"/><line x1="${(20 + bar).toFixed(1)}" y1="${H - 26}" x2="${(20 + bar).toFixed(1)}" y2="${H - 18}" stroke="${C.text}"/>
      <text x="20" y="${H - 30}">100 m</text>
      <g transform="translate(${W - 26},28)"><path d="M0 -14 L6 6 L0 2 L-6 6 Z" fill="${C.text}"/><text y="20" text-anchor="middle">N</text></g>
    </g>`;
  $$('.pad text', svg).forEach(t => { t.setAttribute('fill', C.gold); t.setAttribute('stroke', 'none'); });
  svg.addEventListener('click', e => { const c = e.target.closest('.ent'); if (c) select(c.dataset.dest); });
  svg.addEventListener('keydown', e => { const c = e.target.closest('.ent'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(c.dataset.dest); } });
  $('#map-cap').textContent = `${G.D.nodes.length} FLIGHT-GRAPH NODES · ${G.edges.length} SEGMENTS (${G.networkKm.toFixed(2)} km) · ${G.riskNodes.length} INSIDE NODES < 25 m FROM THE OSM EDGE`;
}

function drawRoute(r) {
  const svg = $('#campus-map');
  $('#cm-route', svg).setAttribute('d', 'M' + r.coords.map(c => proj(c).join(',')).join('L'));
  $('#cm-route', svg).setAttribute('stroke', state.origin === 'gate' ? C.gate : C.mint);
  // Leg breaks (only when a route needs more than one leg).
  $('#cm-legs', svg).innerHTML = r.legs.length > 1 ? r.legs.slice(1).map((l, i) => {
    const [x, y] = proj(G.N[l.nodes[0]]);
    return `<g transform="translate(${x},${y})"><circle r="7" fill="#0c171d" stroke="${C.gold}" stroke-width="2"/><text y="3.5" font-family="Consolas,monospace" font-size="9" text-anchor="middle" fill="${C.gold}">${i + 2}</text><title>Leg ${i + 2} starts here (node ${l.nodes[0]})</title></g>`;
  }).join('') : '';
  const d = state.dest, [x, y] = proj(G.N[state.origin === 'gate' ? d.gateEnt : d.ent]);
  const anchor = +x > 560 ? 'end' : 'start', dx = anchor === 'end' ? -12 : 12;
  $('#cm-sel', svg).innerHTML = `<circle cx="${x}" cy="${y}" r="9" fill="none" stroke="${C.mint}" stroke-width="2"/><text x="${+x + dx}" y="${+y - 10}" text-anchor="${anchor}" font-family="Consolas,monospace" font-size="11" fill="${C.text}" paint-order="stroke" stroke="#0c171d" stroke-width="4">${esc(d.label.toUpperCase())}</text>`;
  $$('.pad', svg).forEach(g => g.setAttribute('opacity', +g.dataset.pad === (state.origin === 'gate' ? G.GATE : d.pad.id) ? 1 : 0.55));
}

/* ---------------- Planner ---------------- */
function buildPlanner() {
  const sel = $('#dest-select');
  sel.innerHTML = G.dests.map(d => `<option value="${esc(d.name)}">${esc(d.label)} · ${esc(d.cat)}</option>`).join('');
  sel.addEventListener('change', () => select(sel.value));
  $$('[data-origin]').forEach(b => b.addEventListener('click', () => {
    state.origin = b.dataset.origin;
    $$('[data-origin]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    select(state.dest.name);
  }));
}

export function select(name) {
  const d = G.dests.find(x => x.name === name); if (!d) return;
  state.dest = d;
  $('#dest-select').value = d.name;
  const r = G.route(d, state.origin);
  drawRoute(r);
  const lim = G.D.legLimit, walk = r.m / G.D.walkSpeed;
  const origin = state.origin === 'gate' ? `Main gate (Gate Pad, node ${G.GATE})` : `${d.pad.name} (node ${d.pad.id})`;
  const longest = Math.max(...r.legs.map(l => l.m));
  const verdict = r.legs.length === 1
    ? `<span class="ok-badge yes">ONE LEG · WITHIN ${lim} m</span>`
    : `<span class="ok-badge no">${r.legs.length} LEGS · BATTERY SWAP AT EACH BREAK</span>`;
  $('#route-out').innerHTML = `
    <div class="route-head"><div><span class="label">Route length</span><div class="readout" style="font-size:52px">${Math.round(r.m)}<small>m</small></div></div>${verdict}</div>
    <dl class="kv" style="margin-top:4px">
      <dt>Launch from</dt><dd>${esc(origin)}</dd>
      <dt>Destination entrance</dt><dd>node ${state.origin === 'gate' ? d.gateEnt : d.ent}</dd>
      <dt>Graph nodes on route</dt><dd>${r.nodes.length}</dd>
      <dt>Legs · longest leg</dt><dd>${r.legs.length} · ${Math.round(longest)} m</dd>
      <dt>Walking time at ${G.D.walkSpeed} m/s</dt><dd>${fmtT(walk)}</dd>
      <dt>With 15% stop allowance</dt><dd>${fmtT(walk * 1.15)}</dd>
    </dl>
    <div class="leg-viz">${r.legs.map((l, i) => `
      <div class="lv-row"><span class="label"><span>Leg ${i + 1}</span><span>${Math.round(l.m)} / ${lim} m</span></span>
      <div class="lv-track"><i style="width:${Math.min(100, l.m / lim * 100).toFixed(1)}%;background:${l.m > lim ? C.coral : state.origin === 'gate' ? C.gate : C.pad}"></i></div></div>`).join('')}
    </div>
    <p class="fine" style="margin:10px 0 0">${state.origin === 'gate'
      ? `From the gate this destination is ${Math.round(d.fromGate)} m. With the pads, ${esc(d.pad.name)} reaches it in ${Math.round(d.fromPad)} m.`
      : `Shortest path over the flight graph from the nearest pad to the nearest entrance (Haversine, Dijkstra). From the main gate it would be ${Math.round(d.fromGate)} m.`}</p>`;
  $$('#dest-chart .dest-row').forEach(g => g.classList.toggle('sel', g.dataset.dest === d.name));
}

/* ---------------- Chart: from gate vs from nearest pad ---------------- */
function buildChart() {
  const host = $('#dest-chart'), tip = $('#chart-tip');
  const rows = [...G.dests].sort((a, b) => b.fromGate - a.fromGate);
  const inGate = G.dests.filter(d => d.fromGate <= G.D.legLimit).length;
  $('#chart-title').textContent = `From the gate, only ${inGate} of ${G.dests.length} destinations fit in one leg.`;
  const render = () => {
    const W = Math.max(320, host.clientWidth), narrow = W < 560;
    const L = narrow ? 128 : 190, Rr = 16, T = 22, rowH = narrow ? 18 : 17, H = T + rows.length * rowH + 26;
    const max = 1300, x = v => L + (v / max) * (W - L - Rr);
    const ticks = [0, 250, 500, 750, 1000, 1250];
    const short = s => narrow && s.length > 17 ? s.slice(0, 16) + '…' : s;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Distance to each destination from the main gate and from its nearest launch pad">
      <g font-size="10" fill="${C.muted}">${ticks.map(t => `<line x1="${x(t)}" y1="${T - 6}" x2="${x(t)}" y2="${H - 22}" stroke="#1e3139"/><text x="${x(t)}" y="${H - 8}" text-anchor="middle">${t}${t === 1250 ? ' m' : ''}</text>`).join('')}</g>
      <line x1="${x(G.D.legLimit)}" y1="${T - 12}" x2="${x(G.D.legLimit)}" y2="${H - 22}" stroke="${C.gold}" stroke-width="1.5" stroke-dasharray="4 4"/>
      <text x="${x(G.D.legLimit) + 6}" y="${T - 6}" font-size="10" fill="${C.gold}">${G.D.legLimit} m leg limit</text>
      ${rows.map((d, i) => {
        const y = T + i * rowH + rowH / 2, a = x(d.fromPad), b = x(d.fromGate);
        return `<g class="dest-row" data-dest="${esc(d.name)}" tabindex="0" role="button" aria-label="${esc(d.label)}: ${Math.round(d.fromGate)} m from the gate, ${Math.round(d.fromPad)} m from ${esc(d.pad.name)}">
          <rect class="hit" x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>
          <text x="${L - 10}" y="${y + 3.5}" text-anchor="end" font-size="${narrow ? 10 : 11}" fill="${C.text}">${esc(short(d.label))}</text>
          <line x1="${a}" y1="${y}" x2="${b}" y2="${y}" stroke="#4a6168" stroke-width="2"/>
          <circle cx="${b}" cy="${y}" r="4.5" fill="${C.gate}" stroke="#111e25" stroke-width="2"/>
          <circle cx="${a}" cy="${y}" r="4.5" fill="${C.pad}" stroke="#111e25" stroke-width="2"/>
        </g>`;
      }).join('')}
    </svg>`;
    $$('.dest-row', host).forEach(g => g.classList.toggle('sel', g.dataset.dest === state.dest?.name));
  };
  render();
  new ResizeObserver(() => render()).observe(host);
  const show = (g, ev) => {
    const d = G.dests.find(x => x.name === g.dataset.dest);
    tip.innerHTML = `<b>${esc(d.label)}</b><span>From main gate <em>${Math.round(d.fromGate)} m · ${Math.ceil(d.fromGate / G.D.legLimit) || 1} leg${d.fromGate > G.D.legLimit ? 's' : ''}</em></span><span>From ${esc(d.pad.name)} <em>${Math.round(d.fromPad)} m</em></span><span>Walk at 0.8 m/s <em>${fmtT(d.fromPad / 0.8)}</em></span>`;
    tip.hidden = false;
    const card = host.closest('.chart-card').getBoundingClientRect();
    const r = g.getBoundingClientRect();
    const left = Math.min(card.width - 210, Math.max(10, (ev?.clientX ?? r.left + r.width / 2) - card.left + 14));
    tip.style.left = left + 'px';
    tip.style.top = (r.top - card.top - 8 - tip.offsetHeight) + 'px';
  };
  host.addEventListener('pointermove', e => { const g = e.target.closest('.dest-row'); if (g) show(g, e); else tip.hidden = true; });
  host.addEventListener('pointerleave', () => { tip.hidden = true; });
  host.addEventListener('focusin', e => { const g = e.target.closest('.dest-row'); if (g) show(g); });
  host.addEventListener('focusout', () => { tip.hidden = true; });
  host.addEventListener('click', e => { const g = e.target.closest('.dest-row'); if (g) { select(g.dataset.dest); $('#campus-map').scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
  host.addEventListener('keydown', e => { const g = e.target.closest('.dest-row'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(g.dataset.dest); } });
}

/* ---------------- Leg-limit calculator ---------------- */
function buildCalculator() {
  const u = $('#c-usable'), s = $('#c-speed'), h = $('#c-hes');
  const routes = [[316, 'Longest pad leg'], [350, 'Working limit'], [460, ''], [600, ''], [700, '']];
  const update = () => {
    const U = +u.value, V = +s.value, H = +h.value / 100;
    $('#o-usable').textContent = U.toFixed(1) + ' min';
    $('#o-speed').textContent = V.toFixed(2) + ' m/s';
    $('#o-hes').textContent = Math.round(H * 100) + '%';
    const raw = V * U * 60 / (1 + H), dmax = Math.floor(raw / 5) * 5;
    $('#c-out').innerHTML = `${dmax}<small>m</small>`;
    $('#c-formula').innerHTML = `d<sub>max</sub> = <b>${V.toFixed(2)}</b> m/s × <b>${U.toFixed(1)}</b> min × 60 ÷ (1 + <b>${H.toFixed(2)}</b>) = <b>${raw.toFixed(1)} m</b> → ${dmax} m`;
    const byPad = G.dests.filter(d => d.fromPad <= dmax).length, byGate = G.dests.filter(d => d.fromGate <= dmax).length, n = G.dests.length;
    $('#c-cover').innerHTML = `
      <div class="leg-viz">
        <div class="lv-row"><span class="label"><span>With the six pads</span><span>${byPad} / ${n} in one leg</span></span><div class="lv-track"><i style="width:${byPad / n * 100}%;background:${C.pad}"></i></div></div>
        <div class="lv-row"><span class="label"><span>From the main gate only</span><span>${byGate} / ${n}</span></span><div class="lv-track"><i style="width:${byGate / n * 100}%;background:${C.gate}"></i></div></div>
      </div>
      <p class="fine" style="margin:6px 0 0">${byPad === n ? 'Every destination stays a single leg from its nearest pad.' : `<b class="gold">${n - byPad} destination${n - byPad > 1 ? 's' : ''} would need a second leg</b> — the set cover must be re-run with the measured endurance.`}</p>`;
    $('#c-table tbody').innerHTML = routes.map(([m, note]) => {
      const need = sp => m / sp * (1 + H) / 60;
      const ok = sp => need(sp) <= U;
      const v = ok(V) ? ['yes', `OK at ${V.toFixed(2)} m/s`] : ok(1.0) ? ['mid', 'OK at 1.0 m/s'] : ok(1.3) ? ['mid', 'Brisk only'] : ['no', 'Not feasible'];
      return `<tr><td><b>${m} m</b>${note ? `<small>${note}</small>` : ''}</td>${[0.8, 1.0, 1.3].map(sp => `<td class="num ${ok(sp) ? '' : 'muted'}">${need(sp).toFixed(1)} min</td>`).join('')}<td><span class="ok-badge ${v[0]}">${v[1].toUpperCase()}</span></td></tr>`;
    }).join('');
  };
  [u, s, h].forEach(el => el.addEventListener('input', update));
  update();
}

/* ---------------- Tables ---------------- */
function buildTables() {
  $('#pad-body').innerHTML = G.pads.map((p, i) => {
    const served = G.dests.filter(d => d.pad.id === p.id);
    const far = served.reduce((a, d) => d.fromPad > (a?.fromPad ?? -1) ? d : a, null);
    return `<tr><td><b>${i + 1} · ${esc(p.name)}</b>${far ? `<small>Farthest: ${esc(far.label)}, ${Math.round(far.fromPad)} m</small>` : ''}</td><td class="num">${p.id}</td><td class="num">${p.pos[0].toFixed(6)}</td><td class="num">${p.pos[1].toFixed(6)}</td><td class="num">${served.length}</td></tr>`;
  }).join('');
  const m = $('#pad-matrix');
  if (m) {
    const short = n => n.replace(' Pad', '').replace('North-West', 'NW');
    m.innerHTML = `<thead><tr><th></th>${G.pads.map(p => `<th>${esc(short(p.name))}</th>`).join('')}</tr></thead><tbody>${G.pads.map(a => `<tr><th style="text-align:left">${esc(short(a.name))}</th>${G.pads.map(b => {
      const d = metres(a.pos, b.pos);
      return `<td class="${a === b ? 'z' : d > G.D.legLimit ? 'hot' : ''}">${a === b ? '—' : Math.round(d)}</td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
  }
}

export const campusReady = () => loadCampus();
