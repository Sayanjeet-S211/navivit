// NAVI — content data.
// Sources: NAVI Complete Project Summary (12 Oct 2026), 20% review deck, and the
// project's web-showcase specification. Prices are planning estimates, not quotes.

export const TEAM = [
  { name: 'Carollo Aradhan V', initials: 'CA', school: 'SMEC', dept: 'Mechanical', role: 'Airframe lead',
    work: 'Airframe assembly, landing gear, motor and ESC mounting, vibration isolation, weight and thrust budget, and CAD modelling.' },
  { name: 'Utkarsh Dilipkumar Ghorpade', initials: 'UG', school: 'SENSE', dept: 'Electronics', role: 'Electronics and link lead',
    work: 'Power module wiring, GPS and compass integration, the 433 MHz SiK telemetry link, and LiPo charging and care.' },
  { name: 'N Arun', initials: 'NA', school: 'SCOPE', dept: 'Computer Science', role: 'Autonomy lead',
    work: 'ArduPilot configuration, sensor calibration, MAVLink scripting, ArduPilot SITL simulation and pacing-controller logic.' },
  { name: 'Muhammed Farhan', initials: 'MF', school: 'SCOPE', dept: 'Computer Science', role: 'Mapping and planning lead',
    work: 'Campus route-graph processing, the Dijkstra planner, launch-pad set-cover optimisation and geofence integration.' },
  { name: 'Sayanjeet Das', initials: 'SD', school: 'SCOPE', dept: 'Computer Science', role: 'Interface and validation lead',
    work: 'Kiosk and control web applications, phone GPS intake filtering, documentation and budget tracking.' }
];

// Subsystem layers of the CAD model. `color` is a UI accent, not the CAD paint.
export const LAYERS = [
  { id: 'structure', n: 'L1', name: 'Structural', color: '#b9ccd1',
    blurb: 'Glass-fibre top plate, bottom plate with integrated PDB copper traces, arms and tall landing legs.' },
  { id: 'propulsion', n: 'L2', name: 'Propulsion', color: '#edc18a',
    blurb: 'A2212 1000KV brushless motors, SimonK 30A ESCs and 1045 propellers.' },
  { id: 'avionics', n: 'L3', name: 'Avionics', color: '#95e5c9',
    blurb: 'F405 flight controller isolated on M3 rubber anti-vibration grommets to protect the IMU from motor vibration.' },
  { id: 'sensors', n: 'L4', name: 'Sensor mast & telemetry', color: '#8ec5ec',
    blurb: 'Raised GPS/compass mast, 433 MHz SiK transceiver antenna and the FlySky iA6B iBUS receiver.' },
  { id: 'power', n: 'L5', name: 'Power bay', color: '#f0a586',
    blurb: '3S LiPo mounted centrally with XT60 wiring and a current-sensing power module.' }
];

const KIT = 'Included in F450 kit (Rs 4,059)';

