/*
 * layoutBinary.ts — parse the binary graph layout returned by /api/layout.bin
 *
 * Format docs live in src/ui/layout3d.h (keep them in sync). The whole point
 * of this path is that we never materialize per-node JS objects — at 1M+
 * nodes that would cost 100s of MB of heap and seconds of GC pauses. The
 * renderer reads positions/colors/sizes straight out of typed arrays, and
 * the rare "give me node X" lookups (tooltip, click, camera fly-to) build
 * a single GraphNode-shaped object on demand.
 *
 * Wire format v2 (header version == 2): edge endpoints are transmitted as
 * u32 *node indices* (src_idx array, then tgt_idx array) instead of the v1
 * i64 node-id arrays. The server guarantees every index is < nodeCount, so
 * the old parse-time id→index Map build and the edge resolution/compaction
 * pass are gone — the index arrays are zero-copy views on the fetched
 * buffer and edgeCount from the header is final. Everything after the edge
 * sections (positions, sizes, colors, string offsets, label/etype ids,
 * padding, offset tables, strings) is byte-identical to v1.
 */
import type { GraphData, GraphNode, GraphEdge, NodeStatus } from "./types";

/* Wire enum for the dead-code status (v3). Order pinned in layout3d.h. */
const STATUS_NAMES: NodeStatus[] = [
  "dead",
  "single",
  "entry",
  "test",
  "exported",
  "normal",
  "structural",
];

const MAGIC = 0x4c414233; /* 'LAB3' */
const HEADER_SIZE = 32;

export interface GraphView {
  /* Counts */
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly totalNodes: number;

  /* Hot path: typed arrays the renderer hands directly to the GPU. */
  readonly nodeIds: Int32Array; /* ids fit in i32 in practice; high bits ignored */
  readonly positions: Float32Array; /* length = nodeCount * 3, xyz interleaved */
  readonly sizes: Float32Array; /* length = nodeCount */
  readonly colors: Uint32Array; /* length = nodeCount, 0xRRGGBB */

  /* Edge arrays use node *indices* (not ids) for direct lookup into positions.
   * Since v2 the C side emits indices directly (u32 on the wire); we validate
   * them against nodeCount at parse time and otherwise use zero-copy views. */
  readonly edgeSrcIdx: Int32Array; /* length = edgeCount */
  readonly edgeTgtIdx: Int32Array; /* length = edgeCount */
  readonly edgeTypeId: Uint8Array; /* length = edgeCount */

  /* v3 per-node metadata (dead-code view + code preview / deep links). */
  readonly inCalls: Uint32Array; /* inbound CALLS-family degree */
  readonly startLines: Uint32Array; /* 1-based; 0 = unknown */
  readonly endLines: Uint32Array; /* 1-based; 0 = unknown */
  readonly statusId: Uint8Array; /* index into STATUS_NAMES */

  /* String dictionary (small enumerations, dereferenced into ids by index). */
  readonly labels: string[];
  readonly edgeTypes: string[];

  /* Optional linked-project galaxies; loaded separately as JSON when needed. */
  linkedProjects?: GraphData["linked_projects"];

  /* On-demand accessors — typed-array indexed, not allocating until called. */
  getName(i: number): string;
  getPath(i: number): string;
  getQn(i: number): string;
  getLabel(i: number): string;
  getEdgeType(i: number): string;
  getStatus(i: number): NodeStatus;
  /* Build a one-off GraphNode object for code paths (tooltip, side panel)
   * that still want the legacy object shape. Allocation is intentional. */
  nodeAt(i: number): GraphNode;
  /* Reverse map: node id → index (built lazily on first call). */
  indexOfId(id: number): number;
}

/* Decode a NUL-terminated UTF-8 string starting at `offset` within `bytes`.
 * Returns "" when offset == 0 (the binary format's "absent" sentinel). */
function readCString(
  decoder: TextDecoder,
  bytes: Uint8Array,
  offset: number,
): string {
  if (offset === 0) return "";
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}

