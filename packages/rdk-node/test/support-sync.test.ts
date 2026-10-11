import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/node-controller.js", () => ({ NodeController: class {} }));
vi.mock("../src/central-client.js", () => ({ CentralClient: class {} }));
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn() }));
import { SubzeroSupportSync } from "../src/support-sync.js";

afterEach(() => vi.unstubAllGlobals());
function harness(
  overrides: Record<string, unknown> = {},
  indexErrors: string[] = [],
) {
  const calls: string[] = [];
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
    1,
    node as any,
    central as any,
    "owner",
  );
  return { worker, node, central, calls };
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
});
