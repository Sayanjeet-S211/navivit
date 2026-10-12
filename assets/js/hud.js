// NAVI — simulated ground-station HUD. A real campus route, a proposed pacing controller
// and the designed failsafe responses. Nothing here is flight data.
import { loadCampus, metres } from './graph.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titleCase = s => s.replace(/(^|\s)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtT = s => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
const stamp = s => `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Proposed pacing thresholds (symbolic until phone error is measured).
const P = { LEAD: 15, HOLD: 22, RESUME: 17, STALE: 30, ALT: 15, CLIMB: 1.5, SINK: 0.8, VMAX: 3, WALK: 0.8, GPS_EKF: 6, GCS_TIMEOUT: 10 };
const CAP = 3300, RESERVE = 0.25;
const MODES = ['AUTO', 'GUIDED', 'LOITER', 'RTL', 'LAND', 'MANUAL'];
const SAFETY = ['SAFE', 'WARNING', 'HOLD', 'RETURN_TO_LAUNCH', 'EMERGENCY'];
const SAFETY_CLASS = { SAFE: '', WARNING: 'warn', HOLD: 'hold', RETURN_TO_LAUNCH: 'rtl', EMERGENCY: 'emerg' };
const FAULTS = [
  { id: 'stop', label: 'Visitor stops', toggle: true },
  { id: 'delay', label: 'Visitor slows down', toggle: true },
  { id: 'stale', label: 'Phone position stale', toggle: true },
  { id: 'gps', label: 'GPS fix lost', toggle: true },
  { id: 'telem', label: 'Telemetry link lost', toggle: true },
  { id: 'rc', label: 'RC link lost', toggle: true },
  { id: 'batt', label: 'Battery below reserve', toggle: false },
  { id: 'fence', label: 'Geofence breach (gust)', toggle: false },
  { id: 'manual', label: 'Operator takeover', toggle: true }
];
const OCV = [[0, 3.3], [0.05, 3.5], [0.1, 3.62], [0.2, 3.7], [0.5, 3.82], [0.8, 3.98], [1, 4.2]];
const ocv = soc => { for (let i = 1; i < OCV.length; i++) if (soc <= OCV[i][0]) { const [a, va] = OCV[i - 1], [b, vb] = OCV[i]; return va + (vb - va) * (soc - a) / (b - a); } return 4.2; };

let G, route, S, speedMul = 4, visible = false, lastFrame = 0, lastPaint = 0, lastHist = 0;
const hist = { alt: [], spd: [], cur: [] };

export async function initHud() {
  G = await loadCampus();
  const opts = G.dests.filter(d => d.fromPad >= 40).sort((a, b) => a.fromPad - b.fromPad);
  $('#sim-dest').innerHTML = opts.map(d => `<option value="${esc(d.name)}">${esc(titleCase(d.name))} · ${esc(d.pad.name)} → ${Math.round(d.fromPad)} m</option>`).join('');
  $('#sim-dest').value = 'Gazebo';
  $('#mode-chips').innerHTML = MODES.map(m => `<span class="mode-chip" data-m="${m}">${m}</span>`).join('');
  $('#safety-chips').innerHTML = SAFETY.map(m => `<span class="mode-chip" data-s="${m}">${m}</span>`).join('');
  $('#faults').innerHTML = FAULTS.map(f => `<button class="btn" data-fault="${f.id}" ${f.toggle ? 'aria-pressed="false"' : ''} disabled>${f.label}</button>`).join('');
  $('.sats', $('#g-gps')).innerHTML = Array.from({ length: 16 }, () => '<i></i>').join('');
  $('#sim-dest').addEventListener('change', reset);
  $('#sim-reset').addEventListener('click', reset);
  $('#sim-run').addEventListener('click', () => {
    if (S.phase === 'IDLE') start();
    else if (S.phase === 'LANDED') { reset(); start(); }
    else { S.paused = !S.paused; paintControls(); }
  });
  $$('.seg [data-speed]').forEach(b => b.addEventListener('click', () => {
    speedMul = +b.dataset.speed;
    $$('.seg [data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#faults').addEventListener('click', e => { const b = e.target.closest('[data-fault]'); if (b && !b.disabled) inject(b.dataset.fault); });
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe($('#console'));
  reset();
  requestAnimationFrame(loop);
}

/* ---------------- Mission setup ---------------- */
function reset() {
  const d = G.dests.find(x => x.name === $('#sim-dest').value) || G.dests[0];
  const r = G.route(d, 'pad');
  // Rotate the local metric frame so the route runs left to right (north arrow shows the rotation).
  const raw = r.coords.map(G.xy), first = raw[0], last = raw.at(-1);
  const rot = -Math.atan2(last[1] - first[1], last[0] - first[0]);
  const pts = raw.map(([x, y]) => [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
  const cum = [0];
  for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + metres(r.coords[i - 1], r.coords[i]));
  route = { dest: d, name: titleCase(d.name), pad: d.pad.name, pts, cum, rot, L: cum[cum.length - 1], nodes: r.nodes.length };
  S = {
    t: 0, phase: 'IDLE', paused: false, armed: false, sa: 0, alt: 0, va: 0, xt: 0, xtTarget: 0,
    sv: -3, vv: 0, vEst: 0, sEst: -3, lastSample: 0, lastAccepted: null, samples: [], rejected: 0, acc: 9,
    mAh: 0, I: 0.6, V: 12.6, sats: 13, hdop: 0.8, linkQ: 98,
    faults: Object.fromEntries(FAULTS.map(f => [f.id, false])), timers: {}, stillFor: 0, hold: null,
    rtlTarget: 0, rtlName: 'origin pad', breached: false, safety: 'SAFE', mode: 'GUIDED'
  };
  hist.alt.length = hist.spd.length = hist.cur.length = 0;
  $('#sim-log').innerHTML = '';
  log(`Route ready: ${route.pad} → ${route.name} · ${Math.round(route.L)} m · ${route.nodes} surveyed nodes · 1 leg`);
  drawRouteBase();
  paintControls();
  paint(true);
}

function start() {
  S.phase = 'PREFLIGHT'; S.timers.pre = 0;
  log('Waypoints whitelisted (all surveyed nodes) · geofence check passed', 'ok');
  log('Mission uploaded over MAVLink · SiK 433 MHz');
  paintControls();
}

function log(msg, cls = '') {
  const el = $('#sim-log');
  el.insertAdjacentHTML('beforeend', `<div class="${cls}"><span>${stamp(S.t)}</span><span>${esc(msg)}</span></div>`);
  while (el.children.length > 80) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

function inject(id) {
  const f = FAULTS.find(x => x.id === id);
  if (f.toggle) S.faults[id] = !S.faults[id];
  const on = S.faults[id];
  switch (id) {
    case 'stop': log(on ? 'Injected: visitor stops walking' : 'Visitor walking again', on ? 'w' : 'ok'); break;
    case 'delay': log(on ? 'Injected: visitor slows to 0.4 m/s' : 'Visitor back to 0.8 m/s', on ? 'w' : 'ok'); break;
    case 'stale': log(on ? 'Injected: phone stops reporting (screen locked)' : 'Phone position samples resumed', on ? 'w' : 'ok'); if (on) S.timers.staleSince = S.t; break;
    case 'gps': log(on ? 'Injected: GPS fix lost — EKF variance rising' : 'GPS 3D fix restored', on ? 'e' : 'ok'); S.timers.gpsSince = S.t; break;
    case 'telem': log(on ? 'Injected: SiK telemetry link lost' : 'Telemetry link restored', on ? 'e' : 'ok'); S.timers.telemSince = S.t; break;
    case 'rc': log(on ? 'Injected: RC link lost (FS-i6X out of range)' : 'RC link restored', on ? 'e' : 'ok'); break;
    case 'manual': log(on ? 'Operator takeover — switch to MANUAL' : 'Operator hands back to NAVI', on ? 'w' : 'ok'); break;
    case 'batt': {
      const target = RESERVE - 0.02;
      S.mAh = Math.max(S.mAh, CAP * (1 - target));
      log('Injected: battery below 25% reserve', 'e');
      break;
    }
    case 'fence': S.xtTarget = 46; S.timers.fence = S.t; log('Injected: gust pushes aircraft off the corridor', 'w'); break;
  }
  paintControls();
}

/* ---------------- Simulation ---------------- */
const flying = () => ['TAKEOFF', 'LEAD', 'HOLD', 'ARRIVE', 'RTL', 'MANUAL'].includes(S.phase);

function step(dt) {
  S.t += dt;
  const f = S.faults, soc = 1 - S.mAh / CAP;

  // Visitor: walks toward the destination, never far past the aircraft.
  const walking = ['LEAD', 'HOLD', 'ARRIVE', 'MANUAL'].includes(S.phase) && S.sa > 5 && S.phase !== 'RTL';
  let vTarget = walking ? (f.stop ? 0 : f.delay ? 0.4 : P.WALK) * (1 + 0.08 * Math.sin(S.t / 3.1)) : 0;
  if (S.sa - S.sv < 6) vTarget = Math.min(vTarget, Math.max(0, (S.sa - S.sv - 3) * 0.25));
  if (S.sv >= route.L - 2) vTarget = 0;
  S.vv += clamp(vTarget - S.vv, -0.8 * dt, 0.5 * dt);
  S.sv = Math.min(route.L, S.sv + S.vv * dt);

  // Phone samples at 1 Hz. Phone GPS error is slowly varying (a correlated bias) plus a little
  // white noise, with occasional spikes; implausible jumps are rejected before filtering.
  if (!f.stale && S.phase !== 'IDLE' && S.t - S.lastSample >= 1) {
    S.lastSample = S.t;
    S.acc = clamp(S.acc + gauss() * 0.6, 7, 13);
    S.bias = clamp(0.93 * (S.bias || 0) + gauss() * 0.7, -6, 6);
    let z = S.sv + S.bias + gauss() * 0.8;
    if (Math.random() < 0.05) z += (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 12);
    const prev = S.lastAccepted;
    const implied = prev ? Math.abs(z - prev.z) / Math.max(0.5, S.t - prev.t) : 0;
    const ok = !prev || implied < 4.0 || S.t - prev.t > 5;
    S.samples.push({ z, ok, t: S.t, xt: gauss() * 3 });
    if (S.samples.length > 10) S.samples.shift();
    if (ok) {
      S.window = (S.window || []).filter(w => S.t - w.t <= 6);
      S.window.push({ t: S.t, z });
      if (S.window.length >= 3) {
        const n = S.window.length, mt = S.window.reduce((a, w) => a + w.t, 0) / n, mz = S.window.reduce((a, w) => a + w.z, 0) / n;
        const num = S.window.reduce((a, w) => a + (w.t - mt) * (w.z - mz), 0), den = S.window.reduce((a, w) => a + (w.t - mt) ** 2, 0);
        S.vEst = clamp(0.5 * S.vEst + 0.5 * (num / den), 0, 2);
      }
      S.sEst += 0.4 * (z - S.sEst);
      S.lastAccepted = { z, t: S.t };
    } else S.rejected++;
  }
  const age = S.t - (S.lastAccepted?.t ?? S.t);
  if (age < 2) S.sEst += S.vEst * dt;

  // Sensors and links.
  const sTarget = f.gps ? 4 : 13 + Math.round(Math.sin(S.t / 9));
  S.sats += clamp(sTarget - S.sats, -2 * dt, 1 * dt);
  S.hdop = f.gps ? Math.min(9.9, S.hdop + 2 * dt) : Math.max(0.8, S.hdop - 1.5 * dt);
  S.linkQ = f.telem ? 0 : clamp(S.linkQ + gauss() * 1.5, 88, 99);
  S.xt += clamp(S.xtTarget - S.xt, -6 * dt, 12 * dt);
  if (!f.gps && S.timers.fence == null) S.xt += gauss() * 0.3 * dt - S.xt * 0.5 * dt;
  if (f.gps && flying()) S.xt += gauss() * 3 * dt;

  // Phase logic, with precedence: failsafe > geofence > stale data > pacing.
  const gap = S.sa - S.sEst;
  switch (S.phase) {
    case 'PREFLIGHT':
      S.timers.pre += dt;
      if (S.timers.pre > 2) { S.phase = 'TAKEOFF'; S.armed = true; log(`Armed · AUTO takeoff to ${P.ALT} m AGL`); }
      break;
    case 'TAKEOFF':
      S.alt = Math.min(P.ALT, S.alt + P.CLIMB * dt);
      if (S.alt >= P.ALT) { S.phase = 'LEAD'; log(`GUIDED · leading at ≈${P.LEAD} m`, 'ok'); }
      break;
  }

  if (flying() && S.phase !== 'RTL' && S.phase !== 'TAKEOFF') {
    if (f.rc) {
      if (soc < RESERVE) return emergency('RC lost with battery low — vertical auto-land');
      return startRtl('RC link lost', 0);
    }
    if (soc < RESERVE) {
      const toStart = S.sa, toEnd = route.L - S.sa;
      return startRtl('Battery below reserve — mission aborted', toEnd < toStart ? route.L : 0, toEnd < toStart ? 'destination pad' : 'origin pad');
    }
    if (f.gps && S.t - S.timers.gpsSince > P.GPS_EKF) return emergency('EKF failsafe — GPS position unusable, landing vertically');
    if (f.telem && S.t - S.timers.telemSince > P.GCS_TIMEOUT) return startRtl(`Telemetry lost > ${P.GCS_TIMEOUT} s`, 0, 'origin pad');
    if (f.stale && age > 2 * P.STALE) return startRtl(`Visitor position stale > ${2 * P.STALE} s`, 0, 'origin pad');
  }

  switch (S.phase) {
    case 'LEAD':
    case 'HOLD': {
      let reason = null;
      if (f.manual) { S.phase = 'MANUAL'; break; }
      if (f.gps) reason = 'GPS degraded — loiter';
      else if (f.telem) reason = 'Telemetry lost — loiter, waiting for link';
      else if (S.xt > 40) { reason = 'Geofence breach — halt and hold'; S.breached = true; S.xtTarget = 0; }
      else if (S.breached) reason = 'Returning inside the corridor';
      else if (f.stale && age > P.STALE) reason = `Visitor position stale > ${P.STALE} s`;
      if (S.vEst < 0.15) S.stillFor += dt; else S.stillFor = 0;
      if (!reason && S.phase === 'LEAD') {
        if (gap > P.HOLD) reason = `Visitor behind (${gap.toFixed(0)} m > ${P.HOLD} m)`;
        else if (S.stillFor > 3 && S.sEst > 2) reason = 'Visitor stopped';
      }
      if (!reason && S.phase === 'HOLD' && S.hold && /Visitor/.test(S.hold) && !/stale/.test(S.hold)) {
        if (!(gap < P.RESUME && S.vEst > 0.35)) reason = S.hold;
      }
      if (reason) {
        if (S.phase !== 'HOLD' || reason !== S.hold) log(`HOLD · ${reason}`, /Visitor/.test(reason) && !/stale/.test(reason) ? '' : 'w');
        S.phase = 'HOLD'; S.hold = reason;
        S.va += clamp(0 - S.va, -1.2 * dt, 1.2 * dt);
      } else {
        if (S.phase === 'HOLD') log(`Resume LEAD · gap ${(Math.floor(gap * 10) / 10).toFixed(1)} m < ${P.RESUME} m`, 'ok');
        S.phase = 'LEAD'; S.hold = null;
        const cmd = clamp(S.vEst + 0.25 * (P.LEAD - gap), 0, P.VMAX);
        S.va += clamp(cmd - S.va, -1 * dt, 1 * dt);
      }
      if (S.breached && S.xt < 3) { S.breached = false; S.timers.fence = null; log('Back inside the surveyed corridor', 'ok'); }
      S.sa = Math.min(route.L, S.sa + S.va * dt);
      if (S.sa >= route.L - 0.3) { S.phase = 'ARRIVE'; S.va = 0; log('Over the destination pad · waiting for the visitor'); }
      break;
    }
    case 'MANUAL':
      S.va += clamp(0 - S.va, -1.5 * dt, 1.5 * dt);
      S.sa = Math.min(route.L, S.sa + S.va * dt);
      if (!f.manual) { S.phase = 'HOLD'; S.hold = 'Visitor'; }
      break;
    case 'ARRIVE':
      if (route.L - S.sv < 8) { S.phase = 'LAND'; log('Visitor arrived · LAND at destination pad'); }
      break;
    case 'LAND':
      S.alt = Math.max(0, S.alt - P.SINK * dt);
      if (S.alt <= 0) finish(`Arrived: ${route.name} · ${Math.round(route.L)} m in ${fmtT(S.t)} · battery ${Math.round((1 - S.mAh / CAP) * 100)}%`, 'ok');
      break;
    case 'RTL': {
      const dir = Math.sign(S.rtlTarget - S.sa);
      S.alt = Math.min(P.ALT, S.alt + P.CLIMB * dt);
      S.xtTarget = 0;
      if (Math.abs(S.rtlTarget - S.sa) > 0.5) { S.va = Math.min(P.VMAX, Math.abs(S.va) + 1 * dt); S.sa += dir * S.va * dt; if (Math.sign(S.rtlTarget - S.sa) !== dir) S.sa = S.rtlTarget; }
      else { S.va = 0; S.alt = Math.max(0, S.alt - P.SINK * 2 * dt); if (S.alt <= 0.05) finish(`Landed at ${S.rtlName} · mission aborted`, 'w'); }
      break;
    }
    case 'EMERGENCY':
      S.va += clamp(0 - S.va, -1.5 * dt, 1.5 * dt);
      S.sa += S.va * dt;
      S.alt = Math.max(0, S.alt - P.SINK * dt);
      if (S.alt <= 0) finish('Landed in place · operator recovers the aircraft', 'e');
      break;
  }

  // Battery: ≈14 A hover plus a little per m/s of airspeed; sag through pack resistance.
  S.I = S.armed ? (S.alt > 0.2 || S.phase === 'TAKEOFF' ? 13.6 + 1.2 * Math.abs(S.va) + gauss() * 0.4 : 4) : 0.6;
  S.mAh += S.I * dt / 3.6;
  S.V = 3 * ocv(clamp(1 - S.mAh / CAP, 0, 1)) - S.I * 0.025;

  // Derived mode and safety state.
  S.mode = { PREFLIGHT: 'AUTO', TAKEOFF: 'AUTO', LEAD: 'GUIDED', ARRIVE: 'GUIDED', HOLD: 'LOITER', LAND: 'LAND', RTL: 'RTL', EMERGENCY: 'LAND', MANUAL: 'MANUAL' }[S.phase] || S.mode;
  S.safety = S.phase === 'EMERGENCY' ? 'EMERGENCY'
    : S.phase === 'RTL' ? 'RETURN_TO_LAUNCH'
      : S.phase === 'HOLD' ? 'HOLD'
        : flying() && (f.gps || f.telem || (f.stale && age > 5) || f.manual || S.xt > 25) ? 'WARNING' : 'SAFE';
}

function startRtl(reason, target, name = 'origin pad') {
  if (S.phase === 'RTL') return;
  S.phase = 'RTL'; S.rtlTarget = target; S.rtlName = name; S.va = 0;
  log(`RTL · ${reason} → ${name}`, 'e');
}
function emergency(reason) {
  if (S.phase === 'EMERGENCY') return;
  S.phase = 'EMERGENCY';
  log(`EMERGENCY · ${reason}`, 'e');
}
function finish(msg, cls) {
  S.phase = 'LANDED'; S.armed = false; S.alt = 0; S.va = 0;
  log('Disarmed · ' + msg, cls);
  paintControls();
}

/* ---------------- Rendering ---------------- */
let frame;
function drawRouteBase() {
  const svg = $('#route-svg'), W = 900, H = 200, padX = 50, top = 28, mapH = 108;
  const xs = route.pts.map(p => p[0]), ys = route.pts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min((W - 2 * padX) / Math.max(1, maxX - minX), mapH / Math.max(1, maxY - minY));
  const ox = (W - (maxX - minX) * k) / 2, oy = top + (mapH - (maxY - minY) * k) / 2;
  frame = { k, map: ([x, y]) => [ox + (x - minX) * k, oy + (maxY - y) * k] };
  const d = 'M' + route.pts.map(p => frame.map(p).map(v => v.toFixed(1)).join(',')).join('L');
  const [sx, sy] = frame.map(route.pts[0]), [ex, ey] = frame.map(route.pts.at(-1));
  const bar = { x0: 40, x1: 860, y: 172 };
  const tick = []; for (let m = 0; m <= route.L; m += 50) { const x = bar.x0 + (bar.x1 - bar.x0) * m / route.L; tick.push(`<line x1="${x}" y1="${bar.y - 4}" x2="${x}" y2="${bar.y + 4}"/><text x="${x}" y="${bar.y + 18}" text-anchor="middle">${m}</text>`); }
  svg.innerHTML = `
    <text x="14" y="16" font-size="10" fill="#7f959d" letter-spacing="1">${esc(route.pad.toUpperCase())} → ${esc(route.name.toUpperCase())} · REAL ROUTE GEOMETRY · ${Math.round(route.L)} m</text>
    <path d="${d}" fill="none" stroke="#1f363e" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#4a6a72" stroke-width="1.5" stroke-dasharray="4 6"/>
    <path id="rs-lead" fill="none" stroke="#95e5c9" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="none" stroke="#edc18a" stroke-dasharray="3 3"><rect x="${sx - 9}" y="${sy - 9}" width="18" height="18" rx="3"/><rect x="${ex - 9}" y="${ey - 9}" width="18" height="18" rx="3"/></g>
    <g font-family="Georgia" font-size="11" fill="#edc18a" text-anchor="middle"><text x="${sx}" y="${sy + 4}">P</text><text x="${ex}" y="${ey + 4}">P</text></g>
    <g id="rs-samples"></g>
    <circle id="rs-est" r="9" fill="none" stroke="#95e5c9" stroke-width="1.2" stroke-dasharray="2 2"/>
    <g id="rs-visitor"><circle r="6.5" fill="#e8f0ed"/><text y="3.5" font-size="8" font-weight="700" text-anchor="middle" fill="#0b141a">V</text></g>
    <line id="rs-tether" stroke="#95e5c9" stroke-opacity=".5" stroke-dasharray="2 3"/>
    <g id="rs-drone">
      <line x1="-9" y1="-9" x2="9" y2="9" stroke="#c9d9dc" stroke-width="2.4"/><line x1="-9" y1="9" x2="9" y2="-9" stroke="#c9d9dc" stroke-width="2.4"/>
      <circle cx="-9" cy="-9" r="4.5" fill="#edc18a" opacity=".85"/><circle cx="9" cy="-9" r="4.5" fill="#edc18a" opacity=".85"/><circle cx="-9" cy="9" r="4.5" fill="#4a5866"/><circle cx="9" cy="9" r="4.5" fill="#4a5866"/>
      <rect x="-4" y="-4" width="8" height="8" rx="2" fill="#95e5c9"/>
    </g>
    <g transform="translate(878,48) rotate(${(-route.rot * 180 / Math.PI).toFixed(1)})"><path d="M0 -11 L5 5 L0 2 L-5 5 Z" fill="#9cafb5"/><text y="-14" font-size="9" text-anchor="middle" fill="#9cafb5">N</text></g>
    <text id="rs-msg" x="886" y="16" font-size="10" text-anchor="end" fill="#edc18a" letter-spacing="1"></text>
    <g font-size="9" fill="#55707a" stroke="#36505a">${tick.join('')}</g>
    <line x1="${bar.x0}" y1="${bar.y}" x2="${bar.x1}" y2="${bar.y}" stroke="#2a3f47" stroke-width="4" stroke-linecap="round"/>
    <rect id="rs-band" y="${bar.y - 7}" height="14" fill="rgba(237,193,138,.12)" stroke="rgba(237,193,138,.45)" stroke-dasharray="2 2"/>
    <line id="rs-bar-lead" y1="${bar.y}" y2="${bar.y}" stroke="#95e5c9" stroke-width="4" stroke-linecap="round"/>
    <circle id="rs-bar-v" cy="${bar.y}" r="5" fill="#e8f0ed"/>
    <path id="rs-bar-a" d="M0 -7 L6 4 L-6 4 Z" fill="#95e5c9"/>`;
  frame.bar = bar;
}

function at(s) {
  const { cum, pts } = route; s = clamp(s, 0, route.L);
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / Math.max(0.001, cum[i] - cum[i - 1]);
  const a = pts[i - 1], b = pts[i];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  return { p: [a[0] + dx * t, a[1] + dy * t], n: [-dy / len, dx / len] };
}
const onMap = (s, xt = 0) => { const { p, n } = at(s); return frame.map([p[0] + n[0] * xt, p[1] + n[1] * xt]); };
const setT = (el, x, y) => el.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);

function paint(force) {
  const svg = $('#route-svg'), age = S.t - (S.lastAccepted?.t ?? S.t), telemLost = S.faults.telem;
  // Route view.
  const [dx, dy] = onMap(S.sa, clamp(S.xt, -60, 60));
  setT($('#rs-drone', svg), dx, dy - S.alt * 1.2);
  $('#rs-drone', svg).style.opacity = telemLost ? 0.45 : 1;
  const [ax, ay] = onMap(S.sa);
  const tether = $('#rs-tether', svg);
  tether.setAttribute('x1', dx); tether.setAttribute('y1', dy - S.alt * 1.2); tether.setAttribute('x2', dx); tether.setAttribute('y2', dy);
  const [vx, vy] = onMap(Math.max(0, S.sv));
  setT($('#rs-visitor', svg), vx, vy);
  const [ex, ey] = onMap(clamp(S.sEst, 0, route.L));
  $('#rs-est', svg).setAttribute('cx', ex); $('#rs-est', svg).setAttribute('cy', ey);
  $('#rs-est', svg).style.opacity = S.phase === 'IDLE' ? 0 : 1;
  $('#rs-samples', svg).innerHTML = S.samples.map((s, i) => { const [x, y] = onMap(clamp(s.z, 0, route.L), s.xt); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.ok ? 2.4 : 3.2}" fill="${s.ok ? '#edc18a' : 'none'}" stroke="${s.ok ? 'none' : '#f08a8a'}" opacity="${(0.25 + 0.75 * i / S.samples.length).toFixed(2)}"/>`; }).join('');
  const a = clamp(Math.min(S.sEst, S.sa), 0, route.L), b = clamp(Math.max(S.sEst, S.sa), 0, route.L);
  let dd = '';
  if (b - a > 1 && S.alt > 1) for (let s = a; s <= b + 0.01; s += Math.max(1, (b - a) / 40)) { const [x, y] = onMap(Math.min(s, b)); dd += (dd ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1); }
  $('#rs-lead', svg).setAttribute('d', dd || 'M0 0');
  $('#rs-lead', svg).style.opacity = dd ? 1 : 0;
  const msg = telemLost ? 'TELEMETRY LOST · SHOWING SIMULATOR TRUTH' : S.phase === 'HOLD' ? 'HOLD · ' + (S.hold || '').toUpperCase() : S.phase === 'RTL' ? 'RETURNING TO ' + S.rtlName.toUpperCase() : S.phase === 'EMERGENCY' ? 'EMERGENCY LAND' : '';
  $('#rs-msg', svg).textContent = msg;
  // Progress bar with hold/resume thresholds measured from the visitor estimate.
  const { x0, x1 } = frame.bar, bx = s => x0 + (x1 - x0) * clamp(s, 0, route.L) / route.L;
  const band = $('#rs-band', svg);
  band.setAttribute('x', bx(S.sEst + P.RESUME)); band.setAttribute('width', Math.max(0, bx(S.sEst + P.HOLD) - bx(S.sEst + P.RESUME)));
  band.style.opacity = S.phase === 'IDLE' || S.phase === 'LANDED' ? 0 : 1;
  const bl = $('#rs-bar-lead', svg); bl.setAttribute('x1', bx(a)); bl.setAttribute('x2', bx(b)); bl.style.opacity = dd ? 1 : 0;
  $('#rs-bar-v', svg).setAttribute('cx', bx(Math.max(0, S.sv)));
  setT($('#rs-bar-a', svg), bx(S.sa), frame.bar.y - 11);

  // Chips.
  $$('#mode-chips .mode-chip').forEach(c => c.classList.toggle('on', S.phase !== 'IDLE' && S.phase !== 'LANDED' && c.dataset.m === S.mode));
  $$('#safety-chips .mode-chip').forEach(c => { c.className = 'mode-chip' + (c.dataset.s === S.safety ? ' on ' + SAFETY_CLASS[S.safety] : ''); });
  const arm = $('#arm-badge'); arm.textContent = S.armed ? 'ARMED' : 'DISARMED'; arm.classList.toggle('armed', S.armed);

  // Gauges.
  const spark = (el, arr, max, target) => {
    const svgEl = $('svg', el); if (!svgEl) return;
    const pts = arr.map((v, i) => `${(i / 59 * 120).toFixed(1)},${(32 - clamp(v / max, 0, 1) * 30).toFixed(1)}`).join(' ');
    svgEl.innerHTML = `${target != null ? `<line x1="0" x2="120" y1="${32 - target / max * 30}" y2="${32 - target / max * 30}" stroke="#edc18a" stroke-dasharray="3 3" stroke-width="1"/>` : ''}<polyline points="${pts}" fill="none" stroke="#95e5c9" stroke-width="1.6" stroke-linejoin="round"/>`;
  };
  const g = (id, val, unit, sub) => { const el = $(id); $('.val', el).innerHTML = `${val}<small>${unit}</small>`; $('.sub', el).textContent = sub; el.classList.toggle('stale', telemLost); return el; };
  spark(g('#g-alt', S.alt.toFixed(1), 'm', `target ${P.ALT} m AGL · ${S.phase === 'TAKEOFF' ? 'climbing' : S.alt > 0.2 && ['LAND', 'EMERGENCY'].includes(S.phase) ? 'descending' : 'level'}`), hist.alt, 20, P.ALT);
  spark(g('#g-spd', Math.abs(S.va).toFixed(2), 'm/s', `visitor ${S.vv.toFixed(2)} · est ${S.vEst.toFixed(2)}`), hist.spd, 3.5);
  spark(g('#g-cur', S.I.toFixed(1), 'A', `${Math.round(S.I * S.V)} W · ${Math.round(S.mAh)} mAh used`), hist.cur, 25);
  const soc = clamp(1 - S.mAh / CAP, 0, 1);
  const bat = g('#g-bat', S.V.toFixed(2), 'V', `${Math.round(soc * 100)}% · ${(S.V / 3).toFixed(2)} V/cell · reserve 25%`);
  $('.bar i', bat).style.width = (soc * 100).toFixed(1) + '%';
  $('.bar i', bat).style.background = soc < RESERVE ? 'var(--red)' : soc < 0.4 ? 'var(--gold)' : 'var(--mint)';
  const gps = g('#g-gps', Math.round(S.sats), 'sats', `HDOP ${S.hdop.toFixed(1)} · ${S.faults.gps ? 'NO FIX' : '3D FIX'}`);
  $$('.sats i', gps).forEach((el, i) => el.classList.toggle('on', i < Math.round(S.sats)));
  const link = $('#g-link');
  $('.val', link).innerHTML = `${Math.round(S.linkQ)}<small>%</small>`;
  $('.sub', link).textContent = `SiK ${S.faults.telem ? 'LOST' : 'ok'} · RC ${S.faults.rc ? 'LOST' : 'ok'}`;
  $('.bar i', link).style.width = S.linkQ + '%';
  $('.bar i', link).style.background = S.faults.telem ? 'var(--red)' : 'var(--mint)';

  // Visitor tracking widget.
  const gap = S.sa - S.sEst;
  $('#v-gap').innerHTML = S.phase === 'IDLE' ? `—<small>m</small>` : `${gap.toFixed(1)}<small>m</small>`;
  const ang = Math.atan2(clamp(S.xt, -60, 60), Math.max(1, gap)), len = clamp(8 + Math.abs(gap) * 0.9, 8, 26);
  const tx = Math.sin(ang) * len, ty = -Math.cos(ang) * len * Math.sign(gap || 1);
  $('#v-vec').innerHTML = `<circle r="29" fill="none" stroke="#29404a"/><circle r="15" fill="none" stroke="#1d2f36" stroke-dasharray="2 3"/>
    <line x1="0" y1="0" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="#95e5c9" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="4" fill="#95e5c9"/><circle r="4.5" fill="#e8f0ed"/>`;
  const lock = $('#v-lock');
  const lockState = S.phase === 'IDLE' ? ['WAITING', 'degraded'] : S.faults.stale ? (age > P.STALE ? ['STALE', 'stale'] : age > 5 ? ['DEGRADED', 'degraded'] : ['LOCKED', '']) : ['LOCKED', ''];
  lock.textContent = lockState[0]; lock.className = 'lock ' + lockState[1];
  $('#v-speed').textContent = `${S.vEst.toFixed(2)} m/s`;
  $('#v-acc').textContent = S.phase === 'IDLE' ? '—' : `±${S.acc.toFixed(0)} m`;
  $('#v-age').textContent = S.phase === 'IDLE' ? '—' : `${age.toFixed(1)} s ago`;
  $('#v-rej').textContent = String(S.rejected);
  $('#v-prog').textContent = `${Math.max(0, S.sv).toFixed(0)} / ${Math.round(route.L)} m`;
  $('#v-eta').textContent = S.vEst > 0.1 ? fmtT((route.L - S.sv) / S.vEst) : '—';
}

