# NAVI — Navigation Assistant for Visitor Interaction

Showcase website for NAVI, an autonomous quadcopter that leads visitors across the VIT Chennai campus. It is a static site with no build step: open `index.html` through any web server.

## Mobile visitor app

`app/` holds the NAVI visitor guide, a mobile Progressive Web App with a labelled demo mode (simulated aircraft), a live-mode adapter, a dependency-free mock ground station and an operator console. See [`app/README.md`](app/README.md) for setup, the API, the deployment plan and the feature traceability table. Online demo: `https://sayanjeet-s211.github.io/navivit/app/`.

## Run locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Open it through a server rather than straight from the file system: the 3D viewer and campus graph load files with `fetch`, which browsers block on `file://`.

## Publish with GitHub Pages

Settings → Pages → Deploy from a branch → choose the branch and `/ (root)`. The empty `.nojekyll` file makes Pages serve the files as they are.

## What is on the page

| Section | What it does |
|---|---|
| 01 Concept | Problem, journey comparison, animated pacing schematic, scope |
| 02 Airframe | Scroll-driven inspection of `navi_f450.glb`, then an interactive atelier: explode slider (vectors read from `navi_f450_exploded.glb`), five subsystem layers, 14 hotspots with specs, wiring and budget; CAD drawing set and STEP/STL/GLB downloads |
| 03 Hardware | Bill of materials, budget against the Rs 25,000 pool, vendor reference photos, design decisions |
| 04 Telemetry | Simulated ground-station HUD on a real campus route: flight modes, gauges, visitor tracking, fault injection driving the safety state machine |
| 05 Campus | Campus map from the real flight graph, live Dijkstra route planner, gate vs. pad distance chart, 350 m leg-limit calculator, pad table |
| 06 Software | Architecture, delivered apps, algorithms, pacing hysteresis, pad-to-pad Haversine matrix |
| 07 Safety | Interactive state machine (SAFE → WARNING → HOLD → RETURN_TO_LAUNCH → EMERGENCY) and failsafe table |
| 08 Roadmap | Phases 0–5 with gates, outstanding measurements, risk register, backup ground robot |
| 09 Team | Roles, and questions reviewers ask |

## Files

```
index.html                 the page
assets/css/site.css        styles (palette from the Prototype Atelier reference)
assets/js/main.js          section rendering, navigation, present mode
assets/js/data.js          content: parts, BOM, safety, phases, team, references
assets/js/cad.js           three.js viewers (scroll inspection + atelier)
assets/js/graph.js         campus graph: Haversine, Dijkstra, leg splitting, geofence
assets/js/campus.js        campus map, route planner, chart, calculator
assets/js/hud.js           telemetry simulation
assets/data/campus.json    flight graph, boundary, destinations, pads (extracted from navi_app)
assets/img/                web-sized renders and photos made from the originals in the repo root
vendor/three/              three.js r160 (MIT)
```

The CAD files, decks, reports and papers in the repository root are used in place; the site links to them and nothing at the root was moved or modified.

## Honesty notes

- No flight has been performed. Telemetry on the page is simulated, and the pacing thresholds are symbolic until phone GPS error is measured.
- Endurance, budget and positioning figures are planning estimates. Every one names the measurement that will replace it.
- The component photos are vendor reference images, not photographs of the team's hardware. Confirm that you may reuse them before publishing the site publicly.
- Campus boundary © OpenStreetMap contributors (ODbL 1.0). Paths and entrances are derived from the VIT Chennai Way Finder dataset. Map imagery in the app screenshot © Esri.
