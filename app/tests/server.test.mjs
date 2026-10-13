// Mock ground-station API: access control, validation, idempotency and the session stream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { esc } from '../js/ui.js';

const PORT = 18000 + Math.floor(Math.random() * 2000), BASE = `http://127.0.0.1:${PORT}`, OP = 'test-operator-token-0123456789';
let proc;
before(async () => {
  proc = spawn(process.execPath, [new URL('../server/gcs-mock.mjs', import.meta.url).pathname, '--port', String(PORT), '--operator-token', OP], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { proc.stdout.on('data', d => /ground station/.test(d) && resolve()); proc.on('exit', reject); setTimeout(() => reject(new Error('server did not start')), 5000); });
});
after(() => proc?.kill());

const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
  const r = await fetch(BASE + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
};
const gate = { kind: 'pad', ll: [12.840649, 80.153159], nodeId: 111, label: 'Gate Pad' };

/** Tiny WebSocket client (masked frames) so the test controls the Origin header. */
function wsConnect(path, origin = BASE) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request(BASE + path, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', Origin: origin } });
    req.on('response', res => resolve({ rejected: res.statusCode }));
    req.on('upgrade', (res, socket) => {
      const msgs = []; let buf = Buffer.alloc(0), closed = null; const waiters = [];
      socket.on('data', d => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) break;
          const op = buf[0] & 0x0f, data = buf.subarray(off, off + len); buf = buf.subarray(off + len);
          if (op === 1) msgs.push(JSON.parse(data.toString()));
          if (op === 8) closed = data.length >= 2 ? data.readUInt16BE(0) : 1005;
          waiters.splice(0).forEach(f => f());
        }
      });
      socket.on('close', () => { closed ??= 1006; waiters.splice(0).forEach(f => f()); });
      const send = obj => { const p = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4); const h = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]); const m = Buffer.from(p.map((b, i) => b ^ mask[i & 3])); socket.write(Buffer.concat([h, mask, m])); };
      const next = (pred, ms = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const check = () => { const i = msgs.findIndex(pred); if (i >= 0) return res(msgs.splice(i, 1)[0]); if (closed) return res({ closed }); if (Date.now() - t0 > ms) return rej(new Error('timeout')); waiters.push(check); setTimeout(check, 100); }; check(); });
      resolve({ send, next, close: () => socket.destroy(), get closed() { return closed; } });
    });
    req.on('error', reject); req.end();
  });
}

test('health identifies a NAVI ground station with a simulated aircraft', async () => {
  const r = await call('/api/health');
  assert.equal(r.json.service, 'navi-gcs');
  assert.equal(r.json.aircraftSource, 'simulated');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

test('static files: app served, server code and traversal refused', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await fetch(BASE + '/server/gcs-mock.mjs')).status, 404);
  assert.equal((await fetch(BASE + '/tests/server.test.mjs')).status, 404);
  assert.equal((await fetch(BASE + '/..%2fpackage.json')).status, 404);
  assert.equal((await fetch(BASE + '/%2e%2e/%2e%2e/etc/passwd')).status, 404);
});