export function parseLayoutBinary(buf: ArrayBuffer): GraphView {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`layout.bin too short: ${buf.byteLength} bytes`);
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`bad magic: 0x${magic.toString(16)} (expected 0x4c414233)`);
  }
  const version = dv.getUint32(4, true);
  if (version !== 3) {
    throw new Error(`unsupported layout.bin version ${version}`);
  }
  const nodeCount = dv.getUint32(8, true);
  const edgeCount = dv.getUint32(12, true);
  const totalNodes = dv.getUint32(16, true);
  const stringsSize = dv.getUint32(20, true);
  const labelCount = dv.getUint32(24, true);
  const etypeCount = dv.getUint32(28, true);

  let p = HEADER_SIZE;

  /* Node ids are i64 in the wire format. Read each as a JS Number — every
   * project we've ever indexed has ids that fit comfortably in i32, and
   * BigInt arrays would slow down the indexOfId lookup hugely. The high
   * 32 bits are inspected and we throw if we ever see one set (early
   * warning if a project exceeds 4B ids, which we'd handle differently). */
  const nodeIds = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const lo = dv.getInt32(p, true);
    const hi = dv.getInt32(p + 4, true);
    if (hi !== 0 && hi !== -1) {
      throw new Error(`node id at index ${i} exceeds 32-bit range`);
    }
    nodeIds[i] = lo;
    p += 8;
  }

  /* v2: edge endpoints are u32 node indices, wrapped as zero-copy views on
   * the fetched buffer. Alignment holds: 32 + 8*nodeCount is 4-aligned, and
   * each u32 section keeps it 4-aligned. Int32Array is fine for the field
   * type — the server guarantees indices < nodeCount < 2^31, and we gate on
   * that below anyway. */
  const edgeSrcIdx = new Int32Array(buf, p, edgeCount);
  p += edgeCount * 4;
  const edgeTgtIdx = new Int32Array(buf, p, edgeCount);
  p += edgeCount * 4;

  /* Safety gate: a corrupt payload with an out-of-range index would send the
   * renderer reading garbage positions (or crash far away from here in a
   * much less debuggable place). One cheap linear pass; throwing routes the
   * caller to the JSON fallback. A u32 >= 2^31 shows up negative through
   * the Int32Array view, so the < 0 check covers that case too. */
  for (let i = 0; i < edgeCount; i++) {
    const s = edgeSrcIdx[i];
    const t = edgeTgtIdx[i];
    if (s < 0 || s >= nodeCount || t < 0 || t >= nodeCount) {
      throw new Error(`edge ${i} has node index out of range (nodes=${nodeCount})`);
    }
  }

  /* Positions, sizes, colors — wrap the underlying ArrayBuffer directly
   * (zero copy). The C side already aligned these on 4-byte boundaries. */
  const positions = new Float32Array(buf, p, nodeCount * 3);
  p += nodeCount * 12;
  const sizes = new Float32Array(buf, p, nodeCount);
  p += nodeCount * 4;
  const colors = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;

  const nameOff = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;
  const pathOff = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;
  const qnOff = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;

  /* v3: inbound-call counts + source line ranges (zero-copy u32 views). */
  const inCalls = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;
  const startLines = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;
  const endLines = new Uint32Array(buf, p, nodeCount);
  p += nodeCount * 4;

  /* u8 sections (byte views — alignment is a non-issue for u8). The C side
   * pads after these to restore 4-byte alignment for the u32 offset tables
   * that follow. */
  const nodeLabelId = new Uint8Array(buf, p, nodeCount);
  p += nodeCount;
  /* v3: dead-code status enum (u8 per node). */
  const statusId = new Uint8Array(buf, p, nodeCount);
  p += nodeCount;
  const edgeTypeId = new Uint8Array(buf, p, edgeCount);
  p += edgeCount;
  /* Skip alignment padding written by the server (0-3 bytes). */
  p = (p + 3) & ~3;

  /* Label + edge-type string-table offsets. */
  const labelOff = new Uint32Array(buf, p, labelCount);
  p += labelCount * 4;
  const etypeOff = new Uint32Array(buf, p, etypeCount);
  p += etypeCount * 4;

  /* Strings byte block. */
  const stringBytes = new Uint8Array(buf, p, stringsSize);
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const labels: string[] = new Array(labelCount);
  for (let i = 0; i < labelCount; i++) {
    labels[i] = readCString(decoder, stringBytes, labelOff[i]);
  }
  const edgeTypes: string[] = new Array(etypeCount);
  for (let i = 0; i < etypeCount; i++) {
    edgeTypes[i] = readCString(decoder, stringBytes, etypeOff[i]);
  }

  /* id→index Map is built LAZILY on the first indexOfId call. Only the rare
   * interaction paths (click resolution, path selection) need it; at 1M
   * nodes the build costs ~100ms and ~40MB, so the parse hot path must not
   * pay for it. Closure-captured — built at most once per view. */
  let idToIdx: Map<number, number> | null = null;

  const view: GraphView = {
    nodeCount,
    edgeCount,
    totalNodes,
    nodeIds,
    positions,
    sizes,
    colors,
    edgeSrcIdx,
    edgeTgtIdx,
    edgeTypeId,
    inCalls,
    startLines,
    endLines,
    statusId,
    labels,
    edgeTypes,
    getName: (i) => readCString(decoder, stringBytes, nameOff[i]),
    getPath: (i) => readCString(decoder, stringBytes, pathOff[i]),
    getQn: (i) => readCString(decoder, stringBytes, qnOff[i]),
    getLabel: (i) => labels[nodeLabelId[i]] ?? "",
    getEdgeType: (i) => edgeTypes[edgeTypeId[i]] ?? "",
    getStatus: (i) => STATUS_NAMES[statusId[i]] ?? "normal",
    nodeAt: (i) => ({
      id: nodeIds[i],
      x: positions[i * 3],
      y: positions[i * 3 + 1],
      z: positions[i * 3 + 2],
      label: labels[nodeLabelId[i]] ?? "",
      name: readCString(decoder, stringBytes, nameOff[i]),
      file_path: readCString(decoder, stringBytes, pathOff[i]) || undefined,
      size: sizes[i],
      color: "#" + colors[i].toString(16).padStart(6, "0"),
      status: STATUS_NAMES[statusId[i]] ?? "normal",
      in_calls: inCalls[i],
      start_line: startLines[i] || undefined,
      end_line: endLines[i] || undefined,
    }),
    indexOfId: (id: number) => {
      if (!idToIdx) {
        idToIdx = new Map<number, number>();
        for (let i = 0; i < nodeCount; i++) {
          idToIdx.set(nodeIds[i], i);
        }
      }
      return idToIdx.get(id) ?? -1;
    },
  };

  return view;
}

