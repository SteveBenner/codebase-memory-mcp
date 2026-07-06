/*
 * layoutBinary.test.ts — unit tests for the v2 wire-format parser.
 *
 * The fixture builder below constructs a byte-exact v2 payload with a
 * DataView, mirroring the pinned contract shared with the C serializer:
 *   header(32) | node ids i64×N | src_idx u32×E | tgt_idx u32×E |
 *   positions f32×3N | sizes f32×N | colors u32×N |
 *   name/path/qn offsets u32×N each | label ids u8×N | edge type ids u8×E |
 *   pad to 4 | label offsets u32×L | etype offsets u32×T | strings
 */
import { describe, expect, it } from "vitest";
import { parseLayoutBinary } from "./layoutBinary";

const MAGIC = 0x4c414233; /* 'LAB3' */

interface FixtureOverrides {
  version?: number;
  /* Override the first edge's src index (to exercise the range gate). */
  firstSrcIdx?: number;
}

interface Fixture {
  buf: ArrayBuffer;
  nodeIds: number[];
  positions: number[][];
  sizes: number[];
  colors: number[];
  edgeSrc: number[];
  edgeTgt: number[];
  edgeTypeIds: number[];
  labels: string[];
  etypes: string[];
  names: string[];
  paths: string[];
}

function buildFixture(overrides: FixtureOverrides = {}): Fixture {
  const nodeIds = [101, 202, 303];
  /* All coordinates exactly representable as f32 so equality checks hold. */
  const positions = [
    [0, 0, 0],
    [10, 20, 30],
    [-5, 2.5, 7],
  ];
  const sizes = [1.5, 2.5, 3.5];
  const colors = [0xff0000, 0x00ff00, 0x0000ff];
  const edgeSrc = [overrides.firstSrcIdx ?? 0, 2];
  const edgeTgt = [1, 0];
  const edgeTypeIds = [0, 1];
  const nodeLabelIds = [0, 1, 0];
  const labels = ["Function", "File"];
  const etypes = ["CALLS", "IMPORTS"];
  const names = ["alpha", "beta", "gamma"];
  const paths = ["src/a.ts", "", ""]; /* "" encodes as the offset-0 sentinel */

  const n = nodeIds.length;
  const e = edgeSrc.length;

  /* Strings block: byte 0 is the "absent" sentinel, so every real string
   * starts at offset >= 1. */
  const enc = new TextEncoder();
  const stringBytes: number[] = [0];
  const addString = (s: string): number => {
    if (s === "") return 0;
    const off = stringBytes.length;
    for (const b of enc.encode(s)) stringBytes.push(b);
    stringBytes.push(0);
    return off;
  };
  const labelOffs = labels.map(addString);
  const etypeOffs = etypes.map(addString);
  const nameOffs = names.map(addString);
  const pathOffs = paths.map(addString);
  const qnOffs = [0, 0, 0];
  const stringsSize = stringBytes.length;

  const unpadded = 32 + n * 8 + e * 8 + n * 12 + n * 4 * 5 + n + e;
  const padded = (unpadded + 3) & ~3;
  const total =
    padded + labels.length * 4 + etypes.length * 4 + stringsSize;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, overrides.version ?? 2, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, e, true);
  dv.setUint32(16, n, true); /* totalNodes */
  dv.setUint32(20, stringsSize, true);
  dv.setUint32(24, labels.length, true);
  dv.setUint32(28, etypes.length, true);

  let p = 32;
  for (const id of nodeIds) {
    dv.setInt32(p, id, true);
    dv.setInt32(p + 4, 0, true); /* i64 high word */
    p += 8;
  }
  for (const s of edgeSrc) {
    dv.setUint32(p, s, true);
    p += 4;
  }
  for (const t of edgeTgt) {
    dv.setUint32(p, t, true);
    p += 4;
  }
  for (const xyz of positions) {
    dv.setFloat32(p, xyz[0], true);
    dv.setFloat32(p + 4, xyz[1], true);
    dv.setFloat32(p + 8, xyz[2], true);
    p += 12;
  }
  for (const s of sizes) {
    dv.setFloat32(p, s, true);
    p += 4;
  }
  for (const c of colors) {
    dv.setUint32(p, c, true);
    p += 4;
  }
  for (const off of nameOffs) {
    dv.setUint32(p, off, true);
    p += 4;
  }
  for (const off of pathOffs) {
    dv.setUint32(p, off, true);
    p += 4;
  }
  for (const off of qnOffs) {
    dv.setUint32(p, off, true);
    p += 4;
  }
  for (const id of nodeLabelIds) {
    dv.setUint8(p, id);
    p += 1;
  }
  for (const id of edgeTypeIds) {
    dv.setUint8(p, id);
    p += 1;
  }
  p = (p + 3) & ~3; /* 0-3 pad bytes (zero-filled by ArrayBuffer) */
  for (const off of labelOffs) {
    dv.setUint32(p, off, true);
    p += 4;
  }
  for (const off of etypeOffs) {
    dv.setUint32(p, off, true);
    p += 4;
  }
  for (const b of stringBytes) {
    dv.setUint8(p, b);
    p += 1;
  }
  expect(p).toBe(total);

  return {
    buf,
    nodeIds,
    positions,
    sizes,
    colors,
    edgeSrc,
    edgeTgt,
    edgeTypeIds,
    labels,
    etypes,
    names,
    paths,
  };
}

