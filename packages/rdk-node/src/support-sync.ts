import { createHash } from "node:crypto";
import { NodeController } from "./node-controller.js";
import { CentralClient } from "./central-client.js";
import { loadConfig } from "./config.js";

/** Customer-operated publication worker. It runs no model and never publishes
 * to the public network. Run it with a dedicated project node/config. */
export class SubzeroSupportSync {
  constructor(
    private readonly api: string,
    private readonly token: string,
    private readonly projectId: number,
    private readonly node: NodeController,
    private readonly central: CentralClient,
    private readonly nodeId: string,
  ) {}
  private async call(path: string, body?: unknown): Promise<any> {
    const response = await fetch(
      `${this.api.replace(/\/$/, "")}/agent-api/knowledge/${this.projectId}${path}`,
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
  async tick(): Promise<number> {
    const jobs = await this.call("/jobs");
    let done = 0;
    for (const job of jobs) {
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
              sourceAdapter: "subzero",
              version: claim.revision,
              isPublic: false,
            },
          ]);
          if (result.errors.length) throw new Error(result.errors.join("; "));
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
        await this.call(path + "/fail", {
          claimToken: claim.claim_token,
          error:
            "RDK indexing, pinning or verification failed. Check the publication worker logs, correct the problem and retry approval.",
        }).catch(() => {});
        throw error;
      }
    }
    return done;
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
