import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import type { GraphNode, GraphEdge } from "../lib/types";
import { getView, type GraphView } from "../lib/layoutBinary";

/*
 * EdgeLines — draws every edge as a colored line segment.
 *
 * Two paths:
 *  1. View path (binary loader): edge endpoints are already node indices, so
 *     we go straight from positions[] to a packed Float32Array — no Map
 *     lookups, no per-edge string parsing, no THREE.Color allocations.
 *     Geometry (and its ~24MB position upload at 1M edges) is built ONCE per
 *     view; highlight/opacity changes only rewrite the persistent color
 *     buffer in place. Rebuilding per click used to cost two Float32Array
 *     (edgeCount*6) allocations (~48MB), a full GPU re-upload of positions
 *     that never change, and leaked the replaced geometry (R3F does not
 *     auto-dispose a geometry passed via the `geometry` prop).
 *  2. Legacy path (JSON / linked galaxies): mirrors the previous implementation
 *     so cross-galaxy edges keep working unchanged. It still rebuilds per
 *     change (these graphs are <10k edges in practice) but now disposes the
 *     replaced geometry.
 */

interface EdgeLinesProps {
  /* View path */
  view?: GraphView | null;
  /* Legacy path */
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  /* Common */
  highlightedIds: Set<number> | null;
  opacity?: number;
  /* When set, edge.target is looked up in this array instead of `nodes`.
   * Used for cross-galaxy edges (legacy path only). */
  targetNodes?: GraphNode[];
}

const EDGE_TYPE_COLORS: Record<string, string> = {
  CALLS: "#1DA27E",
  IMPORTS: "#3b82f6",
  DEFINES: "#a855f7",
  DEFINES_METHOD: "#a855f7",
  CONTAINS_FILE: "#22c55e",
  CONTAINS_FOLDER: "#22c55e",
  CONTAINS_PACKAGE: "#22c55e",
  HANDLES: "#eab308",
  IMPLEMENTS: "#f97316",
  HTTP_CALLS: "#e11d48",
  ASYNC_CALLS: "#ec4899",
  GRPC_CALLS: "#f59e0b",
  GRAPHQL_CALLS: "#e879f9",
  TRPC_CALLS: "#a78bfa",
  CROSS_HTTP_CALLS: "#fb923c",
  CROSS_ASYNC_CALLS: "#fb7185",
  CROSS_GRPC_CALLS: "#fbbf24",
  CROSS_GRAPHQL_CALLS: "#f0abfc",
  CROSS_TRPC_CALLS: "#c4b5fd",
  CROSS_CHANNEL: "#fdba74",
  MEMBER_OF: "#64748b",
  TESTS_FILE: "#06b6d4",
};

const DEFAULT_EDGE_COLOR = "#1C8585";

function getClusterKey(fp?: string): string {
  if (!fp) return "";
  const parts = fp.split("/");
  return parts.slice(0, Math.min(2, parts.length)).join("/");
}

/* Pre-resolve the edge-type → packed RGB color so the inner loop never
 * touches THREE.Color. Each entry is three normalized floats. */
function buildTypeColorTable(types: string[]): Float32Array {
  const tmp = new THREE.Color();
  const out = new Float32Array(types.length * 3);
  for (let i = 0; i < types.length; i++) {
    tmp.set(EDGE_TYPE_COLORS[types[i]] ?? DEFAULT_EDGE_COLOR);
    out[i * 3] = tmp.r;
    out[i * 3 + 1] = tmp.g;
    out[i * 3 + 2] = tmp.b;
  }
  return out;
}

/* Persistent view-path geometry bundle: positions upload once, colors are
 * rewritten in place on every highlight/opacity change. */
interface ViewGeometry {
  geometry: THREE.BufferGeometry;
  colorAttr: THREE.BufferAttribute;
  colors: Float32Array;
  typeColors: Float32Array;
}

/* Hot path, step 1 of 2: build the geometry ONCE per view. Positions never
 * change after layout, so the attribute is StaticDrawUsage; colors change on
 * every highlight flip, so that attribute is DynamicDrawUsage and starts
 * zeroed — writeViewColors fills it before the first paint. No JS objects
 * allocated per edge. */
