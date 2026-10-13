# NAVI visitor guide (mobile PWA)

A zero-install Progressive Web App for visitors to VIT Chennai. A visitor sets a starting point, picks one of the 36 campus destinations, previews the walking route and the NAVI guidance plan, requests a guide, shares their location, follows the guide's confirmed status, can pause or end guidance, and gets an arrival cue once landing is confirmed.

**Status: 20% project stage.** The app runs in **demo mode** by default: the ground-station logic runs inside the page and the aircraft and visitor are simulated. A persistent “Demo · no aircraft connected” label says so. A separate **live mode** talks to a NAVI ground station served from the same origin. The bundled mock ground station (`server/gcs-mock.mjs`) implements that API with the same core and a **simulated aircraft**; it has no MAVLink link and cannot command real equipment. Nothing in this folder can arm, launch or control a real aircraft.

## Quick start

| What | How |
| --- | --- |
| Demo, no install | Open `app/` from any static server, e.g. the GitHub Pages site: `https://sayanjeet-s211.github.io/navivit/app/`, or `python3 -m http.server` in the repo root and visit `http://localhost:8000/app/` |
| Live mode with the mock ground station | `cd app && node server/gcs-mock.mjs` (Node 18.17+, no dependencies), open `http://localhost:8080/`, then Settings → Mode → **Live ground station**. Add `--auto-approve` to skip operator approval |
| Operator console | `http://localhost:8080/operator.html`, opens directly, no token needed. To require one, start the server with `--operator-token <secret>` (or `NAVI_OPERATOR_TOKEN`) |
| Phones on the campus network | Run with HTTPS: `node server/gcs-mock.mjs --host 0.0.0.0 --port 8443 --cert cert.pem --key key.pem` (see Deployment) |
| Tests | `node --test tests/*.test.mjs` (core + API), `node tests/e2e.mjs` (browser, needs Playwright), `node tests/budget.mjs` (first-load size) |

Demo controls (flask icon in the header) let you approve/decline requests, change pad readiness, make the simulated visitor walk/slow/stop, drop the phone's position, walk off route, inject a position spike, cut aircraft telemetry, degrade GPS/EKF, drain the battery, push the aircraft past the fence, lose the RC link, hand over to the operator's device, take RC control, cut the phone ↔ ground link and release the wake lock. Settings → Demo speed runs the simulation at ×3 or ×6.

## What is real and what is simulated

| Part | Demo mode | Live mode with the mock server | Live mode with a real ground station (future) |
| --- | --- | --- | --- |
| Campus graph, destinations, pads, boundary | Real source data | Real source data | Real source data |
| Route planning, ETA, leg-limit and fence checks | Real computation | Real computation, server-authoritative | Same |
| Visitor position | Simulated walker; your real location is never used | Your phone's real `watchPosition()` fixes | Same |
| Dispatch, pacing, recovery state machine | Ground-station core in the page | Same core on the server | To be replaced/validated by the team's ground station |
| Aircraft telemetry | Simulated, labelled “demo value” | Simulated (`aircraftSource: "simulated"`), labelled “Live · simulated aircraft” | MAVLink bridge to F405/ArduPilot (not built) |
| Commands (pause, resume, end, abort) | Delivered to the in-page simulation only | Delivered to the mock server's simulation only | Ground station → MAVLink; the FS-i6X RC link stays independent |

## Structure

```
app/
  index.html, css/app.css         visitor app shell and styles (dark + daylight themes)
  js/app.js                       controller: screens A–H, sharing pipeline, commands, alerts, HUD
  js/campus.js                    data validation, Dijkstra, trip planning, fence metrics
  js/filter.js                    sample validation, velocity filter, route matching, freshness
  js/config.js                    every planning/filter threshold in one place
  js/geo.js, js/map.js            geodesy helpers; Leaflet map wrapper (path-only by default)
  js/sensors.js                   geolocation watch, screen wake lock, compass heading
  js/providers/{demo,live}.js     provider interface: Demo, GroundStationLive, Disconnected
  js/sim/groundstation.js         ground-station core (dispatch, pacing, recovery, simulated aircraft)
  js/sim/walker.js                demo-only simulated visitor
  data/campus.v1.json             versioned campus dataset (see Data)
  sw.js, manifest.webmanifest     offline shell and install metadata; icons/
  operator.html, js/operator.js   operator console (token-authenticated)
  server/gcs-mock.mjs, ws.mjs     mock ground station: static files, REST API, WebSocket stream
  tests/                          node:test suites, Playwright e2e script, budget script
  vendor/leaflet, fonts/          self-hosted Leaflet 1.9.4 (BSD-2) and font subsets (OFL)
```