// Components of the CAD model. `nodes` are prefixes of node names in navi_f450.glb.
// `anchor` names the node whose bounding box positions the hotspot.
export const PARTS = [
  {
    id: 'top', n: '01', layer: 'structure', name: 'Top plate', short: 'Top plate',
    nodes: ['top_plate'], anchor: 'top_plate', owner: 'Carollo Aradhan V',
    status: 'In airframe kit', budget: KIT, envelope: '116 × 116 × 1.8 mm',
    does: 'Closes the centre section and carries the avionics stack: the flight controller on its dampers, the receiver, the power module, the SiK radio and the GPS mast base.',
    why: 'Glass-fibre plates are stiff and light, and the F450 layout leaves a flat deck for a 30.5 mm flight-controller pattern with room around it for the radios.',
    iface: [['Above', 'F405 on M3 grommets, iA6B, power module, SiK radio, GPS mast base'], ['Below', 'Arm roots, sandwiched to the bottom plate']],
    verify: 'Check screw torque and arm alignment after the first hard landing.'
  },
  {
    id: 'bottom', n: '02', layer: 'structure', name: 'Bottom plate with PDB', short: 'Bottom plate + PDB',
    nodes: ['bottom_plate_PDB'], anchor: 'bottom_plate_PDB', owner: 'Carollo Aradhan V',
    status: 'In airframe kit', budget: KIT, envelope: '140 × 140 × 1.8 mm',
    does: 'The lower frame plate doubles as the power distribution board: copper traces carry battery current to the four ESC pads and the power module.',
    why: 'An integrated PDB removes a separate board and its wiring. One XT60 feed splits to every high-current load.',
    iface: [['Battery in', 'XT60 via power module (V/I sense)'], ['ESC pads', '4 × solder pads, one per arm'], ['Wire', '14 AWG silicone, heat-shrunk']],
    verify: 'Continuity and short-circuit check with a multimeter before the first battery is connected.'
  },
  {
    id: 'arms', n: '03', layer: 'structure', name: 'F450 arms ×4', short: 'Arms ×4',
    nodes: ['arm_'], anchor: 'arm_45', owner: 'Carollo Aradhan V',
    status: 'In airframe kit', budget: KIT, envelope: '450 mm wheelbase (diagonal)',
    does: 'Carry the motors at the tips and route ESC power along their length. Red arms mark the front (+X); white arms mark the rear.',
    why: 'A 450 mm wheelbase swings 10-inch propellers with clearance and matches the A2212 / 3S thrust budget.',
    iface: [['Front', 'Red arms (+X); orange propellers'], ['Rear', 'White arms; dark propellers']],
    verify: 'Arm-to-plate squareness; propeller tip clearance to the GPS mast and antennas.'
  },
  {
    id: 'gear', n: '04', layer: 'structure', name: 'Tall landing gear', short: 'Landing gear',
    nodes: ['gear_'], anchor: 'gear_skid_1', owner: 'Carollo Aradhan V',
    status: 'Stage 1 purchase', budget: 'Rs 300–500', envelope: '150 mm below bottom plate',
    does: 'Four legs and two foam-padded skids lift the aircraft so the under-slung battery clears the ground and the pad surface.',
    why: 'Tall legs keep the 3S pack and XT60 off gravel and grass on unprepared 5 m × 5 m landing pads.',
    iface: [['Mount', 'Bottom plate'], ['Contact', 'Two skids with foam pads']],
    verify: 'Clearance under the battery at full compression; tip-over margin on a slope.'
  },
  {
    id: 'motors', n: '05', layer: 'propulsion', name: 'A2212 1000KV motors ×4', short: 'A2212 motors',
    nodes: ['motor_', 'prop_adapter_'], anchor: 'motor_45', owner: 'Carollo Aradhan V',
    status: 'In airframe kit', budget: `${KIT}; spare motor Rs 479`, envelope: '28 mm can · 1000 KV',
    does: 'Brushless outrunners that turn the 1045 propellers. ArduPilot changes each motor’s speed independently to hold attitude and position.',
    why: 'Sized for 3S thrust-to-weight balance on a 450 mm frame. One spare is budgeted because one bad landing can destroy a motor.',
    iface: [['Phase wires', '3 × to the arm’s ESC'], ['Quad X order', 'M1 front-right CCW · M2 rear-left CCW · M3 front-left CW · M4 rear-right CW']],
    verify: 'Spin direction per motor with propellers removed; bearing noise and heat after a timed hover.'
  },
  {
    id: 'props', n: '06', layer: 'propulsion', name: '1045 propellers ×4', short: '1045 props',
    nodes: ['prop_1045_'], anchor: 'prop_1045_315', owner: 'Carollo Aradhan V',
    status: 'In kit + spares', budget: 'In kit; 2–3 spare pairs Rs 300–450', envelope: '254 mm (10 in) dia · 4.5 in pitch',
    does: 'Two clockwise and two counter-clockwise propellers. The orange front pair makes heading readable from the ground.',
    why: 'The standard pairing for A2212 1000KV on 3S. Contrasting front colours help the safety operator judge orientation at a distance.',
    iface: [['Mount', 'Prop adapter on motor shaft'], ['Pairs', 'CW on M3/M4, CCW on M1/M2']],
    verify: 'Balance every propeller; fit them only after every props-off failsafe test passes.'
  },
  {
    id: 'escs', n: '07', layer: 'propulsion', name: 'SimonK 30A ESCs ×4', short: '30A ESCs',
    nodes: ['esc_30A_'], anchor: 'esc_30A_315', owner: 'Utkarsh Dilipkumar Ghorpade',
    status: 'In airframe kit', budget: KIT, envelope: '4 × discrete, under each arm',
    does: 'Turn battery DC into three-phase drive for each motor, commanded by standard PWM from the flight controller.',
    why: 'The kit’s discrete ESCs work with an ArduPilot F405 over plain PWM, so no 4-in-1 stack is needed. Buy the FC alone.',
    iface: [['Signal', 'FC outputs M1–M4 (PWM) + GND'], ['Power', 'PDB pads'], ['Setting', 'MOT_PWM_TYPE = 0 (normal PWM)']],
    verify: 'Calibrate the ESCs once during setup; confirm all four start together.'
  },
  {
    id: 'fc', n: '08', layer: 'avionics', name: 'F405 flight controller', short: 'F405 FC',
    nodes: ['flight_controller_F405', 'fc_mcu', 'fc_forward_arrow'], anchor: 'flight_controller_F405', owner: 'N Arun',
    status: 'Stage 1 purchase', budget: 'Rs 3,000–4,500', envelope: '36 × 36 mm · 30.5 mm pattern',
    does: 'Runs official ArduPilot firmware: stabilisation, the EKF, AUTO and GUIDED flight, geofence and onboard failsafes. It accepts mission and pacing commands over MAVLink.',
    why: 'An F405-class board on ArduPilot’s supported list (e.g. SpeedyBee F405 V3 FC-only, or Matek F405) has a barometer and 3+ UARTs at a fraction of a Pixhawk’s cost.',
    pinout: [
      ['TELEM UART', 'SiK 433 MHz radio', 'SERIALn_PROTOCOL = 2 (MAVLink 2) · 57600 baud'],
      ['GPS UART + I²C', 'NEO-M8N + compass', 'SERIALn_PROTOCOL = 5 (GPS) · SDA/SCL for compass'],
      ['RX pad', 'iA6B iBUS', 'RC input (iBUS); throttle failsafe → RTL'],
      ['M1–M4', '4 × 30A ESC', 'PWM · Quad X (FRAME_CLASS 1, FRAME_TYPE 1)'],
      ['VBAT / CURR / 5V', 'Power module', 'BATT_MONITOR = 4 (analog V and I)']
    ],
    pinNote: 'Proposed allocation. UART numbering differs between boards: confirm against the chosen board’s ArduPilot hardware page before wiring.',
    verify: 'Accelerometer, compass and radio calibration; every failsafe triggered on the bench with propellers off.'
  },
  {
    id: 'dampers', n: '09', layer: 'avionics', name: 'M3 anti-vibration grommets', short: 'M3 grommets',
    nodes: ['fc_damper'], anchor: 'fc_damper_15', owner: 'Carollo Aradhan V',
    status: 'Stage 1 purchase', budget: 'Rs 100–200', envelope: '4 × M3 · 30.5 mm square',
    does: 'Soft-mount the flight controller so that motor and propeller vibration does not corrupt the IMU’s accelerometer and gyro data.',
    why: 'Poor mounting is a listed risk: aliased vibration degrades the EKF position estimate that GPS autonomy depends on.',
    iface: [['Pattern', '30.5 × 30.5 mm (M3)'], ['Between', 'Top plate and F405 board']],
    verify: 'Review vibration logs and FFT after the first manual hovers, before any autonomy.'
  },
  {
    id: 'gps', n: '10', layer: 'sensors', name: 'NEO-M8N GPS + compass mast', short: 'GPS / compass mast',
    nodes: ['gps_'], anchor: 'gps_M8N_compass', owner: 'Utkarsh Dilipkumar Ghorpade',
    status: 'Stage 2 purchase', budget: 'Rs 1,200–2,000', envelope: 'Ø60 mm puck · 95 mm mast',
    does: 'Provides position (about 2.5–5 m without RTK) and heading. ArduPilot needs both for position hold, return-to-launch and waypoint flight.',
    why: 'Raised on a mast, away from the PDB and motor wires, so their magnetic fields do not bias the compass. The puck’s arrow points forward.',
    pinout: [
      ['5V / GND', 'FC GPS port', 'Power from FC'],
      ['TX → RX', 'FC GPS UART', 'NMEA/UBX position'],
      ['RX ← TX', 'FC GPS UART', 'Configuration'],
      ['SDA / SCL', 'FC I²C', 'Compass (heading)']
    ],
    pinNote: 'Standard 2.5–5 m accuracy is compensated by a ~15 m lead distance and 5 m × 5 m landing zones.',
    verify: 'Spot-check the GPS at five or six known graph nodes; confirm no systematic offset from the wayfinder coordinates.'
  },
  {
    id: 'sik', n: '11', layer: 'sensors', name: 'SiK 433 MHz telemetry radio', short: 'SiK 433 MHz',
    nodes: ['telemetry_'], anchor: 'telemetry_SiK_433', owner: 'Utkarsh Dilipkumar Ghorpade',
    status: 'Stage 3 purchase', budget: 'Rs 2,500–4,000 (pair)', envelope: 'Onboard half of the pair',
    does: 'Bidirectional MAVLink channel between the aircraft and the kiosk ground station: mission upload, pacing commands down; position and status up.',
    why: '433 MHz is used because 915 MHz is not a licence-free band in India. Required for unattended kiosk operation; an ESP32 Wi-Fi bridge (≈20–30 m) is the short-range alternative.',
    pinout: [
      ['5V / GND', 'FC TELEM port', 'Power'],
      ['TX → RX', 'FC TELEM UART', 'MAVLink to FC'],
      ['RX ← TX', 'FC TELEM UART', 'MAVLink from FC'],
      ['Config', 'SERIALn_PROTOCOL = 2', '57600 baud, matched NetID with ground radio']
    ],
    verify: 'Range test at the furthest pad; telemetry-loss failsafe in SITL, then with the ground radio unplugged in the field.'
  },
  {
    id: 'rx', n: '12', layer: 'sensors', name: 'FlySky iA6B receiver', short: 'iA6B receiver',
    nodes: ['receiver_iA6B', 'rx_antenna'], anchor: 'receiver_iA6B', owner: 'N Arun',
    status: 'Stage 1 purchase', budget: 'Rs 3,500–4,500 (with FS-i6X)', envelope: 'Dual antenna · 2.4 GHz',
    does: 'Receives the safety operator’s FS-i6X transmitter over an independent 2.4 GHz link and passes stick and switch positions to the FC over iBUS.',
    why: 'A second, independent link: if telemetry, the Wi-Fi bridge or the laptop fails, the radio still works. One switch moves from the NAVI route to position hold or full manual.',
    pinout: [
      ['iBUS servo', 'FC RX pad', 'Single-wire RC input'],
      ['5V / GND', 'FC', 'Power'],
      ['Failsafe', 'FS_THR_ENABLE', 'RC loss → return to launch']
    ],
    pinNote: 'F405 boards do not read plain multi-wire PWM receivers; the receiver must output iBUS, SBUS or PPM.',
    verify: 'Transmitter-off test with props removed; confirm RTL triggers.'
  },
  {
    id: 'battery', n: '13', layer: 'power', name: '3S LiPo 3300 mAh', short: '3S LiPo',
    nodes: ['battery_'], anchor: 'battery_3S_3300mAh', owner: 'Utkarsh Dilipkumar Ghorpade',
    status: 'Stage 1 purchase (+ second pack in Stage 2)', budget: 'Rs 1,500–2,200 per pack', envelope: '138 × 43 × 25 mm (approx.)',
    does: 'The only energy source: 11.1 V nominal, 25C or higher, XT60, held centrally under the frame by two straps.',
    why: 'Estimated 10–13 minutes of hover on 3300 mAh (about 8–9 minutes on 2200 mAh) with no companion computer. The 350 m leg limit depends on this figure.',
    iface: [['Connector', 'XT60 → power module'], ['Mount', '2 straps, centred under the bottom plate'], ['Care', 'Balance charger; LiPo safe bag']],
    verify: 'Timed hover to failsafe with the real payload replaces the estimate; capacity check on each new pack.'
  },
  {
    id: 'pm', n: '14', layer: 'power', name: 'Power module (V/I sense)', short: 'Power module',
    nodes: ['power_module'], anchor: 'power_module', owner: 'Utkarsh Dilipkumar Ghorpade',
    status: 'Stage 1 purchase', budget: 'Rs 500–800', envelope: 'In-line XT60',
    does: 'Supplies a clean 5 V to the flight controller and reports battery voltage and current, which drive ArduPilot’s low-battery failsafe.',
    why: 'Without current sensing, the reserve threshold behind the 350 m leg cannot be enforced in flight.',
    pinout: [
      ['XT60 in / out', 'Battery → PDB', 'Main current path'],
      ['5V / GND', 'FC', 'Regulated supply'],
      ['V sense', 'FC VBAT ADC', 'BATT_MONITOR = 4'],
      ['I sense', 'FC CURR ADC', 'Calibrate BATT_AMP_PERVLT']
    ],
    verify: 'Calibrate voltage and current against a multimeter; trigger the low-voltage failsafe on the bench.'
  }
];