function buildViewGeometry(view: GraphView): ViewGeometry {
  const positions = new Float32Array(view.edgeCount * 6);
  const pos = view.positions;
  for (let e = 0; e < view.edgeCount; e++) {
    const si = view.edgeSrcIdx[e];
    const ti = view.edgeTgtIdx[e];
    const off = e * 6;
    positions[off] = pos[si * 3];
    positions[off + 1] = pos[si * 3 + 1];
    positions[off + 2] = pos[si * 3 + 2];
    positions[off + 3] = pos[ti * 3];
    positions[off + 4] = pos[ti * 3 + 1];
    positions[off + 5] = pos[ti * 3 + 2];
  }
  const colors = new Float32Array(view.edgeCount * 6);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.StaticDrawUsage);
  geometry.setAttribute("position", posAttr);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("color", colorAttr);

  return {
    geometry,
    colorAttr,
    colors,
    typeColors: buildTypeColorTable(view.edgeTypes),
  };
}

/* Hot path, step 2 of 2: rewrite the persistent color buffer in place — no
 * allocation, no position touch, one GPU upload of the color attribute.
 *
 * Edges whose endpoints are both outside the highlight set get (0,0,0):
 * with the AdditiveBlending material black contributes nothing, so they're
 * invisible — visually identical to the old "skip the edge" compaction
 * without ever resizing the buffers. */
function writeViewColors(
  view: GraphView,
  entry: ViewGeometry,
  highlightedIds: Set<number> | null,
  opacity: number,
): void {
  const { colors, typeColors } = entry;
  const ids = view.nodeIds;
  const srcIdx = view.edgeSrcIdx;
  const tgtIdx = view.edgeTgtIdx;
  const hasHl = !!highlightedIds && highlightedIds.size > 0;
  for (let e = 0; e < view.edgeCount; e++) {
    const off = e * 6;

    /* Intensity: default ambient brightness, boosted when both endpoints
     * are highlighted, dimmed when only loosely related. */
    let intensity = 0.18;
    if (hasHl) {
      const sHl = highlightedIds!.has(ids[srcIdx[e]]);
      const tHl = highlightedIds!.has(ids[tgtIdx[e]]);
      if (!sHl && !tHl) {
        colors[off] = 0;
        colors[off + 1] = 0;
        colors[off + 2] = 0;
        colors[off + 3] = 0;
        colors[off + 4] = 0;
        colors[off + 5] = 0;
        continue;
      }
      intensity = sHl && tHl ? 0.6 : 0.04;
    }

    const typeId = view.edgeTypeId[e];
    const tcr = typeColors[typeId * 3] * intensity * opacity;
    const tcg = typeColors[typeId * 3 + 1] * intensity * opacity;
    const tcb = typeColors[typeId * 3 + 2] * intensity * opacity;

    colors[off] = tcr;
    colors[off + 1] = tcg;
    colors[off + 2] = tcb;
    colors[off + 3] = tcr;
    colors[off + 4] = tcg;
    colors[off + 5] = tcb;
  }
  entry.colorAttr.needsUpdate = true;
}

/* Legacy path: kept intact for cross-galaxy / JSON callers. The hot 1M-edge
 * case goes through buildGeometryFromView above. */