No build step: plain ES modules, so the folder is the runnable build.

## Data

`data/campus.v1.json` (schema `navi-campus/1`, version `2026-10-12.1`) was extracted from the `const D` object in the team's saved NAVI app, keeping node IDs, coordinates and adjacency:

- 260 flight-graph nodes, 36 destinations (entrance nodes and categories), 6 pads with their source nodes, 36-vertex campus boundary (OSM way 336095563, ODbL), centre `[12.8425, 80.156]`.
- Validated at load: schema, duplicate IDs, coordinate validity and order (swapped lat/lon is caught), missing references, destination entrances, pad nodes, connectivity.
- Recomputed statistics: **286 segments, 6.98 km, one connected component.** The source reports 303 segments and 8.24 km for the full 278-node survey; both figures are shown, labelled.
- No footpath/road or forbidden-edge classification exists in the data, so every plan says **route inspection pending** and never claims “sidewalk only”. The planner already honours `edgeMeta.forbidden` (excluded) and `edgeMeta.penalty` (preference only) when that data arrives.

## Planning rules

- Distances: Haversine per edge, summed along the path. ETA = `distance / 0.8 m/s × 1.15` (350 m → 8 min 23 s), shown as an estimate; dispatch and waiting time are separate.
- **At least 95% of the visitor's walking must be drone-guided** (see the next section). Plans are chains of guided legs between pads; the planner no longer picks the pad nearest the destination and leaves the visitor to walk there alone.
- A leg is feasible when its length and every single edge are within the provisional 350 m, its flight time (launch/landing overhead + guided walk + any return flight without the visitor) fits one battery, and the whole leg stays inside the 40 m buffered boundary. Unknown readiness stays “unknown”; no qualifying plan means “95% drone-guided navigation is currently unavailable for this route” with the reasons.
- The fence uses a local tangent-plane metre frame (point-in-polygon + distance to edges), checks every route vertex and segment, and draws the 40 m buffer as a separate layer from the boundary. The buffer is a visualisation of an approximate boundary, not a flight permission.

## 95% drone-guided coverage

**Pads.** `data/pads.v1.json` (schema `navi-pads/1`) is generated by `tools/gen-pads.mjs`. It keeps the six source pads and adds proposed candidates at the outdoor entrance node of the Guest House, VIT-SEDAXIS, every academic block, every hostel and every gate entrance. It then adds further entrance, junction and path-node candidates greedily, only where origin–destination trips would otherwise fall below 95%. The pad count is an output, not a target. Each record has a stable ID, name, kind, the destinations it serves, its graph node and coordinates, placement provenance, approval (`proposed`) and inspection (`pending`) state, and handoff support. Destinations that share an entrance node (D1/D2 Block Hostel) share one physical candidate, flagged `shared`, which can be split after inspection. **Every pad is labelled “Proposed pad: placement pending inspection”.**

**Journey planning** (`js/journey.js`). For each usable start pad near the origin, the planner runs a shortest-path search over feasible pad-to-pad legs. Relaunching at a pad requires handoff support there (a staffed battery swap with one aircraft). It then finishes either with a guided final leg to the entrance (the aircraft flies back along the route to land) or by landing at a pad and leaving an unguided final approach. Candidates are ranked by:
1. Constraints: approved path graph, pad readiness, handoff support, aircraft availability, leg length and battery.
2. Planned guided coverage ≥ 95% (unrounded).
3. The least unguided metres.
4. The shortest total walk, then the fewest legs, then the least flight time.

The total walk must be at most max(1.3 × the shortest walking route, the shortest route + 60 m), so a long guided detour cannot inflate the percentage. A leg is never split at an invented point.

