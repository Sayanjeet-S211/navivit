import {
  TEAM, BOM, BUDGET, DECISIONS, ALTERNATIVES, SAFETY, STATES, PRINCIPLES, PHASES,
  MEASUREMENTS, RISKS, QA, REFERENCES, PARTS, rupeeRange
} from './data.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const announce = msg => { const el = $('#announce'); if (el) el.textContent = msg; };

/* ---------------- Static, data-driven sections ---------------- */
function renderHardware() {
  let lo = 0, hi = 0;
  $('#bom-body').innerHTML = BOM.map(r => {
    if (!r.kit) { lo += r.lo; hi += r.hi; }
    const cost = r.kit ? '<span class="muted">Included in kit</span>' : rupeeRange(r.lo, r.hi) + (r.note ? `<small>${esc(r.note)}</small>` : '');
    const link = r.part ? `<button class="row-link" data-part="${r.part}" aria-label="View ${esc(r.item)} in 3D">VIEW IN 3D →</button>` : '';
    return `<tr><td><b>${esc(r.sub)}</b></td><td>${esc(r.item)}</td><td><small style="margin:0">${esc(r.role)}</small></td><td class="num">${cost}</td><td>${link}</td></tr>`;
  }).join('');
  $('#bom-total').innerHTML = `${rupeeRange(lo, hi)}<small style="font-weight:400">excl. charger, wiring, legs, 2nd pack</small>`;

  const max = 32000, pct = v => (v / max * 100).toFixed(2) + '%';
  const rows = BUDGET.configs.map(c => `
    <div class="bchart-row">
      <div class="nm">${esc(c.name)}<small>${esc(c.sub)} · ${rupeeRange(c.lo, c.hi)}</small></div>
      <div class="bchart-track" title="${esc(c.name)}: ${rupeeRange(c.lo, c.hi)}, about Rs ${c.mid.toLocaleString('en-IN')} at mid prices">
        <div class="bchart-range" style="left:${pct(c.lo)};width:${pct(c.hi - c.lo)}"></div>
        <div class="bchart-mid" style="left:${pct(c.mid)}"></div>
        <div class="bchart-pool" style="left:${pct(BUDGET.pool)}"></div>
      </div>
    </div>`).join('');
  const ticks = [0, 5000, 10000, 15000, 20000, 25000, 30000].map(v => `<span style="left:${pct(v)}">${v ? (v / 1000) + 'k' : '0'}</span>`).join('');
  $('#budget-chart').innerHTML = rows + `<div class="bchart-axis">${ticks}</div>` +
    `<p class="fine" style="margin:14px 0 0">At mid prices the supervised build lands near <b class="gold">Rs 20,000</b> and the unattended-capable build near <b class="gold">Rs 23,500</b> — inside the pool, but the high end of both ranges is not. Hence staged buying and a reserve.</p>`;

  $('#stage-list').innerHTML = BUDGET.stages.map(s => `<li><b>${esc(s.name)}</b><span>${esc(s.range)}</span><small>${esc(s.items)}</small></li>`).join('');
  $('#decisions').innerHTML = DECISIONS.map((d, i) => `<div class="card reveal"><span class="label">D${i + 1}</span><h4 style="margin-top:10px">${esc(d.k)}</h4><p>${esc(d.v)}</p></div>`).join('');
  $('#alt-body').innerHTML = ALTERNATIVES.map(([o, v, r]) => `<tr><td>${esc(o)}</td><td><span class="verdict ${v}">${esc(v)}</span></td><td>${esc(r)}</td></tr>`).join('');
}

