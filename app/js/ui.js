// UI helpers: escaping, icons, announcements, haptics and the arrival chime.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/** Escape any dynamic text before it reaches innerHTML (labels, server reasons, names). */
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

const recent = new Map();
/** Announce to screen readers. Repeats of the same message within 20 s are muted. */
export function announce(text, priority = 'polite') {
  const now = Date.now();
  if (recent.has(text) && now - recent.get(text) < 20000) return;
  recent.set(text, now);
  const el = $(priority === 'assertive' ? '#sr-assertive' : '#sr-polite');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}

export const settings = {
  get(k, d) { try { const v = localStorage.getItem('navi.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('navi.' + k, JSON.stringify(v)); } catch {} }
};

const PATTERNS = { tap: 15, hold: [30, 50, 30], alert: [100, 50, 100, 50, 200], arrive: [40, 80, 40, 80, 120] };
export function haptic(kind) {
  if (!settings.get('haptics', true) || !('vibrate' in navigator)) return false;
  try { return navigator.vibrate(PATTERNS[kind] || 15); } catch { return false; }
}

let audio = null;
/** Create the audio context inside a user gesture so a later chime is allowed. */
export function unlockAudio() {
  if (audio || !settings.get('sound', true)) return;
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
}
export function chime() {
  if (!settings.get('sound', true) || !audio) return false;
  const t0 = audio.currentTime + 0.02;
  [[784, 0], [1047, 0.16], [1319, 0.32]].forEach(([f, dt]) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.5);
    o.connect(g).connect(audio.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.55);
  });
  return true;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const ago = s => !Number.isFinite(s) ? 'never' : s < 1 ? 'just now' : s < 60 ? `${Math.round(s)} s ago` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s ago`;