// Bill of materials (flight hardware). Ranges in rupees.
export const BOM = [
  { sub: 'Airframe', item: 'F450 glass-fibre frame kit', role: 'Integrated power distribution board (PDB) and tall landing legs.', lo: 4059, hi: 4059, note: 'Confirmed listing', part: 'bottom' },
  { sub: 'Propulsion motors', item: '4 × A2212 1000KV brushless', role: 'Sized for 3S thrust-to-weight balance on a 450 mm frame.', kit: true, part: 'motors' },
  { sub: 'Speed controllers', item: '4 × SimonK 30A ESC', role: 'Driven by standard PWM outputs from the flight controller.', kit: true, part: 'escs' },
  { sub: 'Propellers', item: '1045 propeller pairs', role: '10-inch diameter, 4.5-inch pitch.', kit: true, part: 'props' },
  { sub: 'Flight controller', item: 'F405-class board (SpeedyBee / Matek)', role: 'Official ArduPilot firmware; onboard barometer and 3+ UARTs.', lo: 3000, hi: 4500, part: 'fc' },
  { sub: 'Positioning', item: 'u-blox NEO-M8N / M10 GNSS + compass', role: 'Elevated on a mast, away from PDB and motor-wire interference.', lo: 1200, hi: 2000, part: 'gps' },
  { sub: 'Manual RC radio', item: 'FlySky FS-i6X + iA6B receiver', role: 'iBUS link for instant manual intervention, tuning and arming.', lo: 3500, hi: 4500, part: 'rx' },
  { sub: 'Ground data link', item: 'SiK telemetry pair, 433 MHz', role: 'Bidirectional MAVLink between aircraft and kiosk / ground station.', lo: 2500, hi: 4000, part: 'sik' },
  { sub: 'Battery pack', item: '3S LiPo 2200–3300 mAh, 25C, XT60', role: 'About 8–13 minutes of hover endurance (estimate).', lo: 1500, hi: 2200, part: 'battery' },
  { sub: 'Power module', item: '5 V BEC with voltage and current sensing', role: 'Powers the FC and reports battery state for low-voltage failsafes.', lo: 500, hi: 800, part: 'pm' },
  { sub: 'Spares & safety', item: 'Spare motor, extra 1045 props, LiPo safe bag', role: 'Field-repair reserve and safe battery storage.', lo: 1600, hi: 2100 }
];

