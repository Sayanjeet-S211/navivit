// NAVI visitor guide: controller and screens.
import { Campus } from './campus.js';
import { CONFIG, fmtDuration, fmtShort, fmtDist } from './config.js';
import { fmtPercent, coverageOf, PAD_APPROVAL_TEXT } from './journey.js';
import { haversine, bearing, cardinal } from './geo.js';
import { SampleFilter, Freshness } from './filter.js';
import { MapView } from './map.js';
import { DeviceLocation, WakeLockManager, HeadingSensor } from './sensors.js';
import { DemoProvider } from './providers/demo.js';
import { LiveProvider, DisconnectedProvider } from './providers/live.js';
import { $, $$, esc, icon, announce, settings, haptic, unlockAudio, chime, uid, ago } from './ui.js';

export const APP_VERSION = '0.2.0';
const appEl = $('#app'), sheet = $('#sheet'), overlay = $('#overlay'), hudEl = $('#hud'), bannersEl = $('#banners');
let campus, map, provider, wake, heading, device = null, offSim = null, clientFilter = null, refreshTimer = null;
const fresh = new Freshness();
const pendingAcks = new Map();
const TERMINAL = new Set(['DECLINED', 'UNAVAILABLE', 'CANCELLED']);

const S = {
  screen: 'boot', mode: settings.get('mode', 'demo'), conn: 'connecting', connError: null,
  origin: null, draft: null, locate: { status: 'idle', fix: null },
  destinationId: null, query: '', cat: 'all', favOnly: false, favorites: new Set(settings.get('favorites', [])),
  placeQuery: '', plan: null, planSource: null, planBusy: false, planError: null,
  request: null, requesting: false, idemKey: null,
  sharing: { status: 'off', error: null, sent: 0, acked: 0, rejected: 0, lastReject: null, handedOver: false },
  visitor: null, mission: null, aircraft: null, source: 'visitor', link: 'up',
  commands: new Map(), events: [], arrival: { reached: false, landed: null },
  showRaw: false, spark: [], wake: 'off', qrPad: null, layers: settings.get('layers', { network: false, nodes: false, buffer: true }),
  feedback: null, banners: [], dismissed: new Set(), staleRequests: new Set(), closedSessions: new Set(), offTrack: []
};

/* ======================================================================= boot */
async function boot() {
  applyTheme();
  try {
    const [r, rp] = await Promise.all(['data/campus.v1.json', 'data/pads.v1.json'].map(u => fetch(u, { cache: 'no-cache' })));
    if (!r.ok || !rp.ok) throw new Error('HTTP ' + (r.ok ? rp.status : r.status));
    campus = new Campus(await r.json(), CONFIG, await rp.json());
  } catch (e) {
    sheet.classList.add('full');
    sheet.innerHTML = `<div class="sheet-body error-screen"><h1>Campus data could not be loaded</h1><p class="lead">${esc(e.message)}</p><button class="btn primary" id="retry">Try again</button></div>`;
    $('#retry').addEventListener('click', () => location.reload());
    return;
  }
  map = new MapView($('#map'), campus, { onTap: onMapTap, onTileError: k => { pushEvent(`${k} tiles unavailable; showing path-only map`); setBase('path'); } });
  setBase(settings.get('mapStyle', 'path'));
  map.setLayers(S.layers);
  wake = new WakeLockManager(s => { S.wake = s; });
  heading = new HeadingSensor(() => updateHud());
  const qp = new URLSearchParams(location.search).get('pad');
  if (qp && campus.pad(qp)) S.qrPad = qp; // only a known pad id is accepted; nothing else is read from the URL
  bindGlobal();
  await setMode(S.mode, { initial: true });
  go('welcome');
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  refreshTimer = setInterval(refresh, 250);
  window.addEventListener('resize', () => { map.invalidate(); if (S.screen === 'pin') placeCrosshair(); });
  window.addEventListener('online', () => { S.online = true; render(); });
  window.addEventListener('offline', () => { S.online = false; render(); });
}

