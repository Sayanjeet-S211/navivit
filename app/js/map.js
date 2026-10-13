// Leaflet map wrapper. Path-only (no tiles) is the default and works offline; satellite and street
// tiles load only when chosen and are never bulk-cached.
const L = window.L;

const BASES = {
  satellite: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Imagery © Esri'],
  streets: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap contributors']
};

const droneSvg = rover => rover
  ? `<svg viewBox="-16 -16 32 32" aria-hidden="true"><rect x="-9" y="-11" width="18" height="22" rx="4" fill="currentColor"/><rect x="-13" y="-10" width="4" height="7" rx="1.5" fill="currentColor"/><rect x="9" y="-10" width="4" height="7" rx="1.5" fill="currentColor"/><rect x="-13" y="3" width="4" height="7" rx="1.5" fill="currentColor"/><rect x="9" y="3" width="4" height="7" rx="1.5" fill="currentColor"/><path d="M0 -8 L4 -2 H-4 Z" fill="var(--ink)"/></svg>`
  : `<svg viewBox="-16 -16 32 32" aria-hidden="true"><g stroke="currentColor" stroke-width="2.4"><line x1="-9" y1="-9" x2="9" y2="9"/><line x1="-9" y1="9" x2="9" y2="-9"/></g><g fill="currentColor"><circle cx="-9" cy="-9" r="5" opacity=".55"/><circle cx="9" cy="-9" r="5" opacity=".55"/><circle cx="-9" cy="9" r="5" opacity=".55"/><circle cx="9" cy="9" r="5" opacity=".55"/><rect x="-4" y="-4" width="8" height="8" rx="2"/></g><path d="M0 -13 L3 -8 H-3 Z" fill="currentColor"/></svg>`;

