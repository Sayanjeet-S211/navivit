// Live provider: talks to an authorised NAVI ground station served from the SAME origin as this
// page (never a URL taken from a QR code or query string). REST for requests, a WebSocket for the
// session stream. A failed connection is reported as disconnected; it never falls back to simulation.
import { Emitter } from './emitter.js';

const EVENT_TYPES = new Set(['dispatch', 'mission', 'aircraft', 'sampleAck', 'command', 'alert', 'source', 'snapshot', 'heartbeat']);

export class LiveProvider extends Emitter {
  constructor(campus, { base = '/api/' } = {}) {
    super();
    this.kind = 'live'; this.campus = campus; this.base = base;
    this.now = () => Date.now();
    this.session = null; this.ws = null; this.backoff = 0; this.closed = false;
    this.info = { kind: 'live', label: 'Ground station', aircraftSource: 'unknown', connected: false };
  }
  destroy() { this.closed = true; this.ws?.close(); }

  async _fetch(path, { method = 'GET', body, headers = {}, timeoutMs = 6000 } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const h = { ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (this.session?.token) h.Authorization = 'Bearer ' + this.session.token;
      const r = await fetch(this.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: h, signal: ctl.signal, credentials: 'same-origin', cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data.error || 'http_' + r.status); e.status = r.status; e.data = data; throw e; }
      return data;
    } finally { clearTimeout(timer); }
  }

  async connect() {
    const h = await this._fetch('health', { timeoutMs: 4000 });
    if (h.service !== 'navi-gcs') throw new Error('not_a_navi_ground_station');
    this.info = { kind: 'live', label: h.label || 'Ground station', aircraftSource: h.aircraftSource || 'unknown', connected: true, campusVersion: h.campusVersion };
    return h;
  }
  async createSession() {
    this.session = await this._fetch('visitor-sessions', { method: 'POST', body: {} });
    this._openStream();
    return this.session;
  }
  _openStream() {
    if (!this.session || this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${this.base}sessions/${encodeURIComponent(this.session.sessionId)}/stream`);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'auth', token: this.session.token })); this.backoff = 0; this.emit('link', { state: 'up' }); };
    ws.onmessage = m => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (!ev || !EVENT_TYPES.has(ev.type)) return;
      this.emit('event', ev);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || !this.session) return;
      this.emit('link', { state: 'down' });
      const wait = [1, 2, 4, 8, 15][Math.min(this.backoff++, 4)] * 1000;
      setTimeout(() => this._openStream(), wait);
    };
  }
  async pads() { return this._fetch('pads'); }
  async previewRoute(body) { return this._fetch('routes/preview', { method: 'POST', body }); }
  async requestGuide(body) {
    // Safe to retry: the server de-duplicates on the idempotency key.
    for (let i = 0; ; i++) {
      try { return await this._fetch('guide-requests', { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }); }
      catch (e) { if (e.status || i >= 2) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
    }
  }
  async cancel() { return this._fetch(`sessions/${encodeURIComponent(this.session.sessionId)}/cancel`, { method: 'POST', body: {} }); }
  async action(type, commandId) {
    const body = { commandId, type };
    if (type === 'abort' && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'action', action: body })); // priority path; the POST below is the confirmed one
    return this._fetch(`sessions/${encodeURIComponent(this.session.sessionId)}/actions`, { method: 'POST', body, timeoutMs: 4000 });
  }
  /** Samples are sent only while the stream is open; stale fixes are never queued for later. */
  sendSample(sample) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ type: 'sample', sample }));
    return true;
  }
  async closeSession() {
    if (!this.session) return { closed: true };
    const id = this.session.sessionId;
    try { return await this._fetch(`visitor-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    finally { this.session = null; const ws = this.ws; this.ws = null; ws?.close(); }
  }
}

export class DisconnectedProvider extends Emitter {
  constructor(reason) { super(); this.kind = 'disconnected'; this.reason = reason; this.now = () => Date.now(); this.info = { kind: 'disconnected', label: 'Not connected', aircraftSource: 'none', connected: false }; }
  destroy() {}
  async connect() { throw new Error(this.reason || 'not_connected'); }
  async createSession() { throw new Error('not_connected'); }
  async pads() { return null; }
  async previewRoute() { throw new Error('not_connected'); }
  async requestGuide() { throw new Error('not_connected'); }
  async cancel() { throw new Error('not_connected'); }
  async action() { throw new Error('not_connected'); }
  sendSample() { return false; }
  async closeSession() { return { closed: true }; }
}
