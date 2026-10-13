#!/usr/bin/env node
// NAVI mock ground station. Serves the visitor app and implements the live API with the SAME
// ground-station core the demo uses. The aircraft is SIMULATED: this server never opens a MAVLink
// link, never talks to a radio and cannot command real equipment. /api/health says so
// (aircraftSource: "simulated") and the app labels the session accordingly.
//
//   node app/server/gcs-mock.mjs [--port 8080] [--host 127.0.0.1] [--cert cert.pem --key key.pem]
//                                [--auto-approve] [--operator-token TOKEN]
//
// Browsers only share location with secure pages: http://localhost works for testing on the same
// machine; phones on the campus network need HTTPS (see app/README.md, "Deployment").
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.mjs';
import { Campus } from '../js/campus.js';
import { CONFIG } from '../js/config.js';
import { GroundStation } from '../js/sim/groundstation.js';
import { isLatLon } from '../js/geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, d) => { const i = args.indexOf('--' + name); return i < 0 ? d : args[i + 1]; };
const flag = name => args.includes('--' + name);

const PORT = +arg('port', 8080), HOST = arg('host', '127.0.0.1');
const CERT = arg('cert'), KEY = arg('key');
// No operator token by default; pass --operator-token (or NAVI_OPERATOR_TOKEN) to require one.
const OPERATOR_TOKEN = arg('operator-token', process.env.NAVI_OPERATOR_TOKEN || null);
const TLS = !!(CERT && KEY);

const campusRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/campus.v1.json'), 'utf8'));
const padsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pads.v1.json'), 'utf8'));
const campus = new Campus(campusRaw, CONFIG, padsRaw);
const gs = new GroundStation({ campus, autoApprove: flag('auto-approve'), aircraftSource: 'simulated' });
const TICK_MS = 100;
setInterval(() => gs.tick(TICK_MS / 1000), TICK_MS).unref?.();

/* ------------------------------------------------------------------ utilities */
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a); // never logs tokens, bodies or positions
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://server.arcgisonline.com https://tile.openstreetmap.org; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};
if (TLS) SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=86400';

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(data);
}
const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });

async function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('content_type_must_be_json'), { status: 415 });
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body_too_large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

/** Token buckets per client address: a cheap guard against floods from a misbehaving page. */
const buckets = new Map();
function allow(key, ratePerS, burst) {
  const now = Date.now(), b = buckets.get(key) || { t: now, n: burst };
  b.n = Math.min(burst, b.n + (now - b.t) / 1000 * ratePerS); b.t = now;
  buckets.set(key, b);
  if (b.n < 1) return false;
  b.n -= 1; return true;
}
setInterval(() => { const cut = Date.now() - 600e3; for (const [k, b] of buckets) if (b.t < cut) buckets.delete(k); }, 60e3).unref?.();

const selfOrigin = req => `${TLS ? 'https' : 'http'}://${req.headers.host}`;
/** Browsers send Origin on cross-site and state-changing requests; refuse anything not from this host. */
const sameOrigin = req => !req.headers.origin || req.headers.origin === selfOrigin(req);

const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isOperator = req => !OPERATOR_TOKEN || safeEq(bearer(req), OPERATOR_TOKEN);
const visitorSession = (req, id) => gs.session(id, bearer(req));

/* ------------------------------------------------------------------ validation */
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = v => typeof v === 'number' && Number.isFinite(v);
function cleanOrigin(o) {
  if (!o || typeof o !== 'object' || !isLatLon(o.ll)) return null;
  const kind = ['measured', 'place', 'pad', 'pin'].includes(o.kind) ? o.kind : 'pin';
  const out = { kind, ll: [o.ll[0], o.ll[1]], label: str(o.label, 80) ? o.label : 'Starting point' };
  if (num(o.accuracyM) && o.accuracyM >= 0 && o.accuracyM < 5000) out.accuracyM = o.accuracyM;
  // A claimed graph node is used only for named places and only if it really is at that point.
  if ((kind === 'place' || kind === 'pad') && Number.isInteger(o.nodeId) && campus.nodes.has(o.nodeId)) {
    const n = campus.node(o.nodeId).ll;
    if (Math.hypot((n[0] - out.ll[0]) * 111320, (n[1] - out.ll[1]) * 111320 * Math.cos(n[0] * Math.PI / 180)) < 30) out.nodeId = o.nodeId;
  }
  return out;
}
function cleanSample(x) {
  if (!x || typeof x !== 'object') return null;
  const s = { seq: x.seq, lat: x.lat, lon: x.lon, accuracyM: x.accuracyM, timestamp: x.timestamp, speed: num(x.speed) ? x.speed : null, heading: num(x.heading) ? x.heading : null, source: str(x.source, 32) ? x.source : 'device' };
  if (!Number.isInteger(s.seq) || s.seq < 0 || !num(s.lat) || !num(s.lon) || !num(s.accuracyM) || !num(s.timestamp)) return null;
  return s; // range checks (coordinates, accuracy, time) are done by the shared sample filter
}

/* ------------------------------------------------------------------ API */
const routes = [];
const route = (method, pattern, handler, { auth = 'none', mutate = method !== 'GET' } = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth, mutate });