function applyTheme() {
  const t = settings.get('theme', 'system');
  const dark = t === 'dark' || (t === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { applyTheme(); });
function setBase(k) { settings.set('mapStyle', k); map.setBase(k); }

/* ============================================================ providers */
async function setMode(mode, { initial = false } = {}) {
  if (!initial) await endSession();
  provider?.destroy?.();
  S.mode = mode; settings.set('mode', mode);
  S.conn = 'connecting'; S.connError = null;
  provider = mode === 'live' ? new LiveProvider(campus) : new DemoProvider(campus, { speed: settings.get('demoSpeed', 1) });
  try {
    await provider.connect();
    S.conn = 'connected';
  } catch (e) {
    // Never fall back to simulated data: live mode without a ground station is simply disconnected.
    S.conn = 'disconnected'; S.connError = e.message;
    provider = new DisconnectedProvider(e.message);
  }
  provider.on('event', onEvent);
  refreshPads();
  provider.on('link', l => { S.link = l.state; if (l.state === 'up') fresh.mark('ground', provider.now()); render(); });
  updatePill();
  if (!initial) {
    S.notice = { text: mode === 'demo' ? 'Demo mode: the aircraft is simulated. Any previous session was ended.' : S.conn === 'connected' ? 'Connected to the ground station. Any previous session was ended.' : 'Live mode: no ground station reachable. Any previous session was ended.', until: Date.now() + 7000 };
    announce(S.notice.text, 'assertive');
    go('welcome');
  }
}

/** Pad readiness for the map's pad layer, from whichever ground station is connected. */
async function refreshPads() {
  try { const list = await provider.pads(); if (list) map.setPadStates(list); else map.setPadStates(campus.pads.map(p => ({ id: p.id, status: 'unknown', handoff: undefined }))); }
  catch { map.setPadStates(campus.pads.map(p => ({ id: p.id, status: 'unknown' }))); }
}

function updatePill() {
  const p = $('#mode-pill');
  if (S.mode === 'demo') { p.className = 'mode-pill demo'; p.textContent = 'Demo · no aircraft connected'; }
  else if (S.conn === 'connected') {
    const sim = provider.info.aircraftSource !== 'mavlink';
    p.className = 'mode-pill live'; p.textContent = sim ? 'Live · simulated aircraft' : 'Live · ground station';
  } else { p.className = 'mode-pill off'; p.textContent = 'Not connected'; }
  $('#btn-demo').hidden = S.mode !== 'demo';
  $('#btn-shield').hidden = S.conn !== 'connected';
}

function onEvent(ev) {
  if (ev.sessionId && S.closedSessions.has(ev.sessionId)) return;
  fresh.mark('ground', provider.now());
  switch (ev.type) {
    case 'dispatch':
      if (!mergeRequest(ev)) break;
      if (ev.state === 'READY' && S.screen === 'dispatch') go('guidance'); else if (S.screen === 'dispatch') renderSoon();
      announce(dispatchText(ev.state).title, TERMINAL.has(ev.state) ? 'assertive' : 'polite');
      break;
    case 'mission': {
      const prev = S.mission;
      S.mission = ev;
      const route = currentRoute(ev);
      if (clientFilter && route && clientFilter.route !== route) clientFilter.setRoute(route);
      if (prev?.legIndex !== ev.legIndex || prev?.status !== ev.status) drawProgress();
      if (prev?.status !== ev.status) { onStatusChange(prev?.status, ev.status); }
      break;
    }
    case 'aircraft': S.aircraft = { ...ev, receivedAt: provider.now() }; fresh.mark('aircraft', provider.now()); break;
    case 'sampleAck': onAck(ev); break;
    case 'command': applyCommand(ev); break;
    case 'source': S.source = ev.source; if (ev.source === 'operator-device') announce('The operator is assisting. Their device now provides your position.', 'assertive'); break;
    case 'alert': onAlert(ev); break;
    case 'snapshot':
      if (ev.request) mergeRequest(ev.request);
      if (ev.mission) S.mission = ev.mission;
      if (ev.aircraft) S.aircraft = { ...ev.aircraft, receivedAt: provider.now() };
      if (ev.source) S.source = ev.source;
      (ev.commands || []).forEach(applyCommand);
      renderSoon();
      break;
  }
}

/** The part of the plan the visitor is on now: the walk to the first pad, a guided leg, or the final approach. */
function currentRoute(m = S.mission) {
  const p = S.plan; if (!p?.legs) return null;
  if (!m || m.stage === 'transfer') return p.transfer?.needed ? p.transfer.coords : p.legs[0].coords;
  return p.legs[Math.min(m.legIndex || 0, p.legs.length - 1)].coords;
}
/** Map overlay during transit: completed guided legs, the leg guided right now, unguided movement. */
function drawProgress() {
  const m = S.mission; if (!S.plan?.legs || !m) return map.setProgress({});
  const ended = ['landed', 'ended'].includes(m.status), done = ended && m.outcome === 'arrived' ? S.plan.legs.length : (m.legIndex || 0) + (['handoff', 'interrupted'].includes(m.status) ? 1 : 0);
  map.setProgress({ plan: S.plan, legIndex: m.legIndex || 0, done, active: !!m.guidanceActive, track: S.offTrack });
}

/** Apply a dispatch update only if it belongs to the current request and does not move it backwards
 *  (responses and stream events can arrive in either order). */
const DISPATCH_RANK = { REQUESTING: 0, QUEUED: 1, AWAITING_OPERATOR: 2, APPROVED: 3, MEET_AT_PAD: 4, READY: 5, DECLINED: 6, UNAVAILABLE: 6, CANCELLED: 6 };
function mergeRequest(r) {
  if (!r?.state || (r.requestId && S.staleRequests.has(r.requestId))) return false;
  const cur = S.request || {};
  if (cur.requestId && r.requestId && cur.requestId !== r.requestId) return false;
  if ((DISPATCH_RANK[r.state] ?? 0) < (DISPATCH_RANK[cur.state] ?? -1)) return false;
  S.request = { ...cur, ...r };
  return true;
}

function onStatusChange(prev, now) {
  const msg = { takeoff: 'NAVI is taking off. Stay outside the pad area.', leading: 'NAVI is leading. Follow it.', waiting: 'NAVI is waiting for you.', paused: 'NAVI is paused and holding position.', returning: 'NAVI is returning to its pad.', operator: 'The safety operator is assisting.' }[now];
  if (msg) announce(msg, now === 'returning' || now === 'operator' ? 'assertive' : 'polite');
  if (now === 'waiting') haptic('hold');
  if (now === 'returning') haptic('alert');
  if (['guidance', 'dispatch'].includes(S.screen)) renderSoon();
}

function onAlert(ev) {
  pushEvent(alertText(ev));
  if (ev.code === 'destination_reached') { S.arrival.reached = true; announce(`You have reached ${S.plan?.destination.name}.`, 'assertive'); renderSoon(); }
  if (ev.code === 'landed' && ev.confirmed) {
    S.arrival.landed = ev;
    for (const c of S.commands.values()) if (c.state === 'unconfirmed' || c.state === 'sending') c.state = 'moot'; // the aircraft is down
    const arrived = S.mission?.outcome === 'arrived' || S.arrival.reached;
    stopSharing();
    if (arrived) { chime(); haptic('arrive'); announce(S.mode === 'demo' ? 'Demo journey complete.' : `Landing confirmed. Welcome to ${S.plan?.destination.name}.`, 'assertive'); }
    go(arrived ? 'arrival' : 'ended');
  }
}
const alertText = ev => ({ preflight: 'Pre-flight checks at the pad', takeoff: 'Takeoff', leading: 'Leading', hold: 'Holding: ' + (ev.reason || ''), resume: 'Resumed leading', dest_hold: 'Over the destination entrance', destination_reached: 'Destination reached', returning: 'Returning: ' + (ev.reason || ''), emergency_land: 'Landing in place: ' + (ev.reason || ''), landed: 'Landing confirmed', handoff_landing: 'Landing at the handoff pad', handoff: 'Handoff: battery swap', handoff_blocked: 'Handoff blocked: ' + (ev.reason || ''), leg_started: `Leg ${(ev.legIndex ?? 0) + 1} started`, last_leg_landing: 'Landing at the last pad', guided_section_complete: 'Guided section complete', rc_takeover: 'Operator took manual control', rc_released: 'Operator handed back control' }[ev.code] || ev.code);
function pushEvent(text) { S.events.push({ t: provider?.now() || Date.now(), text }); if (S.events.length > 40) S.events.shift(); }

/* ============================================================ routing helpers */
function go(screen) {
  S.screen = screen;
  render();
  VIEWS[screen]?.enter?.();
  const h = sheet.querySelector('h1,h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}
let renderQueued = false;
function renderSoon() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }

function render() {
  appEl.dataset.screen = S.screen;
  $('#crosshair').hidden = S.screen !== 'pin';
  const view = VIEWS[S.screen] || VIEWS.welcome;
  sheet.classList.toggle('full', !!view.full);
  const keepScroll = sheet.querySelector('.sheet-body')?.scrollTop || 0;
  const focusId = document.activeElement?.id;
  sheet.innerHTML = view.html();
  const body = sheet.querySelector('.sheet-body'); if (body && view.keepScroll) body.scrollTop = keepScroll;
  if (focusId && view.keepScroll) { const el = document.getElementById(focusId); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }
  view.after?.();
  updatePill();
  const hud = S.screen === 'guidance';
  hudEl.hidden = !hud; appEl.classList.toggle('has-hud', hud);
  updateHud(); updateBanners();
}

/* ======================================================================= views */
const VIEWS = {};
const backBtn = (to, label = 'Back') => `<button class="icon-btn" data-act="goto" data-to="${to}" aria-label="${esc(label)}">${icon('back')}</button>`;
const demoNote = () => S.mode === 'demo' ? `<p class="note" style="margin-top:14px">Demo mode: the guide aircraft and its telemetry are simulated. No aircraft is connected and no flight commands leave this page.</p>` : '';

VIEWS.welcome = {
  enter: () => { if (!S.origin) map.fitTo(campus.boundary, [8, 8], { top: 0 }); },
  html: () => {
    const qr = S.qrPad && campus.pad(S.qrPad);
    return `<div class="grab"></div><div class="sheet-body">
      ${qr ? `<div class="card chamfer" style="margin:6px 0 16px"><p class="eyebrow">From the pad QR code</p><h3 style="margin:4px 0 6px">Starting at ${esc(qr.name)}</h3><p class="small muted">The QR code only suggests this pad. Correct it if you are somewhere else.</p><div class="btn-row" style="margin-top:12px"><button class="btn primary" data-act="use-qr">Start here</button><button class="btn" data-act="dismiss-qr">Change</button></div></div>` : ''}
      <p class="eyebrow">VIT Chennai visitor guide</p>
      <h1>Where are you starting?</h1>
      <p class="lead">Pick how to set your starting point. Nothing is shared until you ask NAVI to guide you.</p>
      <div class="stack">
        <button class="choice" data-act="locate">${icon('locate')}<span><b>Use my location</b><small>Find your position with this phone</small></span>${icon('next', 'chev')}</button>
        <button class="choice" data-act="goto" data-to="place">${icon('place')}<span><b>Choose a place</b><small>A building, gate or launch pad</small></span>${icon('next', 'chev')}</button>
        <button class="choice" data-act="pin">${icon('pin')}<span><b>Pin on the map</b><small>Move the map to where you are</small></span>${icon('next', 'chev')}</button>
      </div>
      <div class="between" style="margin-top:16px"><button class="btn ghost" data-act="about">${icon('info')} About NAVI</button>${S.mode === 'live' && S.conn !== 'connected' ? `<span class="chip danger">${icon('link-off')} No ground station</span>` : ''}</div>
      ${demoNote()}
    </div>`;
  }
};

VIEWS.locate = {
  html: () => {
    const L = S.locate, f = L.fix;
    let body;
    if (L.status === 'requesting') body = `<div class="card"><div class="row">${icon('locate')}<div><b>Finding your location…</b><p class="small muted">Your browser may ask for permission. The position stays on this phone while you plan.</p></div></div></div>`;
    else if (L.status === 'fix') {
      const age = (Date.now() - f.timestamp) / 1000, out = campus.outsideM([f.lat, f.lon]), poor = f.accuracyM > CONFIG.poorAccuracyM;
      body = `<div class="card"><p class="eyebrow">Measured position</p><dl class="kv" style="margin-top:8px"><dt>Accuracy</dt><dd>±${Math.round(f.accuracyM)} m</dd><dt>Measured</dt><dd data-k="fixAge">${esc(ago(age))}</dd><dt>On campus</dt><dd>${out === 0 ? 'Yes' : out <= CONFIG.fenceBufferM ? 'At the edge' : 'No'}</dd></dl></div>
        ${poor ? `<p class="note" style="margin-top:10px">${icon('alert')} This position is approximate. Confirm only if the pin looks right, or choose a place instead.</p>` : ''}
        ${out > CONFIG.fenceBufferM ? `<div class="card" style="margin-top:10px;border-color:var(--caution)"><b>You appear to be outside the campus</b><p class="small muted" style="margin:4px 0 10px">NAVI only guides inside VIT Chennai. Plan from the main gate, or choose where you will enter.</p><div class="btn-row"><button class="btn" data-act="from-gate">Plan from Main Gate</button><button class="btn" data-act="goto" data-to="place">Choose a place</button></div></div>` : ''}`;
    } else {
      const msgs = {
        denied: ['Location permission is off', 'Allow location for this site in your browser settings, or choose your start another way.'],
        unavailable: ['Your position is unavailable', 'The phone could not get a position. Try again outdoors, or choose your start another way.'],
        timeout: ['Finding your position took too long', 'Try again, or choose your start another way.'],
        insecure: ['Location needs a secure page', 'Browsers only share location with pages served over HTTPS (or localhost).'],
        unsupported: ['This browser cannot share location', 'Choose a place or pin your start on the map instead.']
      }[L.status] || ['Use your location', ''];
      body = `<div class="card" style="border-color:var(--caution)"><div class="row">${icon('alert')}<div><b>${esc(msgs[0])}</b><p class="small muted">${esc(msgs[1])}</p></div></div></div>
        <div class="stack" style="margin-top:12px">${['unavailable', 'timeout'].includes(L.status) ? `<button class="btn primary" data-act="locate">Try again</button>` : ''}<button class="btn" data-act="goto" data-to="place">Choose a place</button><button class="btn" data-act="pin">Pin on the map</button></div>`;
    }
    const canConfirm = L.status === 'fix' && campus.outsideM([L.fix.lat, L.fix.lon]) <= CONFIG.fenceBufferM;
    return `<div class="grab"></div><div class="sheet-body"><div class="sheet-head">${backBtn('welcome')}<h2>Your location</h2></div>${body}</div>
      ${L.status === 'fix' ? `<div class="sheet-foot"><div class="btn-row"><button class="btn" data-act="goto" data-to="welcome">Change location</button><button class="btn primary" data-act="confirm-fix" ${canConfirm ? '' : 'disabled'}>Confirm starting point</button></div></div>` : ''}`;
  },
  keepScroll: true
};

VIEWS.place = {
  full: true, keepScroll: true,
  html: () => {
    const q = S.placeQuery.trim().toLowerCase();
    const items = campus.places().filter(p => !q || p.name.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q));
    return `<div class="sheet-body"><div class="sheet-head">${backBtn('welcome')}<h2>Choose a place</h2></div>
      <div class="search">${icon('search')}<input id="place-q" type="search" placeholder="Search buildings, gates and pads" value="${esc(S.placeQuery)}" autocomplete="off" aria-label="Search places"></div>
      <p class="count" aria-live="polite">${items.length} place${items.length === 1 ? '' : 's'}</p>
      ${items.length ? `<ul class="list">${items.map(p => `<li><button class="pick" data-act="pick-place" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.sub)}</small></button></li>`).join('')}</ul>` : `<p class="empty">No places match “${esc(S.placeQuery)}”.</p>`}
    </div>`;
  },
  after: () => $('#place-q')?.addEventListener('input', e => { S.placeQuery = e.target.value; render(); })
};

VIEWS.pin = {
  after: () => placeCrosshair(),
  enter: () => { map.fitTo(campus.boundary, [12, 12], { top: 0 }); },
  html: () => `<div class="grab"></div><div class="sheet-body"><div class="sheet-head">${backBtn('welcome')}<h2>Pin your start</h2></div>
    <p class="lead" style="margin-top:0">Move the map so the pin sits where you are, or tap the map. You can also nudge it:</p>
    <div class="row" style="justify-content:center;gap:6px" role="group" aria-label="Move the pin 10 metres">
      <button class="btn" data-act="nudge" data-dx="-10" data-dy="0" aria-label="West 10 metres">W</button>
      <button class="btn" data-act="nudge" data-dx="0" data-dy="10" aria-label="North 10 metres">N</button>
      <button class="btn" data-act="nudge" data-dx="0" data-dy="-10" aria-label="South 10 metres">S</button>
      <button class="btn" data-act="nudge" data-dx="10" data-dy="0" aria-label="East 10 metres">E</button>
    </div></div>
    <div class="sheet-foot"><button class="btn primary block" data-act="pin-here">Use this point</button></div>`
};

VIEWS.confirm = {
  html: () => {
    const d = S.draft, out = campus.outsideM(d.ll);
    return `<div class="grab"></div><div class="sheet-body"><div class="sheet-head">${backBtn(d.kind === 'pin' ? 'pin' : 'place')}<h2>Starting point</h2></div>
      <div class="card"><p class="eyebrow">${d.kind === 'pin' ? 'Pinned point' : d.kind === 'pad' ? 'Launch pad' : 'Place'}</p><h3 style="margin:4px 0">${esc(d.label)}</h3><p class="small muted">Starting point selected. This is a planning point, not live location sharing.</p></div>
      ${out > CONFIG.fenceBufferM ? `<div class="card" style="margin-top:10px;border-color:var(--caution)"><b>This point is outside the campus</b><p class="small muted" style="margin:4px 0 10px">NAVI only guides inside VIT Chennai.</p><button class="btn block" data-act="from-gate">Plan from Main Gate</button></div>` : ''}
    </div><div class="sheet-foot"><div class="btn-row"><button class="btn" data-act="goto" data-to="welcome">Change location</button><button class="btn primary" data-act="confirm-draft" ${out > CONFIG.fenceBufferM ? 'disabled' : ''}>Confirm starting point</button></div></div>`;
  }
};

VIEWS.directory = {
  full: true, keepScroll: true,
  html: () => {
    const q = S.query.trim().toLowerCase();
    let list = campus.destinations.filter(d => (S.cat === 'all' || d.category === S.cat) && (!S.favOnly || S.favorites.has(d.id)) && (!q || d.name.toLowerCase().includes(q) || d.category.toLowerCase().includes(q)));
    const o = S.origin;
    return `<div class="sheet-body"><div class="sheet-head">${backBtn('welcome', 'Change starting point')}<h2>Where to?</h2></div>
      <p class="small muted" style="margin:-6px 0 12px">From <b style="color:var(--text)">${esc(o.label)}</b> · <button class="btn ghost" style="min-height:44px;padding:0 8px" data-act="goto" data-to="welcome">change</button></p>
      <div class="search">${icon('search')}<input id="dest-q" type="search" placeholder="Search 36 destinations" value="${esc(S.query)}" autocomplete="off" aria-label="Search destinations"></div>
      <div class="chips" role="group" aria-label="Filter by category" style="margin-top:10px">
        <button class="filter-chip" data-act="cat" data-cat="all" aria-pressed="${S.cat === 'all' && !S.favOnly}">All</button>
        <button class="filter-chip" data-act="fav-only" aria-pressed="${S.favOnly}">${icon('star-fill')} Saved</button>
        ${campus.categories.map(c => `<button class="filter-chip" data-act="cat" data-cat="${esc(c)}" aria-pressed="${S.cat === c}">${esc(c)}</button>`).join('')}
      </div>
      <p class="count" aria-live="polite">${list.length} destination${list.length === 1 ? '' : 's'}</p>
      ${list.length ? `<ul class="list">${list.map(d => {
        const m = campus.straightLineM(o.ll, d), fav = S.favorites.has(d.id);
        return `<li><button class="pick" data-act="pick-dest" data-id="${esc(d.id)}"><b>${esc(d.name)}</b><small>${esc(d.category)} · about ${fmtDist(m)} away in a straight line</small></button>
          <button class="icon-btn fav" data-act="fav" data-id="${esc(d.id)}" aria-pressed="${fav}" aria-label="${fav ? 'Remove' : 'Save'} ${esc(d.name)}">${icon(fav ? 'star-fill' : 'star')}</button></li>`;
      }).join('')}</ul>` : `<div class="empty"><p>No destinations match${q ? ` “${esc(S.query)}”` : ''}${S.cat !== 'all' ? ` in ${esc(S.cat)}` : ''}${S.favOnly ? ' among your saved places' : ''}.</p><button class="btn" style="margin-top:10px" data-act="clear-filters">Clear search and filters</button></div>`}
      <p class="small muted" style="margin-top:12px">Distances here are straight-line hints. The walking route length appears in the preview.</p>
    </div>`;
  },
  after: () => $('#dest-q')?.addEventListener('input', e => { S.query = e.target.value; render(); })
};

function planChecks(p) {
  const li = (cls, ic, text) => `<li class="${cls}">${icon(ic)}<span>${text}</span></li>`;
  const out = [];
  if (p.legs?.length) out.push(li('ok', 'check', `${p.legs.length} guided leg${p.legs.length > 1 ? 's' : ''}, each within the provisional ${CONFIG.legLimitM} m limit and one battery`));
  if (p.legs?.length) {
    const worst = Math.max(...p.legs.map(l => campus.routeFenceCheck(l.coords).maxOutsideM));
    out.push(worst > CONFIG.fenceBufferM ? li('bad', 'alert', 'Part of a guided leg leaves the 40 m buffered boundary') : worst > 0 ? li('warn', 'alert', `A guided leg runs up to ${Math.round(worst)} m outside the hand-traced boundary (within the 40 m buffer)`) : li('ok', 'check', 'Guided legs stay inside the campus boundary'));
  }
  out.push(li('warn', 'alert', 'Footpath/road classification is not in the data yet, so route inspection is pending. Follow footpaths, never the carriageway.'));
  if (p.pads?.length) {
    const proposed = p.pads.filter(x => x.approval !== 'approved').length;
    if (proposed) out.push(li('warn', 'info', `${proposed === p.pads.length ? 'All' : proposed} pad${proposed > 1 ? 's' : ''} on this route ${proposed > 1 ? 'are' : 'is'} proposed: placement pending inspection`));
    const st = x => ({ ready: S.mode === 'demo' ? 'ready (simulated)' : 'ready', busy: 'busy', unavailable: 'unavailable', unknown: 'readiness unknown' }[x.status] || x.status);
    for (const x of p.pads) out.push(li(x.status === 'ready' ? 'ok' : x.status === 'unknown' ? 'info' : 'bad', x.status === 'ready' ? 'check' : 'info', `${esc(x.name)}: ${esc(st(x))}`));
  }
  out.push(li('info', 'phone', S.sharing.status === 'active' ? 'Location sharing is active' : 'Location is not shared yet; you will be asked first'));
  return out.join('');
}

/** Itinerary in words, built from the plan's own segment classification. */
function itinerary(p) {
  const rover = settings.get('rover', false), steps = [];
  const step = (cls, ic, title, sub) => `<li class="${cls}"><span class="dot ${cls}">${icon(ic)}</span><span><b>${title}</b><small>${sub}</small></span></li>`;
  const t = p.segments?.find(x => x.role === 'transfer');
  steps.push(t ? step('walk', 'walk', `Walk to ${esc(p.startPad.name)}`, `${fmtDist(t.lengthM)} · about ${fmtDuration(t.etaS)} · on your own (unguided)`) : step('walk', 'flag', `Meet NAVI at ${esc(p.startPad.name)}`, 'You start at the pad'));
  p.legs.forEach((l, i) => {
    steps.push(step('guided', rover ? 'rover' : 'drone', `Leg ${i + 1}: NAVI guides you to ${l.to ? esc(l.to.name) : `the ${esc(p.destination.name)} entrance`}`, `${fmtDist(l.lengthM)} · about ${fmtDuration(l.etaS)} · drone-guided`));
    const h = p.handoffs?.find(x => x.id === l.to?.id && i < p.legs.length - 1);
    if (h) steps.push(step('wait', 'clock', `Handoff at ${esc(h.name)}: wait about ${Math.round(h.waitS / 60)} min`, 'Staffed battery swap (estimate). Wait here; guidance continues after the handoff.'));
  });
  const f = p.finalApproach;
  if (f) steps.push(step('walk', 'walk', `Walk the last ${fmtDist(f.lengthM)} to the entrance`, `about ${fmtDuration(f.etaS)} · on your own (unguided)`));
  else steps.push(step('walk', 'flag', `Arrive at ${esc(p.destination.name)}`, `NAVI then lands at ${esc(campus.pad(p.landingPadId)?.name || 'its pad')}`));
  return `<ol class="steps itin">${steps.join('')}</ol>`;
}

function coverageCard(p, label = 'Planned drone-guided coverage') {
  const c = p.coverage;
  if (!c?.applicable) return '';
  const ok = c.meets;
  return `<div class="cov ${ok ? 'ok' : 'bad'}" role="group" aria-label="${esc(label)}">
    <div class="cov-main"><small>${esc(label)}</small><b>${fmtPercent(c.percent)}</b><span class="chip ${ok ? 'ok' : 'danger'}">${ok ? `${icon('check')} Meets ${c.thresholdPct}%` : `${icon('alert')} Below ${c.thresholdPct}%`}</span></div>
    <div class="cov-bar" aria-hidden="true"><span class="g" style="width:${c.percent}%"></span></div>
    <dl class="kv cov-kv"><dt><span class="sw g"></span>Drone-guided walking</dt><dd>${fmtDist(c.guidedM)}</dd><dt><span class="sw u"></span>Unguided walking</dt><dd>${fmtDist(c.unguidedM)}${c.unguidedM > 0 ? ` (${fmtPercent(c.unguidedPercent)})` : ''}</dd><dt>Total walk</dt><dd>${fmtDist(c.totalM)}</dd></dl>
  </div>`;
}
const legend = () => `<p class="legend"><span><i class="ln g"></i>Drone-guided</span><span><i class="ln u"></i>Unguided walking</span><span><i class="pd"></i>Pad</span></p>`;

VIEWS.preview = {
  keepScroll: true,
  html: () => {
    const p = S.plan;
    if (!p) return `<div class="grab"></div><div class="sheet-body"><div class="sheet-head">${backBtn('directory')}<h2>Planning…</h2></div>${S.planError ? `<p class="lead">${esc(S.planError)}</p>` : '<p class="lead">Working out the route.</p>'}</div>`;
    const head = `<div class="sheet-head">${backBtn('directory', 'Back to destinations')}<h2>${esc(p.destination.name)}</h2></div>
      <p class="small muted" style="margin:-8px 0 12px">From ${esc(p.origin.label)} · ${esc(p.destination.category)}</p>`;
    if (p.availability === 'at_destination') return `<div class="grab"></div><div class="sheet-body">${head}<div class="card"><h3>You are already at the destination</h3><p class="small muted" style="margin-top:4px">Your starting point is at the ${esc(p.destination.name)} entrance, so there is nothing to guide. Drone-guided coverage does not apply.</p></div></div>
      <div class="sheet-foot"><button class="btn block" data-act="goto" data-to="directory">Choose another destination</button></div>`;
    const canRequest = p.availability === 'available' && S.conn === 'connected' && S.planSource === 'ground' && navigator.onLine !== false;
    const unavailable = p.availability === 'unavailable';
    const why = S.conn !== 'connected' ? 'Not connected to a ground station.' : S.planSource !== 'ground' ? 'Route not validated by the ground station yet.' : p.availability === 'unknown' ? 'Pad readiness is unknown.' : '';
    return `<div class="grab"></div><div class="sheet-body">${head}
      ${unavailable ? `<div class="card unavailable" role="alert"><h3>${esc(p.unavailableText || '95% drone-guided navigation is currently unavailable for this route.')}</h3>
        <ul class="checks" style="margin-top:8px">${p.reasons.map(r => `<li class="bad">${icon('alert')}<span>${esc(r.text)}</span></li>`).join('')}</ul>
        ${p.suggestions?.length ? `<p class="section-label">What would close the gap</p>${p.suggestions.map(x => `<p class="small">${icon('pin')} ${esc(x.text)}</p>`).join('')}` : ''}</div>` : ''}
      ${p.legs?.length ? coverageCard(p, unavailable ? 'Best plan found (does not qualify)' : 'Planned drone-guided coverage') : ''}
      ${p.legs?.length ? `<p class="section-label">${unavailable ? 'Best plan found' : 'Your journey'}</p>${legend()}${itinerary(p)}
        <div class="card" style="margin-top:6px"><div class="between"><span class="muted">Walking time</span><b class="mono">${fmtDuration(p.totalEtaS)}</b></div>${p.handoffs.length ? `<div class="between"><span class="muted">Waiting at handoffs</span><b class="mono">about ${fmtDuration(p.waitS)}</b></div>` : ''}<p class="small muted" style="margin-top:6px">Walking at 0.8 m/s plus a 15% allowance for pauses. Dispatch and handoff waits are estimates and are separate.</p></div>` : ''}
      <div class="card" style="margin-top:10px"><div class="between"><span class="muted">Shortest walk without NAVI</span><b class="mono">${fmtDist(p.direct?.lengthM)} · ${fmtDuration(p.direct?.etaS)}</b></div></div>
      ${p.startPad && !unavailable ? `<div class="card" style="margin-top:10px"><p class="eyebrow">Meeting point</p><p style="margin-top:4px"><b>${esc(p.startPad.name)}</b> — ${esc(p.startPad.meet || '')}. Stay outside the marked ${CONFIG.padClearanceM} m × ${CONFIG.padClearanceM} m area.</p><p class="small muted" style="margin-top:4px">${esc(PAD_APPROVAL_TEXT[p.startPad.approval] || '')}</p></div>` : ''}
      ${p.legs?.length && !unavailable ? `<p class="section-label">Pre-flight</p><div class="chips" style="flex-wrap:wrap">${preflightChips(p)}</div>` : ''}
      <p class="section-label">Checks</p>
      <ul class="checks">${planChecks(p)}</ul>
      ${p.notes.filter(n => !/classification/.test(n)).map(n => `<p class="note" style="margin-top:10px">${esc(n)}</p>`).join('')}
      <p class="small muted" style="margin-top:12px">${S.planSource === 'ground' ? `Validated by the ${S.mode === 'demo' ? 'demo ' : ''}ground station · route ${esc(p.routeId)}` : 'Offline estimate from this phone · not validated by a ground station'}${S.mode === 'demo' ? ' · pad and aircraft availability simulated' : ''}</p>
    </div>
    <div class="sheet-foot">
      ${unavailable ? '' : !canRequest ? `<button class="btn block" disabled>Guide unavailable</button><p class="small muted" style="margin-top:6px">${esc(why)}</p>`
        : settings.get('slide', false) ? `<button class="slide" id="slide" data-act="request" aria-label="Request Guide (slide, or press Enter)"><span class="fill"></span><span class="label">Slide to request guide</span><span class="thumb">${icon('next')}</span></button>`
        : `<button class="btn primary block lg" id="request" data-act="request-tap" ${S.requesting ? 'disabled' : ''}>${icon(settings.get('rover', false) ? 'rover' : 'drone')} Request Guide</button>`}
      <button class="btn ${unavailable ? '' : 'ghost'} block" style="margin-top:6px" data-act="walk-only">Walking directions only${unavailable ? ' (not drone-guided)' : ''}</button>
    </div>`;
  },
  after: () => bindSlide()
};

function preflightChips(p) {
  if (S.planSource !== 'ground') return `<span class="chip">${icon('info')} Pre-flight status unknown offline</span>`;
  const air = settings.get('rover', false) ? 'Ground robot · ESP32' : 'F450 · ArduPilot';
  if (S.mode === 'demo') return [`<span class="chip ${p.pad?.status === 'ready' ? 'ok' : 'caution'}">${icon('check')} Pad ${esc(p.pad?.status || 'unknown')}</span>`, `<span class="chip">${p.legs.length} leg${p.legs.length > 1 ? 's' : ''} · ${p.handoffs.length} handoff${p.handoffs.length === 1 ? '' : 's'}</span>`, `<span class="chip">${icon('drone')} ${air}</span>`, `<span class="chip caution">Wind 3.2 m/s · demo value</span>`, `<span class="chip caution">${icon('bolt')} 12.4 V · demo value</span>`].join('');
  return [`<span class="chip ${p.pad?.status === 'ready' ? 'ok' : 'caution'}">${icon('check')} Pad ${esc(p.pad?.status || 'unknown')}</span>`, `<span class="chip">${icon('drone')} ${air}</span>`, `<span class="chip">Wind: not reported</span>`].join('');
}

VIEWS.walk = {
  html: () => {
    const p = S.plan;
    return `<div class="grab"></div><div class="sheet-body"><div class="sheet-head">${backBtn('preview')}<h2>Walking directions</h2></div>
      <p class="chip" style="margin-bottom:10px">Not drone-guided</p>
      <div class="card"><div class="between"><span class="muted">${esc(p.origin.label)} → ${esc(p.destination.name)}</span><b class="mono">${fmtDist(p.direct.lengthM)}</b></div><div class="between"><span class="muted">Estimated time</span><b class="mono">${fmtDuration(p.direct.etaS)}</b></div></div>
      <p class="note" style="margin-top:12px">You walk this on your own; NAVI does not guide it. The dashed line follows the campus path graph. Keep to footpaths; route inspection for footpath and road classification is still pending. No location is shared in this view.</p></div>`;
  }
};

const DISPATCH_FLOW = ['REQUESTING', 'QUEUED', 'AWAITING_OPERATOR', 'APPROVED', 'MEET_AT_PAD', 'READY'];
function dispatchText(st) {
  return {
    REQUESTING: { title: 'Sending your request', sub: 'To the ground station' },
    QUEUED: { title: 'Request received', sub: 'Waiting in the queue' },
    AWAITING_OPERATOR: { title: 'Waiting for the operator', sub: 'A person approves every guided trip' },
    APPROVED: { title: 'Approved', sub: 'NAVI is being prepared' },
    MEET_AT_PAD: { title: 'Meet NAVI at the pad', sub: 'Share your location so NAVI knows you have arrived' },
    READY: { title: 'Ready', sub: 'NAVI is preparing to take off' },
    DECLINED: { title: 'Request declined', sub: '' }, UNAVAILABLE: { title: 'Guide unavailable', sub: '' }, CANCELLED: { title: 'Request cancelled', sub: '' }
  }[st] || { title: st, sub: '' };
}

VIEWS.dispatch = {
  keepScroll: true,
  html: () => {
    const r = S.request || { state: 'REQUESTING' }, p = S.plan, st = r.state, idx = DISPATCH_FLOW.indexOf(st);
    if (TERMINAL.has(st)) {
      return `<div class="grab"></div><div class="sheet-body"><div class="sheet-head"><h2>${esc(dispatchText(st).title)}</h2></div>
        <div class="card" style="border-color:var(--caution)"><p>${esc(r.reason || (st === 'CANCELLED' ? 'You cancelled this request.' : 'The ground station could not accept this request.'))}</p></div>
        <p class="small muted" style="margin-top:10px">No aircraft was dispatched.</p></div>
        <div class="sheet-foot"><div class="btn-row"><button class="btn" data-act="goto" data-to="directory">Choose another</button><button class="btn primary" data-act="goto" data-to="preview">Back to route</button></div></div>`;
    }
    const sh = S.sharing;
    const shareChip = { off: '<span class="chip">Not shared</span>', starting: '<span class="chip caution">Starting…</span>', waiting: '<span class="chip caution">Waiting for confirmation</span>', active: `<span class="chip ok">${icon('check')} Sharing active</span>`, error: '<span class="chip danger">Not available</span>' }[sh.status];
    return `<div class="grab"></div><div class="sheet-body">
      <div class="sheet-head"><h2>${esc(dispatchText(st).title)}</h2></div>
      ${['MEET_AT_PAD', 'READY'].includes(st) ? `<div class="card chamfer" style="margin-bottom:14px"><p class="eyebrow">Meeting point</p><h3 style="margin:4px 0">${esc(p.pad.name)}</h3><p class="small">${esc(p.pad.meet)}. ${p.transfer?.needed ? `Walk ${fmtDist(p.transfer.lengthM)} (about ${fmtDuration(p.transfer.etaS)}). ` : ''}Stay outside the marked area.</p>
        <div class="between" style="margin-top:10px"><span class="small muted">Location sharing</span>${shareChip}</div>
        ${sh.status === 'off' || sh.status === 'error' ? `<button class="btn primary block" style="margin-top:10px" data-act="share">${icon('phone')} Share my location</button>` : ''}
        ${sh.error ? `<p class="small" style="color:var(--danger);margin-top:6px">${esc(sh.error)}</p>` : ''}</div>` : ''}
      <ol class="timeline" aria-label="Request progress">${DISPATCH_FLOW.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="b" aria-hidden="true"></span><span>${esc(dispatchText(s).title)}${i === idx ? `<small>${esc(dispatchText(s).sub)}</small>` : ''}<span class="sr-only">${i < idx ? ' (done)' : i === idx ? ' (current)' : ''}</span></span></li>`).join('')}</ol>
      ${S.mode === 'demo' ? `<p class="note" style="margin-top:12px">Demo: an operator approval is simulated, and after you start sharing a simulated visitor walks to the pad. Your real location is not used.</p>` : ''}
    </div>
    <div class="sheet-foot">${S.cancelError ? `<p class="small" role="alert" style="color:var(--danger);margin-bottom:8px">${esc(S.cancelError)}</p>` : ''}<button class="btn block" data-act="cancel-request" ${S.requesting ? 'disabled' : ''}>${S.requesting ? 'Cancelling…' : 'Cancel request'}</button></div>`;
  }
};

/* ---------- guidance ---------- */
function statusInfo() {
  const m = S.mission, cmds = [...S.commands.values()];
  const pend = type => cmds.find(c => c.type === type && ['sending', 'accepted', 'executing'].includes(c.state));
  const reason = m?.holdReason ? humanReason(m.holdReason) : '';
  const map = {
    meet: ['Walk to the pad', 'NAVI waits at the pad', 'walk', 'accent'],
    preflight: ['NAVI is getting ready', 'Pre-flight checks at the pad. Stay outside the marked area.', 'drone', 'accent'],
    takeoff: ['NAVI is taking off', 'Stay outside the pad area until it is overhead.', 'drone', 'accent'],
    leading: ['NAVI is guiding you', 'Follow it at your own pace along the footpath', 'drone', 'ok'],
    handoff: ['Waiting for the next leg', 'Wait here. Guidance will continue after the handoff.', 'clock', 'caution'],
    interrupted: ['Guidance interrupted. Wait for the operator.', reason || 'The next leg cannot start yet.', 'user', 'danger'],
    waiting: ['Waiting for you', reason || 'NAVI is holding position', 'pause', 'caution'],
    paused: ['Paused', 'NAVI is holding position until you resume', 'pause', 'caution'],
    operator: ['Operator assisting', reason || 'The safety operator is in control', 'user', 'caution'],
    returning: ['Returning to the pad', reason || 'Guidance has ended', 'alert', 'danger'],
    landing: [S.arrival.reached ? `You have arrived` : 'Landing', `NAVI is returning to land at ${campus.pad(m?.landingPad)?.name || 'its pad'}. Landing not yet confirmed.`, 'flag', 'ok'],
    landed: ['Landed', 'Landing confirmed', 'check', 'ok']
  };
  let [title, sub, ic, tone] = map[m?.status] || ['Connecting…', 'Waiting for the ground station', 'link', 'accent'];
  if (pend('pause')) { title = 'Pause requested…'; sub = 'Waiting for NAVI to confirm'; }
  if (pend('resume')) { title = 'Resume requested…'; sub = 'Waiting for NAVI to confirm'; }
  if (pend('end')) { title = 'Ending guidance…'; sub = 'NAVI is returning to its pad'; }
  const gAge = fresh.ageS('ground', provider.now());
  if (m && !['landed', 'ended'].includes(m.status) && (S.link === 'down' || gAge > 8)) { title = 'Guidance interrupted. Wait for the operator.'; sub = `Connection to the ground station lost (last status ${ago(gAge)}). Stay clear of NAVI.`; tone = 'danger'; }
  else if (m && ['leading', 'waiting'].includes(m.status) && S.aircraft && fresh.ageS('aircraft', provider.now()) > 5) { title = 'Guidance interrupted. Wait for the operator.'; sub = 'NAVI’s position is not updating. Stay clear of it.'; tone = 'danger'; }
  if (m?.status === 'handoff' && m.handoffRemainingS != null) sub = `Wait here. Guidance will continue after the handoff (about ${fmtShort(m.handoffRemainingS)}).`;
  return { title, sub, ic, tone };
}
const humanReason = r => r.replace(/^Visitor (\d+) m behind$/, 'You are $1 m behind, so NAVI waits').replace('Visitor stopped', 'You stopped, so NAVI waits').replace('Visitor asked NAVI to wait', 'You asked NAVI to wait');

VIEWS.guidance = {
  keepScroll: true,
  html: () => {
    const m = S.mission || {}, si = statusInfo(), cmds = [...S.commands.values()];
    const pend = type => cmds.some(c => c.type === type && ['sending', 'accepted', 'executing'].includes(c.state));
    const flying = ['takeoff', 'leading', 'waiting', 'paused', 'operator'].includes(m.status);
    const paused = m.status === 'paused';
    const rover = settings.get('rover', false);
    return `<div class="grab"></div><div class="sheet-body">
      <p class="trip-line">${icon('flag')}<span>To <b>${esc(S.plan?.destination.name || '')}</b></span><span class="chip leg-chip" data-k="legChip">Leg ${(m.legIndex || 0) + 1} of ${S.plan?.legs?.length || 1}</span></p>
      <div class="status-card chamfer" data-tone="${si.tone}" role="status">${icon(si.ic)}<div><b data-k="status">${esc(si.title)}</b><small data-k="statusSub">${esc(si.sub)}</small></div></div>
      <div class="metrics">
        <div class="metric"><small>To go</small><b data-k="remaining">—</b></div>
        <div class="metric"><small>Walking time</small><b data-k="eta">—</b></div>
        <div class="metric"><small>${rover ? 'Robot' : 'NAVI'} lead</small><b data-k="lead">—</b></div>
      </div>
      <div class="actions">
        ${paused || (m.status === 'waiting' && /asked/.test(m.holdReason || '')) ? `<button class="btn primary" data-act="cmd" data-cmd="resume" ${pend('resume') ? 'disabled' : ''}>${icon('play')} ${pend('resume') ? 'Resuming…' : 'Resume'}</button>` : `<button class="btn caution" data-act="cmd" data-cmd="pause" ${!flying || pend('pause') ? 'disabled' : ''}>${icon('pause')} ${pend('pause') ? 'Pause requested…' : 'Wait for me'}</button>`}
        <button class="btn" data-act="end" ${pend('end') || ['returning', 'landing', 'landed'].includes(m.status) ? 'disabled' : ''}>End guidance</button>
      </div>
      <button class="btn danger-outline block estop" data-act="estop" ${['landed'].includes(m.status) ? 'disabled' : ''}>${icon('stop')} Emergency stop guidance</button>
      <div class="leadbar" aria-hidden="true"><div class="track"><div class="fill" data-k="leadFill" style="width:0"></div><span class="mark" style="left:${CONFIG.leadTargetM / 30 * 100}%" title="target"></span><span class="mark hold" style="left:${CONFIG.holdGapM / 30 * 100}%" title="hold"></span></div><div class="scale"><span>0</span><span>target ${CONFIG.leadTargetM} m</span><span>hold ${CONFIG.holdGapM} m</span><span>30 m</span></div></div>
      <p class="small muted" data-k="sep">Lead is measured along the route and is an estimate.</p>
      <div class="fresh">
        <div>${icon('user')}<span>You: <b data-k="ageYou">—</b></span></div>
        <div>${icon(rover ? 'rover' : 'drone')}<span>${rover ? 'Robot' : 'NAVI'}: <b data-k="ageAir">—</b></span></div>
        <div>${icon('link')}<span>Ground: <b data-k="ageGround">—</b></span></div>
        <div>${icon('phone')}<span>Sharing: <b data-k="share">—</b></span></div>
      </div>
      <p class="small muted" data-k="wakeNote"></p>
      <button class="btn ghost block" style="margin-top:4px" data-act="operator-help">${icon('user')} Operator assistance</button>
      <details class="more" id="details"><summary>Flight and location details</summary>
        <div class="ribbon" style="margin-top:6px" data-k="ribbon"></div>
        <p class="section-label">Your location</p>
        <p class="small" data-k="gpsBadge">—</p>
        ${S.sharing.status !== 'off' ? `<button class="btn block" style="margin:8px 0" data-act="stop-share">${icon('phone')} Stop sharing my location</button>` : ''}
        <div class="toggle-row"><span>Show raw phone positions</span><button class="switch" role="switch" data-act="toggle-raw" aria-checked="${S.showRaw}" aria-label="Show raw phone positions"></button></div>
        <p class="section-label">Position report age (last 60 s)</p>
        <svg class="spark" data-k="spark" viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label="Age of your last valid position over the last minute"></svg>
        <dl class="kv" data-k="freshKv" style="margin-top:8px"></dl>
        <p class="section-label">Direction</p>
        <div class="between"><span class="small" data-k="dirMode">Direction shown relative to north</span><button class="btn" data-act="compass">${icon('compass')} Use compass</button></div>
        <p class="section-label">Recent events</p>
        <ul class="small muted" data-k="events" style="padding-left:18px;margin:0"></ul>
        <p class="section-label">Session</p>
        <dl class="kv"><dt>Mode</dt><dd>${esc(S.mode === 'demo' ? 'Demo (simulated)' : 'Live')}</dd><dt>Aircraft data</dt><dd>${esc(provider.info.aircraftSource)}</dd><dt>Route</dt><dd>${esc(S.plan?.routeId || '—')}</dd><dt>Campus data</dt><dd>${esc(campus.version)}</dd></dl>
      </details>
    </div>`;
  },
  after: () => { const d = $('#details'); if (d) { d.open = !!S.detailsOpen; d.addEventListener('toggle', () => { S.detailsOpen = d.open; }); } patchGuidance(); }
};

VIEWS.arrival = {
  html: () => {
    const p = S.plan, demo = S.mode === 'demo', L = S.arrival.landed, m = S.mission || {};
    const approach = p.finalApproach;
    // Observed coverage: movement the ground station accepted, split by whether confirmed guidance
    // was active; any final approach still to walk is unguided.
    const obs = m.observed ? coverageOf(m.observed.guidedM, m.observed.unguidedM + (approach ? approach.lengthM : 0), CONFIG.minGuidedPercent) : null;
    const landPad = campus.pad(L?.padId);
    return `<div class="grab"></div><div class="sheet-body arrive">
      <div class="badge">${icon('check')}</div>
      <p class="eyebrow">${demo ? 'Demo journey complete' : 'Landing confirmed'}</p>
      <h1>${demo ? 'Demo journey complete' : approach ? 'Guided section complete' : `Welcome to ${esc(p.destination.name)}`}</h1>
      <p class="lead">${demo ? `In this simulation you were guided toward the ${esc(p.destination.name)} entrance, and the simulated aircraft landed at ${esc(landPad?.name || 'its pad')}.` : `NAVI has landed at ${esc(landPad?.name || 'its pad')}.`}</p>
      ${approach ? `<div class="card" style="text-align:left;margin-bottom:12px"><b>Walk the last ${fmtDist(approach.lengthM)} to the entrance</b><p class="small muted">About ${fmtDuration(approach.etaS)}, on your own (unguided). Follow the dashed line on the map.</p></div>` : ''}
      <ul class="checks" style="text-align:left;margin:10px 0 16px">
        <li class="${S.arrival.reached ? 'ok' : 'info'}">${icon(S.arrival.reached ? 'check' : 'info')}<span>${S.arrival.reached ? 'Destination reached' : 'Destination entrance still ahead'}</span></li>
        <li class="ok">${icon('check')}<span>Aircraft landing</span></li>
        <li class="ok">${icon('check')}<span>Landing confirmed${landPad ? ` at ${esc(landPad.name)}` : ''}</span></li>
      </ul>
      <dl class="kv" style="text-align:left;margin-bottom:14px"><dt>Planned drone-guided coverage</dt><dd>${fmtPercent(p.coverage?.percent)}</dd>
        <dt>Observed drone-guided coverage</dt><dd>${obs?.applicable ? fmtPercent(obs.percent) : 'n/a'}</dd>
        <dt>Observed guided / unguided</dt><dd>${obs?.applicable ? `${fmtDist(obs.guidedM)} / ${fmtDist(obs.unguidedM)}` : '—'}</dd></dl>
      <p class="small muted" style="text-align:left;margin:-6px 0 12px">Observed values come from positions the ground station accepted while guidance was confirmed active${approach ? ', with the final approach counted as unguided' : ''}. They can be lower than planned if guidance paused or was interrupted.</p>
      <p class="section-label">Was NAVI helpful?</p>
      <div class="thumbs" role="group" aria-label="Feedback, stored only on this phone"><button class="btn" data-act="feedback" data-v="up" aria-pressed="${S.feedback === 'up'}">Yes</button><button class="btn" data-act="feedback" data-v="down" aria-pressed="${S.feedback === 'down'}">Not really</button></div>
      ${S.feedback ? '<p class="small muted" style="margin-top:6px">Thanks. Saved on this phone only.</p>' : ''}
    </div>
    <div class="sheet-foot"><div class="btn-row"><button class="btn" data-act="another">Choose another destination</button><button class="btn primary" data-act="finish">Finish</button></div></div>`;
  },
  after: () => map.setLanding(null)
};

VIEWS.ended = {
  html: () => {
    const m = S.mission || {}, L = S.arrival.landed;
    return `<div class="grab"></div><div class="sheet-body">
      <div class="sheet-head"><h2>Guidance ended</h2></div>
      <div class="card"><p>${esc(m.holdReason ? humanReason(m.holdReason) : 'Guidance ended.')}</p><p class="small muted" style="margin-top:6px">${L?.where === 'in_place' ? 'The aircraft landed where it was. The safety operator will recover it. Stay clear of it.' : `The aircraft landed at ${esc(campus.pad(L?.padId)?.name || 'its pad')}.`}</p>${S.mission?.observed && S.plan?.coverage?.applicable ? `<p class="small muted" style="margin-top:6px">Observed drone-guided walking: ${fmtDist(S.mission.observed.guidedM)} of the planned ${fmtDist(S.plan.coverage.guidedM)}.</p>` : ''}</div>
      ${S.plan?.direct ? `<p class="small" style="margin-top:12px">To reach ${esc(S.plan.destination.name)} on foot, use the walking directions.</p>` : ''}
    </div>
    <div class="sheet-foot"><div class="btn-row"><button class="btn" data-act="walk-only">Walking directions</button><button class="btn primary" data-act="finish">Finish</button></div></div>`;
  }
};

/* ============================================================ actions */
function bindGlobal() {
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  appEl.addEventListener('click', e => {
    if (e.target.closest('#overlay')) return; // dialogs have their own handler below
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = ACTIONS[b.dataset.act];
    if (fn) { haptic('tap'); fn(b, e); }
  });
  overlay.addEventListener('click', e => {
    e.stopPropagation(); // an action may re-render the dialog and detach e.target before it bubbles to #app
    if (e.target === overlay) closeOverlay();
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled && ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act](b, e);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) closeOverlay(); });
  $('#btn-settings').addEventListener('click', () => openOverlay('settings'));
  $('#btn-demo').addEventListener('click', () => openOverlay('demo'));
  $('#btn-shield').addEventListener('click', () => openOverlay('shield'));
}

const ACTIONS = {
  goto: b => { if (b.dataset.to === 'welcome') stopLocate(); if (b.dataset.to === 'preview' && S.plan) map.setPlan(S.plan); go(b.dataset.to); },
  about: () => openOverlay('about'),
  'zoom-in': () => map.map.zoomIn(), 'zoom-out': () => map.map.zoomOut(),
  recenter: () => { if (S.plan) map.setPlan(S.plan); else map.fitTo(campus.boundary); },
  layers: () => openOverlay('layers'),
  'use-qr': () => { const p = campus.pad(S.qrPad); setOrigin({ kind: 'pad', ll: p.ll, nodeId: p.node, label: p.name }); },
  'dismiss-qr': () => { S.qrPad = null; render(); },
  locate: () => startLocate(),
  'confirm-fix': () => { const f = S.locate.fix; stopLocate(); setOrigin({ kind: 'measured', ll: [f.lat, f.lon], accuracyM: f.accuracyM, measuredAt: f.timestamp, label: `My location (±${Math.round(f.accuracyM)} m)` }); },
  'from-gate': () => { stopLocate(); const g = campus.pad('gate'); setOrigin({ kind: 'pad', ll: g.ll, nodeId: g.node, label: 'Main Gate (Gate Pad)' }); },
  'pick-place': b => { const p = campus.places().find(x => x.id === b.dataset.id); S.draft = { kind: p.kind, ll: p.ll, nodeId: p.nodeId, label: p.name }; map.setOrigin(S.draft); map.panTo(p.ll); go('confirm'); },
  pin: () => { stopLocate(); map.setOrigin(null); go('pin'); },
  nudge: b => { const f = campus.frame, c = f.toXY(pinPoint()); map.panPointTo(f.toLL([c[0] + +b.dataset.dx, c[1] + +b.dataset.dy]), pinPixel()); announce('Pin moved 10 metres'); },
  'pin-here': () => { S.draft = { kind: 'pin', ll: pinPoint(), label: 'Pinned point' }; map.setOrigin(S.draft); go('confirm'); },
  'confirm-draft': () => setOrigin(S.draft),
  cat: b => { S.cat = b.dataset.cat; S.favOnly = false; render(); },
  'fav-only': () => { S.favOnly = !S.favOnly; render(); },
  'clear-filters': () => { S.query = ''; S.cat = 'all'; S.favOnly = false; render(); },
  fav: b => { const id = b.dataset.id; S.favorites.has(id) ? S.favorites.delete(id) : S.favorites.add(id); settings.set('favorites', [...S.favorites]); render(); },
  'pick-dest': b => selectDestination(b.dataset.id),
  request: (b, e) => { if (e.detail === 0) requestGuide(); }, // slide variant: keyboard / assistive activation; touch must slide
  'request-tap': () => requestGuide(),
  'walk-only': () => { map.setWalkOnly(S.plan); go('walk'); },
  'cancel-request': () => cancelRequest(),
  share: () => openOverlay('privacy'),
  'stop-share': () => openOverlay('stopshare'),
  'stop-share-yes': () => { closeOverlay(); pauseSharing(); render(); },
  'share-yes': () => { closeOverlay(); startSharing(); },
  cmd: b => sendCommand(b.dataset.cmd),
  end: () => openOverlay('end'),
  'end-yes': () => { closeOverlay(); sendCommand('end'); },
  estop: () => sendCommand('abort'),
  'operator-help': () => openOverlay('operator'),
  'toggle-raw': () => { S.showRaw = !S.showRaw; render(); },
  compass: () => heading.start(),
  feedback: b => { S.feedback = b.dataset.v; const all = settings.get('feedback', []); all.push({ v: S.feedback, d: S.plan?.destination.id, t: Date.now() }); settings.set('feedback', all.slice(-20)); render(); },
  another: () => { const origin = S.origin; endSession(); S.origin = origin; map.setOrigin(origin); go('directory'); },
  finish: () => { endSession(); S.origin = null; map.setOrigin(null); map.setPlan(null); go('welcome'); },
  close: () => closeOverlay()
};

/* ---------- origin ---------- */
function startLocate() {
  stopLocate();
  S.locate = { status: 'requesting', fix: null };
  go('locate');
  device = new DeviceLocation({
    onSample: s => {
      S.locate = { status: 'fix', fix: s };
      map.setOrigin({ kind: 'measured', ll: [s.lat, s.lon], accuracyM: s.accuracyM });
      if (!S.locate.panned) { map.panTo([s.lat, s.lon]); S.locate.panned = true; }
      if (S.screen === 'locate') render();
    },
    onError: code => { if (S.locate.status !== 'fix') { S.locate = { status: code, fix: null }; stopLocate(); if (S.screen === 'locate') render(); } }
  });
  device.start();
}
function stopLocate() { if (device && S.sharing.status === 'off') { device.stop(); device = null; } }
/** The pin crosshair sits in the middle of the part of the map the sheet leaves visible. */
function pinPixel() {
  const m = $('#map').getBoundingClientRect(), r = sheet.getBoundingClientRect();
  const bottom = r.width >= m.width - 2 ? Math.min(m.bottom, r.top) : m.bottom;
  const left = r.width < m.width - 2 && r.left <= m.left + 2 ? r.right : m.left, right = r.width < m.width - 2 && r.left > m.left + 2 ? r.left : m.right;
  return [Math.round((left + right) / 2 - m.left), Math.round((m.top + bottom) / 2 - m.top)];
}
function placeCrosshair() { const [x, y] = pinPixel(), c = $('#crosshair'); c.style.left = x + 'px'; c.style.top = y + 'px'; }
function pinPoint() { return map.latLngAt(pinPixel()); }
function onMapTap(ll) { if (S.screen === 'pin') map.panPointTo(ll, pinPixel()); }

function setOrigin(o) {
  S.origin = o; S.draft = null; S.plan = null;
  map.setOrigin(o); map.setPlan(null);
  go('directory');
}

/* ---------- planning ---------- */
async function selectDestination(id) {
  S.destinationId = id; S.plan = null; S.planError = null; S.planSource = null;
  go('preview');
  const body = { origin: { kind: S.origin.kind, ll: S.origin.ll, nodeId: S.origin.nodeId, accuracyM: S.origin.accuracyM, label: S.origin.label }, destinationId: id };
  try {
    if (S.conn !== 'connected' || !provider.session && !(await ensureSession())) throw new Error('offline');
    S.plan = await provider.previewRoute(body);
    S.planSource = 'ground';
  } catch {
    try { S.plan = campus.plan({ ...body, padStatus: {} }); S.planSource = 'local'; }
    catch (e) { S.planError = e.message; }
  }
  if (S.screen !== 'preview' || S.destinationId !== id) return;
  render();
  if (S.plan) map.setPlan(S.plan); // after render, so the fit accounts for the sheet's real height
}
async function ensureSession() {
  if (provider.session) return true;
  try { await provider.createSession(); return true; } catch { return false; }
}

function bindSlide() {
  const el = $('#slide'); if (!el) return;
  const thumb = el.querySelector('.thumb'), fill = el.querySelector('.fill');
  let startX = null, max = 0, done = false;
  const set = x => { thumb.style.transform = `translateX(${x}px)`; fill.style.width = `${x + 58}px`; };
  el.addEventListener('pointerdown', e => { if (el.disabled) return; startX = e.clientX; max = el.clientWidth - 58; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => { if (startX == null) return; set(Math.max(0, Math.min(max, e.clientX - startX))); });
  const end = e => {
    if (startX == null) return;
    const x = Math.max(0, Math.min(max, e.clientX - startX)); startX = null;
    if (x > max * 0.9 && !done) { done = true; set(max); haptic('hold'); requestGuide(); }
    else set(0);
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', () => { startX = null; set(0); });
}

/* ---------- dispatch ---------- */
async function requestGuide() {
  if (S.requesting) return;
  S.requesting = true; S.idemKey = S.idemKey || uid();
  if (S.request?.requestId) S.staleRequests.add(S.request.requestId);
  S.request = { state: 'REQUESTING' }; S.cancelError = null; S.arrival = { reached: false, landed: null }; S.commands.clear();
  go('dispatch');
  try {
    const r = await provider.requestGuide({ routeId: S.plan.routeId, idempotencyKey: S.idemKey });
    if (r.error) S.request = { state: 'UNAVAILABLE', reason: r.error === 'request_active' ? 'A request is already active for this session.' : r.error };
    else mergeRequest(r);
  } catch (e) {
    S.request = { state: 'UNAVAILABLE', reason: 'Could not reach the ground station. Nothing was dispatched.' };
  }
  S.requesting = false;
  if (TERMINAL.has(S.request.state)) S.idemKey = null;
  if (S.request.state === 'READY' && S.screen === 'dispatch') go('guidance'); else render();
}
async function cancelRequest() {
  // The ground station owns the request state: show "cancelled" only once it confirms.
  S.requesting = true; S.cancelError = null; render();
  let r = null;
  try { r = await provider.cancel(); } catch { r = null; }
  S.requesting = false;
  if (r && !r.error) { mergeRequest(r); stopSharing(); S.idemKey = null; }
  else if (r?.error === 'in_flight_use_end') S.cancelError = 'NAVI has already taken off. Use End guidance instead.';
  else if (r?.error !== 'nothing_to_cancel') S.cancelError = 'Could not confirm the cancellation. Try again, or tell the operator.';
  if (TERMINAL.has(S.request?.state)) { stopSharing(); S.idemKey = null; }
  render();
}

/* ---------- location sharing ---------- */
function startSharing() {
  const resume = S.sharing.stoppedByVisitor && clientFilter; // sharing again during the same trip
  S.sharing = { status: 'starting', error: null, sent: resume ? S.sharing.sent : 0, acked: resume ? S.sharing.acked : 0, rejected: 0, lastReject: null, handedOver: false };
  if (!resume) {
    clientFilter = new SampleFilter(campus.frame, CONFIG);
    clientFilter.setRoute(currentRoute());
    fresh.clear(['valid', 'delivered']); pendingAcks.clear(); S.spark = []; S.offTrack = [];
  }
  if (S.mode === 'demo') {
    if (resume && provider.walker) provider.visitor({ dropout: false }); else provider.startSimulatedVisitor(S.plan);
    offSim?.(); offSim = provider.on('simSample', onSample);
  } else {
    device?.stop();
    device = new DeviceLocation({ onSample, onError: code => { S.sharing.status = 'error'; S.sharing.error = { denied: 'Location permission was denied. Allow it in browser settings, or ask the operator to assist.', insecure: 'Location sharing needs HTTPS.', unsupported: 'This browser cannot share location.', timeout: 'Your phone has not reported a position yet.', unavailable: 'Your position is unavailable.' }[code] || code; renderSoon(); } });
    device.start();
  }
  wake.acquire();
  render();
}
function onSample(sample) {
  if (!clientFilter) return;
  const r = clientFilter.process(sample);
  const structural = ['invalid_coordinates', 'invalid_accuracy', 'invalid_timestamp', 'duplicate', 'out_of_order'].includes(r.reason);
  if (r.accepted) {
    fresh.mark('valid', sample.timestamp);
    S.visitor = { rawLL: r.raw, ll: r.matched?.ll || null, accuracyM: sample.accuracyM, matched: r.matched, quality: r.quality, source: sample.source };
    // Newly unguided movement: walking during a leg while guidance is not confirmed active, or off the route.
    const m = S.mission, unguidedNow = m && m.stage === 'leg' && !['landed', 'ended'].includes(m.status) && (!m.guidanceActive || r.matched?.offRoute);
    if (unguidedNow) { const t = S.offTrack.at(-1); if (t && !t.closed) t.push(r.raw); else S.offTrack.push([r.raw]); }
    else if (S.offTrack.length) S.offTrack.at(-1).closed = true;
  } else { S.sharing.rejected++; S.sharing.lastReject = r.reason; }
  if (structural) return;
  if (provider.sendSample(sample)) { S.sharing.sent++; pendingAcks.set(sample.seq, sample.timestamp); if (S.sharing.status === 'starting') S.sharing.status = 'waiting'; }
  if (pendingAcks.size > 200) pendingAcks.delete(pendingAcks.keys().next().value);
}
function onAck(ev) {
  const ts = pendingAcks.get(ev.seq); pendingAcks.delete(ev.seq);
  if (ev.accepted) {
    S.sharing.acked++;
    if (ts != null) fresh.mark('delivered', ts);
    if (S.sharing.status !== 'active') { S.sharing.status = 'active'; announce('Location sharing is active.'); renderSoon(); }
    S.sharing.handedOver = false;
  } else if (ev.reason === 'source_handed_over') S.sharing.handedOver = true;
}
/** The visitor turned sharing off mid-trip: nothing more is sent; the ground station's own staleness
 *  rules (hold, then return) take over. The trip state is kept so sharing can resume. */
function pauseSharing() {
  if (S.mode === 'demo') { provider.visitor({ dropout: true }); offSim?.(); offSim = null; } else { device?.stop(); device = null; }
  wake?.release();
  S.sharing = { ...S.sharing, status: 'off', stoppedByVisitor: true };
  announce('Location sharing stopped.', 'assertive');
}
function stopSharing() {
  device?.stop(); device = null;
  offSim?.(); offSim = null;
  if (S.mode === 'demo') provider.stopSimulatedVisitor?.();
  wake?.release();
  if (S.sharing.status !== 'off') S.sharing = { ...S.sharing, status: 'off' };
  clientFilter = null;
}

/* ---------- commands ---------- */
const ORDER = { sending: 0, accepted: 1, executing: 2, confirmed: 3, rejected: 3, failed: 3, unconfirmed: 1, superseded: 4, moot: 4 };
async function sendCommand(type) {
  const commandId = uid();
  const cmd = { commandId, type, state: 'sending', reason: null, sentAt: Date.now() };
  S.commands.set(commandId, cmd);
  haptic(type === 'abort' ? 'alert' : type === 'pause' ? 'hold' : 'tap');
  if (type === 'abort') announce('Emergency stop sent. Waiting for confirmation.', 'assertive');
  render();
  const timer = setTimeout(() => { if (cmd.state === 'sending') { cmd.state = 'unconfirmed'; renderSoon(); } }, CONFIG.commandTimeoutS * 1000);
  try { const r = await provider.action(type, commandId); applyCommand({ commandId, command: type, state: r.state, reason: r.reason }); }
  catch { if (cmd.state === 'sending') cmd.state = 'unconfirmed'; }
  finally { clearTimeout(timer); renderSoon(); }
}
function applyCommand(ev) {
  let c = S.commands.get(ev.commandId);
  if (!c) { c = { commandId: ev.commandId, type: ev.command, state: 'sending' }; S.commands.set(ev.commandId, c); }
  if (ORDER[ev.state] >= ORDER[c.state] || c.state === 'unconfirmed') { c.state = ev.state; c.reason = ev.reason; }
  // A later request of the same kind that the ground station did receive replaces an unconfirmed one.
  if (['accepted', 'executing', 'confirmed'].includes(c.state)) for (const o of S.commands.values()) if (o !== c && o.type === c.type && o.state === 'unconfirmed') o.state = 'superseded';
  if (c.state === 'rejected' && !c.doneAt) { c.doneAt = Date.now(); announce(`Request not accepted: ${commandReason(c.reason)}`, 'assertive'); }
  renderSoon();
}
const cmdLabel = t => ({ pause: 'Wait for me', resume: 'Resume guidance', end: 'End guidance', abort: 'Emergency stop' }[t] || t);
const commandReason = r => ({ position_not_fresh: 'NAVI needs a fresh position from your phone before resuming.', visitor_off_route: 'You seem to be off the route.', not_paused: 'NAVI is not paused.', not_leading: 'NAVI is not leading right now.', no_active_guidance: 'No guidance is active.', aircraft_link_lost: 'The ground station cannot reach the aircraft right now.' }[r] || r || '');

/** End the visitor session: local state is cleared at once; the ground station is told in the
 *  background (it still recovers any airborne aircraft). Late events from it are ignored. */
async function endSession() {
  stopSharing(); stopLocate();
  const sid = provider?.session?.sessionId;
  if (sid) S.closedSessions.add(sid);
  const closing = provider?.closeSession?.().catch(() => {});
  Object.assign(S, { plan: null, request: null, mission: null, aircraft: null, visitor: null, idemKey: null, source: 'visitor', arrival: { reached: false, landed: null }, feedback: null, destinationId: null, detailsOpen: false, cancelError: null });
  S.sharing = { status: 'off', error: null, sent: 0, acked: 0, rejected: 0, lastReject: null, handedOver: false };
  S.commands.clear(); S.events = []; fresh.clear(); S.dismissed.clear(); S.offTrack = [];
  try { sessionStorage.clear(); } catch {}
  map?.setPlan(null); map?.setVisitor(null); map?.setAircraft(null); map?.setLanding(null); map?.setProgress({});
  await closing;
}

/* ============================================================ live refresh */
function refresh() {
  if (!provider) return;
  const now = provider.now();
  if (S.sharing.status !== 'off') {
    const t = Math.floor(now / 1000);
    if (t !== S.sparkT) { S.sparkT = t; S.spark.push(Math.min(60, fresh.ageS('valid', now))); if (S.spark.length > 60) S.spark.shift(); }
  }
  // Map markers: visitor and aircraft, each styled by its own freshness.
  if (S.visitor && S.sharing.status !== 'off') map.setVisitor({ ...S.visitor, ll: S.visitor.ll, showRaw: S.showRaw, stale: fresh.ageS('valid', now) > 10 });
  else map.setVisitor(null);
  const airAge = fresh.ageS('aircraft', now);
  if (S.aircraft?.ll && ['dispatch', 'guidance'].includes(S.screen)) map.setAircraft({ ll: S.aircraft.ll, heading: S.aircraft.headingDeg, stale: airAge > 3, ageText: ago(airAge), rover: settings.get('rover', false) });
  else if (!['dispatch', 'guidance'].includes(S.screen)) map.setAircraft(null);
  const landPad = S.mission?.status === 'landing' ? campus.pad(S.mission.landingPad) : S.mission?.phase === 'LEG_LANDING' ? campus.pad(S.mission.handoffPadId) : null;
  map.setLanding(S.screen === 'guidance' && landPad ? landPad.ll : null);
  if (S.screen === 'guidance') patchGuidance();
  if (S.screen === 'locate' && S.locate.fix) { const el = $('[data-k=fixAge]'); if (el) el.textContent = ago((Date.now() - S.locate.fix.timestamp) / 1000); }
  updateHud(); updateBanners();
}

function patchGuidance() {
  const now = provider.now(), m = S.mission || {}, set = (k, v) => { const el = sheet.querySelector(`[data-k=${k}]`); if (el && el.textContent !== v) el.textContent = v; };
  const si = statusInfo();
  set('status', si.title); set('statusSub', si.sub);
  set('legChip', `Leg ${Math.min((m.legIndex || 0) + 1, S.plan?.legs?.length || 1)} of ${S.plan?.legs?.length || 1}`);
  if (S.offTrack.length && S.offTrack.length !== S.offTrackDrawn) { S.offTrackDrawn = S.offTrack.length; drawProgress(); }
  const card = sheet.querySelector('.status-card'); if (card && card.dataset.tone !== si.tone) card.dataset.tone = si.tone;
  set('remaining', S.arrival.reached ? 'arrived' : fmtDist(m.remainingM)); set('eta', S.arrival.reached ? '—' : fmtShort(m.etaS));
  const posUncertain = fresh.ageS('valid', now) > 10 || S.visitor?.matched?.offRoute || S.visitor?.matched?.ambiguous;
  const pacing = ['leading', 'waiting', 'paused'].includes(m.status);
  set('lead', m.leadM == null || !pacing ? '—' : posUncertain ? 'uncertain' : `${Math.max(0, Math.round(m.leadM))} m`);
  const fill = sheet.querySelector('[data-k=leadFill]');
  if (fill) { fill.style.width = `${Math.max(0, Math.min(100, (m.leadM || 0) / 30 * 100))}%`; fill.style.background = m.status === 'waiting' ? 'var(--caution)' : 'var(--accent)'; }
  set('sep', posUncertain ? 'Position uncertain: lead and separation are estimates only.' : m.separationM != null ? `Lead is measured along the route. Straight-line separation, including height: about ${Math.round(m.separationM)} m.` : 'Lead is measured along the route and is an estimate.');
  const acc = S.visitor?.accuracyM;
  set('ageYou', S.sharing.status === 'off' ? 'not sharing' : `${ago(fresh.ageS('valid', now))}${acc ? ` · ±${Math.round(acc)} m` : ''}`);
  set('ageAir', ago(fresh.ageS('aircraft', now)));
  set('ageGround', ago(fresh.ageS('ground', now)));
  set('share', S.sharing.handedOver ? 'operator device' : { off: 'off', starting: 'starting', waiting: 'unconfirmed', active: 'active', error: 'error' }[S.sharing.status]);
  set('wakeNote', { active: 'Screen kept awake. Keep this page open while walking.', unsupported: 'Keep this page open and the screen on while walking.', released: 'Screen may sleep: tap the page to keep it awake, and keep it open while walking.', denied: 'Keep this page open and the screen on while walking.', off: 'Keep this page open while walking.' }[S.wake] || '');
  const a = S.aircraft, rover = settings.get('rover', false);
  const rib = sheet.querySelector('[data-k=ribbon]');
  if (rib) rib.innerHTML = a ? `<div><span>Mode</span><b>${esc(a.mode)}</b></div><div><span>Airspeed</span><b>${a.groundSpeedMps.toFixed(1)} m/s</b></div><div><span>Your pace</span><b>${(m.visitorSpeedMps ?? 0).toFixed(2)} m/s</b></div><div><span>${rover ? 'Height' : 'Altitude'}</span><b>${rover ? 'ground robot' : `${a.altM.toFixed(1)} m`}</b></div><div style="grid-column:1/-1"><span>Altitude reference</span><b>${esc(rover ? 'n/a' : a.altRef)}</b></div><div><span>Battery</span><b>${a.batteryV.toFixed(2)} V · ${a.batteryPct}%</b></div><div><span>Link 433 MHz SiK</span><b>${a.rssiDbm} dBm</b></div><div><span>EKF</span><b>${esc(a.ekf)}</b></div><div><span>GPS</span><b>${a.sats} sats · HDOP ${a.hdop.toFixed(1)}</b></div>${S.mode === 'demo' ? '<div style="grid-column:1/-1"><span>Source</span><b>simulated (demo)</b></div>' : ''}` : '<div><span>Telemetry</span><b>waiting…</b></div>';
  const st = clientFilter?.stats;
  set('gpsBadge', S.visitor ? `${S.visitor.matched?.offRoute ? 'Off route' : S.visitor.matched?.ambiguous ? 'Ambiguous match, keeping last position' : 'Matched to the route'} · ±${Math.round(S.visitor.accuracyM)} m · ${st?.rejected || 0} fix${st?.rejected === 1 ? '' : 'es'} rejected${st?.reasons?.implausible_jump ? ` (${st.reasons.implausible_jump} jumps)` : ''}${S.mode === 'demo' ? ' · simulated phone' : ''}` : 'No position yet');
  const sp = sheet.querySelector('[data-k=spark]');
  if (sp) {
    const pts = S.spark.map((v, i) => `${(i / 59 * 240).toFixed(1)},${(38 - Math.min(v, 30) / 30 * 36).toFixed(1)}`).join(' ');
    const amber = (S.spark.at(-1) || 0) >= CONFIG.heartbeatAmberS;
    sp.innerHTML = `<line x1="0" x2="240" y1="${38 - CONFIG.heartbeatAmberS / 30 * 36}" y2="${38 - CONFIG.heartbeatAmberS / 30 * 36}" stroke="var(--caution)" stroke-dasharray="3 3" stroke-width="1"/><polyline points="${pts}" fill="none" stroke="${amber ? 'var(--caution)' : 'var(--accent)'}" stroke-width="2"/>`;
  }
  const fk = sheet.querySelector('[data-k=freshKv]');
  if (fk) fk.innerHTML = `<dt>Last valid phone position</dt><dd>${esc(ago(fresh.ageS('valid', now)))}</dd><dt>Last position confirmed by ground</dt><dd>${esc(ago(fresh.ageS('delivered', now)))}</dd><dt>Last ground-station message</dt><dd>${esc(ago(fresh.ageS('ground', now)))}</dd><dt>Last aircraft telemetry</dt><dd>${esc(ago(fresh.ageS('aircraft', now)))}</dd><dt>Samples sent / confirmed</dt><dd>${S.sharing.sent} / ${S.sharing.acked}</dd>`;
  set('dirMode', heading.state === 'active' ? 'Direction shown relative to your phone' : heading.state === 'denied' ? 'Compass permission denied: direction relative to north' : heading.state === 'unavailable' ? 'No compass reading: direction relative to north' : 'Direction shown relative to north');
  const ev = sheet.querySelector('[data-k=events]');
  if (ev) { const html = S.events.slice(-6).reverse().map(e => `<li>${esc(e.text)}</li>`).join(''); if (ev.innerHTML !== html) ev.innerHTML = html; }
}

/* ---------- HUD: sky bearing + pacing reticle ---------- */
function updateHud() {
  if (S.screen !== 'guidance') return;
  const now = provider.now(), a = S.aircraft, v = S.visitor, m = S.mission || {}, rover = settings.get('rover', false);
  const you = v?.ll || v?.rawLL;
  let line = 'Waiting for positions', sub = 'Shown once both are fresh', rot = 0, label = 'Direction to NAVI appears once both positions are fresh.';
  const fresh2 = a && you && fresh.ageS('aircraft', now) < 5 && fresh.ageS('valid', now) < 15;
  if (fresh2) {
    const brg = bearing(you, a.ll), dist = haversine(you, a.ll), elev = rover ? 0 : Math.atan2(a.altM, Math.max(1, dist)) * 180 / Math.PI;
    const useCompass = heading.state === 'active' && heading.heading != null;
    rot = useCompass ? brg - heading.heading : brg;
    line = `${Math.round(dist)} m · ${cardinal(brg)} ${Math.round(brg)}°`;
    sub = `${rover ? 'Ground robot' : `Look up ${Math.round(elev)}°`} · ${useCompass ? 'phone-relative' : 'north-up'}`;
    label = `${rover ? 'Robot' : 'NAVI'} is ${Math.round(dist)} metres away, bearing ${Math.round(brg)} degrees ${cardinal(brg)}${rover ? '' : `, ${Math.round(elev)} degrees above the horizon at ${a.altM.toFixed(0)} m (${S.mode === 'demo' ? 'simulated' : a.altRef || 'reference unknown'})`}. Arrow ${useCompass ? 'relative to your phone' : 'relative to north'}.`;
  }
  const waiting = m.status === 'waiting';
  const lead = m.leadM == null ? null : Math.max(0, m.leadM), sc = 46 / 30;
  const dotY = lead == null ? null : -Math.min(48, lead * sc);
  const html = `<div class="sky" role="img" aria-label="${esc(label)}"><div class="arrow"><svg viewBox="-12 -12 24 24" style="transform:rotate(${Math.round(rot)}deg)"><path d="M0 -10 L6 7 L0 3 L-6 7Z" fill="currentColor"/></svg></div><div style="min-width:0"><b>${esc(line)}</b><small>${esc(sub)}</small></div></div>
    <div class="reticle ${waiting ? 'waiting' : ''}" role="img" aria-label="${esc(lead == null ? 'Lead unknown' : `Lead about ${Math.round(lead)} metres; target ${CONFIG.leadTargetM}`)}"><div class="sweep"></div>
      <svg viewBox="-52 -52 104 104"><circle r="${CONFIG.holdGapM * sc}" fill="none" stroke="var(--caution)" stroke-opacity=".5" stroke-dasharray="2 4"/><circle class="ring-target" r="${CONFIG.leadTargetM * sc}" fill="none" stroke="var(--accent)" stroke-width="1.5"/><circle r="8" fill="none" stroke="var(--ok)" stroke-width="2.5"/>${dotY == null ? '' : `<circle cy="${dotY.toFixed(1)}" r="5" fill="${waiting ? 'var(--caution)' : 'var(--drone)'}"/>`}<text y="46" text-anchor="middle" font-size="10" fill="var(--text2)" font-family="var(--mono)">${lead == null ? '—' : Math.round(lead) + ' m'}</text></svg></div>`;
  if (hudEl.innerHTML !== html) hudEl.innerHTML = html;
}

/* ---------- alerts ---------- */
function computeBanners() {
  const now = provider.now(), out = [], m = S.mission || {}, a = S.aircraft, inSession = ['dispatch', 'guidance'].includes(S.screen);
  const flying = ['takeoff', 'leading', 'waiting', 'paused', 'operator', 'returning', 'landing'].includes(m.status);
  const add = (id, level, ic, title, body, action) => out.push({ id, level, ic, title, body, action });
  if (S.mode === 'live' && S.conn !== 'connected') add('noconn', 'critical', 'link-off', 'No NAVI ground station at this address', 'Route planning still works on this phone, but guided trips need the campus ground station.', { act: 'use-demo', label: 'Use demo' });
  if (S.mode === 'live' && navigator.onLine === false) add('offline', 'caution', 'link-off', 'You are offline', 'Saved routes can be viewed. New guide requests are disabled until you reconnect.');
  const abort = [...S.commands.values()].find(c => c.type === 'abort' && (c.state === 'unconfirmed' || c.state === 'failed'));
  if (abort) add('abort', 'critical', 'alert', 'Could not confirm the request.', 'Stay clear of the aircraft and contact the operator.', { act: 'estop', label: 'Send again' });
  const rejected = [...S.commands.values()].reverse().find(c => c.state === 'rejected' && Date.now() - c.doneAt < 15000);
  if (rejected) add('rejected-' + rejected.commandId, 'caution', 'alert', `“${cmdLabel(rejected.type)}” was not accepted`, commandReason(rejected.reason) || 'The ground station declined the request.');
  const otherUnconf = [...S.commands.values()].find(c => c.type !== 'abort' && c.state === 'unconfirmed');
  if (otherUnconf) add('cmd', 'caution', 'alert', 'Could not confirm the request.', `Your “${cmdLabel(otherUnconf.type)}” request was not acknowledged. Check the status before trying again.`);
  if (inSession && S.sharing.status !== 'off' && (S.link === 'down' || fresh.ageS('ground', now) > 8)) add('ground', 'critical', 'link-off', 'Lost connection to the ground station', 'NAVI follows its own safety rules (hold, then return). Stay clear of it and contact the operator if this does not recover.');
  if (S.sharing.status === 'error') add('share', 'critical', 'phone', 'Location sharing is not working', S.sharing.error || '', { act: 'operator-help', label: 'Get help' });
  if (inSession && S.sharing.stoppedByVisitor && S.sharing.status === 'off' && !TERMINAL.has(S.request?.state) && !['landing', 'landed', 'ended'].includes(m.status)) add('shareoff', 'critical', 'phone', 'Location sharing is off', 'NAVI cannot pace you, so it holds and then returns to its pad. Share again, or ask the operator to assist.', { act: 'share', label: 'Share again' });
  const staleS = fresh.ageS('valid', now);
  if (inSession && S.sharing.status !== 'off' && Number.isFinite(staleS) && staleS > CONFIG.staleWarnS && !S.sharing.handedOver) {
    if (m.status === 'paused') add('stale', 'info', 'clock', `No position from your phone for ${Math.round(staleS)} s`, 'NAVI is paused and waiting. Keep this page open so it can find you when you resume.');
    else add('stale', 'critical', 'clock', `No position from your phone for ${Math.round(staleS)} s`, 'NAVI is holding position and will return to its pad if updates do not resume. Keep this page open and the screen on.');
  } else if (inSession && S.sharing.status === 'waiting' && S.sharing.sent > 4 && !S.sharing.acked) add('unack', 'caution', 'phone', 'Waiting for the ground station to confirm your position', 'Sharing becomes active once a position is confirmed.');
  if (S.screen === 'guidance' && S.visitor?.quality === 'poor') add('acc', 'caution', 'locate', `Your position is approximate (±${Math.round(S.visitor.accuracyM)} m)`, 'Move into the open if you can. NAVI holds when positions disagree.');
  if (S.screen === 'guidance' && S.visitor?.matched?.offRoute && flying) add('offroute', 'caution', 'walk', 'You seem to be off the route', 'Walk back to the path NAVI is following. It waits for you.');
  if (inSession && flying && a && fresh.ageS('aircraft', now) > 3) add('air', 'caution', 'drone', `Aircraft position not updating (${ago(fresh.ageS('aircraft', now))})`, 'The marker shows its last known position. The aircraft follows its onboard failsafes. Stay clear of it.');
  // Without wake-lock support the note in the sheet says to keep the screen on; a banner is raised only when a held lock is lost.
  if (S.screen === 'guidance' && flying && S.wake === 'released') add('wake', 'caution', 'phone', 'Your screen may turn off', 'Tap the page to keep it awake. NAVI cannot track you when the browser is in the background.');
  else if (S.screen === 'guidance' && flying && S.sharing.status !== 'off' && ['unsupported', 'denied'].includes(S.wake)) add('wake', 'info', 'phone', 'This browser cannot keep the screen on', 'Keep this page open and the screen on while walking, or NAVI will stop receiving your position.');
  if (S.screen === 'guidance' && a && a.batteryPct < 30 && flying) add('batt', 'caution', 'bolt', 'NAVI battery is low', 'It may end guidance early and return to its pad.');
  if (S.screen === 'guidance' && a?.ekf === 'DEGRADED') add('ekf', 'caution', 'alert', 'NAVI’s own GPS is degraded', 'It is holding position and may land where it is. Stay clear.');
  if (S.screen === 'guidance' && /Geofence|corridor/.test(m.holdReason || '')) add('fence', 'caution', 'alert', 'NAVI drifted near the campus boundary', 'It has stopped and is moving back inside the campus corridor.');
  if (S.screen === 'guidance' && S.sharing.handedOver) add('handover', 'info', 'user', 'The operator is assisting', 'Their device now provides your position. Your phone’s position is not being used.');
  if (S.screen === 'guidance' && m.status === 'interrupted') add('interrupted', 'critical', 'user', 'Guidance interrupted. Wait for the operator.', `${m.holdReason || 'The next leg cannot start yet'}. Stay at the pad; do not continue on your own.`);
  if (S.screen === 'guidance' && m.status === 'operator') add('rc', 'info', 'user', 'The safety operator has control', m.holdReason ? humanReason(m.holdReason) : 'Follow the operator’s instructions.');
  if (S.screen === 'guidance' && m.status === 'landing' && S.arrival.reached) add('arrived', 'info', 'flag', `You have reached ${S.plan.destination.name}`, `NAVI is returning to land at ${campus.pad(m.landingPad)?.name || 'its pad'}. Stay clear until it lands.`);
  if (S.notice && Date.now() < S.notice.until) add('notice', 'info', 'info', S.mode === 'demo' ? 'Switched to demo mode' : 'Switched to live mode', S.notice.text);
  const rank = { critical: 0, caution: 1, info: 2 };
  return out.filter(b => !S.dismissed.has(b.id)).sort((x, y) => rank[x.level] - rank[y.level]).slice(0, 3);
}
function updateBanners() {
  if (!provider) return;
  const list = computeBanners();
  const key = (S.bannerOpen || '') + '#' + list.map(b => b.id + b.title + b.body).join('|');
  appEl.classList.toggle('calm', list.some(b => b.level === 'critical'));
  if (key === S.bannerKey) return;
  const prevIds = new Set(S.banners.map(b => b.id));
  S.banners = list; S.bannerKey = key;
  // The most important banner is shown in full; the others collapse to their title and expand on tap.
  const open = list.some(b => b.id === S.bannerOpen) ? S.bannerOpen : list[0]?.id;
  bannersEl.innerHTML = list.map(b => `<div class="banner ${b.level}${b.id === open ? '' : ' compact'}" role="${b.level === 'critical' ? 'alert' : 'status'}">${icon(b.ic)}<div>${b.id === open ? `<b>${esc(b.title)}</b><span>${esc(b.body)}</span>` : `<button class="banner-title" data-act="banner-open" data-id="${b.id}" aria-expanded="false"><b>${esc(b.title)}</b><span class="sr-only">${esc(b.body)}</span></button>`}</div>${b.action ? `<button class="btn" data-act="${b.action.act}">${esc(b.action.label)}</button>` : b.level !== 'critical' ? `<button class="icon-btn" data-act="dismiss" data-id="${b.id}" aria-label="Dismiss: ${esc(b.title)}">${icon('close')}</button>` : ''}</div>`).join('');
  for (const b of list) if (!prevIds.has(b.id)) { announce(`${b.title}. ${b.body}`, b.level === 'critical' ? 'assertive' : 'polite'); if (b.level === 'critical') haptic('alert'); }
}
ACTIONS.dismiss = b => { S.dismissed.add(b.dataset.id); S.bannerKey = null; updateBanners(); };
ACTIONS['banner-open'] = b => { S.bannerOpen = b.dataset.id; updateBanners(); };
ACTIONS['use-demo'] = () => setMode('demo');

/* ============================================================ overlays */
let overlayReturn = null;
function openOverlay(kind) {
  const same = !overlay.hidden && overlay.dataset.kind === kind;
  if (!same) overlayReturn = document.activeElement;
  // Re-rendering the open dialog keeps its scroll position and the focused control.
  const scroll = same ? overlay.querySelector('.dialog')?.scrollTop : 0;
  const f = same && document.activeElement?.closest?.('#overlay') ? document.activeElement : null;
  const fKey = f && `[data-act="${f.dataset.act}"]${f.dataset.k ? `[data-k="${f.dataset.k}"]` : ''}`;
  overlay.hidden = false; overlay.dataset.kind = kind;
  overlay.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">${OVERLAYS[kind]()}</div>`;
  const dlg = overlay.querySelector('.dialog');
  if (same) { dlg.scrollTop = scroll; (fKey && overlay.querySelector(fKey) || dlg).focus?.({ preventScroll: true }); return; }
  overlay.querySelector('h2')?.setAttribute('tabindex', '-1');
  overlay.querySelector('h2')?.focus();
}
/** Refresh a dialog after a delayed change, but only if the visitor still has it open. */
function refreshOverlay(kind) { if (!overlay.hidden && overlay.dataset.kind === kind) openOverlay(kind); }
function closeOverlay() { overlay.hidden = true; overlay.innerHTML = ''; overlayReturn?.focus?.({ preventScroll: true }); overlayReturn = null; }
const head = title => `<div class="between"><h2 id="dlg-title">${esc(title)}</h2><button class="icon-btn" data-act="close" aria-label="Close">${icon('close')}</button></div>`;
const sw = (act, on, label, extra = '') => `<div class="toggle-row"><span>${label}</span><button class="switch" role="switch" data-act="${act}" ${extra} aria-checked="${!!on}" aria-label="${esc(label.replace(/<[^>]+>/g, ''))}"></button></div>`;

