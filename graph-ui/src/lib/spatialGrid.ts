/*
 * spatialGrid.ts — uniform-grid spatial index for ray picking over the
 * binary view's typed arrays.
 *
 * Three's InstancedMesh.raycast is O(N) sphere+triangle tests per
 * pointermove, which makes hover lag past ~500k nodes. This grid brings a
 * pick down to the handful of cells the ray actually crosses:
 *
 *  - Build: one counting-sort pass over positions. `cellStart` is a prefix-
 *    sum table (length numCells + 1) and `entries` holds node indices
 *    grouped by cell, so cell c owns entries[cellStart[c] .. cellStart[c+1]).
 *    No per-node JS objects, no Maps — two Uint32Arrays total.
 *  - Query: Amanatides–Woo 3D DDA. The ray is clipped to the grid AABB
 *    first (miss → no hit), then marches cell by cell testing ray-vs-sphere
 *    against each entry. We stop as soon as the best hit so far is closer
 *    than the t at which the ray would enter the next cell.
 *
 * Radius model: each node is treated as a sphere of radius sizes[i] * 0.5,
 * matching the rendered highlight scale. Dimmed nodes render at 0.2×, so
 * picking slightly overshoots them — acceptable: it errs toward easier
 * hovering, never toward missed hits on full-size nodes.
 *
 * Each node is registered in the single cell containing its center. A
 * sphere can poke into a neighboring cell the ray visits without its home
 * cell being visited — a sub-node-radius inaccuracy at cell boundaries
 * that's irrelevant for hover picking and keeps the build a pure counting
 * sort. The AABB used for clipping is expanded by the largest node radius
 * so boundary spheres (and degenerate zero-extent axes, where every node
 * sits on a plane) still intersect the box.
 */

export interface SpatialGridHit {
  /* Node index into the positions/sizes arrays the grid was built from. */
  index: number;
  /* Ray parameter t of the hit (== distance when direction is unit). */
  distance: number;
}

export interface SpatialGrid {
  /* Cast a ray (origin, unit direction) against the indexed spheres.
   * `near`/`far` bound the accepted t range. Returns the nearest hit or
   * null. Direction MUST be normalized — callers get that for free from
   * THREE.Ray. */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    near: number,
    far: number,
  ): SpatialGridHit | null;
}

/* 64^3 = 262,144 cells tops out the memory cost at ~1MB for cellStart while
 * keeping average cell occupancy at a few nodes for 1M-node graphs. */
const MAX_RESOLUTION = 64;

/* Target average occupancy: enough that the DDA visits few cells, few
 * enough that per-cell sphere tests stay cheap. */
const TARGET_NODES_PER_CELL = 4;