route('GET', '/api/health', () => ({ service: 'navi-gcs', label: 'NAVI mock ground station', aircraftSource: 'simulated', campusVersion: campus.version, time: Date.now() }));
route('GET', '/api/campus', () => campusRaw);
route('GET', '/api/pad-config', () => padsRaw);
route('GET', '/api/pads', () => gs.pads());

route('POST', '/api/visitor-sessions', (req, res, p, ip) => {
  if (!allow('session:' + ip, 10 / 60, 10)) return fail(res, 429, 'too_many_sessions');
  return gs.createSession();
});
route('DELETE', '/api/visitor-sessions/:id', (req, res, { s }) => gs.closeSession(s.id), { auth: 'visitor' });
route('POST', '/api/routes/preview', async (req, res, { s }) => {
  const b = await readJson(req), origin = cleanOrigin(b.origin);
  if (!origin) return fail(res, 400, 'invalid_origin');
  if (!str(b.destinationId, 64) || !campus.destination(b.destinationId)) return fail(res, 400, 'unknown_destination');
  return gs.previewRoute(s, { origin, destinationId: b.destinationId });
}, { auth: 'visitor' });
route('POST', '/api/guide-requests', async (req, res, { s }) => {
  const b = await readJson(req), key = req.headers['idempotency-key'];
  if (!str(key, 100) || (b.idempotencyKey && b.idempotencyKey !== key)) return fail(res, 400, 'idempotency_key_required');
  if (!str(b.routeId, 40)) return fail(res, 400, 'invalid_route');
  const r = gs.requestGuide(s, { routeId: b.routeId, idempotencyKey: key });
  return r.error ? fail(res, 409, r.error, { request: r.request }) : r;
}, { auth: 'visitor' });
route('POST', '/api/sessions/:id/cancel', (req, res, { s }) => {
  const r = gs.cancel(s);
  return r.error ? fail(res, 409, r.error) : r;
}, { auth: 'visitor' });
route('POST', '/api/sessions/:id/actions', async (req, res, { s }) => {
  const b = await readJson(req);
  if (!str(b.commandId, 100) || !str(b.type, 10)) return fail(res, 400, 'invalid_command');
  return gs.action(s, { commandId: b.commandId, type: b.type });
}, { auth: 'visitor' });

/* operator */
route('GET', '/api/operator/sessions', () => gs.operatorView(), { auth: 'operator' });
route('POST', '/api/operator/auto-approve', async req => { const b = await readJson(req); gs.autoApprove = !!b.on; return { autoApprove: gs.autoApprove }; }, { auth: 'operator' });
route('POST', '/api/operator/requests/:rid/decision', async (req, res, { params }) => {
  const b = await readJson(req);
  const r = gs.decide(params.rid, !!b.approve, str(b.reason, 160) ? b.reason : null);
  return r.error ? fail(res, 409, r.error) : r;
}, { auth: 'operator' });
route('POST', '/api/operator/aircraft', async req => gs.setAircraft((await readJson(req)).available), { auth: 'operator' });
route('POST', '/api/operator/pads/:pid', async (req, res, { params }) => {
  const b = await readJson(req);
  if (typeof b.handoff === 'boolean') { const h = gs.setHandoff(params.pid, b.handoff); if (h.error) return fail(res, 400, h.error); if (b.status === undefined) return h; }
  const r = gs.setPad(params.pid, b.status);
  return r.error ? fail(res, 400, r.error) : r;
}, { auth: 'operator' });
const opSession = (res, id) => { const s = gs.sessions.get(id); if (!s) fail(res, 404, 'unknown_session'); return s; };
route('POST', '/api/operator/sessions/:id/handover', async (req, res, { params }) => { const s = opSession(res, params.id); if (!s) return; const b = await readJson(req); const r = gs.handover(s, b.source); return r.error ? fail(res, 400, r.error) : r; }, { auth: 'operator' });
route('POST', '/api/operator/handover', async (req, res) => { const b = await readJson(req); const s = str(b.sessionId, 40) && opSession(res, b.sessionId); if (!s) return res.headersSent ? undefined : fail(res, 400, 'session_required'); const r = gs.handover(s, b.source); return r.error ? fail(res, 400, r.error) : r; }, { auth: 'operator' });
route('POST', '/api/operator/sessions/:id/samples', async (req, res, { params }) => {
  const s = opSession(res, params.id); if (!s) return;
  const smp = cleanSample((await readJson(req)).sample);
  return smp ? gs.ingestSample(s, smp, { asOperator: true }) : fail(res, 400, 'invalid_sample');
}, { auth: 'operator' });
route('POST', '/api/operator/sessions/:id/rc', async (req, res, { params }) => { const s = opSession(res, params.id); if (!s) return; const r = gs.rcTakeover(s, !!(await readJson(req)).on); return r.error ? fail(res, 409, r.error) : r; }, { auth: 'operator' });
route('POST', '/api/operator/sessions/:id/faults', async (req, res, { params }) => { const s = opSession(res, params.id); if (!s) return; const b = await readJson(req); const r = gs.fault(s, b.name, !!b.on); return r.error ? fail(res, 400, r.error) : r; }, { auth: 'operator' });

