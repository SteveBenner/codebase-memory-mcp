import { useEffect, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useGraphData } from "../hooks/useGraphData";
import {
  GraphScene,
  computeCameraTarget,
  computeCameraTargetFromView,
  type CameraTarget,
} from "./GraphScene";
import { Sidebar } from "./Sidebar";
import { FilterPanel } from "./FilterPanel";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { ResizeHandle } from "./ResizeHandle";
import { ErrorBoundary } from "./ErrorBoundary";
import type { GraphNode, GraphData, RepoInfo } from "../lib/types";
import { getView } from "../lib/layoutBinary";
import { colorForStatus } from "../lib/colors";

/* Persist panel widths */
function loadWidth(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v) return Math.max(150, Math.min(600, parseInt(v, 10)));
  } catch { /* ignore */ }
  return fallback;
}
function saveWidth(key: string, value: number) {
  try { localStorage.setItem(key, String(Math.round(value))); } catch { /* ignore */ }
}

interface GraphTabProps {
  project: string | null;
}

export function formatGraphLimitNotice(data: GraphData | null): string | null {
  if (!data) return null;
  /* View-aware: reading data.nodes.length on the binary path would
   * materialize every GraphNode just to count them. */
  const shown = getView(data)?.nodeCount ?? data.nodes.length;
  if (data.total_nodes <= shown) return null;
  return `Showing ${shown.toLocaleString("en-US")} of ${data.total_nodes.toLocaleString("en-US")} nodes. Use filters to narrow.`;
}

