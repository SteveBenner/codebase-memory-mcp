import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLayoutJson, fetchLayoutResilient } from "./useGraphData";
import { LayoutHttpError } from "../lib/layoutBinary";

/* The fork's contract: no client-side max_nodes param by default (the server
 * applies its own render cap, CBM_UI_MAX_RENDER_NODES to override), and
 * lod=overview opts into the hub-only quick preview. */
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

  it("throws LayoutHttpError with the Retry-After hint on 503", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: { get: (n: string) => (n === "retry-after" ? "10" : null) },
      json: async () => ({ error: "project is being indexed" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await fetchLayoutJson("p").catch((e) => e);
    expect(err).toBeInstanceOf(LayoutHttpError);
    expect(err.status).toBe(503);
    expect(err.retryAfterSecs).toBe(10);
    expect(err.message).toBe("project is being indexed");
  });
});

describe("fetchLayoutResilient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const bin503 = {
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    headers: {
      get: (n: string) =>
        n === "retry-after" ? "1" : n === "content-type" ? "application/json" : null,
    },
    json: async () => ({ error: "project is being indexed" }),
  };

  it("retries after a 503 instead of falling back to JSON", async () => {
    /* First layout.bin call 503s; the retry succeeds with a JSON-shaped OK
     * response is NOT expected — the binary endpoint is retried, so make the
     * second call return ok with a valid buffer? Building a real v3 blob here
     * is overkill; instead have the second call 404 and assert the JSON
     * fallback was reached only AFTER the 503 retry (i.e. two layout.bin
     * calls, then one /api/layout call). */
    let binCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/layout.bin")) {
        binCalls++;
        if (binCalls === 1) return bin503;
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: { get: () => null },
          json: async () => ({ error: "project not found" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ nodes: [], edges: [], total_nodes: 0 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLayoutResilient("p", {}, () => true);

    expect(binCalls).toBe(2);
    expect(result).toEqual({ nodes: [], edges: [], total_nodes: 0 });
    const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
    expect(urls[urls.length - 1]).toBe("/api/layout?project=p");
  });

  it("stops retrying when the caller no longer wants the project", async () => {
    const fetchMock = vi.fn(async () => bin503);
    vi.stubGlobal("fetch", fetchMock);

    const err = await fetchLayoutResilient("p", {}, () => false).catch((e) => e);

    expect(err).toBeInstanceOf(LayoutHttpError);
    expect(err.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
