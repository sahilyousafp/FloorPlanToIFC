// Finds rooms in a plan. The model has no room class, so rooms are the regions
// enclosed by walls, gap fillers and openings: rasterize those onto a grid, flood the
// outside from the border, and every other connected free region is a space.

// Grid resolution, coarsened on very large plans to bound the cell count.
const CELL_M = 0.05;
const MAX_CELLS_PER_SIDE = 800;
// Cracks up to about twice this wide between barriers are sealed before flooding.
const CLOSE_RADIUS_M = 0.1;
// Regions smaller than this are slivers between parallel walls or noise, not rooms.
const MIN_SPACE_AREA_M2 = 1;
// Spaces are numbered in reading order: by top edge, in bands of this height, then left to right.
const ROW_BAND_M = 1;

const NEIGHBORS_8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * @param {Array}  rects  barrier rectangles {cx, cy, length, thickness, angle} in plan-frame meters
 * @param {object} plan   {width, height, metersPerPx}
 * @returns {Array} [{polygon: [[x, y], ...], area}] in plan-frame meters, in reading order
 */
export function detectSpaces(rects, plan) {
  const widthM = plan.width * plan.metersPerPx;
  const heightM = plan.height * plan.metersPerPx;
  if (!rects.length || !(widthM > 0) || !(heightM > 0)) return [];

  const cell = Math.max(CELL_M, Math.max(widthM, heightM) / MAX_CELLS_PER_SIDE);
  // One free cell of margin on every side, so the outside is connected all around.
  const cols = Math.ceil(widthM / cell) + 2;
  const rows = Math.ceil(heightM / cell) + 2;
  const originX = -widthM / 2 - cell;
  const originY = -heightM / 2 - cell;

  const barrier = new Uint8Array(cols * rows);
  for (const r of rects) rasterize(r, barrier, cols, rows, cell, originX, originY);

  const radius = Math.max(1, Math.round(CLOSE_RADIUS_M / cell));
  const sealed = dilate(barrier, cols, rows, radius);

  // Label: -1 blocked, 0 outside, 1.. rooms.
  const labels = new Int32Array(cols * rows);
  for (let i = 0; i < labels.length; i++) labels[i] = sealed[i] ? -1 : -2;
  const border = [];
  for (let x = 0; x < cols; x++) border.push(x, (rows - 1) * cols + x);
  for (let y = 0; y < rows; y++) border.push(y * cols, y * cols + cols - 1);
  flood(labels, cols, rows, border.filter((i) => labels[i] === -2), 0);

  let regionCount = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === -2) flood(labels, cols, rows, [i], ++regionCount);
  }
  if (!regionCount) return [];

  growBack(labels, barrier, cols, rows, radius);

  const cellsPerRegion = new Array(regionCount + 1).fill(0);
  for (const label of labels) if (label > 0) cellsPerRegion[label]++;

  const spaces = [];
  for (let label = 1; label <= regionCount; label++) {
    const area = cellsPerRegion[label] * cell * cell;
    if (area < MIN_SPACE_AREA_M2) continue;
    const outline = simplify(traceOutline(labels, cols, rows, label), 1);
    if (outline.length < 3) continue;
    const polygon = outline.map(([x, y]) => [originX + x * cell, originY + y * cell]);
    spaces.push({ polygon, area, top: Math.min(...polygon.map((p) => p[1])), left: Math.min(...polygon.map((p) => p[0])) });
  }

  spaces.sort((a, b) => Math.round(a.top / ROW_BAND_M) - Math.round(b.top / ROW_BAND_M) || a.left - b.left);
  return spaces.map(({ polygon, area }) => ({ polygon, area }));
}

// Marks every cell whose center lies inside the rectangle, grown by half a cell so thin
// walls never fall between cell centers.
function rasterize(r, grid, cols, rows, cell, originX, originY) {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const halfL = r.length / 2 + cell / 2;
  const halfT = r.thickness / 2 + cell / 2;
  const extX = halfL * Math.abs(c) + halfT * Math.abs(s);
  const extY = halfL * Math.abs(s) + halfT * Math.abs(c);
  const x0 = Math.max(0, Math.floor((r.cx - extX - originX) / cell));
  const x1 = Math.min(cols - 1, Math.ceil((r.cx + extX - originX) / cell));
  const y0 = Math.max(0, Math.floor((r.cy - extY - originY) / cell));
  const y1 = Math.min(rows - 1, Math.ceil((r.cy + extY - originY) / cell));
  for (let y = y0; y <= y1; y++) {
    const dy = originY + (y + 0.5) * cell - r.cy;
    for (let x = x0; x <= x1; x++) {
      const dx = originX + (x + 0.5) * cell - r.cx;
      if (Math.abs(dx * c + dy * s) <= halfL && Math.abs(-dx * s + dy * c) <= halfT) grid[y * cols + x] = 1;
    }
  }
}

