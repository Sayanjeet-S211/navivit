// Geographic helpers shared by the browser app, the mock ground station and the tests.
// Distances use Haversine; local geometry (projections, buffers, polygon tests) uses a
// local tangent-plane frame in metres, which is accurate to well under 0.1% across a campus.

export const EARTH_R = 6371008.8;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Great-circle distance in metres between [lat, lon] pairs. */
export function haversine(a, b) {
  const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north. */
export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export const cardinal = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((d % 360) + 360) % 360 / 45) % 8];

/** Local east/north frame in metres around an origin. */
export function localFrame(origin) {
  const lat0 = rad(origin[0]);
  const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0) + 1.175 * Math.cos(4 * lat0);
  const mLon = 111412.84 * Math.cos(lat0) - 93.5 * Math.cos(3 * lat0);
  return {
    toXY: p => [(p[1] - origin[1]) * mLon, (p[0] - origin[0]) * mLat],
    toLL: q => [origin[0] + q[1] / mLat, origin[1] + q[0] / mLon]
  };
}

/** Closest point on segment ab to p (all [x, y] metres). */
export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { t, q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

export function pointInPolygon(p, poly) {
  let c = false;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
    if ((y1 > p[1]) !== (y2 > p[1]) && p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1) c = !c;
  }
  return c;
}

export function distanceToPolygonEdge(p, poly) {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) best = Math.min(best, projectOnSegment(p, poly[i], poly[(i + 1) % n]).d);
  return best;
}

export const isLatLon = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

/** 32-bit FNV-1a hash as hex, used for stable route identifiers. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