**Measurement.** `guidedCoveragePercent = 100 × guided / (guided + unguided)`, using the plan's own segment lengths: initial transfer, guided legs, final approach, and the off-graph walk from a manual origin. Waiting is reported as time, not distance. The display rounds **down** (94.96% shows as 94.9%) and the threshold uses the unrounded value. A trip of 10 m or less shows “You are already at the destination”, and coverage is not applicable rather than 100%.

**Planned vs observed.** The preview shows planned coverage, guided and unguided metres, the itinerary with legs, handoff pads and estimated waits, a legend, and solid cyan (guided) versus dotted (unguided) lines drawn from the plan's segment types. During the trip the ground station adds visitor movement to the observed guided total only while guidance is confirmed active. Anything else counts as unguided: walking during a handoff, a lost link, RC control, or being off the route. The arrival screen shows both values; the map shows completed legs in green and any newly unguided movement in amber. During a handoff the app says “Waiting for the next leg. Wait here. Guidance will continue after the handoff.” The next leg starts only once the pad's crew is confirmed and the visitor is at the pad. Otherwise the app says “Guidance interrupted. Wait for the operator.”

**Diagnostics.** When no plan qualifies, the reasons name the cause: no aircraft, an unavailable pad, missing handoff support, an excessive start transfer or final approach, an infeasible leg chain, too long a detour, or no walking route. The app also suggests where an additional proposed pad would close the gap. Walking directions stay available, labelled “not drone-guided”.

**Report.** `node tools/coverage-report.mjs` regenerates [`docs/coverage-report.md`](docs/coverage-report.md) and `.csv`: the pad table, the required scenarios (Gate ↔ Guest House, Gate ↔ VIT-SEDAXIS, Gate → every academic block and hostel, hostel → academic block, manual/off-graph/at-destination origins, failure cases), the whole-network matrix and a before/after comparison with the old six-pad planner.

## Location pipeline (client display + server authority)

| Stage | Rule (all values in `js/config.js`) |
| --- | --- |
| Validation | Reject invalid coordinates/accuracy/timestamp, repeated or older sequence numbers, older or identical timestamps (replays), accuracy > 100 m |
| Velocity filter | Implied speed after subtracting half of both fixes' accuracy must be ≤ 3 m/s; three mutually consistent rejected fixes re-anchor (the old anchor was the outlier) |
| Route matching | Project onto the active route within a continuity window; > max(30 m, 1.5 × accuracy) away = off-route (not snapped); two candidates within 4 m but > 25 m apart along the route = ambiguous (last progress kept) |
| Pacing hysteresis (server) | Hold when lead > 22 m or the visitor is still (< 0.15 m/s) for 4 s; resume only below 17 m and after 2 s of movement |
| Freshness | Separate ages for last valid phone fix, last fix confirmed by the ground station, last ground-station message and last aircraft telemetry. A heartbeat never refreshes the location |
| Staleness (server) | > 30 s without a valid fix: hold and warn; > 60 s: return to the pad (suspended while paused, up to 5 min). Sharing shows **active** only after the ground station acknowledges a sample |

## Modes and provider interface

`DemoProvider`, `LiveProvider` and `DisconnectedProvider` share one interface (`connect`, `createSession`, `previewRoute`, `requestGuide`, `cancel`, `action`, `sendSample`, `closeSession`, events). Switching modes ends the current session and shows a notice. A failed live connection becomes **Disconnected** (“Not connected” pill, offline-estimate planning only, guide requests disabled); it never falls back to simulated telemetry. Live mode only talks to `/api/` on the page's own origin; QR codes can only preselect a known pad ID (`?pad=east`), never a server URL.

## API (implemented by `server/gcs-mock.mjs`)