const OVERLAYS = {
  privacy: () => `${head('Share your location?')}
    <p class="lead">So NAVI can lead at your walking pace, this phone shares your position while you are being guided.</p>
    <dl class="kv" style="grid-template-columns:auto 1fr"><dt>What</dt><dd style="text-align:left;font-family:var(--body)">Position, its accuracy and the time it was measured</dd><dt>Why</dt><dd style="text-align:left;font-family:var(--body)">To keep NAVI about ${CONFIG.leadTargetM} m ahead and to stop when you stop</dd><dt>Who</dt><dd style="text-align:left;font-family:var(--body)">${S.mode === 'demo' ? 'Nobody: the demo runs only in this browser' : 'The NAVI ground station on the campus network and its operator'}</dd><dt>How long</dt><dd style="text-align:left;font-family:var(--body)">Until you finish or end guidance. Session data is then deleted.</dd></dl>
    ${S.mode === 'demo' ? '<p class="note" style="margin-top:12px">Demo: a simulated visitor walks the route instead of your real position.</p>' : '<p class="note" style="margin-top:12px">Keep this page open while walking. Phones may stop reporting position when the screen is locked.</p>'}
    <div class="btn-row" style="margin-top:16px"><button class="btn" data-act="close">Not now</button><button class="btn primary" data-act="share-yes">Share my location</button></div>`,
  stopshare: () => `${head('Stop sharing your location?')}<p class="lead">Without your position NAVI cannot pace you. It will hold where it is and, if sharing does not resume within about a minute, return to land at its launch pad.</p><p>The operator can assist with their own device. You can share again at any time.</p><div class="btn-row" style="margin-top:14px"><button class="btn" data-act="close">Keep sharing</button><button class="btn primary" data-act="stop-share-yes">Stop sharing</button></div>`,
  end: () => `${head('End guidance?')}<p class="lead">NAVI will stop guiding and return to land at its launch pad. Stay clear of it.</p><div class="btn-row"><button class="btn" data-act="close">Keep going</button><button class="btn primary" data-act="end-yes">End guidance</button></div>`,
  operator: () => `${head('Operator assistance')}<p class="lead">During supervised trials a NAVI team member walks with you, holding the FlySky FS-i6X radio. They can hold the aircraft, take manual control or land it.</p>
    <p>If something feels wrong, stop walking and speak to them. For an immediate stop, use <b>Emergency stop guidance</b>; it asks the ground station to end guidance and bring the aircraft back.</p>
    <p class="note" style="margin-top:12px">If your phone cannot share location, the operator’s own device can take over as the position source. That handover is done by the operator, not from this phone.</p>
    <button class="btn block" style="margin-top:14px" data-act="close">OK</button>`,
  shield: () => `${head('Supervised autonomy')}<p class="lead">${S.mode === 'demo' ? 'Demo: this describes how real trials will run.' : 'This ground station runs supervised trials.'}</p><ul class="checks"><li class="ok">${icon('shield')}<span>The aircraft flies the route itself.</span></li><li class="ok">${icon('user')}<span>A safety observer is nearby with an independent FS-i6X radio link.</span></li><li class="info">${icon('info')}<span>Unattended kiosk operation comes only after many supervised flights and written campus permission.</span></li></ul><button class="btn block" style="margin-top:14px" data-act="close">OK</button>`,
  layers: () => `${head('Map')}
    <p class="section-label">Base map</p>
    <div class="seg" role="group" aria-label="Base map">${[['path', 'Paths only'], ['satellite', 'Satellite'], ['streets', 'Streets']].map(([k, l]) => `<button data-act="base" data-k="${k}" aria-pressed="${map.baseKey === k}">${l}</button>`).join('')}</div>
    <p class="small muted" style="margin-top:6px">Paths-only works offline. Satellite (© Esri) and street (© OpenStreetMap) tiles load from the internet and are not stored for offline use.</p>
    <p class="section-label">Layers</p>
    ${sw('layer', S.layers.pads !== false, `Pads (${campus.pads.length}, proposed sites)`, 'data-k="pads"')}
    ${sw('layer', S.layers.buffer, '40 m buffered boundary', 'data-k="buffer"')}
    ${sw('layer', S.layers.network, `Path network (${campus.stats.segments} segments)`, 'data-k="network"')}
    ${sw('layer', S.layers.nodes, `Graph nodes (${campus.stats.nodes})`, 'data-k="nodes"')}
    <details style="margin-top:10px"><summary class="small">List of pads (${campus.pads.length})</summary>
      <p class="small muted" style="margin:6px 0">Every pad is a proposed site: placement pending inspection. Diamonds on the map; a number in a circle groups nearby pads (tap to zoom).</p>
      <ul class="small" style="padding-left:18px;margin:0;color:var(--text2)">${[...campus.pads].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<li><b style="color:var(--text)">${esc(p.name)}</b> · ${esc({ source: 'source pad', destination: 'building entrance', gate: 'gate', junction: 'path junction' }[p.kind] || p.kind)}${p.serves?.length ? ` · serves ${esc(p.serves.map(id => campus.destination(id)?.name).join(', '))}` : ''}${p.shared ? ' · shared entrance' : ''} · ${esc(map.padStatus[p.id] || 'unknown')}</li>`).join('')}</ul></details>
    <p class="small muted" style="margin-top:10px">Computed from data ${esc(campus.version)}: ${campus.stats.nodes} nodes, ${campus.stats.segments} segments, ${campus.stats.networkKm.toFixed(2)} km. The source reports ${campus.raw.sourceReported.segments} segments and ${campus.raw.sourceReported.networkKm} km for the full ${campus.raw.sourceReported.surveyedNodes}-node survey.</p>`,
  settings: () => `${head('Settings')}
    <p class="section-label">Mode</p>
    <div class="seg" role="group" aria-label="Mode"><button data-act="mode" data-k="demo" aria-pressed="${S.mode === 'demo'}">Demo</button><button data-act="mode" data-k="live" aria-pressed="${S.mode === 'live'}">Live ground station</button></div>
    <p class="small muted" style="margin-top:6px">Live mode connects only to a NAVI ground station serving this page. Switching ends the current session.</p>
    <p class="section-label">Display</p>
    <div class="seg" role="group" aria-label="Theme">${[['system', 'System'], ['dark', 'Dark'], ['light', 'Daylight']].map(([k, l]) => `<button data-act="theme" data-k="${k}" aria-pressed="${settings.get('theme', 'system') === k}">${l}</button>`).join('')}</div>
    ${sw('set', settings.get('sound', true), 'Arrival chime', 'data-k="sound"')}
    ${sw('set', settings.get('haptics', true), 'Vibration', 'data-k="haptics"')}
    ${sw('set', settings.get('slide', false), 'Slide to confirm guide requests', 'data-k="slide"')}
    ${sw('set', settings.get('rover', false), 'Backup ground robot (rover mode)', 'data-k="rover"')}
    <p class="small muted" style="margin-top:6px">Rover mode is for demonstrations with the 4WD ESP32 robot. Robot-unsuitable edges such as kerbs are not marked in the data yet.</p>
    ${S.mode === 'demo' ? `<p class="section-label">Demo speed</p><div class="seg" role="group" aria-label="Demo speed">${[1, 3, 6].map(x => `<button data-act="speed" data-k="${x}" aria-pressed="${settings.get('demoSpeed', 1) === x}">×${x}</button>`).join('')}</div>` : ''}
    <p class="section-label">Privacy</p>
    ${sw('set', settings.get('diagnostics', false), 'Keep a diagnostic log on this phone', 'data-k="diagnostics"')}
    <p class="small muted">Off by default. Nothing is sent to analytics or a public cloud service.</p>
    <button class="btn block" style="margin-top:10px" data-act="clear-favs">Clear saved destinations</button>
    <button class="btn ghost block" style="margin-top:6px" data-act="about">About NAVI</button>
    <p class="small muted" style="margin-top:10px">Version ${APP_VERSION} · campus data ${esc(campus.version)}</p>`,
  about: () => `${head('About NAVI')}
    <img class="about-img" src="img/design-model.webp" alt="Render of the NAVI F450 quadcopter design model" loading="lazy">
    <p class="figcap">DESIGN MODEL · NOMINAL GEOMETRY · NOT A PHOTOGRAPH</p>
    <p style="margin-top:12px">NAVI (Navigation Assistant for Visitor Interaction) is a student project at VIT Chennai across SMEC (mechanical), SENSE (electronics) and SCOPE (computer science). An autonomous quadcopter leads visitors along surveyed campus paths at their walking pace.</p>
    <p class="section-label">Planned hardware</p>
    <ul class="small" style="padding-left:18px;margin:0;color:var(--text2)"><li>F450 frame, 4 × A2212 1000KV motors, 4 × discrete 30A ESCs, 1045 propellers</li><li>SpeedyBee F405 V3 flight controller (FC only) running ArduPilot</li><li>NEO-M8N GPS with compass on a mast</li><li>FlySky FS-i6X radio with iA6B receiver for the safety operator</li><li>3S 3300 mAh LiPo (XT60); SiK 433 MHz telemetry or an ESP32 bridge</li><li>All route planning and pacing on the ground station; no onboard computer</li></ul>
    <p class="note" style="margin-top:12px">Status: design and simulation. The hardware has not been assembled or flown; endurance, positioning and pad figures are planning estimates.</p>
    <p class="small muted" style="margin-top:10px">Campus boundary © OpenStreetMap contributors (ODbL). Paths and entrances from the VIT Chennai Way Finder dataset. Fonts: Inter, Space Grotesk, JetBrains Mono (OFL). Map: Leaflet (BSD-2).</p>`,
  demo: () => {
    const pend = provider.pending?.(), pads = provider.padStatus?.() || {}, w = provider.walker, f = new Set(provider.faults?.() || []);
    return `${head('Demo controls')}<p class="small muted">Everything here is simulated in this browser.</p>
    <p class="section-label">Operator</p>
    ${sw('demo-auto', provider.gs.autoApprove, 'Auto-approve requests')}
    <div class="btn-row" style="margin-top:8px"><button class="btn" data-act="demo-decide" data-v="1" ${pend ? '' : 'disabled'}>Approve</button><button class="btn" data-act="demo-decide" data-v="0" ${pend ? '' : 'disabled'}>Decline</button></div>
    <p class="section-label">Aircraft</p>
    ${sw('demo-aircraft', (provider.resources?.().aircraftAvailable ?? 1) > 0 || !!S.mission, 'Guide aircraft available')}
    <p class="section-label">Pads on ${S.plan?.pads ? 'this route' : 'the network'}</p>
    <p class="small muted">${S.plan?.pads ? 'Preview the route again after a change.' : 'Choose a destination to see the pads on its route.'} All pads are proposed sites (simulated readiness).</p>
    ${(S.plan?.pads ? S.plan.pads.map(x => campus.pad(x.id)) : campus.pads.filter(p => p.kind === 'source')).map(p => sw('demo-pad', pads[p.id] !== 'unavailable', `${esc(p.name)} <span class="muted small">(${esc(pads[p.id])})</span>`, `data-k="${p.id}"`) + sw('demo-handoff', provider.resources?.().padHandoff[p.id], `↳ handoff crew at ${esc(p.name)}`, `data-k="${p.id}"`)).join('')}
    <button class="btn block" style="margin-top:8px" data-act="demo-pads-reset">Make every pad ready and staffed</button>
    <p class="section-label">Simulated visitor</p>
    <div class="seg" role="group" aria-label="Visitor walking">${['walk', 'slow', 'stop'].map(k => `<button data-act="demo-walk" data-k="${k}" aria-pressed="${w?.behaviour === k}" ${w ? '' : 'disabled'}>${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
    ${sw('demo-visitor', w?.dropout, 'Phone stops reporting (stale)', 'data-k="dropout"')}
    ${sw('demo-visitor', w?.offRoute, 'Walk 45 m off the route', 'data-k="offRoute"')}
    <button class="btn block" style="margin-top:8px" data-act="demo-spike" ${w ? '' : 'disabled'}>Inject a position spike</button>
    <p class="section-label">Aircraft and links</p>
    ${[['aircraft_link', 'Aircraft telemetry lost'], ['gps_ekf', 'Aircraft GPS / EKF degraded'], ['low_battery', 'Battery below reserve'], ['geofence', 'Gust pushes aircraft past the fence'], ['rc_link', 'RC link lost']].map(([k, l]) => sw('demo-fault', f.has(k), l, `data-k="${k}"`)).join('')}
    ${sw('demo-rc', S.mission?.status === 'operator', 'Operator takes manual radio control')}
    ${sw('demo-handover', S.source === 'operator-device', 'Operator device becomes position source')}
    ${sw('demo-link', provider.linkDown, 'Phone ↔ ground station link down')}
    ${sw('demo-wake', S.wake === 'released', 'Screen wake lock released')}`;
  }
};
Object.assign(ACTIONS, {
  base: b => { setBase(b.dataset.k); openOverlay('layers'); },
  layer: b => { S.layers[b.dataset.k] = b.dataset.k === 'pads' ? S.layers.pads === false : !S.layers[b.dataset.k]; settings.set('layers', S.layers); map.setLayers(S.layers); openOverlay('layers'); },
  mode: async b => { if (b.dataset.k === S.mode) return; closeOverlay(); await setMode(b.dataset.k); },
  theme: b => { settings.set('theme', b.dataset.k); applyTheme(); openOverlay('settings'); },
  set: b => { const k = b.dataset.k; settings.set(k, !settings.get(k, k === 'sound' || k === 'haptics')); if (k === 'sound') unlockAudio(); openOverlay('settings'); render(); },
  speed: b => { settings.set('demoSpeed', +b.dataset.k); provider.setSpeed?.(+b.dataset.k); openOverlay('settings'); },
  'clear-favs': () => { S.favorites.clear(); settings.set('favorites', []); openOverlay('settings'); },
  'demo-auto': () => { provider.setAutoApprove(!provider.gs.autoApprove); openOverlay('demo'); },
  'demo-decide': b => { provider.decide(b.dataset.v === '1'); openOverlay('demo'); },
  'demo-aircraft': () => { const r = provider.resources(); provider.setAircraft(r.aircraftAvailable > 0 ? 0 : 1); openOverlay('demo'); },
  'demo-handoff': b => { provider.setHandoff(b.dataset.k, !provider.resources().padHandoff[b.dataset.k]); refreshPads(); openOverlay('demo'); },
  'demo-pads-reset': () => { for (const p of campus.pads) { if (provider.padStatus()[p.id] !== 'busy') provider.setPad(p.id, 'ready'); provider.setHandoff(p.id, true); } refreshPads(); openOverlay('demo'); },
  'demo-pad': b => { const st = provider.padStatus()[b.dataset.k]; provider.setPad(b.dataset.k, st === 'unavailable' ? 'ready' : 'unavailable'); refreshPads(); openOverlay('demo'); },
  'demo-walk': b => { provider.visitor({ behaviour: b.dataset.k }); openOverlay('demo'); },
  'demo-visitor': b => { const w = provider.walker; if (w) provider.visitor({ [b.dataset.k]: !w[b.dataset.k] }); openOverlay('demo'); },
  'demo-spike': () => { provider.visitor({ spike: true }); },
  'demo-fault': b => { const on = !(provider.faults() || []).includes(b.dataset.k); provider.fault(b.dataset.k, on); openOverlay('demo'); },
  'demo-rc': () => { provider.rcTakeover(S.mission?.status !== 'operator'); setTimeout(() => refreshOverlay('demo'), 400); },
  'demo-handover': () => { provider.handover(S.source === 'operator-device' ? 'visitor' : 'operator-device'); setTimeout(() => refreshOverlay('demo'), 400); },
  'demo-link': () => { provider.setLinkDown(!provider.linkDown); openOverlay('demo'); },
  'demo-wake': () => { if (S.wake === 'released') wake.acquire(); else wake.simulateRelease(); setTimeout(() => refreshOverlay('demo'), 50); }
});

boot();
