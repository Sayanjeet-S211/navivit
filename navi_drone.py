"""
NAVI quadcopter — parametric CadQuery model of the planned F450 build.

All dimensions are NOMINAL values for the parts in the plan (F450 frame,
A2212 motors, 1045 props, 30A ESCs, F405 FC, M8N GPS puck, iA6B receiver,
3S 3300 mAh LiPo, tall landing gear). They are approximations for
visualisation and layout, not measured from the team's actual parts.
Units: millimetres. +X = forward, +Z = up. Origin = frame centre, top of
bottom plate.
"""
import math
import sys
import cadquery as cq

EXPLODE = "--explode" in sys.argv

# ── key dimensions ────────────────────────────────────────────────
WHEELBASE = 450.0                 # motor-to-motor diagonal
R_MOTOR = WHEELBASE / 2           # 225 mm centre to motor axis
PLATE_T = 1.8                     # plate thickness
ARM_H = 22.0                      # arm height (gap between plates)
ARM_W_IN, ARM_W_OUT = 34.0, 26.0  # arm width at root and tip
ARM_R0 = 42.0                     # arm root radius
PAD_D, PAD_T = 44.0, 4.0          # motor mount pad
MOTOR_D, MOTOR_H = 27.7, 26.0     # A2212 can
PROP_D = 254.0                    # 10 inch prop
BAT = (138.0, 43.0, 25.0)         # 3S 3300 mAh LiPo L x W x H
GEAR_H = 150.0                    # landing gear height below bottom plate

Z_BOT = 0.0
Z_ARM0 = PLATE_T
Z_TOP = PLATE_T + ARM_H           # underside of top plate
Z_TOP_UP = Z_TOP + PLATE_T        # top surface of top plate
Z_PAD_UP = Z_TOP + PAD_T          # top of motor pad

ARM_ANGLES = [45, 135, 225, 315]  # front-left/right are 45 and 315

# explode offsets (only applied with --explode)
EX = {"props": 200, "motors": 125, "avionics": 75, "top": 40, "arms": 0,
      "esc": -30, "bottom": -45, "battery": -105, "gear": -175} if EXPLODE else {}


def ex(key):
    return (0, 0, EX.get(key, 0))


# ── colours ───────────────────────────────────────────────────────
C = {
    "pcb":   cq.Color(0.10, 0.12, 0.14, 1),
    "plate": cq.Color(0.16, 0.17, 0.19, 1),
    "red":   cq.Color(0.78, 0.10, 0.10, 1),
    "white": cq.Color(0.92, 0.92, 0.90, 1),
    "motor": cq.Color(0.80, 0.55, 0.15, 1),
    "steel": cq.Color(0.72, 0.74, 0.77, 1),
    "prop":  cq.Color(0.08, 0.08, 0.09, 1),
    "propf": cq.Color(0.95, 0.45, 0.08, 1),
    "esc":   cq.Color(0.85, 0.12, 0.12, 1),
    "fc":    cq.Color(0.08, 0.10, 0.25, 1),
    "chip":  cq.Color(0.05, 0.05, 0.05, 1),
    "gps":   cq.Color(0.20, 0.21, 0.23, 1),
    "mast":  cq.Color(0.05, 0.05, 0.05, 1),
    "rx":    cq.Color(0.10, 0.10, 0.12, 1),
    "bat":   cq.Color(0.10, 0.30, 0.65, 1),
    "strap": cq.Color(0.10, 0.10, 0.10, 1),
    "xt60":  cq.Color(0.95, 0.75, 0.10, 1),
    "gear":  cq.Color(0.12, 0.12, 0.12, 1),
    "foam":  cq.Color(0.35, 0.35, 0.35, 1),
    "sik":   cq.Color(0.15, 0.40, 0.25, 1),
    "ant":   cq.Color(0.10, 0.10, 0.10, 1),
}

assy = cq.Assembly(name="NAVI_F450")


def add(shape, name, colour, offset=(0, 0, 0)):
    assy.add(shape.translate(offset) if offset != (0, 0, 0) else shape, name=name, color=C[colour])


# ── bottom plate (PCB power distribution board) ──────────────────
def centre_plate(size, t, holes=True):
    s = size / 2
    c = s * 0.42
    pts = [(s, c), (c, s), (-c, s), (-s, c), (-s, -c), (-c, -s), (c, -s), (s, -c)]
    p = cq.Workplane("XY").polyline(pts).close().extrude(t)
    if holes:
        p = p.faces(">Z").workplane().rect(54, 30).cutThruAll()
        for a in (0, 90, 180, 270):
            x, y = 38 * math.cos(math.radians(a)), 38 * math.sin(math.radians(a))
            p = p.faces(">Z").workplane().center(x, y).circle(6).cutThruAll()
    return p


bottom = centre_plate(140, PLATE_T).translate((0, 0, Z_BOT))
add(bottom, "bottom_plate_PDB", "pcb", ex("bottom"))

top = centre_plate(116, PLATE_T).translate((0, 0, Z_TOP))
add(top, "top_plate", "plate", ex("top"))