export function GraphTab({ project }: GraphTabProps) {
  const { data, loading, streaming, error, fetchOverview } = useGraphData();
  const [highlightedIds, setHighlightedIds] = useState<Set<number> | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [cameraTarget, setCameraTarget] = useState<CameraTarget | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [leftWidth, setLeftWidth] = useState(() => loadWidth("cbm-left-w", 260));
  const [rightWidth, setRightWidth] = useState(() => loadWidth("cbm-right-w", 280));
  const limitNotice = formatGraphLimitNotice(data);

  /* Filter state — all enabled by default */
  const [enabledLabels, setEnabledLabels] = useState<Set<string>>(new Set());
  const [enabledEdgeTypes, setEnabledEdgeTypes] = useState<Set<string>>(new Set());

  /* Dead-code view: recolor by status + status-based filters */
  const [deadCodeView, setDeadCodeView] = useState(false);
  const [showOnlyDead, setShowOnlyDead] = useState(false);
  const [hideEntryPoints, setHideEntryPoints] = useState(false);
  const [hideTests, setHideTests] = useState(false);

  /* Initialize filters when data loads. We prefer the typed-array view's
   * pre-built label/edge-type dictionaries — at 1M nodes a `data.nodes.map`
   * would materialize a million JS objects just to compute a small Set. */
  useEffect(() => {
    if (!data) return;
    const view = getView(data);
    const labels = new Set<string>();
    const types = new Set<string>();
    if (view) {
      for (const l of view.labels) labels.add(l);
      for (const t of view.edgeTypes) types.add(t);
    } else {
      for (const n of data.nodes) labels.add(n.label);
      for (const e of data.edges) types.add(e.type);
    }
    for (const lp of data.linked_projects ?? []) {
      for (const n of lp.nodes) labels.add(n.label);
      for (const e of lp.edges) types.add(e.type);
      for (const e of lp.cross_edges) types.add(e.type);
    }
    setEnabledLabels(labels);
    setEnabledEdgeTypes(types);
  }, [data]);

  /* Compute filtered data.
   *
   * Hot-path optimization: if every label and edge type is enabled (the
   * default after data load) we pass the original GraphData through
   * unchanged. That preserves the hidden typed-array view (__view), so the
   * renderer stays on the fast path. Only an active filter change forces
   * the JS-object materialization + filter pass — a one-time cost the user
   * is opting into. */
  const filteredData: GraphData | null = useMemo(() => {
    if (!data) return null;

    const view = getView(data);
    /* Exact gate on both paths: the view exposes small label/type
     * dictionaries; the JSON path scans its (small by design) arrays. */
    const allLabelsEnabled = view
      ? view.labels.every((l) => enabledLabels.has(l))
      : data.nodes.every((n) => enabledLabels.has(n.label));
    const allTypesEnabled = view
      ? view.edgeTypes.every((t) => enabledEdgeTypes.has(t))
      : data.edges.every((e) => enabledEdgeTypes.has(e.type));
    const deadCodeActive =
      deadCodeView || showOnlyDead || hideEntryPoints || hideTests;

    /* Fast path: nothing on the primary cluster is filtered and no
     * dead-code feature is active. Skip the JS filter pass and reuse
     * `data` directly (preserves __view -> renderer stays on the
     * typed-array fast path). Only linked_projects are rebuilt here
     * because they're small and need their own filter step. */
    if (allLabelsEnabled && allTypesEnabled && !deadCodeActive) {
      const linked_projects = data.linked_projects?.map((lp) => {
        const lpNodes = lp.nodes.filter((n) => enabledLabels.has(n.label));
        const lpIds = new Set(lpNodes.map((n) => n.id));
        const lpEdges = lp.edges.filter(
          (e) =>
            enabledEdgeTypes.has(e.type) &&
            lpIds.has(e.source) &&
            lpIds.has(e.target),
        );
        /* Primary side is fully enabled, so no need to check the source
         * against the primary node id set. */
        const crossEdges = lp.cross_edges.filter(
          (e) => enabledEdgeTypes.has(e.type) && lpIds.has(e.target),
        );
        return {
          ...lp,
          nodes: lpNodes,
          edges: lpEdges,
          cross_edges: crossEdges,
        };
      });

      if (linked_projects === data.linked_projects) return data;
      const out: GraphData = Object.create(data);
      Object.defineProperty(out, "linked_projects", {
        value: linked_projects,
        enumerable: true,
      });
      return out;
    }

    /* Slow path: user has narrowed labels/types or enabled a dead-code
     * feature. Materialize the full JS-object form so the legacy
     * renderers + linked-project cross checks work uniformly. At 1M+
     * nodes this is intentionally expensive; the user opted in. */
    const statusOk = (n: GraphNode) => {
      if (showOnlyDead && n.status !== "dead") return false;
      if (hideEntryPoints && n.status === "entry") return false;
      if (hideTests && n.status === "test") return false;
      return true;
    };
    /* Recolor by status when the dead-code view is on */
    const paint = (n: GraphNode): GraphNode =>
      deadCodeView ? { ...n, color: colorForStatus(n.status) } : n;
    const keep = (n: GraphNode) => enabledLabels.has(n.label) && statusOk(n);

    const nodes = data.nodes.filter(keep).map(paint);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter(
      (e) =>
        enabledEdgeTypes.has(e.type) &&
        nodeIds.has(e.source) &&
        nodeIds.has(e.target),
    );

    const linked_projects = data.linked_projects?.map((lp) => {
      const lpNodes = lp.nodes.filter(keep).map(paint);
      const lpIds = new Set(lpNodes.map((n) => n.id));
      const lpEdges = lp.edges.filter(
        (e) =>
          enabledEdgeTypes.has(e.type) &&
          lpIds.has(e.source) &&
          lpIds.has(e.target),
      );
      const crossEdges = lp.cross_edges.filter(
        (e) =>
          enabledEdgeTypes.has(e.type) &&
          nodeIds.has(e.source) &&
          lpIds.has(e.target),
      );
      return { ...lp, nodes: lpNodes, edges: lpEdges, cross_edges: crossEdges };
    });

    return { nodes, edges, total_nodes: data.total_nodes, linked_projects };
  }, [
    data,
    enabledLabels,
    enabledEdgeTypes,
    deadCodeView,
    showOnlyDead,
    hideEntryPoints,
    hideTests,
  ]);

  useEffect(() => {
    if (project) {
      fetchOverview(project);
      setHighlightedIds(null);
      setSelectedPath(null);
    }
  }, [project, fetchOverview]);

  /* Fetch git remote metadata for GitHub deep-links */
  useEffect(() => {
    if (!project) {
      setRepoInfo(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/repo-info?project=${encodeURIComponent(project)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && !d.error) setRepoInfo(d as RepoInfo);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project]);

  const handleSelectPath = useCallback(
    (path: string, nodeIds: Set<number>) => {
      if (!filteredData || !path || nodeIds.size === 0) {
        setHighlightedIds(null);
        setSelectedPath(null);
        setCameraTarget(null);
        return;
      }
      setSelectedPath(path);
      setHighlightedIds(nodeIds);
      const view = getView(filteredData);
      setCameraTarget(
        view
          ? computeCameraTargetFromView(view, nodeIds)
          : computeCameraTarget(filteredData.nodes, nodeIds),
      );
    },
    [filteredData],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (!filteredData) return;
      setSelectedNode(node);

      /* Highlight the node and its direct connections. Prefer the view's
       * typed-array edge index — iterating 264k JS edge objects synchronously
       * on every click would lock up the main thread for hundreds of ms and
       * force materialization of the lazy edges array. The typed-array path
       * is one Int32Array scan per click, no allocations. */
      const connectedIds = new Set<number>([node.id]);
      const view = getView(filteredData);
      if (view) {
        const ids = view.nodeIds;
        const src = view.edgeSrcIdx;
        const tgt = view.edgeTgtIdx;
        for (let i = 0; i < view.edgeCount; i++) {
          const sId = ids[src[i]];
          const tId = ids[tgt[i]];
          if (sId === node.id) connectedIds.add(tId);
          else if (tId === node.id) connectedIds.add(sId);
        }
      } else {
        for (const edge of filteredData.edges) {
          if (edge.source === node.id) connectedIds.add(edge.target);
          if (edge.target === node.id) connectedIds.add(edge.source);
        }
      }

      setHighlightedIds(connectedIds);
      setSelectedPath(node.file_path ?? null);

      /* computeCameraTarget needs node positions. The view path reads from
       * typed arrays; the legacy path takes a GraphNode[] (which may force
       * materialization, but only in the JSON-only case where it's small). */
      if (view) {
        setCameraTarget(computeCameraTargetFromView(view, connectedIds));
      } else {
        setCameraTarget(
          computeCameraTarget(filteredData.nodes, connectedIds),
        );
      }
    },
    [filteredData],
  );

  const handleNavigateToNode = useCallback(
    (node: GraphNode) => {
      handleNodeClick(node);
    },
    [handleNodeClick],
  );

  const toggleLabel = useCallback((label: string) => {
    setEnabledLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const toggleEdgeType = useCallback((type: string) => {
    setEnabledEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const enableAll = useCallback(() => {
    if (!data) return;
    const view = getView(data);
    const labels = new Set<string>();
    const types = new Set<string>();
    if (view) {
      for (const l of view.labels) labels.add(l);
      for (const t of view.edgeTypes) types.add(t);
    } else {
      for (const n of data.nodes) labels.add(n.label);
      for (const e of data.edges) types.add(e.type);
    }
    for (const lp of data.linked_projects ?? []) {
      for (const n of lp.nodes) labels.add(n.label);
      for (const e of lp.edges) types.add(e.type);
      for (const e of lp.cross_edges) types.add(e.type);
    }
    setEnabledLabels(labels);
    setEnabledEdgeTypes(types);
  }, [data]);

  const disableAll = useCallback(() => {
    setEnabledLabels(new Set());
    setEnabledEdgeTypes(new Set());
  }, []);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-white/30 text-sm">
          Select a project from the Projects tab
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-white/40 text-sm">Computing layout...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <p className="text-red-400 text-sm mb-2">{error}</p>
          <Button variant="outline" size="sm" onClick={() => fetchOverview(project)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  /* Avoid hitting filteredData.nodes here at scale — the lazy getter would
   * materialize a million GraphNode objects just to read .length. The view
   * exposes a cheap nodeCount field. */
  const filteredView = getView(filteredData);
  const filteredCount = filteredView
    ? filteredView.nodeCount
    : (filteredData?.nodes.length ?? 0);
  const totalCount = data
    ? (getView(data)?.nodeCount ?? data.nodes.length)
    : 0;

  /* No data, or the project genuinely has no nodes — there are no filters to
     interact with, so show a plain full-screen message. The "all filtered out"
     case is handled inside the layout below so the filter sidebar stays put. */
  if (!data || !filteredData || totalCount === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-white/30 text-sm">No nodes in this project</p>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Left sidebar — resizable */}
      <div
        className="border-r border-border/30 flex flex-col h-full bg-[#0b1920]/90 backdrop-blur-md shrink-0"
        style={{ width: leftWidth }}
      >
        <FilterPanel
          data={data}
          enabledLabels={enabledLabels}
          enabledEdgeTypes={enabledEdgeTypes}
          showLabels={showLabels}
          onToggleLabel={toggleLabel}
          onToggleEdgeType={toggleEdgeType}
          onToggleShowLabels={() => setShowLabels((v) => !v)}
          onEnableAll={enableAll}
          onDisableAll={disableAll}
          deadCodeView={deadCodeView}
          showOnlyDead={showOnlyDead}
          hideEntryPoints={hideEntryPoints}
          hideTests={hideTests}
          onToggleDeadCodeView={() => setDeadCodeView((v) => !v)}
          onToggleShowOnlyDead={() => setShowOnlyDead((v) => !v)}
          onToggleHideEntryPoints={() => setHideEntryPoints((v) => !v)}
          onToggleHideTests={() => setHideTests((v) => !v)}
        />
        <Sidebar
          nodes={filteredData.nodes}
          onSelectPath={handleSelectPath}
          selectedPath={selectedPath}
        />
      </div>
      <ResizeHandle
        side="left"
        onResize={(d) => {
          setLeftWidth((w) => {
            const nw = Math.max(150, Math.min(500, w + d));
            saveWidth("cbm-left-w", nw);
            return nw;
          });
        }}
      />

      {/* Graph area */}
      <div className="flex-1 relative overflow-hidden">
        {filteredCount === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-white/30 text-sm mb-3">All nodes filtered out</p>
              <Button size="sm" onClick={enableAll}>
                Reset Filters
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ErrorBoundary>
              <GraphScene
                data={filteredData}
                highlightedIds={highlightedIds}
                cameraTarget={cameraTarget}
                showLabels={showLabels}
                onNodeClick={handleNodeClick}
              />
            </ErrorBoundary>

            {/* HUD */}
            <div className="absolute top-4 left-4 text-[11px] text-white/30 pointer-events-none font-mono">
              <p>
                {filteredCount.toLocaleString()} nodes /{" "}
                {(filteredView?.edgeCount ?? filteredData.edges.length).toLocaleString()}{" "}
                edges
              </p>
              {totalCount > filteredCount && (
                <p className="text-white/25 mt-0.5">
                  filtered from {totalCount.toLocaleString()}
                </p>
              )}
              {limitNotice && (
                <p className="text-amber-300/80 mt-0.5">{limitNotice}</p>
              )}
              {streaming && (
                <p className="text-cyan-400/50 mt-0.5">
                  streaming full graph…
                </p>
              )}
              {highlightedIds && highlightedIds.size > 0 && (
                <p className="text-cyan-400/50 mt-0.5">
                  {highlightedIds.size} selected
                </p>
              )}
            </div>

            <div className="absolute top-4 right-4 flex gap-2">
              {highlightedIds && (
                <Button
                  size="sm"
                  onClick={() => {
                    setHighlightedIds(null);
                    setSelectedPath(null);
                    setSelectedNode(null);
                    setCameraTarget(null);
                  }}
                >
                  Clear selection
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setHighlightedIds(null);
                  setSelectedPath(null);
                  setSelectedNode(null);
                  setCameraTarget(null);
                  fetchOverview(project);
                }}
              >
                Refresh
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Right detail panel — resizable */}
      {selectedNode && filteredData && (
        <>
          <ResizeHandle
            side="right"
            onResize={(d) => {
              setRightWidth((w) => {
                const nw = Math.max(200, Math.min(500, w + d));
                saveWidth("cbm-right-w", nw);
                return nw;
              });
            }}
          />
          <div
            className="border-l border-border shrink-0 h-full overflow-hidden"
            style={{ width: rightWidth, maxHeight: "100%" }}
          >
            <NodeDetailPanel
              node={selectedNode}
              allNodes={filteredData.nodes}
              allEdges={filteredData.edges}
              project={project}
              repoInfo={repoInfo}
              onClose={() => {
                setSelectedNode(null);
                setHighlightedIds(null);
                setSelectedPath(null);
              }}
              onNavigate={handleNavigateToNode}
            />
          </div>
        </>
      )}
    </div>
  );
}