// Budget roll-up from the project summary (§6).
export const BUDGET = {
  pool: 25000,
  reserve: [1500, 2000],
  configs: [
    { name: 'Airframe + Stage 1 + Stage 2', sub: 'Supervised autonomy', lo: 18600, hi: 25900, mid: 20000 },
    { name: '+ SiK telemetry pair', sub: 'Unattended-capable', lo: 21100, hi: 29900, mid: 23500 }
  ],
  stages: [
    { name: 'Airframe (identified)', range: 'about Rs 4,600', items: 'F450 kit, spare motor, XT60 pairs' },
    { name: 'Stage 1 · get it hovering', range: 'Rs 11,300–17,100', items: 'FC, RC radio, battery, charger, power module, legs, spare props, wiring, grommets, LiPo safety' },
    { name: 'Stage 2 · GPS autonomy', range: 'Rs 2,700–4,200', items: 'NEO-M8N/M10 GPS with mast, second battery — only after a steady manual hover' },
    { name: 'Stage 3 · NAVI ground link', range: 'Rs 2,500–4,000', items: 'SiK 433 MHz pair (or ESP32 Wi-Fi bridge, Rs 400–500, short range)' }
  ]
};

export const DECISIONS = [
  { k: 'Zero onboard companion computer', v: 'Path planning, graph traversal and pacing run on the ground-station laptop or kiosk and reach the aircraft as MAVLink commands. No extra payload, lower cost, longer battery life.' },
  { k: 'No proprietary drones', v: 'Commercial camera drones have closed firmware that blocks external MAVLink control, and their follow-me modes follow rather than lead.' },
  { k: 'No legacy boards', v: 'KK2.1.5 and APM 2.8 boards were excluded: no autonomous GPS navigation and no support in current ArduPilot.' },
  { k: 'Standard GPS, adapted', v: 'Standard GPS gives 2.5–5 m, not centimetre RTK. The design compensates with a ~15 m lead distance and 5 m × 5 m clear landing zones.' }
];

