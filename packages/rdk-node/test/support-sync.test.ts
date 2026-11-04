import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/node-controller.js", () => ({ NodeController: class {} }));
vi.mock("../src/central-client.js", () => ({ CentralClient: class {} }));
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn() }));
import { SubzeroSupportSync } from "../src/support-sync.js";

afterEach(() => vi.unstubAllGlobals());
function harness(
  overrides: Record<string, unknown> = {},
  indexErrors: string[] = [],
  publisher: { id: number | string; source?: string } = { id: 1 },
) {
  const calls: string[] = [];
  const urls: string[] = [];
  const claim = {
    nodeId: "owner",
    isPublic: false,
    content: "Approved guidance",
    title: "Help",
    sourcePath: "subzero://article",
    revision: 2,
    claim_token: "claim",
    pin_requested: true,
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      urls.push(path);
      calls.push(path.split("/").pop()!);
      return {
        ok: true,
        json: async () =>
          path.endsWith("/jobs")
            ? [{ id: "article", revision: 2 }]
            : path.endsWith("/claim")
              ? claim
              : {},
      };
    }),
  );
  const node = {
    indexDocuments: vi.fn(async () => {
      calls.push("index");
      return { errors: indexErrors };
    }),
    getLocalStore: () => ({
      getDocument: () => ({
        isPublic: false,
        isEncrypted: true,
        content: "ciphertext",
      }),
    }),
    syncNow: vi.fn(async () => {
      calls.push("sync");
      return { errors: 0 };
    }),
  };
  const central = {
    pinDocument: vi.fn(async () => {
      calls.push("pin");
    }),
  };
  const worker = new SubzeroSupportSync(
    "https://api.example.test",
    "test",
    publisher.id,
    node as any,
    central as any,
    "owner",
    ...(publisher.source ? [publisher.source] : []),
  );
  return { worker, node, central, calls, urls };
}
describe("private support publication", () => {
  it("requires verified grant after private indexing and before a paid pin", async () => {
    const h = harness();
    expect(await h.worker.tick()).toBe(1);
    expect(h.calls).toEqual([
      "jobs",
      "claim",
      "index",
      "sync",
      "authorize-pin",
      "pin",
      "complete",
    ]);
    expect(h.node.indexDocuments.mock.calls[0][0][0].isPublic).toBe(false);
  });
  it("rejects a different node or public visibility without indexing", async () => {
    for (const input of [{ nodeId: "other" }, { isPublic: true }]) {
      const h = harness(input);
      await expect(h.worker.tick()).rejects.toThrow("unsafe visibility");
      expect(h.node.indexDocuments).not.toHaveBeenCalled();
      expect(h.calls.at(-1)).toBe("fail");
    }
  });
  it("does not complete a partial index just because its body already exists", async () => {
    const h = harness({}, ["Embedding failed"]);
    await expect(h.worker.tick()).rejects.toThrow("Embedding failed");
    expect(h.central.pinDocument).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("complete");
  });
  it("publishes without paid storage when pinning is not requested", async () => {
    const h = harness({ pin_requested: false });
    expect(await h.worker.tick()).toBe(1);
    expect(h.central.pinDocument).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("authorize-pin");
  });
  it("tags SubZero documents by default", async () => {
    const h = harness({ pin_requested: false });
    await h.worker.tick();
    expect(h.urls[0]).toBe("/agent-api/knowledge/1/jobs");
    expect(h.node.indexDocuments.mock.calls[0][0][0].sourceAdapter).toBe("subzero");
  });
  it("publishes for Koryo under the workspace uuid, tagged koryo", async () => {
    const ws = "0d5c5b4e-3f7a-4c1e-9a62-2b8f3c1d9e70";
    const h = harness({ pin_requested: false }, [], { id: ws, source: "koryo" });
    expect(await h.worker.tick()).toBe(1);
    expect(h.urls).toEqual([
      `/agent-api/knowledge/${ws}/jobs`,
      `/agent-api/knowledge/${ws}/article/revisions/2/claim`,
      `/agent-api/knowledge/${ws}/article/revisions/2/complete`,
    ]);
    expect(h.node.indexDocuments.mock.calls[0][0][0]).toMatchObject({
      sourceAdapter: "koryo",
      isPublic: false,
    });
  });
});