/* Adapter: produce the legacy GraphData shape from a binary view so the rest
 * of the UI keeps working unchanged. At very large N this allocates a lot of
 * JS objects — the hot rendering paths (NodeCloud/EdgeLines) read from the
 * view directly instead. We expose the view via a hidden property so they
 * can pick it up without rewriting the GraphTab plumbing. */
export interface GraphDataWithView extends GraphData {
  __view?: GraphView;
}

export function viewToGraphData(view: GraphView): GraphDataWithView {
  /* `nodes` and `edges` are LAZILY materialized: code paths that only need
   * the typed-array view (the rendering hot path) never trigger the
   * allocation. Panels/filters that still iterate JS objects pay the cost
   * on first access only, then reuse the cached array.
   *
   * At 1M nodes the cached array is roughly 200-300MB of JS objects, so
   * panels that touch it should ideally migrate to the view API too. For
   * now we keep the legacy shape working transparently. */
  let nodesCache: GraphNode[] | null = null;
  let edgesCache: GraphEdge[] | null = null;

  const out = {
    total_nodes: view.totalNodes,
    linked_projects: view.linkedProjects,
  } as GraphDataWithView;

  Object.defineProperty(out, "nodes", {
    enumerable: true,
    get(): GraphNode[] {
      if (!nodesCache) {
        nodesCache = new Array(view.nodeCount);
        for (let i = 0; i < view.nodeCount; i++) {
          nodesCache[i] = view.nodeAt(i);
        }
      }
      return nodesCache;
    },
  });
  Object.defineProperty(out, "edges", {
    enumerable: true,
    get(): GraphEdge[] {
      if (!edgesCache) {
        edgesCache = new Array(view.edgeCount);
        for (let i = 0; i < view.edgeCount; i++) {
          edgesCache[i] = {
            source: view.nodeIds[view.edgeSrcIdx[i]],
            target: view.nodeIds[view.edgeTgtIdx[i]],
            type: view.getEdgeType(i),
          };
        }
      }
      return edgesCache;
    },
  });
  Object.defineProperty(out, "__view", {
    value: view,
    enumerable: false,
    writable: false,
  });
  return out;
}

/* Fetch + parse helper used by useGraphData. Throws on HTTP/parse failure
 * so the caller can fall back to JSON. */
export async function fetchLayoutBinary(
  project: string,
  opts: { lod?: "overview" | "full"; maxNodes?: number } = {},
): Promise<GraphDataWithView> {
  const params = new URLSearchParams({ project });
  if (opts.lod === "overview") params.set("lod", "overview");
  if (opts.maxNodes && opts.maxNodes > 0)
    params.set("max_nodes", String(opts.maxNodes));

  const res = await fetch(`/api/layout.bin?${params}`);
  if (!res.ok) {
    /* Server returns JSON error bodies on failure — surface them. */
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const view = parseLayoutBinary(buf);
  return viewToGraphData(view);
}

/* Type guard used by renderers to pick up the typed-array view when it's
 * present (binary path) and gracefully fall back to JS-object iteration
 * when it isn't (JSON path / small graphs).
 *
 * Accepts any object (or null) because GraphData and GraphDataWithView are
 * structurally distinct in TS — the view is attached via Object.defineProperty
 * and isn't declared on the base GraphData shape. Reading through `unknown`
 * sidesteps the strict structural check without forcing every caller to cast. */
export function getView(data: unknown): GraphView | null {
  if (!data || typeof data !== "object") return null;
  const v = (data as { __view?: unknown }).__view;
  return v && typeof v === "object" ? (v as GraphView) : null;
}
