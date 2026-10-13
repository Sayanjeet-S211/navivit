// Operator console for a NAVI ground station (the bundled mock simulates the aircraft).
// Token-authenticated; the token is kept in sessionStorage for this tab only.
import { DeviceLocation } from './sensors.js';
import { $, esc, announce } from './ui.js';
import { fmtDist } from './config.js';

let token = null, timer = null, data = null, assisting = null; // assisting: { sessionId, loc }
try { token = sessionStorage.getItem('navi.operator'); } catch {}

async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api/' + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'http_' + r.status), { status: r.status });
  return j;
}

$('#signin-form').addEventListener('submit', async e => {
  e.preventDefault();
  token = $('#tok').value.trim();
  try { await call('operator/sessions'); try { sessionStorage.setItem('navi.operator', token); } catch {} start(); }
  catch (err) { $('#signin-err').textContent = err.status === 401 ? 'That token was not accepted.' : err.status === 404 ? 'No NAVI ground station is serving this page.' : 'Could not reach the ground station.'; }
});

function start() {
  $('#signin').hidden = true; $('#console').hidden = false;
  const p = $('#op-pill'); p.className = 'mode-pill live'; p.textContent = 'Operator · signed in';
  poll(); timer = setInterval(poll, 1000);
}

async function poll() {
  try { data = await call('operator/sessions'); render(); $('#op-status').textContent = `Updated ${new Date().toLocaleTimeString()}`; }
  catch (e) {
    $('#op-status').textContent = 'Ground station not reachable: ' + e.message;
    if (e.status === 401) { clearInterval(timer); try { sessionStorage.removeItem('navi.operator'); } catch {} location.reload(); }
  }
}