All JSON. Visitor routes need `Authorization: Bearer <session token>`; operator routes are open by default and need the operator token only when the server was started with one. State-changing requests with a foreign `Origin` are refused (403). Requests are rate-limited per client; bodies are capped at 16 KB.

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | `{service:"navi-gcs", label, aircraftSource, campusVersion, time}` |
| `GET /api/campus`, `GET /api/pads` | Versioned dataset; pad readiness and meeting instructions |
| `POST /api/visitor-sessions` | `{sessionId, token, expiresInS}`; short-lived scoped session |
| `DELETE /api/visitor-sessions/:id` | Close; an airborne aircraft is sent home, never dropped |
| `POST /api/routes/preview` | `{origin:{kind,ll,label,accuracyM?,nodeId?}, destinationId}` → authoritative plan with `routeId` |
| `POST /api/guide-requests` | `Idempotency-Key` header + `{routeId, idempotencyKey}` → `{requestId, state, reason}`; retries return the same request |
| `POST /api/sessions/:id/cancel` | Cancel before take-off |
| `POST /api/sessions/:id/actions` | `{commandId, type: pause|resume|end|abort}` → `{state: accepted|executing|confirmed|rejected|failed, reason}`; a repeated `commandId` is not executed twice |
| `WS /api/sessions/:id/stream` | First message `{type:"auth", token}` (token never in the URL). Server → `snapshot`, `dispatch`, `mission`, `aircraft`, `sampleAck`, `command`, `alert`, `source`, `heartbeat`. Client → `{type:"sample", sample:{seq,lat,lon,accuracyM,timestamp,speed|null,heading|null}}`, `{type:"action", action:{commandId,type:"abort"}}` (priority path; the POST is the confirmed one) |
| `POST /api/operator/handover` | `{sessionId, source: visitor|operator-device}`; old-source samples are then rejected (`source_handed_over`) |
| `GET /api/operator/sessions` | Sessions, requests, mission status, telemetry diagnostics |
| `POST /api/operator/requests/:id/decision`, `/pads/:id`, `/auto-approve`, `/sessions/:id/{rc,faults,samples,handover}` | Approve/decline, pad readiness, RC takeover flag, fault injection (simulated aircraft), operator-device samples |

Dispatch states: `QUEUED → AWAITING_OPERATOR → APPROVED → MEET_AT_PAD → READY`, or `DECLINED`, `UNAVAILABLE`, `CANCELLED` (the client adds `REQUESTING` while sending). Mission statuses: `meet, preflight, takeoff, leading, waiting, paused, operator, returning, landing, landed`. The client never lets a dispatch update move a request backwards and ignores events from a closed session.

## Deployment plan

1. **Public demo (now):** the static `app/` folder on GitHub Pages (or GitLab Pages). Demo mode only; live mode there reports “Not connected”, because a static host is not a ground station.
2. **Live trials:** run the ground station on a laptop on the campus network and serve **both the PWA and the API from it over HTTPS** (same origin, `wss:` for the stream), e.g. `https://navi-gcs.<campus-domain>/`.
   - Certificate: a certificate for a real DNS name that phones already trust (from the campus PKI, or a public CA via DNS-01 validation while the host stays private). Do not ask visitors to accept an untrusted certificate, and do not use a tunnel while claiming no public-network dependency.
   - DNS: the name must resolve to the laptop's campus address on the guest Wi-Fi (split-horizon DNS or a campus record). Phones on mobile data cannot reach a private campus address; the QR code should say “connect to campus Wi-Fi”.
   - Network: allow inbound TCP 443 to the laptop on the guest/visitor VLAN; check client isolation on the Wi-Fi, which can block phone → laptop traffic.
   - An HTTPS page hosted elsewhere must not call `http://` or a private IP (mixed content, local-network access restrictions). Same-origin serving avoids CORS entirely; the mock server sends no CORS headers and checks `Origin`.
   - `http://localhost` counts as secure for testing on the same machine only.
