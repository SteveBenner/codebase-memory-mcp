import { useCallback, useRef, useState } from "react";
import type { GraphData } from "../lib/types";
import { fetchLayoutBinary } from "../lib/layoutBinary";

interface UseGraphDataResult {
  data: GraphData | null;
  loading: boolean;
  /* Progressive load state: true while the full detail fetch is in flight
   * after the overview has already rendered. UI can show a small indicator
   * without blanking the canvas. */
  streaming: boolean;
  error: string | null;
  fetchOverview: (project: string) => void;
  fetchDetail: (project: string, centerNode: string) => void;
}

/* JSON fallback for small graphs / older clients. The binary endpoint is the
 * primary path now — it drops payload size by ~5-10x and parses straight into
 * typed arrays the renderer can hand to the GPU without per-node JS overhead. */
async function fetchLayoutJson(
  project: string,
  opts: { lod?: "overview" | "full"; maxNodes?: number } = {},
): Promise<GraphData> {
  const params = new URLSearchParams({ project });
  if (opts.lod === "overview") params.set("lod", "overview");
  if (opts.maxNodes && opts.maxNodes > 0)
    params.set("max_nodes", String(opts.maxNodes));
  const res = await fetch(`/api/layout?${params}`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export function useGraphData(): UseGraphDataResult {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Track the in-flight project so a late overview/detail response from a
   * previous selection doesn't clobber the current one. */
  const activeProject = useRef<string | null>(null);

  const fetchOverview = useCallback(async (project: string) => {
    activeProject.current = project;
    setLoading(true);
    setStreaming(false);
    setError(null);

    /* Phase 1: hub-only overview via binary — usually <2k nodes, renders
     * effectively instantly so the user sees structure right away. */
    try {
      const overview = await fetchLayoutBinary(project, {
        lod: "overview",
      }).catch(() => fetchLayoutJson(project, { lod: "overview" }));
      if (activeProject.current !== project) return;
      setData(overview);
    } catch (e) {
      if (activeProject.current === project) {
        setError(e instanceof Error ? e.message : "Failed to fetch layout");
        setLoading(false);
      }
      return;
    } finally {
      if (activeProject.current === project) setLoading(false);
    }

    /* Phase 2: full detail in the background. We swap the data in once it
     * lands; the overview keeps the canvas alive in the meantime. */
    setStreaming(true);
    try {
      const full = await fetchLayoutBinary(project).catch(() =>
        fetchLayoutJson(project),
      );
      if (activeProject.current !== project) return;
      setData(full);
    } catch (e) {
      if (activeProject.current === project) {
        setError(e instanceof Error ? e.message : "Failed to load full graph");
      }
    } finally {
      if (activeProject.current === project) setStreaming(false);
    }
  }, []);

  const fetchDetail = useCallback(
    async (project: string, _centerNode: string) => {
      activeProject.current = project;
      setLoading(true);
      setError(null);
      try {
        /* TODO: detail level with center_node filtering — server-side */
        const result = await fetchLayoutBinary(project).catch(() =>
          fetchLayoutJson(project),
        );
        if (activeProject.current === project) setData(result);
      } catch (e) {
        if (activeProject.current === project) {
          setError(e instanceof Error ? e.message : "Failed to fetch layout");
        }
      } finally {
        if (activeProject.current === project) setLoading(false);
      }
    },
    [],
  );

  return { data, loading, streaming, error, fetchOverview, fetchDetail };
}
