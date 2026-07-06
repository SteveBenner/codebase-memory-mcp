import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLayoutJson } from "./useGraphData";

/* The fork's contract: NO default node cap (the renderer streams 1M+ via
 * typed arrays), and lod=overview opts into the hub-only quick preview. */
describe("fetchLayoutJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the full graph by default (no max_nodes cap)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nodes: [], edges: [], total_nodes: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLayoutJson("large-project");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe("/api/layout?project=large-project");
  });

  it("passes lod=overview for the hub preview", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nodes: [], edges: [], total_nodes: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLayoutJson("p", { lod: "overview" });

    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe("/api/layout?project=p&lod=overview");
  });

  it("honors an explicit max_nodes opt-in", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nodes: [], edges: [], total_nodes: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLayoutJson("p", { maxNodes: 500 });

    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe("/api/layout?project=p&max_nodes=500");
  });
});