export const ALTERNATIVES = [
  ['ADAPT lab hardware (S500, Pixhawk, RTK F9P)', 'Unavailable', 'Not obtainable by the team'],
  ['MDP / IDP component store', 'Unavailable', 'Team cannot draw components from it'],
  ['LiteWing ESP32 micro drone', 'Rejected', 'About 45 g, no GPS, indoor firmware, short Wi-Fi range'],
  ['Indoor drone or indoor robot', 'Rejected', 'No GPS indoors; weakens the problem statement'],
  ['Outdoor ground robot', 'Backup', 'Cheapest working option; same software'],
  ['ESP32 as the flight controller', 'Rejected', 'No mature GPS-navigation firmware; used only as a telemetry bridge'],
  ['Toy / GPS camera drones', 'Rejected', 'Closed firmware, no MAVLink; follow-me follows rather than leads'],
  ['Pixhawk 2.4.8 full combo (Rs 15,599)', 'Rejected', 'Full build would reach Rs 27,000–31,000'],
  ['FlyRobo kit / Amazon F450 kit', 'Rejected', 'KK2.1.5 cannot run ArduPilot / about Rs 3,000 dearer'],
  ['F450 kit from an RC store (Rs 4,059)', 'Selected', 'Same parts, lowest price found, in stock']
];