# ── arms ─────────────────────────────────────────────────────────
def arm():
    L = R_MOTOR - ARM_R0
    a = (cq.Workplane("YZ").rect(ARM_W_IN, ARM_H).workplane(offset=L)
         .rect(ARM_W_OUT, ARM_H * 0.8).loft())
    a = a.translate((ARM_R0, 0, Z_ARM0 + ARM_H / 2))
    # lightening windows on the sides
    for i in range(4):
        x = ARM_R0 + 30 + i * 32
        cut = cq.Workplane("XZ").center(x, Z_ARM0 + ARM_H / 2).rect(20, ARM_H * 0.45).extrude(30, both=True)
        a = a.cut(cut)
    pad = (cq.Workplane("XY").circle(PAD_D / 2).extrude(PAD_T)
           .translate((R_MOTOR, 0, Z_TOP)))
    pad = pad.faces(">Z").workplane().circle(4).cutThruAll()
    return a.union(pad)


for ang in ARM_ANGLES:
    colour = "red" if ang in (45, 315) else "white"
    add(arm().rotate((0, 0, 0), (0, 0, 1), ang), f"arm_{ang}", colour, ex("arms"))

# ── motors, prop adapters, props ─────────────────────────────────
def motor():
    base = cq.Workplane("XY").circle(MOTOR_D / 2).extrude(6)
    can = (cq.Workplane("XY").workplane(offset=6).circle(MOTOR_D / 2).extrude(MOTOR_H - 6)
           .faces(">Z").edges().fillet(2))
    for i in range(6):  # cooling slots on the bell
        a = i * 60
        slot = (cq.Workplane("XY").workplane(offset=10).center(
            (MOTOR_D / 2) * math.cos(math.radians(a)), (MOTOR_D / 2) * math.sin(math.radians(a)))
            .rect(4, 4).extrude(10))
        can = can.cut(slot)
    return base.union(can)


def adapter():
    a = cq.Workplane("XY").circle(4.5).extrude(10)
    cone = cq.Workplane("XY").workplane(offset=10).circle(4.5).workplane(offset=12).circle(1.5).loft()
    return a.union(cone)


def prop(direction):
    hub = cq.Workplane("XY").circle(8).extrude(7)
    blades = None
    R = PROP_D / 2
    stations = [6, 20, 40, 65, 90, 110, 122]
    chord = [12, 20, 23, 21, 17, 12, 7]
    lead = [(r, c * 0.38) for r, c in zip(stations, chord)]
    trail = [(r, -c * 0.62) for r, c in zip(stations, chord)][::-1]
    outline = lead + [(R, 0)] + trail
    for side in (1, -1):
        b = cq.Workplane("XY").spline(outline, periodic=True).close().extrude(2.0)
        b = b.rotate((0, 0, 1), (1, 0, 1), direction * 9).translate((0, 0, 2.5))   # blade pitch
        if side == -1:
            b = b.rotate((0, 0, 0), (0, 0, 1), 180)
        blades = b if blades is None else blades.union(b)
    return hub.union(blades)


for i, ang in enumerate(ARM_ANGLES):
    x = R_MOTOR * math.cos(math.radians(ang))
    y = R_MOTOR * math.sin(math.radians(ang))
    m = motor().translate((x, y, Z_PAD_UP))
    add(m, f"motor_{ang}", "motor", ex("motors"))
    ad = adapter().translate((x, y, Z_PAD_UP + MOTOR_H))
    add(ad, f"prop_adapter_{ang}", "steel", ex("motors"))
    direction = 1 if i % 2 == 0 else -1
    p = prop(direction).rotate((0, 0, 0), (0, 0, 1), ang + 30).translate((x, y, Z_PAD_UP + MOTOR_H + 2))
    add(p, f"prop_1045_{ang}", "propf" if ang in (45, 315) else "prop", ex("props"))

# ── ESCs under each arm ──────────────────────────────────────────
for ang in ARM_ANGLES:
    e = (cq.Workplane("XY").box(46, 24, 8).edges("|X").fillet(3)
         .translate((ARM_R0 + 80, 0, Z_ARM0 - 4)))
    add(e.rotate((0, 0, 0), (0, 0, 1), ang), f"esc_30A_{ang}", "esc", ex("esc"))

# ── flight controller on damping standoffs ───────────────────────
fc_z = Z_TOP_UP + 6
for dx in (-15.25, 15.25):
    for dy in (-15.25, 15.25):
        so = cq.Workplane("XY").circle(2.5).extrude(6).translate((dx, dy, Z_TOP_UP))
        add(so, f"fc_damper_{dx}_{dy}", "foam", ex("avionics"))
fc = cq.Workplane("XY").box(36, 36, 1.6).edges("|Z").fillet(3).translate((0, 0, fc_z + 0.8))
add(fc, "flight_controller_F405", "fc", ex("avionics"))
chip = cq.Workplane("XY").box(10, 10, 1.4).rotate((0, 0, 0), (0, 0, 1), 45).translate((0, 0, fc_z + 2.3))
add(chip, "fc_mcu", "chip", ex("avionics"))
arrow = (cq.Workplane("XY").polyline([(14, 0), (6, 6), (6, 2.5), (-8, 2.5), (-8, -2.5), (6, -2.5), (6, -6)])
         .close().extrude(0.4).translate((0, 0, fc_z + 1.6)))
