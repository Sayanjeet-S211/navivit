// Planning and filtering parameters. These are design values for the 20% stage, not
// certified limits: the summary says to replace them with measured endurance, handset
// error and hover-error data. Every module reads them from here.
export const CONFIG = Object.freeze({
  // Planning (Project Summary §10; master prompt §5C)
  legLimitM: 350,              // provisional guided-leg limit, recompute after the timed hover
  walkSpeedMps: 0.8,           // design walking speed for visiting parents
  pauseAllowance: 0.15,        // separately defined stop/pause allowance on walking ETA
  leadTargetM: 15,             // approximate lead design target
  holdGapM: 22,                // pacing: hold when route-progress lead exceeds this
  resumeGapM: 17,              // pacing: resume only below this (hysteresis)
  stillSpeedMps: 0.15,         // pacing: below this the visitor counts as stopped
  holdDwellS: 4,               // ...for at least this long
  resumeDwellS: 2,             // visitor must be moving this long before resuming
  fenceBufferM: 40,            // application buffer around the hand-traced OSM boundary
  padClearanceM: 5,            // pad clear area is about 5 m × 5 m
  padArrivalM: 20,             // visitor counts as at the meeting pad within this radius
  planningAltitudeM: 15,       // placeholder cruise altitude pending obstruction survey

  // Guided-coverage journeys over the expanded pad network (95% edit)
  minGuidedPercent: 95,        // a guided-service offer needs at least this share of walking guided (unrounded)
  maxDetourRatio: 1.3,         // the walk via pads may be at most this × the shortest walking route...
  maxDetourExtraM: 60,         // ...or the shortest route + this, whichever is larger
  atDestinationM: 10,          // shortest walk at or below this: "You are already at the destination"
  arrivalM: 10,                // visitor within this of a leg's end point has reached it
  takeoffLandingS: 90,         // per-leg launch, climb, descent and landing overhead (estimate)
  cruiseMps: 3,                // repositioning/return flight speed without the visitor (conservative)
  enduranceBudgetS: 660,       // usable flight time per battery after reserve (provisional, 3S 3300 mAh ≈ 14 A)
  handoffSwapS: 120,           // staffed battery swap and pre-flight at a handoff pad (estimate)

  // Location conditioning (master prompt §6)
  maxPedestrianSpeedMps: 3.0,  // implied speed above this is treated as a multipath jump
  poorAccuracyM: 35,           // warn the visitor above this reported accuracy
  rejectAccuracyM: 100,        // never use a fix this uncertain for pacing
  offRouteM: 30,               // min distance from route before a fix counts as off-route
  ambiguityM: 4,               // two route candidates this close in distance are ambiguous...
  ambiguityProgressM: 25,      // ...when their along-route positions differ by more than this
  staleWarnS: 30,              // visitor position stale warning (Project Summary §12)
  staleRtlS: 60,               // ground station escalates to RTL after this much staleness
  freshForResumeS: 5,          // resume requires an accepted fix at most this old
  heartbeatAmberS: 10,         // packet-age sparkline turns amber here

  // Commands
  commandTimeoutS: 4,          // no acknowledgement within this → "could not confirm"
  telemetryLossRtlS: 10        // ground station: aircraft link lost this long → RTL
});

/** Walking ETA in seconds: distance / 0.8 m/s × 1.15. 350 m → about 8 min 23 s. */
export const walkingEtaS = (m, c = CONFIG) => m / c.walkSpeedMps * (1 + c.pauseAllowance);

export const fmtDuration = s => {
  if (!Number.isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
};
/** Compact form for tight metric tiles: whole minutes (rounded up) above a minute. */
export const fmtShort = s => !Number.isFinite(s) ? '—' : s < 60 ? `${Math.max(0, Math.round(s))} s` : `${Math.ceil(s / 60)} min`;
export const fmtDist = m => !Number.isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
