// Browser sensors: geolocation watch, screen wake lock and absolute compass heading.
// Each one feature-detects, reports its real state, and cleans up.

/** Continuous opt-in location watch. Emits geolocation-shaped samples; speed/heading stay null when absent. */
export class DeviceLocation {
  constructor({ onSample, onError }) { this.onSample = onSample; this.onError = onError; this.id = null; this.seq = 0; }
  static check() {
    if (!('geolocation' in navigator)) return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    return 'ok';
  }
  start({ highAccuracy = true, timeoutMs = 20000 } = {}) {
    const c = DeviceLocation.check();
    if (c !== 'ok') { this.onError?.(c); return false; }
    this.stop();
    this.id = navigator.geolocation.watchPosition(p => {
      const k = p.coords;
      this.onSample?.({
        seq: ++this.seq, lat: k.latitude, lon: k.longitude, accuracyM: k.accuracy, timestamp: p.timestamp,
        speed: Number.isFinite(k.speed) ? k.speed : null, heading: Number.isFinite(k.heading) ? k.heading : null, source: 'device'
      });
    }, e => this.onError?.(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable'),
    { enableHighAccuracy: highAccuracy, maximumAge: 0, timeout: timeoutMs });
    return true;
  }
  stop() { if (this.id != null) { navigator.geolocation.clearWatch(this.id); this.id = null; } }
  get active() { return this.id != null; }
}

/** Keeps the screen on during a visible guidance session only. */
export class WakeLockManager {
  constructor(onChange) {
    this.onChange = onChange; this.lock = null; this.wanted = false;
    this.state = 'wakeLock' in navigator ? 'off' : 'unsupported';
    document.addEventListener('visibilitychange', () => { if (this.wanted && document.visibilityState === 'visible' && !this.lock) this.acquire(); });
  }
  _set(s) { if (s !== this.state) { this.state = s; this.onChange?.(s); } }
  async acquire() {
    this.wanted = true;
    if (!('wakeLock' in navigator)) return this._set('unsupported');
    if (document.visibilityState !== 'visible') return this._set('released');
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this._set('active');
      this.lock.addEventListener('release', () => { this.lock = null; if (this.wanted) this._set('released'); });
    } catch { this._set('denied'); }
  }
  /** Demo: behave as if the system released the lock. */
  simulateRelease() { this.lock?.release().catch(() => {}); this.lock = null; this._set('released'); }
  release() { this.wanted = false; this.lock?.release().catch(() => {}); this.lock = null; if (this.state !== 'unsupported') this._set('off'); }
}

/** Absolute device heading. Rotation relative to the phone is only shown when this is 'active'. */
export class HeadingSensor {
  constructor(onChange) {
    this.onChange = onChange; this.heading = null; this.state = 'off'; this._h = null; this._t = null;
    const D = window.DeviceOrientationEvent;
    this.needsPermission = !!(D && typeof D.requestPermission === 'function');
    this.supported = !!D;
  }
  _set(s) { this.state = s; this.onChange?.(this); }
  /** Must be called from a user gesture on iOS. */
  async start() {
    if (!this.supported) return this._set('unavailable');
    if (this.needsPermission) {
      try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return this._set('denied'); }
      catch { return this._set('denied'); }
    }
    this.stop();
    const handler = e => {
      let h = null;
      if (Number.isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if (e.absolute && Number.isFinite(e.alpha)) h = 360 - e.alpha;
      if (h == null) return;
      const screenAngle = screen.orientation?.angle || 0;
      this.heading = (h + screenAngle + 360) % 360;
      if (this.state !== 'active') this._set('active'); else this.onChange?.(this);
    };
    this._h = handler;
    const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    this._ev = ev;
    window.addEventListener(ev, handler);
    this._set('starting');
    this._t = setTimeout(() => { if (this.state === 'starting') this._set('unavailable'); }, 3000);
  }
  stop() { if (this._h) window.removeEventListener(this._ev, this._h); this._h = null; clearTimeout(this._t); this.heading = null; if (this.state !== 'off') this._set('off'); }
}
