// Shared rules that turn pixel detections into real-world geometry, used by the
// 3D viewer and the IFC export so both describe the same building.
//
// Every element is an oriented rectangle in the plan frame: meters, centered on the
// plan, x to the right and y down the image. `angle` is the direction of the long
// side in radians, measured from +x towards +y.

import { detectSpaces } from './spaces.js';

// averageDoor is the mean door size in pixels, and a typical door is this wide.
export const DOOR_WIDTH_M = 0.9;
const DOOR_HEIGHT_M = 2.1;
const WINDOW_SILL_M = 0.9;
const WINDOW_TOP_M = 2.1;
// Width used when no door was detected, so the plan still gets a plausible scale.
const FALLBACK_PLAN_WIDTH_M = 20;

// Overlap below this (meters) is treated as rectangles merely touching.
const TOUCH_M = 0.01;
// An opening is hosted by a wall (and cuts it) only if it overlaps this much along the wall;
// less than that means the wall just ends next to the opening.
const HOST_MIN_OVERLAP_M = 0.1;
// An opening with no overlapping wall still borrows the direction of a wall this close.
const NEAR_WALL_M = 0.15;
// Openings without any nearby wall get at most this thickness.
const MAX_FREE_THICKNESS_M = 0.25;
// Walls count as parallel when their directions differ by less than this.
const PARALLEL_RAD = (5 * Math.PI) / 180;
// Gaps between an opening and the next wall or opening along its axis are filled up to
// this length, the way the Unity client grows its gap colliders.
const MAX_BRIDGE_M = DOOR_WIDTH_M;
// Wall ends are sealed across undetected doorways up to this length when finding rooms.
const MAX_SEAL_M = 1.2;

export const CLASSES = ['wall', 'door', 'window'];

export function metersPerPx(averageDoor, widthPx) {
  return averageDoor > 0 ? DOOR_WIDTH_M / averageDoor : FALLBACK_PLAN_WIDTH_M / widthPx;
}

// Height range of a class, in meters above the floor.
export function verticalExtent(cls, wallHeight) {
  if (cls === 'door') return { bottom: 0, top: Math.min(DOOR_HEIGHT_M, wallHeight) };
  if (cls === 'window') {
    return { bottom: Math.min(WINDOW_SILL_M, wallHeight * 0.33), top: Math.min(WINDOW_TOP_M, wallHeight * 0.8) };
  }
  return { bottom: 0, top: wallHeight };
}

// Oriented footprint of a detection in the plan frame. Uses the mask-fitted shape
// when the API sent one, otherwise the bbox with its longer side as the length.
export function orientedFootprint(d, plan) {
  const s = plan.metersPerPx;
  if (d.shape) {
    return {
      cx: (d.shape.cx - plan.width / 2) * s,
      cy: (d.shape.cy - plan.height / 2) * s,
      length: d.shape.length * s,
      thickness: d.shape.thickness * s,
      angle: (d.shape.angle * Math.PI) / 180,
    };
  }
  const w = d.x2 - d.x1;
  const h = d.y2 - d.y1;
  return {
    cx: ((d.x1 + d.x2) / 2 - plan.width / 2) * s,
    cy: ((d.y1 + d.y2) / 2 - plan.height / 2) * s,
    length: Math.max(w, h) * s,
    thickness: Math.min(w, h) * s,
    angle: h > w ? Math.PI / 2 : 0,
  };
}

/**
 * Everything the viewer draws and the IFC export writes, derived from one set of detections.
 * @returns {{walls: Array, fillers: Array, openings: Array, spaces: Array}}
 *   walls     [{d, rect}]            detected walls
 *   fillers   [{rect}]               wall pieces closing gaps next to openings
 *   openings  [{d, rect, hosts}]     doors and windows aligned to their wall; hosts are the
 *                                    walls they cut, best first
 *   spaces    [{polygon, area}]      enclosed rooms, polygon in plan-frame meters
 */
export function buildPlanModel(detections, plan) {
  const walls = detections.filter((d) => d.cls === 'wall').map((d) => ({ d, rect: orientedFootprint(d, plan) }));
  const openings = detections.filter((d) => d.cls === 'door' || d.cls === 'window')
    .map((d) => alignOpening(d, orientedFootprint(d, plan), walls));
  const fillers = bridgeGaps(openings, [...walls, ...openings], MAX_BRIDGE_M);
  // Room boundaries also run through doorways and windows the model missed, so for room
  // detection only, wall ends are sealed to whatever they point at within a doorway's width.
  const elements = [...walls, ...fillers, ...openings];
  const seals = bridgeGaps(walls, elements, MAX_SEAL_M);
  const spaces = detectSpaces([...elements, ...seals].map((e) => e.rect), plan);
  return { walls, fillers, openings, spaces };
}

// ---------------------------------------------------------------- rectangles

function axis(r) {
  return [Math.cos(r.angle), Math.sin(r.angle)];
}

