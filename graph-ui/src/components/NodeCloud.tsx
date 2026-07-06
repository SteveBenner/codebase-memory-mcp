import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { GraphNode } from "../lib/types";
import { getView, type GraphView } from "../lib/layoutBinary";
import { buildSpatialGrid } from "../lib/spatialGrid";

/*
 * NodeCloud — instanced sphere renderer that scales to 1M+ nodes.
 *
 * Critical perf properties (don't regress without measuring):
 *  - The matrix loop runs INSIDE useFrame but guards on dirty flags: it only
 *    iterates when data or highlight actually changed. Steady state is a
 *    single ref read per frame. (We tried useEffect-only; that broke
 *    raycasting for hover/click because the bounding sphere wasn't
 *    refreshed in time for r3f's event loop on data-swap frames.)
 *  - Data changes and highlight changes are tracked SEPARATELY: only a data
 *    change (positions may move) recomputes the bounding sphere, and a
 *    highlight flip between two selections touches only the instances whose
 *    scale actually changes (symmetric difference of the two sets).
 *  - Sphere geometry is intentionally low-poly (8x6 = 48 tris). At 1M
 *    instances that's still 48M tris/frame — anything denser kills FPS on
 *    integrated GPUs.
 *  - When the binary loader is in play (GraphView), positions/sizes/colors
 *    come from typed arrays — no per-node JS object allocation in the
 *    rendering path.
 *
 * Raycasting (hover/click): Three's built-in InstancedMesh raycast is O(N)
 * sphere+triangle tests per pointermove — hover visibly lags past ~500k
 * nodes. On the view path above RAYCAST_GRID_MIN_NODES we override
 * mesh.raycast with a uniform-grid DDA query (see lib/spatialGrid.ts);
 * below the gate, and on the legacy JSON path, Three's default stays in
 * place. */

interface NodeCloudProps {
  /* Either pass the binary view directly (preferred at scale) or fall back
   * to per-node JS objects (small graphs / JSON path). */
  view?: GraphView | null;
  nodes?: GraphNode[];
  highlightedIds: Set<number> | null;
  onHover: (node: GraphNode | null) => void;
  onClick: (node: GraphNode) => void;
  opacity?: number;
}

/* Lower this if FPS tanks; raising it past 12,8 wastes triangles on tiny
 * dots that occupy a few pixels. */
const SPHERE_WIDTH_SEGMENTS = 8;
const SPHERE_HEIGHT_SEGMENTS = 6;

/* Cap on per-frame instance count we'll render in a single mesh. Three.js
 * supports more, but WebGL impls vary on whether very large vertex buffers
 * trigger GPU stalls. 1M is well within the safe range on desktops; if we
 * ever see telemetry showing problems on weaker GPUs we'd split into
 * chunked sub-meshes here. */
const MAX_INSTANCES_PER_MESH = 2_000_000;

/* Grid-accelerated raycasting only pays off past this node count — below it
 * Three's built-in O(N) raycast is already sub-millisecond and simpler. */
const RAYCAST_GRID_MIN_NODES = 20_000;

/* Incremental highlight updates fall back to the full matrix pass when the
 * symmetric difference between the old and new highlight sets exceeds this
 * fraction of the instance count: past that, per-id Map lookups cost more
 * than one straight typed-array sweep. */
const HIGHLIGHT_INCREMENTAL_MAX_FRACTION = 1 / 4;

/* Hex color string → packed Three.Color components written into a Float32Array
 * (rgb interleaved). Used for the JSON-path fallback where colors come in as
 * "#RRGGBB" strings. */
function packColorsFromJson(
  nodes: GraphNode[],
  highlightedIds: Set<number> | null,
  opacity: number,
): Float32Array {
  const tmp = new THREE.Color();
  const out = new Float32Array(nodes.length * 3);
  const hasHl = !!highlightedIds && highlightedIds.size > 0;
  for (let i = 0; i < nodes.length; i++) {
    tmp.set(nodes[i].color);
    if (hasHl && !highlightedIds!.has(nodes[i].id)) {
      tmp.multiplyScalar(0.15);
    } else {
      const brightness = (tmp.r + tmp.g + tmp.b) / 3;
      const boost = 1.2 + brightness * 0.8;
      tmp.multiplyScalar(boost);
    }
    out[i * 3] = tmp.r * opacity;
    out[i * 3 + 1] = tmp.g * opacity;
    out[i * 3 + 2] = tmp.b * opacity;
  }
  return out;
}