// Square dilation, done as a horizontal then a vertical pass. Each line is swept both
// ways, setting every cell within `radius` of a set cell.
function dilate(grid, cols, rows, radius) {
  const pass = (src, horizontal) => {
    const out = new Uint8Array(src.length);
    const lines = horizontal ? rows : cols;
    const span = horizontal ? cols : rows;
    const at = (line, i) => (horizontal ? line * cols + i : i * cols + line);
    for (let line = 0; line < lines; line++) {
      for (const [from, to, step] of [[0, span, 1], [span - 1, -1, -1]]) {
        let distance = Infinity;
        for (let i = from; i !== to; i += step) {
          distance = src[at(line, i)] ? 0 : distance + 1;
          if (distance <= radius) out[at(line, i)] = 1;
        }
      }
    }
    return out;
  };
  return pass(pass(grid, true), false);
}

// 4-connected flood fill of cells labeled -2, starting from the given seeds.
function flood(labels, cols, rows, seeds, label) {
  const stack = [];
  for (const seed of seeds) {
    if (labels[seed] !== -2) continue;
    labels[seed] = label;
    stack.push(seed);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % cols;
    const neighbors = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, i - cols, i + cols];
    for (const n of neighbors) {
      if (n >= 0 && n < labels.length && labels[n] === -2) {
        labels[n] = label;
        stack.push(n);
      }
    }
  }
}

// Sealing cracks also shrank every room by the dilation radius; give rooms back the
// cells that are free in the original barrier grid, one ring at a time. Growing through
// all 8 neighbors undoes the square dilation exactly, so room corners stay square.
function growBack(labels, barrier, cols, rows, radius) {
  for (let step = 0; step < radius; step++) {
    const claims = [];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== -1 || barrier[i]) continue;
      const x = i % cols;
      const y = (i - x) / cols;
      for (const [dx, dy] of NEIGHBORS_8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (labels[n] > 0) {
          claims.push(i, labels[n]);
          break;
        }
      }
    }
    for (let k = 0; k < claims.length; k += 2) labels[claims[k]] = claims[k + 1];
  }
}

// Outer boundary of a region along cell edges, as grid-corner coordinates.
function traceOutline(labels, cols, rows, label) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && labels[y * cols + x] === label;
  // Directed boundary edges keyed by start corner, walking with the region on the same side.
  const edges = new Map();
  const addEdge = (x0, y0, x1, y1) => {
    const key = x0 * (rows + 1) + y0;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push([x0, y0, x1, y1]);
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) addEdge(x + 1, y, x, y);
      if (!inside(x - 1, y)) addEdge(x, y, x, y + 1);
      if (!inside(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1);
      if (!inside(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y);
    }
  }

  let best = [];
  let bestArea = 0;
  for (const bucket of edges.values()) {
    while (bucket.length) {
      const loop = [];
      let edge = bucket.pop();
      const start = [edge[0], edge[1]];
      for (;;) {
        loop.push([edge[0], edge[1]]);
        const [, , x, y] = edge;
        if (x === start[0] && y === start[1]) break;
        const next = edges.get(x * (rows + 1) + y);
        // At a corner where the region touches itself diagonally, keep turning the same
        // way so the loop stays simple.
        const heading = [edge[2] - edge[0], edge[3] - edge[1]];
        next.sort((a, b) => turn(heading, a) - turn(heading, b));
        edge = next.shift();
      }
      const area = Math.abs(signedArea(loop));
      if (area > bestArea) {
        best = loop;
        bestArea = area;
      }
    }
  }
  return best;
}

// Orders candidate edges: left turn first, then straight, then right turn.
function turn(heading, edge) {
  const cross = heading[0] * (edge[3] - edge[1]) - heading[1] * (edge[2] - edge[0]);
  return cross < 0 ? 0 : cross === 0 ? 1 : 2;
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

// Douglas-Peucker on a closed ring, split at the two points farthest apart.
function simplify(ring, tolerance) {
  if (ring.length < 4) return ring;
  let far = 0;
  let farDist = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farDist) {
      far = i;
      farDist = d;
    }
  }
  const first = douglasPeucker(ring.slice(0, far + 1), tolerance);
  const second = douglasPeucker([...ring.slice(far), ring[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const length = Math.hypot(bx - ax, by - ay);
  let index = 0;
  let maxDist = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = length > 0
      ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length
      : Math.hypot(px - ax, py - ay);
    if (d > maxDist) {
      index = i;
      maxDist = d;
    }
  }
  if (maxDist <= tolerance) return [points[0], points[points.length - 1]];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}