const fmtAge = s => s == null ? '—' : s < 1 ? 'now' : `${Math.round(s)} s`;
function render() {
  $('#auto').setAttribute('aria-checked', String(data.autoApprove));
  $('#aircraft').textContent = `Aircraft available: ${data.aircraftAvailable}`;
  // Pads in use or with a problem first; everything is a proposed site pending inspection.
  const order = p => (p.status === 'busy' ? 0 : p.status !== 'ready' || !p.handoff ? 1 : 2);
  $('#pads').innerHTML = [...data.pads].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map(p => `<div class="op-pad"><span><b>${esc(p.name)}</b><br><small class="muted">${esc(p.kind)} · ${p.approval === 'approved' ? 'approved' : 'proposed'} · ${esc(p.status)}${p.handoff ? ' · handoff crew' : ' · no handoff'}</small></span>
    <span class="row" style="gap:6px"><label class="sr-only" for="pad-${esc(p.id)}">${esc(p.name)} readiness</label>
    <select id="pad-${esc(p.id)}" data-pad="${esc(p.id)}" ${p.status === 'busy' ? 'disabled' : ''}>${['ready', 'unavailable', 'unknown'].map(s => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}${p.status === 'busy' ? '<option selected>busy</option>' : ''}</select>
    <button class="btn ${p.handoff ? '' : 'on'}" data-handoff="${p.handoff ? 0 : 1}" data-pid="${esc(p.id)}" aria-label="${p.handoff ? 'Mark no handoff crew at' : 'Mark handoff crew at'} ${esc(p.name)}">${p.handoff ? 'Crew' : 'No crew'}</button></span></div>`).join('');
  const list = data.sessions.filter(s => s.request || !s.closed);
  $('#sessions').innerHTML = list.length ? list.map(s => {
    const r = s.request, m = s.mission, a = s.aircraft, f = new Set(s.faults);
    const fault = (k, l) => `<button class="btn ${f.has(k) ? 'on' : ''}" data-fault="${k}" data-sid="${esc(s.sessionId)}" aria-pressed="${f.has(k)}">${l}</button>`;
    return `<article class="op-session">
      <div class="between"><h3>${esc(r?.destination || 'No request yet')}${r?.pad ? ` <small class="muted">from ${esc(r.pad)}</small>` : ''}</h3>${r ? `<span class="op-state ${r.state === 'AWAITING_OPERATOR' ? 'await' : ''}">${esc(r.state)}</span>` : ''}</div>
      <dl class="kv">
        <dt>Mission</dt><dd>${esc(m ? m.status + (m.rc ? ' · RC' : '') + (m.legCount ? ` · leg ${m.legIndex + 1}/${m.legCount}` : '') : '—')}</dd><dt>Hold</dt><dd>${esc(m?.holdReason || '—')}</dd>
        <dt>Visitor progress</dt><dd>${m ? `${fmtDist(m.visitorProgressM)} / ${fmtDist(m.guidedLengthM)}` : '—'}</dd><dt>Lead</dt><dd>${m?.leadM != null && ['leading', 'waiting', 'paused'].includes(m.status) ? Math.round(m.leadM) + ' m' : '—'}</dd>
        <dt>Position source</dt><dd>${esc(s.source)}</dd><dt>Last fix</dt><dd>${s.lastFix ? `±${Math.round(s.lastFix.accuracyM)} m · ${fmtAge(s.lastFix.ageS)}` : '—'}</dd>
        <dt>Aircraft</dt><dd>${a ? `${esc(a.mode)} · ${a.altM.toFixed(1)} m · ${fmtAge(a.ageS)}` : '—'}</dd><dt>Battery / EKF</dt><dd>${a ? `${a.batteryV.toFixed(2)} V ${a.batteryPct}% · ${esc(a.ekf)}` : '—'}</dd>
        <dt>GPS / link</dt><dd>${a ? `${a.sats} sats HDOP ${a.hdop.toFixed(1)} · ${a.rssiDbm} dBm` : '—'}</dd><dt>Session</dt><dd>${s.closed ? 'closed' : 'open'} · seen ${fmtAge(s.lastSeenAgeS)}</dd>
      </dl>
      <div class="btns">
        ${r?.state === 'AWAITING_OPERATOR' ? `<button class="btn primary" data-decide="1" data-rid="${esc(r.requestId)}">Approve</button><button class="btn" data-decide="0" data-rid="${esc(r.requestId)}">Decline</button>` : ''}
        ${m ? `<button class="btn ${m.rc ? 'on' : ''}" data-rc="${m.rc ? 0 : 1}" data-sid="${esc(s.sessionId)}">${m.rc ? 'Hand back from RC' : 'RC takeover'}</button>` : ''}
        ${s.source === 'operator-device' ? `<button class="btn on" data-handover="visitor" data-sid="${esc(s.sessionId)}">Return position source to visitor</button>` : `<button class="btn" data-handover="operator-device" data-sid="${esc(s.sessionId)}">Use this device as position source</button>`}
      </div>
      <details style="margin-top:10px"><summary class="small">Fault injection (simulated aircraft only)</summary><div class="btns">${fault('aircraft_link', 'Telemetry lost')}${fault('gps_ekf', 'GPS/EKF degraded')}${fault('low_battery', 'Low battery')}${fault('geofence', 'Fence breach')}${fault('rc_link', 'RC link lost')}</div></details>
    </article>`;
  }).join('') : '<p class="muted">No sessions yet.</p>';
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !token || b.disabled) return;
  try {
    if (b.dataset.aircraft) await call('operator/aircraft', { method: 'POST', body: { available: data.aircraftAvailable + +b.dataset.aircraft } });
    else if (b.dataset.handoff) await call(`operator/pads/${encodeURIComponent(b.dataset.pid)}`, { method: 'POST', body: { handoff: b.dataset.handoff === '1' } });
    else if (b.id === 'auto') await call('operator/auto-approve', { method: 'POST', body: { on: !data.autoApprove } });
    else if (b.dataset.decide) { await call(`operator/requests/${encodeURIComponent(b.dataset.rid)}/decision`, { method: 'POST', body: { approve: b.dataset.decide === '1' } }); announce(b.dataset.decide === '1' ? 'Approved' : 'Declined'); }
    else if (b.dataset.rc) await call(`operator/sessions/${encodeURIComponent(b.dataset.sid)}/rc`, { method: 'POST', body: { on: b.dataset.rc === '1' } });
    else if (b.dataset.fault) await call(`operator/sessions/${encodeURIComponent(b.dataset.sid)}/faults`, { method: 'POST', body: { name: b.dataset.fault, on: b.getAttribute('aria-pressed') !== 'true' } });
    else if (b.dataset.handover) await handover(b.dataset.sid, b.dataset.handover);
    else return;
    poll();
  } catch (err) { $('#op-status').textContent = 'Action failed: ' + err.message; }
});
document.addEventListener('change', async e => {
  const s = e.target.closest('select[data-pad]'); if (!s) return;
  try { await call(`operator/pads/${encodeURIComponent(s.dataset.pad)}`, { method: 'POST', body: { status: s.value } }); poll(); }
  catch (err) { $('#op-status').textContent = 'Pad update failed: ' + err.message; }
});

/** Handover: this device's own location becomes the visitor position for that session. Fixes are
 *  sent as they arrive and dropped if the request fails; nothing is queued for later. */
async function handover(sessionId, source) {
  if (source === 'operator-device') {
    assisting?.loc.stop();
    const loc = new DeviceLocation({
      onSample: smp => call(`operator/sessions/${encodeURIComponent(sessionId)}/samples`, { method: 'POST', body: { sample: { ...smp, source: 'operator-device' } } }).catch(() => {}),
      onError: code => { $('#op-status').textContent = 'This device cannot share location: ' + code; }
    });
    if (!loc.start()) return;
    assisting = { sessionId, loc };
  } else if (assisting?.sessionId === sessionId) { assisting.loc.stop(); assisting = null; }
  await call(`operator/sessions/${encodeURIComponent(sessionId)}/handover`, { method: 'POST', body: { source } });
}

if (token) call('operator/sessions').then(start).catch(() => { try { sessionStorage.removeItem('navi.operator'); } catch {} });