function paintControls() {
  const run = $('#sim-run');
  run.textContent = S.phase === 'IDLE' ? '▶ Start mission' : S.phase === 'LANDED' ? '↻ Fly again' : S.paused ? '▶ Resume' : '❚❚ Pause';
  const live = !['IDLE', 'LANDED', 'PREFLIGHT'].includes(S.phase);
  $$('#faults [data-fault]').forEach(b => {
    b.disabled = !live || (b.dataset.fault === 'fence' && S.timers.fence != null);
    if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(!!S.faults[b.dataset.fault]));
  });
}

function loop(now) {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000 || 0); lastFrame = now;
  if (visible && S && !S.paused && !['IDLE', 'LANDED'].includes(S.phase)) {
    const before = S.phase;
    let dt = dtReal * speedMul;
    while (dt > 0 && !['LANDED'].includes(S.phase)) { const h = Math.min(0.1, dt); step(h); dt -= h; }
    if (now - lastHist > 250) {
      lastHist = now;
      hist.alt.push(S.alt); hist.spd.push(Math.abs(S.va)); hist.cur.push(S.I);
      for (const k in hist) if (hist[k].length > 60) hist[k].shift();
    }
    if (S.phase !== before) paintControls();
  }
  if (visible && S && now - lastPaint > 1000 / 15) { lastPaint = now; paint(); }
  requestAnimationFrame(loop);
}