function renderSafety() {
  const statesEl = $('#fsm-states');
  statesEl.innerHTML = STATES.map(s => `<div class="fsm-state" data-s="${s.id}"><b>${s.label.replace(/_/g, '_<wbr>')}</b><span>${esc(s.desc)}</span></div>`).join('');
  $('#safety-body').innerHTML = SAFETY.map(t => `
    <tr class="trig" data-id="${t.id}">
      <td><button class="row-link" style="font:600 13px var(--sans);color:var(--text);text-align:left;letter-spacing:0;white-space:normal" data-trig="${t.id}">${esc(t.trigger)}</button></td>
      <td>${esc(t.primary)}</td><td>${esc(t.secondary)}</td>
      <td><span class="sev ${t.sev}">${t.sev.toUpperCase()}</span></td><td><small style="margin:0">${esc(t.verify)}</small></td>
    </tr>`).join('') +
    `<tr><td><b>Wind or rain above threshold</b></td><td>Do not launch.</td><td>Checked before each trip.</td><td><span class="sev Medium">MEDIUM</span></td><td><small style="margin:0">Hover error vs wind sets the threshold</small></td></tr>`;
  const fsm = $('#fsm');
  const select = id => {
    const t = SAFETY.find(x => x.id === id);
    $$('tr.trig').forEach(tr => tr.classList.toggle('sel', tr.dataset.id === id));
    fsm.classList.add('focus');
    $$('.fsm-state', fsm).forEach(el => {
      const i = t.path.indexOf(el.dataset.s);
      el.classList.toggle('lit', i >= 0);
      el.querySelector('.step-no')?.remove();
      if (i >= 0) el.insertAdjacentHTML('beforeend', `<span class="step-no">${i + 1}</span>`);
    });
    $('#fsm-caption').innerHTML = `<b>${esc(t.trigger)}:</b> ${t.path.map(s => s.replace(/_/g, ' ')).join(' → ')}. ${esc(t.primary)} ${esc(t.secondary)}`;
  };
  $('#safety-body').addEventListener('click', e => {
    const tr = e.target.closest('tr.trig');
    if (tr) select(tr.dataset.id);
  });
  $('#principles').innerHTML = PRINCIPLES.map(p => `<li>${esc(p)}</li>`).join('');
}

function renderRoadmap() {
  $('#phases').innerHTML = PHASES.map(p => `
    <div class="phase ${p.status === 'In progress' ? 'current' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><span class="pno">${p.n}</span><span class="pill ${p.status === 'In progress' ? 'mint' : 'dim'}">${p.status.toUpperCase()}</span></div>
      <h4>${esc(p.name)}</h4><p>${esc(p.work)}</p>
      <div class="gate"><b>GATE · DEFINITION OF DONE</b>${esc(p.gate)}</div>
    </div>`).join('');
  $('#meas-body').innerHTML = MEASUREMENTS.map(([m, w], i) => `<tr><td class="mono">${i + 1}</td><td>${esc(m)}</td><td><small style="margin:0">${esc(w)}</small></td></tr>`).join('');
  $('#risk-body').innerHTML = RISKS.map(([r, d, m]) => `<tr><td><b>${esc(r)}</b></td><td>${esc(d)}</td><td><small style="margin:0">${esc(m)}</small></td></tr>`).join('');
}

function renderTeam() {
  $('#team-grid').innerHTML = TEAM.map(m => {
    const parts = PARTS.filter(p => p.owner === m.name);
    const owns = parts.length ? `<p class="fine" style="margin-top:auto;padding-top:10px;border-top:1px solid var(--line)">Owns ${parts.length} part${parts.length > 1 ? 's' : ''} in the CAD: ${parts.map(p => `<button class="row-link" data-part="${p.id}" style="font:11px var(--sans);letter-spacing:0">${esc(p.short)}</button>`).join(', ')}</p>` : '';
    return `<article class="member reveal"><span class="avatar">${m.initials}</span><h4>${esc(m.name)}</h4><span class="school">${m.school} · ${esc(m.dept.toUpperCase())}</span><span class="role">${esc(m.role)}</span><p>${esc(m.work)}</p>${owns}</article>`;
  }).join('');
  $('#qa').innerHTML = QA.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('');
  $('#ref-list').innerHTML = REFERENCES.map(([id, t, doi, pdf]) => `<li><b>${id}</b><span>${esc(t)} <a href="https://doi.org/${doi}" target="_blank" rel="noopener">doi:${doi}</a>${pdf ? ` · <a href="${encodeURI(pdf)}">PDF in repo</a>` : ''}</span></li>`).join('');
}