export function buildSpatialGrid(
  positions: Float32Array,
  sizes: Float32Array,
  count: number,
): SpatialGrid {
  if (count <= 0) {
    return { raycast: () => null };
  }

  /* Bounding box + largest radius in one pass. */
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let maxRadius = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const r = sizes[i] * 0.5;
    if (r > maxRadius) maxRadius = r;
  }

  /* Resolution: aim for TARGET_NODES_PER_CELL average occupancy with a
   * cube-ish grid, clamped to [1, MAX_RESOLUTION]. Degenerate (zero-extent)
   * axes collapse to a single cell with a placeholder cell size — the
   * inverse below becomes 0, mapping every node to cell 0 on that axis. */
  const targetCells = Math.max(1, Math.ceil(count / TARGET_NODES_PER_CELL));
  const res = Math.max(
    1,
    Math.min(MAX_RESOLUTION, Math.round(Math.cbrt(targetCells))),
  );
  const extX = maxX - minX;
  const extY = maxY - minY;
  const extZ = maxZ - minZ;
  const resX = extX > 0 ? res : 1;
  const resY = extY > 0 ? res : 1;
  const resZ = extZ > 0 ? res : 1;
  const cellX = extX > 0 ? extX / resX : 1;
  const cellY = extY > 0 ? extY / resY : 1;
  const cellZ = extZ > 0 ? extZ / resZ : 1;
  const invCellX = extX > 0 ? 1 / cellX : 0;
  const invCellY = extY > 0 ? 1 / cellY : 0;
  const invCellZ = extZ > 0 ? 1 / cellZ : 0;
  const numCells = resX * resY * resZ;

  /* Counting sort: histogram (offset by one), prefix sum, then scatter. */
  const cellOf = new Uint32Array(count);
  const cellStart = new Uint32Array(numCells + 1);
  for (let i = 0; i < count; i++) {
    let ix = ((positions[i * 3] - minX) * invCellX) | 0;
    let iy = ((positions[i * 3 + 1] - minY) * invCellY) | 0;
    let iz = ((positions[i * 3 + 2] - minZ) * invCellZ) | 0;
    /* Nodes exactly on the max boundary land one past the last cell. */
    if (ix >= resX) ix = resX - 1;
    if (iy >= resY) iy = resY - 1;
    if (iz >= resZ) iz = resZ - 1;
    const c = (iz * resY + iy) * resX + ix;
    cellOf[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 1; c <= numCells; c++) {
    cellStart[c] += cellStart[c - 1];
  }
  const entries = new Uint32Array(count);
  const cursor = cellStart.slice(0, numCells);
  for (let i = 0; i < count; i++) {
    const c = cellOf[i];
    entries[cursor[c]++] = i;
  }

  /* AABB used for the initial ray clip, expanded by the largest radius so
   * spheres centered on the boundary (and flat degenerate axes) still get
   * a non-empty box to intersect. */
  const boxMinX = minX - maxRadius;
  const boxMinY = minY - maxRadius;
  const boxMinZ = minZ - maxRadius;
  const boxMaxX = maxX + maxRadius;
  const boxMaxY = maxY + maxRadius;
  const boxMaxZ = maxZ + maxRadius;

  function raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    near: number,
    far: number,
  ): SpatialGridHit | null {
    /* Clip the ray to the (expanded) grid AABB with the slab method. */
    let tMin = near;
    let tMax = far;
    const invDx = 1 / dx;
    const invDy = 1 / dy;
    const invDz = 1 / dz;
    /* Infinity/-Infinity from a zero direction component sort correctly
     * through min/max, except the NaN produced when the origin sits exactly
     * on a slab plane — guard each axis explicitly instead. */
    if (dx !== 0) {
      const t1 = (boxMinX - ox) * invDx;
      const t2 = (boxMaxX - ox) * invDx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (ox < boxMinX || ox > boxMaxX) {
      return null;
    }
    if (dy !== 0) {
      const t1 = (boxMinY - oy) * invDy;
      const t2 = (boxMaxY - oy) * invDy;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (oy < boxMinY || oy > boxMaxY) {
      return null;
    }
    if (dz !== 0) {
      const t1 = (boxMinZ - oz) * invDz;
      const t2 = (boxMaxZ - oz) * invDz;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (oz < boxMinZ || oz > boxMaxZ) {
      return null;
    }
    if (tMin > tMax) return null;

    /* Entry point → starting cell (clamped: the expanded box extends past
     * the cell lattice, so the entry point may sit slightly outside it;
     * "waiting" inside the clamped border cell until the ray truly crosses
     * a boundary just tests that cell's entries a little early). */
    const px = ox + dx * tMin;
    const py = oy + dy * tMin;
    const pz = oz + dz * tMin;
    let ix = Math.min(resX - 1, Math.max(0, Math.floor((px - minX) * invCellX)));
    let iy = Math.min(resY - 1, Math.max(0, Math.floor((py - minY) * invCellY)));
    let iz = Math.min(resZ - 1, Math.max(0, Math.floor((pz - minZ) * invCellZ)));

    /* Amanatides–Woo stepping state. Single-cell axes never step: there is
     * no next cell to enter, and tMax caps the march anyway. */
    const stepX = resX > 1 && dx !== 0 ? (dx > 0 ? 1 : -1) : 0;
    const stepY = resY > 1 && dy !== 0 ? (dy > 0 ? 1 : -1) : 0;
    const stepZ = resZ > 1 && dz !== 0 ? (dz > 0 ? 1 : -1) : 0;
    const tDeltaX = stepX !== 0 ? cellX / Math.abs(dx) : Infinity;
    const tDeltaY = stepY !== 0 ? cellY / Math.abs(dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? cellZ / Math.abs(dz) : Infinity;
    let tMaxX =
      stepX > 0
        ? tMin + (minX + (ix + 1) * cellX - px) * invDx
        : stepX < 0
          ? tMin + (minX + ix * cellX - px) * invDx
          : Infinity;
    let tMaxY =
      stepY > 0
        ? tMin + (minY + (iy + 1) * cellY - py) * invDy
        : stepY < 0
          ? tMin + (minY + iy * cellY - py) * invDy
          : Infinity;
    let tMaxZ =
      stepZ > 0
        ? tMin + (minZ + (iz + 1) * cellZ - pz) * invDz
        : stepZ < 0
          ? tMin + (minZ + iz * cellZ - pz) * invDz
          : Infinity;

    let bestT = Infinity;
    let bestIdx = -1;

    for (;;) {
      const c = (iz * resY + iy) * resX + ix;
      const start = cellStart[c];
      const end = cellStart[c + 1];
      for (let k = start; k < end; k++) {
        const i = entries[k];
        /* Ray-vs-sphere: project the center onto the ray, compare the
         * perpendicular distance against the radius. */
        const cx = positions[i * 3] - ox;
        const cy = positions[i * 3 + 1] - oy;
        const cz = positions[i * 3 + 2] - oz;
        const tca = cx * dx + cy * dy + cz * dz;
        const r = sizes[i] * 0.5;
        const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
        const r2 = r * r;
        if (d2 > r2) continue;
        const thc = Math.sqrt(r2 - d2);
        let t = tca - thc;
        if (t < near) t = tca + thc; /* origin inside the sphere */
        if (t < near || t > far) continue;
        if (t < bestT) {
          bestT = t;
          bestIdx = i;
        }
      }

      const tNext = Math.min(tMaxX, tMaxY, tMaxZ);
      /* Cells are visited in strictly increasing t order, so once the best
       * hit lies before the next cell boundary no later cell can beat it. */
      if (bestIdx !== -1 && bestT <= tNext) break;
      if (tNext > tMax || tNext === Infinity) break;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        ix += stepX;
        if (ix < 0 || ix >= resX) break;
        tMaxX += tDeltaX;
      } else if (tMaxY <= tMaxZ) {
        iy += stepY;
        if (iy < 0 || iy >= resY) break;
        tMaxY += tDeltaY;
      } else {
        iz += stepZ;
        if (iz < 0 || iz >= resZ) break;
        tMaxZ += tDeltaZ;
      }
    }

    return bestIdx === -1 ? null : { index: bestIdx, distance: bestT };
  }

  return { raycast };
}