/* Same as above but reading the view's packed Uint32Array (zero string parses
 * and zero JS allocations per node). */
function packColorsFromView(
  view: GraphView,
  highlightedIds: Set<number> | null,
  opacity: number,
): Float32Array {
  const out = new Float32Array(view.nodeCount * 3);
  const hasHl = !!highlightedIds && highlightedIds.size > 0;
  const ids = view.nodeIds;
  const cols = view.colors;
  for (let i = 0; i < view.nodeCount; i++) {
    const c = cols[i];
    let r = ((c >> 16) & 0xff) / 255;
    let g = ((c >> 8) & 0xff) / 255;
    let b = (c & 0xff) / 255;
    if (hasHl && !highlightedIds!.has(ids[i])) {
      r *= 0.15;
      g *= 0.15;
      b *= 0.15;
    } else {
      const brightness = (r + g + b) / 3;
      const boost = 1.2 + brightness * 0.8;
      r *= boost;
      g *= boost;
      b *= boost;
    }
    out[i * 3] = r * opacity;
    out[i * 3 + 1] = g * opacity;
    out[i * 3 + 2] = b * opacity;
  }
  return out;
}

export function NodeCloud({
  view: viewProp,
  nodes,
  highlightedIds,
  onHover,
  onClick,
  opacity = 1.0,
}: NodeCloudProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const tempObj = useMemo(() => new THREE.Object3D(), []);

  const count = viewProp ? viewProp.nodeCount : (nodes?.length ?? 0);
  const safeCount = Math.min(count, MAX_INSTANCES_PER_MESH);

  /* Dirty flags: bumped from inside React via useEffect (NOT inside
   * useFrame — useFrame must stay cheap). Split in two because they cost
   * very different amounts of work on the next frame:
   *  - dataDirty (view/nodes identity or count changed): positions may have
   *    moved, so the next frame does a full matrix rebuild AND recomputes
   *    the bounding sphere.
   *  - highlightDirty (highlightedIds changed only): positions are
   *    untouched, only per-instance scale flips — matrices are updated
   *    (incrementally when possible) WITHOUT a bounding-sphere pass. */
  const dataDirtyRef = useRef(true);
  const highlightDirtyRef = useRef(false);
  /* The highlight set the instance matrices currently reflect — used to
   * compute the incremental symmetric difference in useFrame. */
  const appliedHighlightRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    dataDirtyRef.current = true;
  }, [viewProp, nodes, safeCount]);
  useEffect(() => {
    highlightDirtyRef.current = true;
  }, [highlightedIds]);

  /* On mount/remount of the InstancedMesh, install a huge bounding sphere
   * BEFORE the browser paints — otherwise the default mesh.boundingSphere is
   * null and three.js's InstancedMesh.raycast short-circuits, eating every
   * click/hover on the new mesh until the per-frame loop refines it. The
   * useFrame loop replaces this with an accurate sphere on its first dirty
   * pass; this just ensures pointer events route correctly in the meantime. */
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);
  }, [safeCount]);

  /* Full matrix pass over every instance (data changes and large highlight
   * flips). Recreated per render so it always closes over current props —
   * useFrame stores the latest callback each render, so the same holds for
   * the frame loop below. */
  const writeAllMatrices = (mesh: THREE.InstancedMesh) => {
    const hasHl = !!highlightedIds && highlightedIds.size > 0;

    if (viewProp) {
      const positions = viewProp.positions;
      const sizes = viewProp.sizes;
      const ids = viewProp.nodeIds;
      for (let i = 0; i < safeCount; i++) {
        tempObj.position.set(
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
        );
        const isHl = !hasHl || highlightedIds!.has(ids[i]);
        const s = sizes[i] * (isHl ? 0.5 : 0.2);
        tempObj.scale.set(s, s, s);
        tempObj.updateMatrix();
        mesh.setMatrixAt(i, tempObj.matrix);
      }
    } else if (nodes) {
      for (let i = 0; i < safeCount; i++) {
        const n = nodes[i];
        tempObj.position.set(n.x, n.y, n.z);
        const isHl = !hasHl || highlightedIds!.has(n.id);
        const s = n.size * (isHl ? 0.5 : 0.2);
        tempObj.scale.set(s, s, s);
        tempObj.updateMatrix();
        mesh.setMatrixAt(i, tempObj.matrix);
      }
    }
  };

  /* Per-frame loop: cheap when nothing changed (two ref reads + early
   * return). When dirty, update matrices — inside useFrame, not useEffect,
   * which keeps raycasting accurate the same frame the highlight flips and
   * makes click→highlight feel responsive. */
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    if (dataDirtyRef.current) {
      dataDirtyRef.current = false;
      highlightDirtyRef.current = false;
      writeAllMatrices(mesh);
      mesh.count = safeCount;
      mesh.instanceMatrix.needsUpdate = true;
      /* The data pass is the ONLY place we recompute the bounding sphere
       * (an O(N) scan). Highlight flips never move nodes, and the maximum
       * per-instance scale is 0.5× in every state (highlighted 0.5×,
       * dimmed 0.2×, no-highlight-all 0.5×) — so the sphere computed here
       * always bounds every later highlight state. */
      mesh.computeBoundingSphere();
      appliedHighlightRef.current = highlightedIds;
      return;
    }

    if (!highlightDirtyRef.current) return;
    highlightDirtyRef.current = false;

    const prev = appliedHighlightRef.current;
    const next = highlightedIds;
    appliedHighlightRef.current = next;
    if (prev === next) return;

    /* Incremental path (click A → click B): only nodes in the symmetric
     * difference of the two sets change scale. Requires the view path (for
     * indexOfId) and BOTH sets non-empty — a null↔Set (or empty↔non-empty)
     * transition rescales EVERY node, so incremental would just be a
     * slower full pass. */
    const prevHas = !!prev && prev.size > 0;
    const nextHas = !!next && next.size > 0;
    if (viewProp && prevHas && nextHas) {
      const changed: number[] = [];
      for (const id of prev!) {
        if (!next!.has(id)) changed.push(id);
      }
      for (const id of next!) {
        if (!prev!.has(id)) changed.push(id);
      }
      if (changed.length <= safeCount * HIGHLIGHT_INCREMENTAL_MAX_FRACTION) {
        const positions = viewProp.positions;
        const sizes = viewProp.sizes;
        for (const id of changed) {
          const i = viewProp.indexOfId(id);
          if (i < 0 || i >= safeCount) continue;
          tempObj.position.set(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
          );
          const s = sizes[i] * (next!.has(id) ? 0.5 : 0.2);
          tempObj.scale.set(s, s, s);
          tempObj.updateMatrix();
          mesh.setMatrixAt(i, tempObj.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        /* No computeBoundingSphere — see the data-pass comment above. */
        return;
      }
    }

    /* Large flip / legacy path / null↔Set transition: full matrix rewrite,
     * still without a bounding-sphere pass (positions are unchanged). */
    writeAllMatrices(mesh);
    mesh.instanceMatrix.needsUpdate = true;
  });

  /* Spatial index for accelerated raycasting — view path only, gated on
   * node count (see RAYCAST_GRID_MIN_NODES). Built once per view; the
   * layout is static so it never needs rebuilding on highlight changes. */
  const grid = useMemo(() => {
    if (!viewProp || viewProp.nodeCount <= RAYCAST_GRID_MIN_NODES) {
      return null;
    }
    return buildSpatialGrid(
      viewProp.positions,
      viewProp.sizes,
      Math.min(viewProp.nodeCount, MAX_INSTANCES_PER_MESH),
    );
  }, [viewProp]);

  /* Override mesh.raycast with the grid query while a grid is active,
   * restoring Three's default on cleanup. The ray is transformed into the
   * mesh's local space via matrixWorld inverse — identity today, but
   * correct if the mesh ever grows a transform. The pushed intersection
   * carries `instanceId` exactly like Three's InstancedMesh.raycast, so
   * r3f's onPointerOver/onClick handlers (which read e.instanceId) keep
   * working unchanged. safeCount is a dep because key={safeCount} remounts
   * the mesh — the override must be reinstalled on the new instance. */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !grid) return;
    const defaultRaycast = mesh.raycast;
    const inverseMatrix = new THREE.Matrix4();
    const localRay = new THREE.Ray();
    const worldPoint = new THREE.Vector3();

    mesh.raycast = (
      raycaster: THREE.Raycaster,
      intersects: THREE.Intersection[],
    ) => {
      inverseMatrix.copy(mesh.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverseMatrix);
      /* raycaster.near/far are world-space distances; with today's identity
       * matrixWorld they equal local-space t, so pass them straight to the
       * grid to cull hits during traversal, then re-check in world space
       * after mapping the hit point back (correct under any transform). */
      const hit = grid.raycast(
        localRay.origin.x,
        localRay.origin.y,
        localRay.origin.z,
        localRay.direction.x,
        localRay.direction.y,
        localRay.direction.z,
        raycaster.near,
        raycaster.far,
      );
      if (!hit) return;
      localRay.at(hit.distance, worldPoint).applyMatrix4(mesh.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(worldPoint);
      if (distance < raycaster.near || distance > raycaster.far) return;
      intersects.push({
        distance,
        point: worldPoint.clone(),
        object: mesh,
        instanceId: hit.index,
      });
    };
    return () => {
      mesh.raycast = defaultRaycast;
    };
  }, [grid, safeCount]);

  /* Color attribute: built on highlight/data change, attached via args so
   * R3F handles reconciliation. (No ref-based mutation — the args-change
   * recreation is the canonical R3F path and avoids stale-attribute bugs.) */
  const colors = useMemo(() => {
    if (viewProp) {
      return packColorsFromView(viewProp, highlightedIds, opacity);
    }
    if (nodes) {
      return packColorsFromJson(nodes, highlightedIds, opacity);
    }
    return new Float32Array(0);
  }, [viewProp, nodes, highlightedIds, opacity]);

  /* Resolve a clicked/hovered instance back to the JS-object form panels
   * expect. The view path allocates one GraphNode per click — cheap because
   * clicks are rare; reading from the view's typed arrays avoids holding a
   * million GraphNode objects in memory at rest. */
  const resolveNode = (instanceId: number): GraphNode | null => {
    if (viewProp) return viewProp.nodeAt(instanceId);
    if (nodes && instanceId < nodes.length) return nodes[instanceId];
    return null;
  };

  /* React key forces a full remount when the underlying instance count
   * changes (e.g. overview→full data swap). Without this, R3F tries to
   * reconcile the `args`-driven InstancedMesh recreation in-place, and on
   * data swaps we'd intermittently lose pointer-event bindings and end up
   * with a stale bounding sphere that swallows raycasts — which is exactly
   * what was breaking click/hover after the full graph streamed in. */
  return (
    <instancedMesh
      key={safeCount}
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, safeCount)]}
      frustumCulled={false}
      onPointerOver={(e) => {
        e.stopPropagation();
        if (e.instanceId === undefined) return;
        const node = resolveNode(e.instanceId);
        if (node) onHover(node);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.instanceId === undefined) return;
        const node = resolveNode(e.instanceId);
        if (node) onClick(node);
      }}
    >
      <sphereGeometry
        args={[1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS]}
      />
      <meshBasicMaterial vertexColors toneMapped={false} />
      <instancedBufferAttribute
        attach="geometry-attributes-color"
        args={[colors, 3]}
      />
    </instancedMesh>
  );
}

/* Convenience: accept a GraphData (which may carry a hidden GraphView) and
 * pick the right rendering path. Callers like GraphScene can pass the data
 * straight through without knowing which path is active. */
export function NodeCloudFromData(props: {
  data: { nodes: GraphNode[]; __view?: GraphView };
  highlightedIds: Set<number> | null;
  onHover: (node: GraphNode | null) => void;
  onClick: (node: GraphNode) => void;
  opacity?: number;
}) {
  const view = getView(props.data);
  return (
    <NodeCloud
      view={view}
      nodes={view ? undefined : props.data.nodes}
      highlightedIds={props.highlightedIds}
      onHover={props.onHover}
      onClick={props.onClick}
      opacity={props.opacity}
    />
  );
}