/* ---------------- Navigation, reveal, dialog ---------------- */
function initNav() {
  const nav = $('#site-nav'), toggle = $('#menu-toggle');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', e => { if (e.target.closest('a')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); } });
  const links = new Map($$('a', nav).map(a => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      links.forEach(a => a.classList.remove('active'));
      links.get(en.target.id)?.classList.add('active');
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
}

function initReveal() {
  const els = $$('.reveal');
  if (reduced || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }), { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  els.forEach(e => io.observe(e));
}

function initDialog() {
  const dlg = $('#sources');
  $$('[data-open-sources]').forEach(b => b.addEventListener('click', () => dlg.showModal()));
  $('#close-sources').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
}

function initPartLinks() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-part]');
    if (!b) return;
    window.naviPendingPart = b.dataset.part;
    window.dispatchEvent(new CustomEvent('navi:select-part', { detail: { id: b.dataset.part } }));
    $('#atelier').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  });
}

/* ---------------- Present mode ---------------- */
function initPresent() {
  const sections = $$('[data-tour]'), tour = $('#tour');
  let idx = 0;
  const go = i => {
    idx = Math.max(0, Math.min(sections.length - 1, i));
    sections[idx].scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    $('#tour-count').textContent = `${String(idx + 1).padStart(2, '0')} / ${String(sections.length).padStart(2, '0')} · ${sections[idx].dataset.tour}`;
    $('#tour-prev').disabled = idx === 0;
    $('#tour-next').disabled = idx === sections.length - 1;
  };
  const nearest = () => {
    let best = 0, bestD = Infinity;
    sections.forEach((s, i) => { const d = Math.abs(s.getBoundingClientRect().top - 70); if (d < bestD) { bestD = d; best = i; } });
    return best;
  };
  const exit = () => { tour.hidden = true; document.body.classList.remove('presenting'); $('#present').focus(); };
  $('#present').addEventListener('click', () => {
    if (!tour.hidden) return exit();
    tour.hidden = false; document.body.classList.add('presenting'); go(nearest()); $('#tour-next').focus();
  });
  $('#tour-next').addEventListener('click', () => go(nearest() + 1));
  $('#tour-prev').addEventListener('click', () => go(nearest() - 1));
  $('#tour-exit').addEventListener('click', exit);
  document.addEventListener('keydown', e => {
    if (tour.hidden || e.target.matches('input,select,textarea')) return;
    if (['ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); go(nearest() + 1); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(nearest() - 1); }
    else if (e.key === 'Escape') exit();
  });
}

/* ---------------- Concept: pacing schematic ---------------- */
function initPacingSchematic() {
  const svg = $('#pacing-svg'), stateEl = $('#pacing-state');
  const NS = 'http://www.w3.org/2000/svg';
  const d = 'M 80 178 C 230 178, 300 118, 470 132 S 760 192, 920 150';
  svg.innerHTML = `
    <defs><radialGradient id="shadow"><stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>
    <g stroke="#1b2e35" stroke-width="1">${Array.from({ length: 21 }, (_, i) => `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="230"/>`).join('')}</g>
    <path d="${d}" fill="none" stroke="#1f363e" stroke-width="18" stroke-linecap="round"/>
    <path id="pc-path" d="${d}" fill="none" stroke="#4a6a72" stroke-width="1.5" stroke-dasharray="4 7"/>
    <g id="pc-pads"></g>
    <path id="pc-lead" fill="none" stroke="#95e5c9" stroke-width="3" stroke-linecap="round"/>
    <text id="pc-lead-t" font-family="Consolas,monospace" font-size="12" fill="#95e5c9" text-anchor="middle">LEAD ≈ 15 m</text>
    <line id="pc-tether" stroke="#95e5c9" stroke-opacity=".5" stroke-dasharray="3 4"/>
    <ellipse id="pc-shadow" rx="22" ry="5" fill="url(#shadow)"/>
    <g id="pc-visitor"><circle r="10" fill="#e8f0ed"/><text y="4" font-family="Consolas,monospace" font-size="11" text-anchor="middle" fill="#0b141a" font-weight="700">V</text><text y="30" font-family="Consolas,monospace" font-size="10" text-anchor="middle" fill="#9cafb5" letter-spacing="1">VISITOR</text></g>
    <g id="pc-drone">
      <line x1="-16" y1="-6" x2="16" y2="6" stroke="#c9d9dc" stroke-width="3"/><line x1="-16" y1="6" x2="16" y2="-6" stroke="#c9d9dc" stroke-width="3"/>
      <ellipse cx="-16" cy="-6" rx="10" ry="3" fill="#edc18a" opacity=".85"/><ellipse cx="16" cy="6" rx="10" ry="3" fill="#edc18a" opacity=".85"/>
      <ellipse cx="-16" cy="6" rx="10" ry="3" fill="#4a5866"/><ellipse cx="16" cy="-6" rx="10" ry="3" fill="#4a5866"/>
      <rect x="-6" y="-4" width="12" height="8" rx="2" fill="#95e5c9"/>
      <text y="-18" font-family="Consolas,monospace" font-size="10" text-anchor="middle" fill="#95e5c9" letter-spacing="1">NAVI</text>
    </g>`;
  const path = $('#pc-path', svg), L = path.getTotalLength();
  const pt = s => path.getPointAtLength(Math.max(0, Math.min(L, s)));
  const pads = $('#pc-pads', svg);
  [[0, 'LAUNCH PAD'], [L, 'DESTINATION PAD']].forEach(([s, label]) => {
    const p = pt(s);
    pads.insertAdjacentHTML('beforeend', `<rect x="${p.x - 15}" y="${p.y - 15}" width="30" height="30" rx="4" fill="none" stroke="#edc18a" stroke-dasharray="3 3"/><text x="${p.x}" y="${p.y + 4}" font-family="Georgia" font-size="14" text-anchor="middle" fill="#edc18a">P</text><text x="${p.x}" y="${p.y + 34}" font-family="Consolas,monospace" font-size="10" text-anchor="middle" fill="#9cafb5" letter-spacing="1">${label}</text>`);
  });
  const PX_PER_M = 7.2, LEAD = 15 * PX_PER_M, V_WALK = 0.8 * PX_PER_M * 4.5; // 4.5x time-lapse
  const st = { t: 0, phase: 'takeoff', sv: -20, sd: 0, alt: 0, stopT: 0, stopped: false, didStop: false, wait: 0 };
  const set = (id, attrs) => { const el = $(id, svg); for (const k in attrs) el.setAttribute(k, attrs[k]); };
  const label = txt => { if (stateEl.textContent !== txt) stateEl.textContent = txt; };
  function draw() {
    const pv = pt(st.sv), pd = pt(st.sd), y = pd.y - 18 - st.alt * 62;
    set('#pc-visitor', { transform: `translate(${pv.x},${pv.y})`, opacity: st.sv < 0 ? 0.0 + Math.max(0, 1 + st.sv / 20) : 1 });
    set('#pc-drone', { transform: `translate(${pd.x},${y})` });
    set('#pc-shadow', { cx: pd.x, cy: pd.y, opacity: 0.4 + 0.6 * (1 - st.alt) });
    set('#pc-tether', { x1: pd.x, y1: y + 8, x2: pd.x, y2: pd.y - 4, opacity: st.alt > 0.2 ? 1 : 0 });
    const a = Math.max(0, st.sv), b = st.sd, show = b - a > 12 && st.alt > 0.6;
    if (show) {
      let dd = '';
      for (let s = a; s <= b; s += 6) { const p = pt(s); dd += (dd ? 'L' : 'M') + p.x.toFixed(1) + ' ' + (p.y + 18).toFixed(1); }
      set('#pc-lead', { d: dd, opacity: 1 });
      const m = pt((a + b) / 2);
      set('#pc-lead-t', { x: m.x, y: m.y + 38, opacity: 1 });
      $('#pc-lead-t', svg).textContent = st.phase === 'hold' ? 'HOLD' : `LEAD ≈ ${Math.round((b - a) / PX_PER_M)} m`;
    } else { set('#pc-lead', { opacity: 0 }); set('#pc-lead-t', { opacity: 0 }); }
  }
  function step(dt) {
    st.t += dt;
    switch (st.phase) {
      case 'takeoff':
        st.alt = Math.min(1, st.alt + dt / 1.6); label('TAKE OFF · CLIMB TO 15 m AGL');
        if (st.alt >= 1) st.phase = 'lead';
        break;
      case 'lead': {
        if (!st.didStop && st.sv > L * 0.42) { st.phase = 'hold'; st.stopT = 0; st.didStop = true; break; }
        st.sv = Math.min(L - 30, st.sv + V_WALK * dt);
        const target = st.sv + LEAD;
        st.sd = Math.min(L, st.sd + Math.max(0, Math.min(V_WALK * 1.8, (target - st.sd) * 2.2)) * dt);
        label('LEAD ≈ 15 m · AIRCRAFT PACES TO THE VISITOR');
        if (st.sd >= L - 0.5) st.phase = 'arrive';
        break;
      }
      case 'hold':
        st.stopT += dt; label('VISITOR STOPS → AIRCRAFT HOLDS (LOITER)');
        if (st.stopT > 2.6) st.phase = 'lead';
        break;
      case 'arrive':
        st.sv = Math.min(L - 30, st.sv + V_WALK * dt); label('ARRIVING · WAIT FOR THE VISITOR');
        if (st.sv >= L - 30) st.phase = 'land';
        break;
      case 'land':
        st.alt = Math.max(0, st.alt - dt / 1.6); label('LAND AT THE DESTINATION PAD');
        if (st.alt <= 0) { st.phase = 'done'; st.wait = 0; }
        break;
      case 'done':
        st.wait += dt;
        if (st.wait > 1.8) Object.assign(st, { phase: 'takeoff', sv: -20, sd: 0, alt: 0, didStop: false });
        break;
    }
  }
  if (reduced) { Object.assign(st, { phase: 'lead', sv: L * 0.3, sd: L * 0.3 + LEAD, alt: 1 }); draw(); return; }
  let visible = false, last = 0;
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) { last = performance.now(); requestAnimationFrame(loop); } }).observe(svg);
  function loop(now) {
    if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    step(dt); draw();
    requestAnimationFrame(loop);
  }
  draw();
}