export const SAFETY = [
  { id: 'gps', trigger: 'GPS fix degraded / lost', primary: 'Enter position hold / loiter.', secondary: 'Land vertically if the EKF failsafe triggers.', path: ['WARNING', 'HOLD', 'EMERGENCY'], sev: 'High', verify: 'Bench props-off; GPS-denied test; RC takeover drill' },
  { id: 'telem', trigger: 'Telemetry link dropped', primary: 'Aircraft loiters and waits for reconnection.', secondary: 'Autonomous return-to-launch (RTL) to the origin pad.', path: ['WARNING', 'HOLD', 'RETURN_TO_LAUNCH'], sev: 'High', verify: 'Unplug ground radio in SITL, then in the field' },
  { id: 'rc', trigger: 'Manual RC link dropped', primary: 'Autonomous return-to-launch (RTL).', secondary: 'Vertical auto-land if the battery is low.', path: ['WARNING', 'RETURN_TO_LAUNCH', 'EMERGENCY'], sev: 'High', verify: 'Transmitter-off test, props-off first' },
  { id: 'stale', trigger: 'Visitor position stale (> 30 s)', primary: 'Pacing controller halts the aircraft into loiter.', secondary: 'Autonomous RTL if the data remains stale.', path: ['WARNING', 'HOLD', 'RETURN_TO_LAUNCH'], sev: 'Medium', verify: 'Simulation now; SITL; walking volunteer' },
  { id: 'batt', trigger: 'Battery below reserve threshold', primary: 'Immediate abort of the guidance mission.', secondary: 'Autonomous RTL to the nearest landing pad.', path: ['WARNING', 'RETURN_TO_LAUNCH'], sev: 'High', verify: 'Bench voltage threshold; timed hover' },
  { id: 'fence', trigger: 'Geofence breach (> 40 m outside bounds)', primary: 'Autonomous halt and position hold.', secondary: 'Return within the surveyed campus corridor.', path: ['WARNING', 'HOLD', 'SAFE'], sev: 'High', verify: 'Fence export to ArduPilot; SITL breach' }
];

export const STATES = [
  { id: 'SAFE', label: 'SAFE', desc: 'Guiding normally. Visitor tracked, links up, inside the fence.' },
  { id: 'WARNING', label: 'WARNING', desc: 'A signal is degraded. Thresholds are being watched; no action yet.' },
  { id: 'HOLD', label: 'HOLD', desc: 'Aircraft stops and loiters in place. The safe default on doubt.' },
  { id: 'RETURN_TO_LAUNCH', label: 'RETURN_TO_LAUNCH', desc: 'Mission abandoned. Fly the surveyed corridor back to a pad and land.' },
  { id: 'EMERGENCY', label: 'EMERGENCY', desc: 'Navigation cannot be trusted. Land vertically where it is.' }
];

export const PRINCIPLES = [
  'The safe default is always to hold and then return — never to continue on stale data.',
  'Waypoints are whitelisted: any target that is not a surveyed node is rejected before upload.',
  'Routes prefer verges and open ground; road edges carry a cost multiplier in the planner.',
  'The visitor walks the footpath, never the carriageway.',
  'Wind or rain above the threshold: do not launch (checked before each trip).',
  'Every failsafe is triggered deliberately and observed during testing, starting on the ground with propellers removed.'
];

export const PHASES = [
  { n: 0, name: 'Approvals & procurement', work: 'Secure written campus permission, verify regulatory guidelines (e.g. DigitalSky registration for 250 g–2 kg), and acquire Stage 1 hardware.', gate: 'Permission letter held; Stage 1 parts in hand.', status: 'In progress' },
  { n: 1, name: 'Assembly & bench', work: 'Build the F450 frame, route the power module, flash ArduPilot onto the F405, calibrate sensors, ESCs and radio, and verify failsafes with propellers removed.', gate: 'All calibrations pass; failsafes verified on the bench.', status: 'Pending' },
  { n: 2, name: 'Manual flight & tuning', work: 'Manual hovers in open ground, vibration FFT log review, and a timed hover to failsafe to measure usable endurance.', gate: 'Steady hover; acceptable vibration; measured flight time.', status: 'Pending' },
  { n: 3, name: 'GPS autonomy', work: 'Install the GPS/compass mast, tune Loiter and RTL, then fly node-to-node autonomous missions without visitors.', gate: 'Repeatable route flight without intervention.', status: 'Pending' },
  { n: 4, name: 'Human pacing validation', work: 'Validate the pacing controller in ArduPilot SITL, then in live field trials with walking volunteers.', gate: 'Pacing validated in SITL before any live trial.', status: 'Pending' },
  { n: 5, name: 'Full integration', work: 'Integrate the gate kiosk, phone position intake, the 433 MHz SiK link and fault-injection safety drills.', gate: 'Every failsafe triggered and observed; successful guided trips.', status: 'Pending' }
];

