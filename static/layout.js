// Shared rules that turn pixel detections into real-world geometry, used by the
// 3D viewer and the IFC export so both describe the same building.

// averageDoor is the mean door size in pixels, and a typical door is this wide.
export const DOOR_WIDTH_M = 0.9;
const DOOR_HEIGHT_M = 2.1;
const WINDOW_SILL_M = 0.9;
const WINDOW_TOP_M = 2.1;
// Width used when no door was detected, so the plan still gets a plausible scale.
const FALLBACK_PLAN_WIDTH_M = 20;

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

// Footprint of a detection in meters, centered on the plan. x grows to the right
// and y grows down the image, matching the pixel axes.
export function footprint(d, plan) {
  const s = plan.metersPerPx;
  return {
    cx: ((d.x1 + d.x2) / 2 - plan.width / 2) * s,
    cy: ((d.y1 + d.y2) / 2 - plan.height / 2) * s,
    sx: (d.x2 - d.x1) * s,
    sy: (d.y2 - d.y1) * s,
  };
}