3. The mock server already sends CSP, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(self)`, frame denial and (with TLS) HSTS.

## Privacy

Before sharing, the app explains what is shared (position, accuracy, measurement time), why (pacing), with whom (the campus ground station and its operator; in demo, nobody) and for how long (until the visitor finishes or ends guidance). Planning needs no permission and no account; location is requested only on **Use my location** or **Share my location**. A pinned or chosen start is a planning origin and is never sent as a live fix. Nothing is sent to analytics or a public cloud. Visitor session tokens live in memory only (the operator token is kept in `sessionStorage` for the operator's tab) and never appear in URLs or logs; the mock server logs method, path (session IDs shortened), status and time, never bodies or positions. **Finish** stops the location watch and stream, releases the wake lock and clears session data; favourites and the optional feedback stay on the phone. The diagnostic-log setting is off by default.

## Feature traceability

Every item of `NAVI_Mobile_UI_Design_Master_Prompt.md` (the feature inventory referred to as `mobileinterfaceprompt.md`), with the master prompt's corrections applied.
**Status key:** ✅ implemented · 🧪 demonstrated in simulation · 🔌 requires live backend/hardware · 🔁 adapted (reason given) · ⚠️ browser-dependent (fallback given).

| # | Feature | Status | Where / notes |
| --- | --- | --- | --- |
| 1.1 | Zero-install PWA reached by QR at kiosks/pads | ✅ | Manifest, icons, `?pad=<id>` preselects a known pad only |
| 1.2 | HTTPS for geolocation and sensors | ✅ / 🔌 | Secure-context checks with clear errors; HTTPS deployment plan above |
| 1.3 | Screen Wake Lock during transit | ✅ ⚠️ | Acquired only for visible active guidance, re-acquired on return, released on finish; unsupported → “cannot keep the screen on” banner + reminder. Does not keep GPS running in the background |
| 1.4 | Local data ingestion over WebSocket/HTTP, no public cloud | ✅ 🔌 | Same-origin REST + WebSocket; mock server provided |
| 1.5 | < 2 MB static bundle | ✅ | 268 KB gzip / 545 KB raw first load (see Budget) |
| 1.6 | Offline fallback, graph cached | ✅ | Service worker caches shell, data, fonts, Leaflet (CacheStorage); path-only map works offline; no tile bulk-caching |
| 1.7 | Sub-50 ms bi-directional MAVLink telemetry (HEARTBEAT, GLOBAL_POSITION_INT, SYS_STATUS, MISSION_CURRENT) | 🔌 🔁 | WebSocket carries ground-station events; MAVLink parsing belongs on the ground station, not the phone. Latency not measured on hardware |
| 1.8 | Device orientation / compass sensor fusion | ✅ ⚠️ 🔁 | Absolute heading (`deviceorientationabsolute` / iOS `webkitCompassHeading`, permission on tap) rotates a 2D arrow; otherwise north-up with “Direction shown relative to north”. No 3D gyro projection (master prompt: calm visitor UI) |
| 2.1 | Searchable 36-destination directory | ✅ | Case-insensitive search, result count, empty state, saved favourites (local) |
| 2.2 | Haversine route length | ✅ | Computed along the graph; straight-line hint in the list is labelled as such |
| 2.3 | 0.8 m/s + 15% ETA | ✅ | 350 m → 8 min 23 s |
| 2.4 | Nearest operational pad of six | 🔁 🧪 | Superseded by the 95% edit: an expanded proposed pad network and chains of guided legs from a pad near the origin; readiness simulated in demo, from the server in live |
| 2.5 | “Footpath only” routing indicator | 🔁 | Data has no footpath/road classification: shows “route inspection pending”; penalties/forbidden edges supported when supplied |
| 2.6 | “Request Guide” button | ✅ | Primary button; idempotent; duplicate submissions disabled |
| 2.7 | Holographic 3D route preview | 🔁 | 2D map with glowing guided leg, dashed walking transfer and pulse on path-only/satellite/street bases; no 3D (master prompt: no dramatic 3D, no 3D model in trip screens) |
| 2.8 | Smart category bar | ✅ 🔁 | Filter chips use the dataset's own categories (Academic, Administration, Auditorium, Hostel, Laboratory, Sports, Visitor Facilities); text labels, no icons |
| 2.9 | Pre-flight telemetry chip | 🧪 🔌 | Pad status, airframe, wind and battery chips; demo values labelled “demo value”; live shows only what the server reports |
| 2.10 | Slide-to-dispatch | ✅ | Optional (Settings → “Slide to confirm guide requests”); Enter/Space activates it for keyboard and assistive tech |
| 3.1 | Vector and satellite map, 260 nodes / 303 segments / 8.24 km | ✅ ⚠️ | Path-only default; Esri satellite and OSM street tiles online only, with attribution; node and network layers off by default; counts shown with source vs computed figures |
| 3.2 | 40 m buffered geofence | ✅ | Separate buffer and boundary layers; metre-based |
| 3.3 | Dual markers: snapped visitor + aircraft | ✅ 🧪 | Stale markers grey out with “Last update … ago” |
| 3.4 | Pacing meter vs 15 m lead; LEADING / HOLDING / ARRIVED | ✅ 🧪 | Route-progress lead bar and separate straight-line separation; “uncertain” when position is stale/ambiguous/off-route; never a green “safe distance” |
| 3.5 | Drone bearing radar | ✅ ⚠️ | Sky pointer with bearing, cardinal, distance, look-up angle |
| 3.6 | Arrival chime, pop-up, vibration on landing | ✅ ⚠️ | Only on the server's confirmed landing event; chime needs a prior tap (audio unlock), vibration where supported; the visual screen always appears |
| 3.7 | Circular pacing reticle, cyan → amber auto-hold | ✅ | Reticle turns amber while holding; the hold reason is shown in words (e.g. “You are 24 m behind, so NAVI waits”) |
| 3.8 | Sky reticle “BEARING / ELEVATION / ALTITUDE AGL” | ✅ 🔁 | Altitude shown with its real reference (“relative to launch pad (simulated)”), never relabelled AGL; 15 m only as a labelled demo/planning value |
| 3.9 | Telemetry ribbon (airspeed, visitor pace, 433 MHz SiK RSSI, EKF) | ✅ 🧪 | In “Flight and location details”; plus mode, battery, GPS sats/HDOP, source |
| 3.10 | Arrival sequence: landing overlay with 5 × 5 m clearance, haptic, welcome | ✅ | Landing-zone square and rings while landing; arrival screen after confirmation; demo says “Demo journey complete” |
| 4.1 | Velocity threshold filtering | ✅ | 3 m/s after accuracy margin; re-anchor rule |
| 4.2 | Route graph snapping | ✅ | Continuity window, off-route and ambiguity checks (no forced snapping) |
| 4.3 | Hold/resume hysteresis | ✅ | 22 m / 17 m with dwell, on the ground station |
| 4.4 | Freshness heartbeat | ✅ | Four independent ages; heartbeat never refreshes location |
| 4.5 | GPS quality badge | ✅ | Matched/off-route/ambiguous, accuracy, rejected-fix count |
| 4.6 | Raw vs snapped ghost toggle | ✅ | “Show raw phone positions” |
| 4.7 | Packet-age sparkline, amber at 10 s | ✅ | Last 60 s of valid-fix age |
| 5.1 | Stale alert > 30 s, hover then RTL | ✅ 🧪 | Client banner > 30 s; server holds at 30 s and returns at 60 s |
| 5.2 | Wake-lock warning | ✅ | Reminder in the sheet; caution banner when a held lock is released; info banner when unsupported |
| 5.3 | “Wait for me” | ✅ 🧪 | Shows “Pause requested…” until confirmed; suspends the stale countdown (up to 5 min) |
| 5.4 | Emergency abort → RTL | ✅ 🧪 | Sent immediately (WebSocket priority + POST), no dialog; shows delivery/confirmation; on no acknowledgement: “Could not confirm the request. Stay clear of the aircraft and contact the operator.” Never shows RTL success from the click |
| 5.5 | Operator handover | ✅ 🧪 🔌 | Authenticated operator API; old-source samples rejected; RC takeover is a separate mechanism and never supplies a position |
| 5.6 | Holographic loiter orb with ripple | 🔁 | Standard amber “Wait for me” button (thumb reach, clear label); status change is the confirmation |
| 5.7 | Guarded long-press abort (hold 1.5 s) | 🔁 | Replaced by an immediate emergency stop (master prompt §8: no press-and-hold delay) |
| 5.8 | Supervised-autonomy shield | ✅ | Header shield opens the supervision explanation |
| 5.9 | Rover mode switcher | ✅ 🔁 | Settings toggle swaps icons/labels; kerb-avoidance indicators unavailable because robot-unsuitable edges are not in the data |
| 6.1 | Palette, fonts | 🔁 | Master prompt palette and Space Grotesk / Inter / JetBrains Mono (self-hosted subsets); daylight theme added |
| 6.2 | Glassmorphism, chamfers, HUD grid, glow | 🔁 | Chamfered status and meeting cards, faint map grid, glow on route/aircraft; frosted glass kept minimal for outdoor contrast |
| 7.1 | Route pulse 20 px/s | ✅ | `stroke-dasharray` running light |
| 7.2 | Radar sweep 0.5 Hz | ✅ | 2 s rotation; paused during critical alerts and with reduced motion |
| 7.3 | Status morph 0.3 s `cubic-bezier(.4,0,.2,1)` | ✅ | Status card colour/border transition |
| 7.4 | Haptics 15 / [30,50,30] / [100,50,100,50,200] | ✅ ⚠️ | Tap, hold, alert; setting to turn off; iOS Safari has no Vibration API (visual only) |
| 8.1 | 390 × 844 first | ✅ | Also 320–430 px, landscape side panel, ≥ 900 px tablet/desktop side panel |
| 8.2 | 36 destinations, Haversine, 350 m legs | ✅ | Pad-to-pad legs of at most 350 m with handoffs; never split at invented points; over-limit plans are rejected |
| 95.1 | ≥ 95% of walking drone-guided | ✅ 🧪 | Planner requirement with unrounded check, detour limit and diagnostics; planned and observed coverage shown |
| 95.2 | Expanded pads (Guest House, SEDAXIS, academic blocks, hostels, gates, junctions) | ✅ | `data/pads.v1.json`, all proposed pending inspection; pad layer with clustering and a pad list |
| 95.3 | Handoffs with “Wait here…” and confirmed next leg | ✅ 🧪 🔌 | Single aircraft with staffed battery swap; multi-aircraft handover needs live availability (not simulated) |
| 8.3 | Live telemetry tickers incl. mode AUTO/GUIDED/HOLD/RTL | 🧪 | Simulated ArduPilot-style modes in the ribbon |
| 8.4 | Every failover, wake lock, pause, filter | ✅ | See rows above and tests |

Master-prompt screens A–H, alert list and controls table are all implemented: start location (measured / place / pin with nudge buttons / pad QR, outside-campus handling, “Starting point selected” vs live sharing), directory, route preview, dispatch states with cancel, guidance HUD, direction indicator, alerts (permission denied, unavailable, poor accuracy, stale, ground link lost, aircraft telemetry lost, wake lock released/unsupported, off-route, rejected command/mission, low battery, GPS/EKF, geofence, operator handover/RC), arrival with destination reached / landing / landing confirmed and Finish / Choose another / local feedback. An explicit **Stop sharing** control explains that NAVI will hold and then return.

## Tests and results (13 Oct 2026, Node 22, Chromium via Playwright)

| Suite | Result | Covers (acceptance test numbers from the master prompt) |
| --- | --- | --- |
| `tests/core.test.mjs` | 25 / 25 pass | Dataset import and invalid data (1); ETA, metre fence, whole-route check, forbidden/penalty edges, leg limit, pad readiness, already-at-destination (5); filter validation, velocity, re-anchor, off-route, freshness (3, 4); idempotency, dispatch states, command lifecycle, resume needs a fresh fix (6); stale boundary 29.5 s / 30.6 s / 60.6 s (7); abort not confirmed during telemetry loss, handover rejects old source, RC ≠ position (8); landing confirmation order (9); close mid-flight recovers |
| `tests/coverage.test.mjs` | 17 / 17 pass | 95% arithmetic (exactly 95%, 94.96%, 94.999% shown as 94.9%, zero distance); required pads and the shared D1/D2 candidate; Gate ↔ Guest House, Gate ↔ VIT-SEDAXIS, Gate → every academic block and hostel, hostel → academic block (segment lengths add up, legs chain through pads, legs within limits, detour limit); manual/off-graph origins; no aircraft; missing handoff crew; unavailable pad; disconnected graph; detour limit; a simulated multi-leg trip with handoffs and observed coverage ≥ 95%; interrupted guidance lowering observed coverage; a missing handoff crew interrupting guidance until restored |
| `tests/server.test.mjs` | 8 / 8 pass | Health, static file isolation and traversal, cross-origin refusal, input validation, idempotency, session isolation, operator auth, WebSocket origin/auth/snapshot/acks/replay, HTML escaping (10, 12); pad configuration, coverage in previews, operator aircraft and handoff controls |
| `tests/e2e.mjs` | 34 / 34 checks pass | Demo journey; multi-leg trip with handoffs (“Wait here…”, leg 2 resumes, planned and observed coverage at arrival); sharing active only after acknowledgement; pause/resume confirmation; stale alert; unconfirmed emergency stop wording and “Guidance interrupted”; stop sharing; live mode with the real geolocation API against the mock server; disconnected live mode never simulated; offline shell; hostile QR parameters |
| `tools/coverage-report.mjs` | 1,580 of 1,580 evaluated trips qualify | Every pad and destination entrance as origin × all 36 destinations ([report](docs/coverage-report.md)); from the Main Gate 35 of 35 destinations now reach 95% (3 of 35 with the old six-pad planner) |
| `tests/budget.mjs` | 282.7 KB gzip, 263.6 KB brotli, 612.9 KB raw (31 files) | First-load budget (15); excludes map tiles, the lazy About render and the operator console |

Also checked by hand with screenshots: 320 × 640, 390 × 844, 844 × 390 landscape, 1024 × 768; dark and daylight themes; keyboard tab order and focus, labelled controls, ≥ 44 px targets; reduced motion stops the sweep and pulse; live regions announce state changes and critical alerts (repeats muted for 20 s).

## Not yet verified (no devices available)

Only desktop Chromium (headless, mobile emulation) was used. **Untested:** Android Chrome and Samsung Internet on real phones; iOS Safari and iOS home-screen PWA (geolocation prompts, `DeviceOrientationEvent.requestPermission`, no Vibration API, wake-lock support that varies by iOS version, background suspension); Firefox for Android (compass and wake-lock support differ); screen readers (TalkBack, VoiceOver) on devices; OS large-text settings (the layout uses px sizes that scale with browser zoom); behaviour with the screen locked; real campus Wi-Fi reachability and certificates; GPS accuracy on campus. These must be checked before any trial.

## Live integration tasks

1. Inspect and approve (or move) every proposed pad in `data/pads.v1.json`; record approval and the real handoff crews, then re-run `tools/gen-pads.mjs` and `tools/coverage-report.mjs`. 34 building-entrance, 2 gate and 3 path/junction candidates were added to the six source pads; see the report for the list.
1. Replace the simulated aircraft in `js/sim/groundstation.js` with a MAVLink bridge (SiK 433 MHz or ESP32) to the F405/ArduPilot: map `mission`/`aircraft` events to HEARTBEAT, GLOBAL_POSITION_INT, SYS_STATUS, EKF_STATUS_REPORT; send guided position targets, LOITER/BRAKE for holds and RTL/LAND for recovery; confirm commands from vehicle state, not from the send.
2. Mirror the hold/RTL watchdogs in ArduPilot failsafes (GCS loss, battery, EKF, fence) so they work without the laptop.
3. Run the timed hover and route survey; set `legLimitM`, `planningAltitudeM`, lead and pacing thresholds from measured endurance, handset error and hover error.
4. Add footpath/road classification, forbidden edges and robot-unsuitable edges to the dataset; flip `edgeMeta.classified` once inspected.
5. Define pad readiness and operator staffing in the operator console; persist only what the retention policy allows.
6. Deploy over HTTPS on the campus network as described; test reachability from visitor Wi-Fi.
7. Provide an operator tracker/device flow for position handover in the field; keep the FS-i6X RC link independent.
8. Verify on real Android/iOS devices and record the results here.

## Attribution

Campus boundary © OpenStreetMap contributors (ODbL 1.0). Paths and entrances: VIT Chennai Way Finder routing data as processed in the team's NAVI app. Map library: Leaflet 1.9.4 (BSD-2-Clause, `vendor/leaflet/LICENSE`). Fonts: Inter, Space Grotesk, JetBrains Mono (SIL OFL 1.1, `fonts/LICENSE-*`). Optional tiles: Esri World Imagery, OpenStreetMap standard tiles, both with on-map attribution. About image: render of the team's F450 CAD design model, marked “Design model”.
