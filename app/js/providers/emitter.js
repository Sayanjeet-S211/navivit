export class Emitter {
  constructor() { this._l = new Map(); }
  on(type, fn) { if (!this._l.has(type)) this._l.set(type, new Set()); this._l.get(type).add(fn); return () => this._l.get(type)?.delete(fn); }
  emit(type, data) { for (const fn of this._l.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } }
}