function buildGeometryLegacy(
  nodes: GraphNode[],
  edges: GraphEdge[],
  highlightedIds: Set<number> | null,
  opacity: number,
  targetNodes?: GraphNode[],
): THREE.BufferGeometry {
  const srcMap = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) srcMap.set(nodes[i].id, i);
  const tgtArr = targetNodes ?? nodes;
  const tgtMap = targetNodes ? new Map<number, number>() : srcMap;
  if (targetNodes) {
    for (let i = 0; i < targetNodes.length; i++) {
      tgtMap.set(targetNodes[i].id, i);
    }
  }

  const hasHl = !!highlightedIds && highlightedIds.size > 0;
  const positions = new Float32Array(edges.length * 6);
  const colors = new Float32Array(edges.length * 6);
  const tmpColor = new THREE.Color();
  let kept = 0;

  for (const edge of edges) {
    const si = srcMap.get(edge.source);
    const ti = tgtMap.get(edge.target);
    if (si === undefined || ti === undefined) continue;

    const s = nodes[si];
    const t = tgtArr[ti];

    const sHl = !hasHl || highlightedIds!.has(s.id);
    const tHl = !hasHl || highlightedIds!.has(t.id);
    if (hasHl && !sHl && !tHl) continue;

    const sameCluster =
      getClusterKey(s.file_path) === getClusterKey(t.file_path);
    let intensity = sameCluster ? 0.25 : 0.06;
    if (hasHl) intensity = sHl && tHl ? 0.5 : 0.04;

    tmpColor.set(EDGE_TYPE_COLORS[edge.type] ?? DEFAULT_EDGE_COLOR);
    const off = kept * 6;
    positions[off] = s.x;
    positions[off + 1] = s.y;
    positions[off + 2] = s.z;
    positions[off + 3] = t.x;
    positions[off + 4] = t.y;
    positions[off + 5] = t.z;
    colors[off] = tmpColor.r * intensity * opacity;
    colors[off + 1] = tmpColor.g * intensity * opacity;
    colors[off + 2] = tmpColor.b * intensity * opacity;
    colors[off + 3] = colors[off];
    colors[off + 4] = colors[off + 1];
    colors[off + 5] = colors[off + 2];
    kept++;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(positions.slice(0, kept * 6), 3),
  );
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(colors.slice(0, kept * 6), 3),
  );
  return geo;
}

export function EdgeLines({
  view,
  nodes,
  edges,
  highlightedIds,
  opacity = 1.0,
  targetNodes,
}: EdgeLinesProps) {
  /* View path: geometry keyed on the view ONLY — highlight/opacity changes
   * must not reach this memo (that's the whole point of the split). */
  const viewGeo = useMemo(() => (view ? buildViewGeometry(view) : null), [
    view,
  ]);

  /* Recolor in place on highlight/opacity change. Layout effect so the
   * rewrite lands before the browser paints the commit — same visual timing
   * as the old rebuild-in-render, without the allocations. */
  useLayoutEffect(() => {
    if (!view || !viewGeo) return;
    writeViewColors(view, viewGeo, highlightedIds, opacity);
  }, [view, viewGeo, highlightedIds, opacity]);

  /* Legacy path: small graphs / cross-galaxy overlays keep the rebuild-per-
   * change behavior — cheap at their edge counts. */
  const legacyGeo = useMemo(() => {
    if (view || !nodes || !edges) return null;
    return buildGeometryLegacy(
      nodes,
      edges,
      highlightedIds,
      opacity,
      targetNodes,
    );
  }, [view, nodes, edges, highlightedIds, opacity, targetNodes]);

  /* Placeholder when neither path has data yet. */
  const emptyGeo = useMemo(() => new THREE.BufferGeometry(), []);

  /* Dispose replaced geometries. R3F does NOT auto-dispose a geometry passed
   * via the `geometry` prop, so without these cleanups every rebuild leaked
   * the old GPU buffers. */
  useEffect(() => {
    const geo = viewGeo?.geometry;
    if (!geo) return;
    return () => {
      geo.dispose();
    };
  }, [viewGeo]);
  useEffect(() => {
    if (!legacyGeo) return;
    return () => {
      legacyGeo.dispose();
    };
  }, [legacyGeo]);
  useEffect(() => {
    return () => {
      emptyGeo.dispose();
    };
  }, [emptyGeo]);

  const geometry = viewGeo?.geometry ?? legacyGeo ?? emptyGeo;

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={opacity}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </lineSegments>
  );
}

/* Convenience wrapper that picks the right path from GraphData. */
export function EdgeLinesFromData(props: {
  data: { nodes: GraphNode[]; edges: GraphEdge[]; __view?: GraphView };
  highlightedIds: Set<number> | null;
  opacity?: number;
}) {
  const v = getView(props.data);
  return (
    <EdgeLines
      view={v}
      nodes={v ? undefined : props.data.nodes}
      edges={v ? undefined : props.data.edges}
      highlightedIds={props.highlightedIds}
      opacity={props.opacity}
    />
  );
}