test('cross-origin state changes are refused', async () => {
  const r = await call('/api/visitor-sessions', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('visitor flow: validation, idempotent request, session isolation', async () => {
  const a = (await call('/api/visitor-sessions', { method: 'POST', body: {} })).json;
  const b = (await call('/api/visitor-sessions', { method: 'POST', body: {} })).json;
  assert.equal((await call('/api/routes/preview', { method: 'POST', body: { origin: gate, destinationId: 'gazebo' } })).status, 401, 'no token');
  assert.equal((await call('/api/routes/preview', { method: 'POST', token: a.token, body: { origin: { ll: [999, 0] }, destinationId: 'gazebo' } })).status, 400);
  assert.equal((await call('/api/routes/preview', { method: 'POST', token: a.token, body: { origin: gate, destinationId: '<script>' } })).json.error, 'unknown_destination');
  const plan = (await call('/api/routes/preview', { method: 'POST', token: a.token, body: { origin: { ...gate, label: '<img src=x onerror=alert(1)>' }, destinationId: 'gazebo' } })).json;
  assert.equal(plan.availability, 'available');
  assert.equal((await call('/api/guide-requests', { method: 'POST', token: a.token, body: { routeId: plan.routeId } })).status, 400, 'idempotency key required');
  const h = { 'Idempotency-Key': 'key-1' };
  const r1 = (await call('/api/guide-requests', { method: 'POST', token: a.token, headers: h, body: { routeId: plan.routeId, idempotencyKey: 'key-1' } })).json;
  const r2 = (await call('/api/guide-requests', { method: 'POST', token: a.token, headers: h, body: { routeId: plan.routeId, idempotencyKey: 'key-1' } })).json;
  assert.equal(r1.requestId, r2.requestId);
  assert.equal((await call('/api/guide-requests', { method: 'POST', token: b.token, headers: h, body: { routeId: plan.routeId, idempotencyKey: 'key-1' } })).json.state, 'UNAVAILABLE', 'another session cannot use this route');
  assert.equal((await call(`/api/sessions/${a.sessionId}/actions`, { method: 'POST', token: b.token, body: { commandId: 'x', type: 'abort' } })).status, 401, 'session B cannot command session A');
  assert.equal((await call(`/api/visitor-sessions/${a.sessionId}`, { method: 'DELETE', token: b.token })).status, 401);
  assert.equal((await call(`/api/sessions/${a.sessionId}/cancel`, { method: 'POST', token: a.token, body: {} })).json.state, 'CANCELLED');
});

test('operator endpoints need the operator token', async () => {
  assert.equal((await call('/api/operator/sessions')).status, 401);
  const s = (await call('/api/visitor-sessions', { method: 'POST', body: {} })).json;
  assert.equal((await call('/api/operator/sessions', { token: s.token })).status, 401, 'a visitor token is not an operator token');
  assert.equal((await call('/api/operator/handover', { method: 'POST', token: s.token, body: { sessionId: s.sessionId, source: 'operator-device' } })).status, 401);
  const ok = await call('/api/operator/sessions', { token: OP });
  assert.equal(ok.status, 200); assert.ok(Array.isArray(ok.json.sessions));
  const h = await call('/api/operator/handover', { method: 'POST', token: OP, body: { sessionId: s.sessionId, source: 'operator-device' } });
  assert.equal(h.json.source, 'operator-device');
});

test('session stream: origin check, auth in the first message, snapshot, sample acks', async () => {
  const s = (await call('/api/visitor-sessions', { method: 'POST', body: {} })).json;
  assert.equal((await wsConnect(`/api/sessions/${s.sessionId}/stream`, 'https://evil.example')).rejected, 403);
  const bad = await wsConnect(`/api/sessions/${s.sessionId}/stream`);
  bad.send({ type: 'auth', token: 'wrong' });
  assert.equal((await bad.next(() => false)).closed, 4003);
  const ws = await wsConnect(`/api/sessions/${s.sessionId}/stream`);
  ws.send({ type: 'auth', token: s.token });
  const snap = await ws.next(m => m.type === 'snapshot');
  assert.equal(snap.source, 'visitor');
  const t = Date.now();
  ws.send({ type: 'sample', sample: { seq: 1, lat: 12.8406, lon: 80.1532, accuracyM: 9, timestamp: t, speed: null, heading: null } });
  assert.equal((await ws.next(m => m.type === 'sampleAck' && m.seq === 1)).accepted, true);
  ws.send({ type: 'sample', sample: { seq: 1, lat: 12.8406, lon: 80.1532, accuracyM: 9, timestamp: t } });
  const dup = await ws.next(m => m.type === 'sampleAck' && m.seq === 1);
  assert.equal(dup.accepted, false, 'replayed sample rejected');
  ws.send({ type: 'sample', sample: { seq: 'x', lat: 'a' } });
  assert.equal((await ws.next(m => m.type === 'sampleAck' && m.reason === 'invalid_sample')).accepted, false);
  assert.ok(await ws.next(m => m.type === 'heartbeat', 4000));
  ws.close();
});

test('labels are escaped before they reach the page', () => {
  assert.equal(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(esc("O'Neil & co"), 'O&#39;Neil &amp; co');
  assert.equal(esc(null), '');
});