export class MapView {
  constructor(el, campus, { onTap, onTileError } = {}) {
    this.campus = campus; this.onTap = onTap; this.onTileError = onTileError;
    this.map = L.map(el, { zoomControl: false, zoomSnap: 0.25, attributionControl: true, maxZoom: 20, minZoom: 13, tap: true, keyboard: true });
    this.map.attributionControl.setPrefix(false).addAttribution('Boundary © OpenStreetMap contributors (ODbL) · Paths: VIT Chennai Way Finder data');
    this.map.setView(campus.raw.centre, 16);
    this.map.setMaxBounds(L.latLngBounds(campus.boundary).pad(4)); // loose: the campus must be placeable above the sheet
    for (const [name, z] of [['buffer', 330], ['network', 360], ['route', 420], ['ghost', 590]]) { this.map.createPane(name).style.zIndex = z; }
    this.map.on('click', e => this.onTap?.([e.latlng.lat, e.latlng.lng]));
    this.el = el;

    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    this.colors = () => ({ accent: css('--accent'), caution: css('--caution'), danger: css('--danger'), ok: css('--ok'), muted: css('--line-strong'), text: css('--text') });

    // Buffer: union of the polygon, edge strips and vertex discs, painted opaque in a pane whose
    // own opacity is lowered, so overlaps do not stack.
    const b = campus.bufferShapes();
    this.buffer = L.layerGroup([
      L.polygon(campus.boundary, { pane: 'buffer', stroke: false, fillOpacity: 1, className: 'buf' }),
      ...b.rects.map(r => L.polygon(r, { pane: 'buffer', stroke: false, fillOpacity: 1, className: 'buf' })),
      ...b.circles.map(c => L.circle(c.center, { radius: c.radiusM, pane: 'buffer', stroke: false, fillOpacity: 1, className: 'buf' }))
    ]);
    this.boundary = L.polygon(campus.boundary, { fill: false, weight: 1.6, dashArray: '6 6', className: 'boundary', interactive: false });
    this.network = L.layerGroup(campus.edges.map(e => L.polyline([campus.node(e.a).ll, campus.node(e.b).ll], { pane: 'network', weight: 2, className: 'net', interactive: false })));
    this.nodes = L.layerGroup([...campus.nodes.values()].map(n => L.circleMarker(n.ll, { pane: 'network', radius: 2.5, weight: 0, fillOpacity: .9, className: 'node', interactive: false })));
    this.pads = L.layerGroup(campus.pads.map((p, i) => L.marker(p.ll, { icon: L.divIcon({ className: 'mk-pad', html: `<span>${i + 1}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }), keyboard: false, title: `${p.name} (launch pad)` }).bindTooltip(p.name, { direction: 'top', offset: [0, -10] })));
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.originLayer = L.layerGroup().addTo(this.map);
    this.visitorLayer = L.layerGroup().addTo(this.map);
    this.aircraftLayer = L.layerGroup().addTo(this.map);
    this.landingLayer = L.layerGroup().addTo(this.map);
    this.boundary.addTo(this.map); this.pads.addTo(this.map);
    this.base = null; this.baseKey = 'path';
  }

  setBase(key) {
    if (this.base) { this.map.removeLayer(this.base); this.base = null; }
    this.baseKey = BASES[key] ? key : 'path';
    this.el.classList.toggle('path-only', this.baseKey === 'path');
    if (this.baseKey === 'path') return;
    const [url, attr] = BASES[this.baseKey];
    this.base = L.tileLayer(url, { maxZoom: 20, maxNativeZoom: 19, attribution: attr, crossOrigin: true });
    let errors = 0;
    this.base.on('tileerror', () => { if (++errors === 4) this.onTileError?.(this.baseKey); });
    this.base.addTo(this.map); this.base.bringToBack();
  }
  setLayers({ network, nodes, buffer }) {
    const t = (layer, on) => on ? layer.addTo(this.map) : this.map.removeLayer(layer);
    t(this.network, network); t(this.nodes, nodes); t(this.buffer, buffer);
  }

  setOrigin(o) {
    this.originLayer.clearLayers();
    if (!o?.ll) return;
    if (o.kind === 'measured' && o.accuracyM) L.circle(o.ll, { radius: o.accuracyM, className: 'acc', interactive: false }).addTo(this.originLayer);
    L.marker(o.ll, { icon: L.divIcon({ className: 'mk-origin', html: '<span></span>', iconSize: [26, 34], iconAnchor: [13, 32] }), keyboard: false, title: 'Starting point' }).addTo(this.originLayer);
  }

  setPlan(plan, { fit = true } = {}) {
    this.routeLayer.clearLayers();
    if (!plan) return;
    const all = [];
    if (plan.transfer?.coords?.length > 1 && plan.transfer.needed) {
      L.polyline(plan.transfer.coords, { pane: 'route', weight: 4, className: 'rt-transfer', interactive: false }).addTo(this.routeLayer);
      all.push(...plan.transfer.coords);
    }
    if (plan.guided?.coords?.length > 1) {
      L.polyline(plan.guided.coords, { pane: 'route', weight: 10, className: 'rt-glow', interactive: false }).addTo(this.routeLayer);
      L.polyline(plan.guided.coords, { pane: 'route', weight: 4, className: 'rt-guided', interactive: false }).addTo(this.routeLayer);
      L.polyline(plan.guided.coords, { pane: 'route', weight: 4, className: 'rt-pulse', interactive: false }).addTo(this.routeLayer);
      all.push(...plan.guided.coords);
    }
    const end = plan.guided?.coords?.at(-1) || plan.direct?.coords?.at(-1);
    if (end) L.marker(end, { icon: L.divIcon({ className: 'mk-dest', html: '<span></span>', iconSize: [28, 28], iconAnchor: [14, 26] }), keyboard: false, title: plan.destination.name + ' entrance' }).addTo(this.routeLayer);
    if (plan.pad) L.circleMarker(plan.pad.ll, { radius: 16, className: 'pad-ring', interactive: false }).addTo(this.routeLayer);
    if (plan.origin?.ll) all.push(plan.origin.ll);
    if (fit && all.length) this.fitTo(all);
  }

  setVisitor(v) {
    this.visitorLayer.clearLayers();
    if (!v) return;
    if (v.showRaw && v.rawLL) {
      L.circle(v.rawLL, { radius: v.accuracyM || 10, pane: 'ghost', className: 'acc ghost', interactive: false }).addTo(this.visitorLayer);
      L.circleMarker(v.rawLL, { radius: 4, pane: 'ghost', className: 'raw-dot', interactive: false }).addTo(this.visitorLayer);
    }
    const ll = v.ll || v.rawLL;
    if (!ll) return;
    L.marker(ll, { icon: L.divIcon({ className: 'mk-visitor' + (v.stale ? ' stale' : ''), html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }), keyboard: false, title: 'Your position' + (v.stale ? ' (last known)' : '') }).addTo(this.visitorLayer);
  }

  setAircraft(a) {
    this.aircraftLayer.clearLayers();
    if (!a?.ll) return;
    const label = a.stale ? `Last update ${a.ageText}` : '';
    const m = L.marker(a.ll, { icon: L.divIcon({ className: 'mk-aircraft' + (a.stale ? ' stale' : ''), html: `<span style="transform:rotate(${Math.round(a.heading || 0)}deg)">${droneSvg(a.rover)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] }), keyboard: false, title: (a.rover ? 'Ground robot' : 'NAVI aircraft') + (a.stale ? ' (last known position)' : '') });
    m.addTo(this.aircraftLayer);
    if (label) m.bindTooltip(label, { permanent: true, direction: 'right', offset: [16, 0], className: 'tt-stale' }).openTooltip();
  }

  setLanding(ll) {
    this.landingLayer.clearLayers();
    if (!ll) return;
    const half = this.campus.config.padClearanceM / 2, f = this.campus.frame, c = f.toXY(ll);
    const sq = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => f.toLL([c[0] + x, c[1] + y]));
    L.polygon(sq, { className: 'landing-zone', interactive: false }).addTo(this.landingLayer);
    [8, 14, 20].forEach(r => L.circle(ll, { radius: r, className: 'landing-ring', interactive: false }).addTo(this.landingLayer));
  }

  /** Fit to the part of the map the sheet does not cover (bottom sheet, left panel or right panel). */
  fitTo(lls, pad = [40, 40], { top = 70 } = {}) {
    if (!lls?.length) return;
    const b = L.latLngBounds(lls), tl = [pad[0], pad[1] + top], br = [pad[0] + 56, pad[1]];
    const sheet = document.querySelector('.sheet'), m = this.el.getBoundingClientRect();
    if (sheet) {
      const r = sheet.getBoundingClientRect();
      if (r.width >= m.width - 2) br[1] += Math.max(0, m.bottom - r.top);
      else if (r.left <= m.left + 2) tl[0] += r.right - m.left;
      else br[0] += m.right - r.left;
      if (m.height - tl[1] - br[1] < 80) { tl[1] = pad[1]; br[1] = Math.max(pad[1], m.height - tl[1] - 80); }
    }
    this.map.fitBounds(b, { paddingTopLeft: tl, paddingBottomRight: br, maxZoom: 18, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches });
  }
  center() { const c = this.map.getCenter(); return [c.lat, c.lng]; }
  panTo(ll) { this.map.panTo(ll, { animate: !matchMedia('(prefers-reduced-motion: reduce)').matches }); }
  /** Point of the map container at pixel [x, y]; and pan so that ll sits under that pixel. */
  latLngAt(px) { const c = this.map.containerPointToLatLng(px); return [c.lat, c.lng]; }
  panPointTo(ll, px) {
    const size = this.map.getSize(), at = this.map.latLngToContainerPoint(ll);
    this.map.panBy([at.x - px[0], at.y - px[1]], { animate: !matchMedia('(prefers-reduced-motion: reduce)').matches });
    void size;
  }
  invalidate() { this.map.invalidateSize(); }
}