export const MEASUREMENTS = [
  ['Timed hover to failsafe with the real payload, plus hover throttle', 'Replaces the endurance estimate behind the 350 m limit and the six pads'],
  ['Battery capacity check on new packs', 'Lower capacity shortens the leg limit proportionally'],
  ['Overhead obstructions (cables, canopy) per route segment', 'Replaces the flat 15 m cruise-altitude placeholder'],
  ['GPS spot-check at five or six known nodes', 'Confirms the wayfinder coordinates have no systematic offset'],
  ['Phone GPS error on a known route, several handsets', 'Sets the pacing thresholds and lead distance'],
  ['Hover position error versus wind', 'Sets the wind limit for launch']
];

export const RISKS = [
  ['Crash during learning', 'Inexperienced first flights', 'Simulator stick practice; fly low and slow in open ground; spare props and motor; crash reserve'],
  ['Budget overrun', 'Prices higher than estimated', 'Staged buying; Rs 1,500–2,000 reserve; check every listing before ordering'],
  ['GPS accuracy', '2.5–5 m without RTK', '15 m lead; 5 m pads; snap to graph; hold on doubt'],
  ['Endurance', 'Unknown until measured', 'Measure early; recompute leg limit and pads if needed'],
  ['Phone position noise', 'About 7–13 m on phones', 'Filtering, hysteresis; operator phone or tracker as fallback'],
  ['Screen lock', 'Phones throttle location when locked', 'Wake lock and prompt; hold on stale data; operator device'],
  ['Link loss', 'Wi-Fi or SiK dropout', 'RC radio as an independent link; failsafe to return or land'],
  ['Vibration', 'Poor mounting corrupts sensor data', 'Soft-mount the FC; check vibration logs before autonomy'],
  ['Wind', 'Slow lead flight is the hardest case', 'Measure hold error against wind; set a launch threshold'],
  ['Obstructions', 'Cables and canopy over roads', 'Survey per segment; per-segment altitude'],
  ['Permission or registration', 'Conditions not yet confirmed', 'Get written permission early; check registration rules'],
  ['Timeline', 'Drone not ready before a review', 'Ground robot runs the same software as a demonstrable backup']
];

export const QA = [
  ['Why did the hardware change?', 'The laboratory equipment was not available. The team evaluated more than ten alternatives and chose the cheapest platform that still runs ArduPilot and MAVLink, which the software requires.'],
  ['Why not buy a ready-made GPS drone?', 'Consumer drones have closed firmware. Their waypoint and follow-me modes run only in the vendor’s app, so NAVI’s routing, geofence and pacing logic cannot control them — and their follow-me follows rather than leads.'],
  ['Without RTK, is GPS accurate enough?', 'Standard GPS gives about 2.5–5 m. The lead was widened to about 15 m, pads made about 5 m across, positions snapped to the route graph, and the aircraft holds whenever readings disagree.'],
  ['What is novel? Waypoint flight is solved.', 'Correct. The contribution is pacing an aircraft to a walking person, the campus graph with pad optimisation and geofencing, and zero-install guidance.'],
  ['The campus already has a wayfinder.', 'It does, and its data is NAVI’s source. It is still a map, so the visitor must find themselves on it. NAVI removes that step.'],
  ['Why not computer vision to follow the person?', 'Re-identifying one pedestrian from the air among others, in varying light, is an open research problem. Position sharing is sufficient for pacing.'],
  ['Is it really autonomous if someone walks along?', 'Yes. The aircraft flies the route and paces itself. The operator only intervenes in an emergency, the same way autonomous vehicles are tested with a safety driver.'],
  ['What if it fails mid-guide?', 'Every failure has a defined response in the safety state machine, and each is tested deliberately.'],
  ['What if the drone isn’t ready by the review?', 'The ground robot runs the same planning and pacing software and can be demonstrated instead.']
];

