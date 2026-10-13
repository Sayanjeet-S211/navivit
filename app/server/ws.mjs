// Minimal RFC 6455 WebSocket server side: text frames, ping/pong, close, fragmentation and a
// message size cap. Enough for the NAVI session stream without third-party dependencies.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WsConnection extends EventEmitter {
  constructor(socket, { maxMessage = 64 * 1024 } = {}) {
    super();
    this.socket = socket; this.maxMessage = maxMessage; this.buf = Buffer.alloc(0);
    this.frag = null; this.open = true;
    socket.setNoDelay(true);
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }
  get readyState() { return this.open ? 1 : 3; }

  send(text) {
    if (!this.open) return false;
    const payload = Buffer.from(text, 'utf8');
    this.socket.write(Buffer.concat([this._header(0x1, payload.length), payload]));
    return true;
  }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8').subarray(0, 120), p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this.socket.write(Buffer.concat([this._header(0x8, p.length), p])); } catch {}
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.emit('close', code);
  }

  _header(op, len) {
    if (len < 126) return Buffer.from([0x80 | op, len]);
    if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); return h; }
    const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h;
  }
  _closed() { if (this.open) { this.open = false; this.emit('close', 1006); } }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.maxMessage + 16) return this.close(1009, 'too big');
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (!masked) return this.close(1002, 'unmasked client frame');
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(this.maxMessage)) return this.close(1009, 'too big'); len = Number(big); off = 10; }
      if (len > this.maxMessage) return this.close(1009, 'too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) return this.close(1000);
      if (op === 0x9) { this.socket.write(Buffer.concat([this._header(0xA, data.length), data])); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1) this.frag = [data]; else if (this.frag) this.frag.push(data); else return this.close(1002, 'unexpected continuation');
        const total = this.frag.reduce((n, b) => n + b.length, 0);
        if (total > this.maxMessage) return this.close(1009, 'too big');
        if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = null; this.emit('message', msg); }
        continue;
      }
      return this.close(1003, 'unsupported frame');
    }
  }
}

/** Complete the HTTP upgrade. Returns a connection, or null after rejecting the request. */
export function acceptUpgrade(req, socket, opts) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  return new WsConnection(socket, opts);
}