async function api(req, res, url, ip) {
  if (!allow('api:' + ip, 20, 60)) return fail(res, 429, 'rate_limited');
  const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
  if (!r) return routes.some(x => x.re.test(url.pathname)) ? fail(res, 405, 'method_not_allowed') : fail(res, 404, 'not_found');
  if (r.mutate && !sameOrigin(req)) return fail(res, 403, 'cross_origin_refused');
  const params = url.pathname.match(r.re).groups || {};
  let s = null;
  if (r.auth === 'operator' && !isOperator(req)) return fail(res, 401, 'operator_token_required');
  if (r.auth === 'visitor') {
    // Session-scoped routes name the session in the path; the others use the token's own session.
    const id = params.id || [...gs.sessions.values()].find(x => safeEq(x.token, bearer(req)))?.id;
    s = id && visitorSession(req, id);
    if (!s) return fail(res, 401, 'session_invalid_or_expired');
  }
  try {
    const out = await r.handler(req, res, { s, params }, ip);
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'server_error');
    if (!e.status) log('error', req.method, url.pathname, e.message);
  }
}

/* ------------------------------------------------------------------ static files */
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'bad_path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || rel.includes('\0') || /(^|\/)(server|tests)\//.test(rel) || /(^|\/)\./.test(rel)) return fail(res, 404, 'not_found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'not_found');
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', { ETag: etag });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': st.size, ETag: etag, 'Cache-Control': path.basename(file) === 'sw.js' ? 'no-cache' : 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */
const handler = (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'bad_url'); }
  const t0 = Date.now();
  res.on('finish', () => { if (url.pathname.startsWith('/api/')) log(req.method, url.pathname.replace(/\/(v|q)[0-9a-f]{6,}/g, '/$1…'), res.statusCode, Date.now() - t0 + 'ms'); });
  if (url.pathname.startsWith('/api/')) return api(req, res, url, ip).catch(() => fail(res, 500, 'server_error'));
  return serveStatic(req, res, url);
};
const server = TLS ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler) : http.createServer(handler);

/* ------------------------------------------------------------------ session stream */
const streams = new Map(); // sessionId -> Set<WsConnection>
gs.on((sid, ev) => { const set = streams.get(sid); if (set) { const txt = JSON.stringify(ev); for (const c of set) c.send(txt); } });

server.on('upgrade', (req, socket) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
  const ip = req.socket.remoteAddress || '?';
  if (!m || req.headers.origin !== selfOrigin(req) || !allow('ws:' + ip, 1, 10)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const ws = acceptUpgrade(req, socket, { maxMessage: 16 * 1024 });
  if (!ws) return;
  const sid = decodeURIComponent(m[1]);
  let s = null;
  const authTimer = setTimeout(() => { if (!s) ws.close(4001, 'auth timeout'); }, 5000);
  const heartbeat = setInterval(() => ws.send(JSON.stringify({ type: 'heartbeat', serverTime: Date.now() })), 2000);
  ws.on('message', txt => {
    if (!allow('wsmsg:' + sid, 10, 30)) return;
    let msg; try { msg = JSON.parse(txt); } catch { return; }
    if (!s) {
      // The token travels in the first message, not the URL, so it never appears in access logs.
      if (msg?.type !== 'auth' || !(s = gs.session(sid, msg.token))) return ws.close(4003, 'auth failed');
      clearTimeout(authTimer);
      if (!streams.has(sid)) streams.set(sid, new Set());
      streams.get(sid).add(ws);
      ws.send(JSON.stringify({ ...gs.snapshot(s), sessionId: sid, serverTime: Date.now() }));
      return;
    }
    if (!gs.sessions.has(sid)) return ws.close(4004, 'session ended');
    if (msg?.type === 'sample') {
      const smp = cleanSample(msg.sample);
      ws.send(JSON.stringify(smp ? gs.ingestSample(s, smp) : { type: 'sampleAck', seq: msg.sample?.seq, accepted: false, reason: 'invalid_sample' }));
    } else if (msg?.type === 'action' && msg.action && str(msg.action.commandId, 100) && msg.action.type === 'abort') {
      gs.action(s, { commandId: msg.action.commandId, type: 'abort' }); // result arrives as a command event
    }
  });
  ws.on('close', () => { clearTimeout(authTimer); clearInterval(heartbeat); streams.get(sid)?.delete(ws); if (streams.get(sid)?.size === 0) streams.delete(sid); });
});

server.listen(PORT, HOST, () => {
  const base = `${TLS ? 'https' : 'http'}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`NAVI mock ground station (SIMULATED aircraft) on ${base}/`);
  console.log(`  visitor app:   ${base}/   (switch Settings → Mode → Live ground station)`);
  console.log(`  operator view: ${base}/operator.html`);
  console.log(`  operator console: ${OPERATOR_TOKEN ? 'token required' : 'open, no token'}`);
  console.log(`  auto-approve: ${gs.autoApprove ? 'on' : 'off'}${TLS ? '' : '   (HTTP: location sharing works only on this machine via localhost)'}`);
});