export const REFERENCES = [
  ['U01', 'Kuys, B., Haig, A., Mridha, M. (2024). Exploring the Use of Landmarks to Aid Pedestrian Wayfinding. Applied Sciences 14(17), 7814.', '10.3390/app14177814', 'applsci-14-07814.pdf'],
  ['U02', 'Merei, A., Mcheick, H., Ghaddar, A., Rebaine, D. (2025). A Survey on Obstacle Detection and Avoidance Methods for UAVs. Drones 9(3), 203.', '10.3390/drones9030203', 'drones-09-00203-v4.pdf'],
  ['U03', 'Son, S.J., Kim, H.S., Kim, D.H. (2022). Waypoint and Autonomous Flying Control of an Indoor Drone for GPS-Denied Environments. IAES IJRA 11(3), 233–249.', '10.11591/ijra.v11i3.pp233-249'],
  ['U04', 'Tezza, D., Andujar, M. (2019). The State-of-the-Art of Human–Drone Interaction: A Survey. IEEE Access 7, 167438–167454.', '10.1109/ACCESS.2019.2953900'],
  ['U05', 'Avila Soto, M., Funk, M., Hoppe, M., Boldt, R., Wolf, K., Henze, N. (2017). DroneNavigator: Using Leashed and Free-Floating Quadcopters to Navigate Visually Impaired Travelers. ASSETS ’17.', '10.1145/3132525.3132556'],
  ['U06', 'Kruse, T., Pandey, A.K., Alami, R., Kirsch, A. (2013). Human-Aware Robot Navigation: A Survey. Robotics and Autonomous Systems 61(12), 1726–1743.', '10.1016/j.robot.2013.05.007', 'kruse13humanaware-preprint.pdf'],
  ['U07', 'Rousell, A., Zipf, A. (2017). Towards a Landmark-Based Pedestrian Navigation Service Using OSM Data. ISPRS IJGI 6(3), 64.', '10.3390/ijgi6030064', 'ijgi-06-00064.pdf'],
  ['U08', 'Selvi, H.Z., Bildirici, I.O., Ulugtekin, N. (2016). Landmark Orientation and Map Design for Pedestrians: Selçuk University Campus Pedestrian Navigation. IOP Conf. Ser. EES 44, 042027.', '10.1088/1755-1315/44/4/042027', 'Landmark_Orientation_and_Map_Design_for_Pedestrian.pdf'],
  ['U09', 'Newson, P., Krumm, J. (2009). Hidden Markov Map Matching Through Noise and Sparseness. ACM SIGSPATIAL GIS ’09, 336–343.', '10.1145/1653771.1653818', 'map-matching-ACM-GIS-camera-ready.pdf'],
  ['U10', 'Ebeid, E., Skriver, M., Jin, J. (2017). A Survey on Open-Source Flight Control Platforms of Unmanned Aerial Vehicle. Euromicro DSD 2017, 396–402.', '10.1109/DSD.2017.30'],
  ['S01', 'Wögerbauer, E.M., von Castell, C., Welsch, R., Hecht, H. (2024). Preferred Distance in Human–Drone Interaction. Vision 8(4), 59.', '10.3390/vision8040059'],
  ['S02', 'Gómez-López, A., Maya-López, Y., Olivos-Jara, P., Morales, R. (2026). Human-Drone Interaction in Older Adults: A Systematic Review. Drones 10(5), 389.', '10.3390/drones10050389'],
  ['S03', 'Singamaneni, P.T., Bachiller-Burgos, P., Manso, L.J., et al. (2024). A Survey on Socially Aware Robot Navigation: Taxonomy and Future Challenges. IJRR.', '10.1177/02783649241230562'],
  ['S04', 'Karwowski, J., Szynkiewicz, W., Niewiadomska-Szynkiewicz, E. (2024). Bridging Requirements, Planning, and Evaluation: A Review of Social Robot Navigation. Sensors 24(9), 2794.', '10.3390/s24092794'],
  ['S05', 'Ghambari, S., Golabi, M., Jourdan, L., Lepagnot, J., Idoumghar, L. (2024). UAV Path Planning Techniques: A Survey. RAIRO-Operations Research 58, 2951–2989.', '10.1051/ro/2024073'],
  ['S06', 'Yi, S., Zorzi, M., Jin, X., Su, T. (2024). A Switched Approach for Smartphone-Based Pedestrian Navigation. Sensors 24(16), 5247.', '10.3390/s24165247'],
  ['S07', 'Zhang, J., Yu, B., Ge, Y., Gao, J., Sheng, C. (2024). An Effective GNSS/PDR Fusion Positioning Algorithm on Smartphones for Challenging Scenarios. Sensors 24(5), 1452.', '10.3390/s24051452']
];

export const rupees = n => 'Rs ' + n.toLocaleString('en-IN');
export const rupeeRange = (lo, hi) => lo === hi ? rupees(lo) : `Rs ${lo.toLocaleString('en-IN')}–${hi.toLocaleString('en-IN')}`;