add(arrow, "fc_forward_arrow", "white", ex("avionics"))

# ── GPS mast and puck (rear) ─────────────────────────────────────
mx = -42.0
mast_base = cq.Workplane("XY").box(16, 16, 6).translate((mx, 0, Z_TOP_UP + 3))
add(mast_base, "gps_mast_base", "mast", ex("avionics"))
mast = cq.Workplane("XY").circle(3.5).extrude(95).translate((mx, 0, Z_TOP_UP + 6))
add(mast, "gps_mast", "mast", ex("avionics"))
puck = (cq.Workplane("XY").circle(30).extrude(12).faces(">Z").edges().fillet(5)
        .translate((mx, 0, Z_TOP_UP + 101)))
add(puck, "gps_M8N_compass", "gps", ex("avionics"))
garrow = (cq.Workplane("XY").polyline([(14, 0), (2, 8), (2, 3), (-12, 3), (-12, -3), (2, -3), (2, -8)])
          .close().extrude(0.4).translate((mx, 0, Z_TOP_UP + 113)))
add(garrow, "gps_forward_arrow", "white", ex("avionics"))

# ── receiver, power module, telemetry ────────────────────────────
rx = cq.Workplane("XY").box(47, 33, 15).edges("|Z").fillet(2).translate((26, -28, Z_TOP_UP + 7.5))
add(rx, "receiver_iA6B", "rx", ex("avionics"))
for k, a in enumerate((60, -30)):
    ant = (cq.Workplane("XY").circle(0.8).extrude(60)
           .rotate((0, 0, 0), (0, 1, 0), 75).rotate((0, 0, 0), (0, 0, 1), a)
           .translate((26, -28, Z_TOP_UP + 15)))
    add(ant, f"rx_antenna_{k}", "ant", ex("avionics"))

pm = cq.Workplane("XY").box(25, 21, 9).translate((10, 34, Z_TOP_UP + 4.5))
add(pm, "power_module", "fc", ex("avionics"))
xt = cq.Workplane("XY").box(16, 8, 8).translate((25, 34, Z_TOP_UP + 4))
add(xt, "power_module_XT60", "xt60", ex("avionics"))

sik = cq.Workplane("XY").box(26, 55, 12).edges("|Z").fillet(2).translate((-8, 30, Z_TOP_UP + 6)) \
    .rotate((0, 0, 0), (0, 0, 1), 0)
sik = cq.Workplane("XY").box(55, 26, 12).edges("|Z").fillet(2).translate((-62, 34, Z_TOP_UP + 6))
add(sik, "telemetry_SiK_433", "sik", ex("avionics"))
sant = cq.Workplane("XY").circle(4).extrude(70).translate((-86, 34, Z_TOP_UP + 12))
add(sant, "telemetry_antenna", "ant", ex("avionics"))

# ── battery under the frame ──────────────────────────────────────
bz = Z_BOT - 4 - BAT[2] / 2
bat = cq.Workplane("XY").box(*BAT).edges().fillet(3).translate((0, 0, bz))
add(bat, "battery_3S_3300mAh", "bat", ex("battery"))
for sx in (-35, 35):
    strap = (cq.Workplane("XY").box(16, BAT[1] + 4, BAT[2] + 8)
             .cut(cq.Workplane("XY").box(18, BAT[1], BAT[2])).translate((sx, 0, bz + 2)))
    add(strap, f"battery_strap_{sx}", "strap", ex("battery"))
lead = cq.Workplane("XY").box(16, 8, 8).translate((BAT[0] / 2 + 10, 0, bz))
add(lead, "battery_XT60", "xt60", ex("battery"))

# ── tall landing gear ────────────────────────────────────────────
SKID_Y, SKID_Z = 105.0, Z_BOT - GEAR_H
for sy in (1, -1):
    for sx in (1, -1):
        top_pt = cq.Vector(sx * 38, sy * 42, Z_BOT)
        bot_pt = cq.Vector(sx * 62, sy * SKID_Y, SKID_Z + 5)
        d = bot_pt - top_pt
        leg = cq.Workplane("XY").add(cq.Solid.makeCylinder(5, d.Length, top_pt, d.normalized()))
        add(leg, f"gear_leg_{sx}_{sy}", "gear", ex("gear"))
    skid = cq.Workplane("YZ").circle(6).extrude(240).translate((-120, sy * SKID_Y, SKID_Z))
    add(skid, f"gear_skid_{sy}", "gear", ex("gear"))
    for sx in (1, -1):
        foam = cq.Workplane("YZ").circle(8).extrude(30).translate((sx * 95 - 15, sy * SKID_Y, SKID_Z))
        add(foam, f"gear_foam_{sx}_{sy}", "foam", ex("gear"))

out = "navi_f450_exploded" if EXPLODE else "navi_f450"
assy.save(f"{out}.step")
assy.save(f"{out}.glb")
cq.exporters.export(assy.toCompound(), f"{out}.stl", tolerance=0.2, angularTolerance=0.2)
print("saved", out)