describe("parseLayoutBinary (v2)", () => {
  it("parses counts, ids, positions, sizes and colors", () => {
    const fx = buildFixture();
    const view = parseLayoutBinary(fx.buf);

    expect(view.nodeCount).toBe(3);
    expect(view.edgeCount).toBe(2);
    expect(view.totalNodes).toBe(3);
    expect(Array.from(view.nodeIds)).toEqual(fx.nodeIds);
    expect(Array.from(view.positions)).toEqual(fx.positions.flat());
    expect(Array.from(view.sizes)).toEqual(fx.sizes);
    expect(Array.from(view.colors)).toEqual(fx.colors);
  });

  it("reads edge endpoints as node indices directly", () => {
    const fx = buildFixture();
    const view = parseLayoutBinary(fx.buf);

    expect(Array.from(view.edgeSrcIdx)).toEqual(fx.edgeSrc);
    expect(Array.from(view.edgeTgtIdx)).toEqual(fx.edgeTgt);
    expect(Array.from(view.edgeTypeId)).toEqual(fx.edgeTypeIds);
  });

  it("decodes the string tables and per-item accessors", () => {
    const fx = buildFixture();
    const view = parseLayoutBinary(fx.buf);

    expect(view.labels).toEqual(fx.labels);
    expect(view.edgeTypes).toEqual(fx.etypes);
    expect(view.getLabel(0)).toBe("Function");
    expect(view.getLabel(1)).toBe("File");
    expect(view.getEdgeType(0)).toBe("CALLS");
    expect(view.getEdgeType(1)).toBe("IMPORTS");
    expect(view.getName(0)).toBe("alpha");
    expect(view.getName(2)).toBe("gamma");
    expect(view.getPath(0)).toBe("src/a.ts");
    /* Offset-0 sentinel decodes to the empty string. */
    expect(view.getPath(1)).toBe("");
    expect(view.getQn(0)).toBe("");
  });

  it("materializes a GraphNode on demand via nodeAt", () => {
    const fx = buildFixture();
    const view = parseLayoutBinary(fx.buf);

    const n = view.nodeAt(1);
    expect(n.id).toBe(202);
    expect(n.x).toBe(10);
    expect(n.y).toBe(20);
    expect(n.z).toBe(30);
    expect(n.name).toBe("beta");
    expect(n.label).toBe("File");
    expect(n.size).toBe(2.5);
    expect(n.color).toBe("#00ff00");
    expect(n.file_path).toBeUndefined();
  });

  it("resolves ids via the lazily built indexOfId map", () => {
    const fx = buildFixture();
    const view = parseLayoutBinary(fx.buf);

    expect(view.indexOfId(101)).toBe(0);
    expect(view.indexOfId(202)).toBe(1);
    expect(view.indexOfId(303)).toBe(2);
    expect(view.indexOfId(999)).toBe(-1);
  });

  it("rejects non-v2 versions", () => {
    expect(() => parseLayoutBinary(buildFixture({ version: 1 }).buf)).toThrow(
      /version 1/,
    );
    expect(() => parseLayoutBinary(buildFixture({ version: 3 }).buf)).toThrow(
      /version 3/,
    );
  });

  it("rejects out-of-range edge indices", () => {
    expect(() =>
      parseLayoutBinary(buildFixture({ firstSrcIdx: 5 }).buf),
    ).toThrow(/out of range/);
  });

  it("rejects a bad magic and a truncated buffer", () => {
    const fx = buildFixture();
    new DataView(fx.buf).setUint32(0, 0xdeadbeef, true);
    expect(() => parseLayoutBinary(fx.buf)).toThrow(/magic/);
    expect(() => parseLayoutBinary(new ArrayBuffer(8))).toThrow(/too short/);
  });
});
