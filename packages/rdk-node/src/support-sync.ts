import { createHash } from "node:crypto";
import { NodeController } from "./node-controller.js";
import { CentralClient } from "./central-client.js";
import { loadConfig } from "./config.js";
import type { IndexCapacity } from "@rdk/core";

/** One publication pass. */
export interface SupportSyncResult {
  /** Documents indexed, verified and completed in this pass. */
  published: number;
  /** The node reached its indexing rate limit. The remaining documents wait in the publisher's queue. */
  rateLimited: boolean;
  /** When rate limited: milliseconds until the node can index another document. Else 0. */
  retryAfterMs: number;
  /** The node's indexing capacity after the pass (perHour, burst, available, waitMs), when it reports one. */
  capacity?: IndexCapacity;
}

const RATE_LIMITED = /Index rate limit exceeded/i;
class RateLimited extends Error {}

/** Customer-operated publication worker. It runs no model and never publishes
 * to the public network. Run it with a dedicated project node/config.
 * The publisher's API (SubZero, or Koryo for Kaia) serves the same protocol
 * under /agent-api/knowledge/:id, where id is a SubZero project number or a
 * Koryo workspace uuid. */
export class SubzeroSupportSync {
  constructor(
    private readonly api: string,
    private readonly token: string,
    private readonly projectId: number | string,
    private readonly node: NodeController,
    private readonly central: CentralClient,
    private readonly nodeId: string,
    private readonly sourceAdapter = "subzero",
  ) {}
  private async call(path: string, body?: unknown): Promise<any> {
    const response = await fetch(
      `${this.api.replace(/\/$/, "")}/agent-api/knowledge/${encodeURIComponent(String(this.projectId))}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Support publication HTTP ${response.status}: ${await response.text()}`,
      );
    return response.json();
  }
  /**
   * Publishes the queued documents, in order. At the node's indexing rate
   * limit it stops and leaves the rest queued: it does not claim a document it
   * can't index yet, and a document that hits the limit mid-pass goes back to
   * the publisher's queue (`release`), not to failed. A later pass picks them up.
   */
  async run(): Promise<SupportSyncResult> {
    const jobs = await this.call("/jobs");
    let done = 0;
    for (const job of jobs) {
      const before = this.capacity();
      if (before && before.available < 1) return this.limited(done, before);
      const path = `/${job.id}/revisions/${job.revision}`;
      const claim = await this.call(path + "/claim", {});
      try {
        if (claim.nodeId !== this.nodeId || claim.isPublic !== false)
          throw new Error(
            "Support job targets a different node or unsafe visibility",
          );
        const hash = createHash("sha256").update(claim.content).digest("hex");
        {
          // Re-index idempotently: a prior failure may have saved the body without all chunks.
          const result = await this.node.indexDocuments([
            {
              title: claim.title,
              content: claim.content,
              sourcePath: claim.sourcePath,
              sourceAdapter: this.sourceAdapter,
              version: claim.revision,
              isPublic: false,
              // Private, per-account support content: identical text is not a republish.
              supportPublication: true,
            },
          ]);
          if (result.errors.length) {
            const message = result.errors.join("; ");
            throw RATE_LIMITED.test(message) ? new RateLimited(message) : new Error(message);
          }
        }
        const doc = this.node.getLocalStore().getDocument(hash);
        if (!doc || doc.isPublic || !doc.isEncrypted)
          throw new Error("Support document must be private and encrypted");
        const sync = await this.node.syncNow();
        if (sync.errors) throw new Error("RDK metadata sync failed");
        if (claim.pin_requested) {
          await this.call(path + "/authorize-pin", {
            claimToken: claim.claim_token,
          });
          await this.central.pinDocument(hash);
        }
        await this.call(path + "/complete", {
          claimToken: claim.claim_token,
          documentHash: hash,
          sizeBytes: Buffer.byteLength(doc.content, "utf8"),
          pinned: !!claim.pin_requested,
        });
        done++;
      } catch (error) {
        if (error instanceof RateLimited) {
          // Not a failure: back in the queue. A publisher without `release`
          // lets the claim expire instead, and the document is claimed again then.
          await this.call(path + "/release", { claimToken: claim.claim_token }).catch(() => {});
          return this.limited(done, this.capacity());
        }
        await this.call(path + "/fail", {
          claimToken: claim.claim_token,
          error:
            "RDK indexing, pinning or verification failed. Check the publication worker logs, correct the problem and retry approval.",
        }).catch(() => {});
        throw error;
      }
    }
    return { published: done, rateLimited: false, retryAfterMs: 0, capacity: this.capacity() };
  }
  /** `run`, counting the documents published. */
  async tick(): Promise<number> {
    return (await this.run()).published;
  }
  private capacity(): IndexCapacity | undefined {
    return typeof this.node.indexCapacity === "function" ? this.node.indexCapacity() : undefined;
  }
  private limited(published: number, capacity: IndexCapacity | undefined): SupportSyncResult {
    return { published, rateLimited: true, retryAfterMs: Math.max(1000, capacity?.waitMs ?? 60000), capacity };
  }
  static async create(api: string, token: string, projectId: number) {
    if (
      !api.startsWith("https://") ||
      !token ||
      !Number.isSafeInteger(projectId) ||
      projectId < 1
    )
      throw new Error(
        "Set HTTPS SUBZERO_API_URL, SUBZERO_AGENT_TOKEN and SUBZERO_PROJECT_ID",
      );
    const config = loadConfig();
    if (!config.vaultKeyHex)
      throw new Error(
        "Initialize the dedicated support node vault key before starting publication",
      );
    const node = new NodeController({ config });
    await node.start();
    const central = new CentralClient({
      centralApiUrl: config.centralApiUrl,
      apiKey: config.apiKey,
    });
    return new SubzeroSupportSync(
      api,
      token,
      projectId,
      node,
      central,
      config.nodeId,
    );
  }
}