function normal(r) {
  return [-Math.sin(r.angle), Math.cos(r.angle)];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

// Half the extent of a rectangle projected onto a unit direction.
function halfExtent(r, dir) {
  return (r.length / 2) * Math.abs(dot(axis(r), dir)) + (r.thickness / 2) * Math.abs(dot(normal(r), dir));
}

function parallel(a, b) {
  return Math.abs(Math.sin(a.angle - b.angle)) < Math.sin(PARALLEL_RAD);
}

// Fits a door or window into the wall it belongs to: it takes the wall's direction,
// thickness and centerline, and keeps its own extent along the wall.
function alignOpening(d, raw, walls) {
  const candidates = walls.map(({ rect: wall }) => {
    const u = axis(wall);
    const n = normal(wall);
    const offset = [raw.cx - wall.cx, raw.cy - wall.cy];
    const along = dot(offset, u);
    const extU = halfExtent(raw, u);
    const extN = halfExtent(raw, n);
    return {
      wall,
      along,
      extU,
      alongOverlap: Math.min(along + extU, wall.length / 2) - Math.max(along - extU, -wall.length / 2),
      acrossGap: Math.abs(dot(offset, n)) - (wall.thickness / 2 + extN),
      // An opening runs along its wall, so a wall it crosses end-on is not a candidate.
      aligned: extU >= extN,
    };
  }).filter((c) => c.aligned && c.acrossGap <= NEAR_WALL_M && c.alongOverlap >= -NEAR_WALL_M);

  const overlaps = (c) => c.alongOverlap > TOUCH_M && c.acrossGap < -TOUCH_M;
  const gap = (c) => Math.hypot(Math.max(0, -c.alongOverlap), Math.max(0, c.acrossGap));
  const ranked = [
    ...candidates.filter(overlaps).sort((a, b) => b.alongOverlap * -b.acrossGap - a.alongOverlap * -a.acrossGap),
    ...candidates.filter((c) => !overlaps(c)).sort((a, b) => gap(a) - gap(b)),
  ];
  const reference = ranked[0];
  if (!reference) {
    return { d, rect: { ...raw, thickness: Math.min(raw.thickness, MAX_FREE_THICKNESS_M) }, hosts: [] };
  }

  const { wall } = reference;
  const u = axis(wall);
  const rect = {
    cx: wall.cx + u[0] * reference.along,
    cy: wall.cy + u[1] * reference.along,
    length: 2 * reference.extU,
    thickness: wall.thickness,
    angle: wall.angle,
  };
  // Only walls running the same way are cut; a crossing wall at a corner is left whole.
  const hosts = ranked
    .filter((c) => overlaps(c) && parallel(c.wall, wall) && c.alongOverlap >= HOST_MIN_OVERLAP_M)
    .map((c) => c.wall);
  return { d, rect, hosts };
}

// Detected walls usually stop short of a door or window. Like the Unity client's
// DoorGaps/WindowGaps, look outwards from both ends of every source element along its
// axis and fill the gap to the nearest target with a wall piece of the source's thickness.
function bridgeGaps(sources, targets, maxDistance) {
  const fillers = [];
  const bridged = new Set();

  sources.forEach((source, index) => {
    const r = source.rect;
    const u = axis(r);
    const n = normal(r);
    for (const side of [-1, 1]) {
      const end = [r.cx + side * u[0] * (r.length / 2), r.cy + side * u[1] * (r.length / 2)];
      let best = null;
      for (const target of targets) {
        if (target === source) continue;
        const t = target.rect;
        const offset = [t.cx - end[0], t.cy - end[1]];
        const center = [t.cx - r.cx, t.cy - r.cy];
        // Interval the target covers along the search ray and across the opening's band.
        const alongC = side * dot(offset, u);
        const extU = halfExtent(t, u);
        const acrossC = dot(center, n);
        const extN = halfExtent(t, n);
        if (acrossC - extN >= r.thickness / 2 || acrossC + extN <= -r.thickness / 2) continue;
        if (alongC + extU <= 0) continue; // entirely behind this end
        const distance = Math.max(0, alongC - extU);
        if (!best || distance < best.distance) best = { target, distance };
      }
      if (!best || best.distance <= TOUCH_M || best.distance > maxDistance) continue;

      // Two sources facing each other would otherwise both fill the same gap.
      const other = sources.indexOf(best.target);
      if (other >= 0) {
        const key = index < other ? `${index}:${other}` : `${other}:${index}`;
        if (bridged.has(key)) continue;
        bridged.add(key);
      }
      const mid = r.length / 2 + best.distance / 2;
      fillers.push({
        rect: {
          cx: r.cx + side * u[0] * mid,
          cy: r.cy + side * u[1] * mid,
          length: best.distance,
          thickness: r.thickness,
          angle: r.angle,
        },
      });
    }
  });
  return fillers;
}
