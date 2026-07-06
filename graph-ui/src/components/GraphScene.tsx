import { useState, useRef, useEffect, useCallback } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { NodeCloud, NodeCloudFromData } from "./NodeCloud";
import { EdgeLines, EdgeLinesFromData } from "./EdgeLines";
import { NodeLabels } from "./NodeLabels";
import { NodeTooltip } from "./NodeTooltip";
import type { GraphData, GraphNode, LinkedProject } from "../lib/types";
import { getView, type GraphView } from "../lib/layoutBinary";

/* ── Camera fly-to animation ────────────────────────────── */

interface CameraTarget {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

function CameraAnimator({
  target,
  controlsRef,
}: {
  target: CameraTarget | null;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();
  const targetRef = useRef<CameraTarget | null>(null);
  const progress = useRef(1);

  useEffect(() => {
    if (target) {
      targetRef.current = target;
      progress.current = 0;
    }
  }, [target]);

  useFrame(() => {
    if (!targetRef.current || progress.current >= 1) return;

    progress.current = Math.min(1, progress.current + 0.02);
    const t = 1 - Math.pow(1 - progress.current, 3); /* ease-out cubic */

    camera.position.lerp(targetRef.current.position, t * 0.08);

    /* Move the OrbitControls pivot to the focus point as well. Otherwise the
     * controls keep their target at the origin and re-center the view on the
     * next frame, snapping the camera back to the middle after the fly-to. */
    const controls = controlsRef.current;
    if (controls) {
      controls.target.lerp(targetRef.current.lookAt, t * 0.08);
      controls.update();
    } else {
      camera.lookAt(targetRef.current.lookAt);
    }
  });

  return null;
}

/* ── Idle auto-rotation ──────────────────────────────────── */

const IDLE_TIMEOUT_MS = 60_000;
export const GRAPH_CANVAS_DPR: [number, number] = [1, 1.5];
export const GRAPH_COMPOSER_MULTISAMPLING = 0;

function IdleAutoRotate({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const lastInteraction = useRef(Date.now());

  /* Reset timer on any pointer/wheel event */
  const resetTimer = useCallback(() => {
    lastInteraction.current = Date.now();
    if (controlsRef.current) {
      controlsRef.current.autoRotate = false;
    }
  }, [controlsRef]);

  useEffect(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return;

    canvas.addEventListener("pointerdown", resetTimer);
    canvas.addEventListener("wheel", resetTimer);
    return () => {
      canvas.removeEventListener("pointerdown", resetTimer);
      canvas.removeEventListener("wheel", resetTimer);
    };
  }, [resetTimer]);

  useFrame(() => {
    if (!controlsRef.current) return;
    const idle = Date.now() - lastInteraction.current > IDLE_TIMEOUT_MS;
    controlsRef.current.autoRotate = idle;
  });

  return null;
}

/* ── Main scene ─────────────────────────────────────────── */

/* Bloom (EffectComposer) is a fixed full-resolution GPU cost every frame,
 * regardless of scene content. Past this node count we drop it: node colors
 * are already boosted >1.0 (see NodeCloud's packColors*), so the scene stays
 * readable without the glow — the gate trades bloom for frame rate at
 * extreme scale. */
const BLOOM_MAX_NODES = 300_000;

interface GraphSceneProps {
  data: GraphData;
  highlightedIds: Set<number> | null;
  cameraTarget: CameraTarget | null;
  showLabels: boolean;
  onNodeClick: (node: GraphNode) => void;
}

export type { CameraTarget };

export function GraphScene({
  data,
  highlightedIds,
  cameraTarget,
  showLabels,
  onNodeClick,
}: GraphSceneProps) {
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  /* Primary node count for the bloom gate. getView is checked FIRST:
   * touching data.nodes on the binary path would trigger the lazy getter
   * that materializes ~1M GraphNode objects just to read .length (see
   * viewToGraphData in layoutBinary.ts). */
  const primaryNodeCount = getView(data)?.nodeCount ?? data.nodes.length;

  return (
    <Canvas
      camera={{ position: [0, 0, 800], fov: 50, near: 0.1, far: 100000 }}
      style={{ background: "#06090f" }}
      dpr={GRAPH_CANVAS_DPR}
      gl={{
        antialias: false,
        alpha: false,
        powerPreference: "high-performance",
      }}
    >
      <color attach="background" args={["#06090f"]} />
      <ambientLight intensity={0.5} />
      <pointLight position={[500, 500, 500]} intensity={0.6} />
      <pointLight
        position={[-300, -200, -300]}
        intensity={0.4}
        color="#6040ff"
      />

      {/* Primary cluster: routes through the view-aware path when binary
       * loader is active (1M+ nodes), falls back to legacy props otherwise. */}
      <EdgeLinesFromData data={data} highlightedIds={highlightedIds} />
      <NodeCloudFromData
        data={data}
        highlightedIds={highlightedIds}
        onHover={setHovered}
        onClick={onNodeClick}
      />
      {showLabels && <NodeLabels nodes={data.nodes} highlightedIds={highlightedIds} />}

      {/* Satellite galaxies for cross-repo linked projects */}
      {data.linked_projects?.map((lp: LinkedProject) => {
        const offsetNodes = lp.nodes.map((n) => ({
          ...n,
          x: n.x + lp.offset.x,
          y: n.y + lp.offset.y,
          z: n.z + lp.offset.z,
        }));
        return (
          <group key={lp.project}>
            <EdgeLines
              nodes={offsetNodes}
              edges={lp.edges}
              highlightedIds={null}
              opacity={0.3}
            />
            <NodeCloud
              nodes={offsetNodes}
              highlightedIds={null}
              onHover={setHovered}
              onClick={onNodeClick}
              opacity={0.5}
            />
            {/* Inter-galaxy CROSS_* edges: source is in primary, target in
             * this linked project's offset nodes. */}
            {lp.cross_edges && lp.cross_edges.length > 0 && (
              <EdgeLines
                nodes={data.nodes}
                targetNodes={offsetNodes}
                edges={lp.cross_edges}
                highlightedIds={highlightedIds}
                opacity={0.85}
              />
            )}
          </group>
        );
      })}

      {hovered && <NodeTooltip node={hovered} />}

      <CameraAnimator target={cameraTarget} controlsRef={controlsRef} />
      <IdleAutoRotate controlsRef={controlsRef} />

      {primaryNodeCount <= BLOOM_MAX_NODES && (
        <EffectComposer multisampling={GRAPH_COMPOSER_MULTISAMPLING}>
          <Bloom
            luminanceThreshold={0.3}
            luminanceSmoothing={0.7}
            intensity={1.2}
            mipmapBlur
            radius={0.6}
          />
        </EffectComposer>
      )}

      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.5}
        zoomSpeed={1.5}
        minDistance={10}
        maxDistance={50000}
        autoRotateSpeed={0.4}
      />
    </Canvas>
  );
}

/* ── Helper: compute camera target from node IDs ────────── */

export function computeCameraTarget(
  nodes: GraphNode[],
  ids: Set<number>,
): CameraTarget | null {
  if (ids.size === 0) return null;

  let cx = 0,
    cy = 0,
    cz = 0,
    count = 0;
  for (const node of nodes) {
    if (ids.has(node.id)) {
      cx += node.x;
      cy += node.y;
      cz += node.z;
      count++;
    }
  }
  if (count === 0) return null;

  cx /= count;
  cy /= count;
  cz /= count;

  /* Distance based on cluster spread — ensure we never zoom too close */
  let maxDist = 0;
  for (const node of nodes) {
    if (ids.has(node.id)) {
      const d = Math.sqrt(
        (node.x - cx) ** 2 + (node.y - cy) ** 2 + (node.z - cz) ** 2,
      );
      if (d > maxDist) maxDist = d;
    }
  }

  /* Minimum distance scales with count: single node = 300, cluster = spread-based */
  const spreadDist = maxDist * 3;
  const minDist = count <= 5 ? 300 : 200;
  const distance = Math.max(minDist, spreadDist);
  const lookAt = new THREE.Vector3(cx, cy, cz);
  const position = new THREE.Vector3(
    cx + distance * 0.2,
    cy + distance * 0.15,
    cz + distance,
  );

  return { position, lookAt };
}

/* Typed-array variant — same math as computeCameraTarget but reads positions
 * from the view's Float32Array without materializing GraphNode objects. Used
 * on the binary load path where the JS edge/node arrays would otherwise be
 * forced into existence by a single click. */
export function computeCameraTargetFromView(
  view: GraphView,
  ids: Set<number>,
): CameraTarget | null {
  if (ids.size === 0) return null;
  const pos = view.positions;
  const nodeIds = view.nodeIds;

  let cx = 0,
    cy = 0,
    cz = 0,
    count = 0;
  for (let i = 0; i < view.nodeCount; i++) {
    if (ids.has(nodeIds[i])) {
      cx += pos[i * 3];
      cy += pos[i * 3 + 1];
      cz += pos[i * 3 + 2];
      count++;
    }
  }
  if (count === 0) return null;
  cx /= count;
  cy /= count;
  cz /= count;

  let maxDist = 0;
  for (let i = 0; i < view.nodeCount; i++) {
    if (ids.has(nodeIds[i])) {
      const dx = pos[i * 3] - cx;
      const dy = pos[i * 3 + 1] - cy;
      const dz = pos[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxDist) maxDist = d;
    }
  }

  const spreadDist = maxDist * 3;
  const minDist = count <= 5 ? 300 : 200;
  const distance = Math.max(minDist, spreadDist);
  const lookAt = new THREE.Vector3(cx, cy, cz);
  const position = new THREE.Vector3(
    cx + distance * 0.2,
    cy + distance * 0.15,
    cz + distance,
  );
  return { position, lookAt };
}
