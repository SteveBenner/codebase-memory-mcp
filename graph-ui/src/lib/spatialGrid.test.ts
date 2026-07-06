/*
 * spatialGrid.test.ts — unit tests for the uniform-grid ray picker.
 *
 * The lattice fixture (4×4×4 nodes, 10 units apart) is big enough that the
 * grid builds with a real multi-cell resolution, so the DDA marching path
 * is exercised rather than degenerating into a single-cell scan.
 */
import { describe, expect, it } from "vitest";
import { buildSpatialGrid } from "./spatialGrid";

/* 64 nodes at (i,j,k)*10 for i,j,k in 0..3; index = (i*4 + j)*4 + k. */
function buildLattice() {
  const count = 4 * 4 * 4;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  let idx = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        positions[idx * 3] = i * 10;
        positions[idx * 3 + 1] = j * 10;
        positions[idx * 3 + 2] = k * 10;
        sizes[idx] = 3; /* radius = sizes * 0.5 = 1.5 */
        idx++;
      }
    }
  }
  return { grid: buildSpatialGrid(positions, sizes, count), count };
}

const latticeIndex = (i: number, j: number, k: number) => (i * 4 + j) * 4 + k;

describe("buildSpatialGrid", () => {
  it("hits the node a ray points straight at", () => {
    const { grid } = buildLattice();
    /* Ray down +z through the (10, 20, *) column: first sphere is the one
     * at z=0, surface at t = 100 - 1.5. */
    const hit = grid.raycast(10, 20, -100, 0, 0, 1, 0.1, Infinity);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(latticeIndex(1, 2, 0));
    expect(hit!.distance).toBeCloseTo(98.5, 5);
  });

  it("returns no hit for a ray that misses every node", () => {
    const { grid } = buildLattice();
    /* Starts beyond the +x face heading further away. */
    expect(grid.raycast(200, 5, 5, 1, 0, 0, 0.1, Infinity)).toBeNull();
    /* Passes between lattice rows (nodes are 10 apart, radius 1.5). */
    expect(grid.raycast(5, 5, -100, 0, 0, 1, 0.1, Infinity)).toBeNull();
  });

  it("returns the nearest of two nodes along the ray", () => {
    const { grid } = buildLattice();
    /* From z=15 down +z: candidates at z=20 and z=30 — z=20 must win. */
    const hit = grid.raycast(10, 20, 15, 0, 0, 1, 0.1, Infinity);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(latticeIndex(1, 2, 2));
    expect(hit!.distance).toBeCloseTo(3.5, 5);
  });

  it("respects the far bound", () => {
    const { grid } = buildLattice();
    /* Same ray as the first test but capped before the t=98.5 hit. */
    expect(grid.raycast(10, 20, -100, 0, 0, 1, 0.1, 50)).toBeNull();
  });

  it("handles degenerate zero-extent axes (all nodes in a plane)", () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]);
    const sizes = new Float32Array([3, 3, 3]);
    const grid = buildSpatialGrid(positions, sizes, 3);

    const hit = grid.raycast(10, 0, 50, 0, 0, -1, 0.1, Infinity);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(1);
    expect(hit!.distance).toBeCloseTo(48.5, 5);

    expect(grid.raycast(10, 50, 50, 0, 0, -1, 0.1, Infinity)).toBeNull();
  });

  it("returns null for an empty grid", () => {
    const grid = buildSpatialGrid(new Float32Array(0), new Float32Array(0), 0);
    expect(grid.raycast(0, 0, -10, 0, 0, 1, 0.1, Infinity)).toBeNull();
  });
});