/* ---------------- Software: pacing hysteresis ---------------- */
function drawHysteresis() {
  const svg = $('#hyst-svg'); if (!svg) return;
  const x = m => 56 + m / 30 * 474, LO = 186, HI = 76;
  const ticks = [0, 5, 10, 15, 17, 22, 25, 30];
  const arrow = (x0, y0, dx, dy) => `<path d="M${x0} ${y0} l${-dy * 5 - dx * 7} ${dx * 5 - dy * 7} M${x0} ${y0} l${dy * 5 - dx * 7} ${-dx * 5 - dy * 7}" stroke="currentColor" stroke-width="2" fill="none"/>`;
  svg.innerHTML = `
    <rect x="${x(17)}" y="${HI - 22}" width="${x(22) - x(17)}" height="${LO - HI + 44}" fill="rgba(237,193,138,.08)" stroke="rgba(237,193,138,.35)" stroke-dasharray="3 3"/>
    <text x="${(x(17) + x(22)) / 2}" y="${HI - 30}" text-anchor="middle" font-size="10" fill="#edc18a">hysteresis band</text>
    <line x1="${x(15)}" y1="${HI - 26}" x2="${x(15)}" y2="${LO + 18}" stroke="#95e5c9" stroke-dasharray="4 4" opacity=".7"/>
    <text x="${x(15) - 6}" y="${LO + 30}" text-anchor="end" font-size="10" fill="#95e5c9">lead target 15 m</text>
    <g color="#95e5c9"><path d="M${x(0)} ${LO} H${x(22)} V${HI}" stroke="currentColor" stroke-width="2.5" fill="none"/>${arrow(x(9), LO, 1, 0)}${arrow(x(22), (LO + HI) / 2, 0, -1)}</g>
    <g color="#f3b860"><path d="M${x(30)} ${HI} H${x(17)} V${LO}" stroke="currentColor" stroke-width="2.5" fill="none" stroke-dasharray="7 4"/>${arrow(x(26), HI, -1, 0)}${arrow(x(17), (LO + HI) / 2 + 8, 0, 1)}</g>
    <text x="${x(0) + 4}" y="${LO - 12}" font-size="11" fill="#e8f0ed">LEAD · fly at visitor pace</text>
    <text x="${x(30)}" y="${HI - 12 + 26}" text-anchor="end" font-size="11" fill="#e8f0ed">HOLD · loiter</text>
    <text x="${x(22) + 6}" y="${(LO + HI) / 2 - 6}" font-size="10" fill="#95e5c9">gap &gt; L_HOLD</text>
    <text x="${x(17) - 6}" y="${(LO + HI) / 2 + 26}" text-anchor="end" font-size="10" fill="#f3b860">gap &lt; L_RESUME</text>
    <line x1="${x(0)}" y1="${LO + 40}" x2="${x(30)}" y2="${LO + 40}" stroke="#36505a"/>
    ${ticks.map(t => `<line x1="${x(t)}" y1="${LO + 36}" x2="${x(t)}" y2="${LO + 44}" stroke="#36505a"/><text x="${x(t)}" y="${LO + 57}" text-anchor="middle" font-size="10" fill="${t === 17 || t === 22 ? '#edc18a' : '#7f959d'}">${t}</text>`).join('')}
    <text x="${x(30)}" y="${LO + 57}" dx="14" font-size="10" fill="#7f959d">m</text>`;
  svg.setAttribute('font-family', 'Consolas, monospace');
}

/* ---------------- Boot ---------------- */
renderHardware();
renderSafety();
renderRoadmap();
renderTeam();
initNav();
initDialog();
initPartLinks();
initPresent();
initPacingSchematic();
drawHysteresis();
initReveal();

import('./campus.js').then(m => m.initCampus()).catch(err => console.error('Campus module failed', err));
import('./hud.js').then(m => m.initHud()).catch(err => console.error('Telemetry module failed', err));

// The 3D module (three.js + 2.2 MB CAD) loads once the airframe section approaches.
const airframe = $('#airframe');
let cadRequested = false;
const loadCad = () => {
  if (cadRequested) return; cadRequested = true;
  import('./cad.js').then(m => m.initCad()).catch(err => {
    console.error('3D module failed', err);
    $$('.loading').forEach(l => { l.innerHTML = '<div>3D VIEW UNAVAILABLE — ' + esc(err.message || err) + '</div>'; });
  });
};
new IntersectionObserver(([en]) => { if (en.isIntersecting) loadCad(); }, { rootMargin: '1200px 0px' }).observe(airframe);
if ('requestIdleCallback' in window) requestIdleCallback(loadCad, { timeout: 4000 }); else setTimeout(loadCad, 2500);
