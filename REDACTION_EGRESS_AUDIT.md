# Model-Facing Egress Audit

Companion to `REDACTION_00_DESIGN.md`. The design's rule is not "the MCP path" —
it is **any path where content enters a model's context**. This file is the
enumeration that claim rests on: every route by which stored content can leave a
node, what kind of consumer is on the other end, and what we do about it.

Re-run this audit whenever a new way to get content out of a node is added.

---

## The choke point

`packages/rdk-core/src/query/serve.ts` — `packageResultsForModel()`.

Its policy argument **defaults to `getActiveRedactionPolicy()`**. That is the
inheritance mechanism from design decision 6: a path added later that packages
results for a model redacts without its author doing anything, and skipping
redaction requires passing `DISABLED_REDACTION_POLICY` on purpose — a visible,
reviewable act rather than an omission.

The policy is installed into `@rdk/core` by `@rdk/node`'s
`installCachedRedactionPolicy()` / `startRedactionPolicySync()`, which every node
runtime calls before it can serve anything.

---

## Model-facing paths — redaction APPLIES

| Path | Where | How |
|---|---|---|
| `rdk_query` MCP tool | `packages/rdk-mcp/src/node.ts` → `QueryPipeline.query()` | via `packageResultsForModel`; policy installed in `RDKNode.init()` before the transport connects |
| Haiku rerank fallback | `packages/rdk-core/src/query/model.ts` | `HaikuRerankModel.score()` redacts candidate text before POSTing to Anthropic |
| `rdk query` (non-interactive) | `packages/rdk-cli/src/commands/query.ts` | via `modelEgress()` — see the CLI note below |
| `rdk network:query` | `packages/rdk-cli/src/commands/network.ts` | via `modelEgress()` |

### Why the CLI counts

`rdk query` and `rdk network:query` are the one genuinely ambiguous surface: a
person runs them at a terminal, and an agent shells out to them whenever no MCP
server is configured — the `rdk` skill documents that fallback explicitly. Left
alone they would be a hole an employee could walk through by simply not
configuring MCP.

`packages/rdk-cli/src/model-egress.ts` resolves the ambiguity with the closest
definitional signal available:

- `--json` → machine format, something is parsing it → redact
- `!isInteractive()` → no person is watching this output → redact
- `--for-model` → the caller says so → redact
- an interactive terminal → a person is reading it → full content

`isInteractive()` (`packages/rdk-cli/src/interactive.ts`) is the project's one
definition of "a human is present": stdin **and** stdout are TTYs, `CI` is not
`true`, and `RDK_NON_INTERACTIVE` is not `1`. Using it rather than a bare
stdout-TTY check matters, because `docs/coding-agents.md` tells coding agents to
set exactly those two variables — and an agent that allocates a pty passes a
stdout-TTY check while being the most model-facing caller there is. Every
condition `isInteractive()` adds can only redact more, never less.

`packages/rdk-cli/test/model-egress.test.ts` pins each case.

**This is an addition beyond the literal build spec**, which listed only MCP and
future model paths. It is here because the compliance claim ("a member cannot
pipe sensitive data into their personal model") is false without it.

A human who wants full content in a pipe reads it in the dashboard or the
desktop app, which are unambiguously human paths.

Note that `rdk network:query --save` still writes **raw** content to the vault.
Saving tokens would destroy the answer for the person who paid for it; the vault
is a human artifact.

---

## Human paths — redaction does NOT apply

Deliberately, per the design: the team is trusted with the full document.

| Path | Where | Consumer |
|---|---|---|
| Dashboard document/chunk reads | RetroDeck dashboard | human |
| Desktop content view, vault tree, inspector | `apps/desktop` | human |
| `rdk vault:search` | `packages/rdk-cli/src/commands/vault.ts` | human at a terminal |
| `rdk query` at an interactive TTY | `packages/rdk-cli/src/commands/query.ts` | human at a terminal |

The desktop node service installs and refreshes the policy anyway
(`apps/desktop/electron/node-service.ts`) so its status surface can report
whether one applies, and so a local-model query added there inherits enforcement.
It does not redact anything it shows to the user today.

**This direction is guarded by tests, not just by convention.**
`apps/desktop/test/main/redaction-human-reads.test.ts` drives the real
`NodeService.readContent()` and `NodeService.query()` with an aggressive org
policy installed and active, and asserts the full document comes back — private
and encrypted, public and plaintext, and a teammate's shared document the router
decrypted with a shared vault key. Each assertion was verified to fail when the
corresponding path was temporarily made to redact.

The reason to guard this side at all: if a model-facing path stops redacting, a
compliance review catches it. If a human path *starts* redacting, nothing fails
— a teammate just finds a colleague's shared document full of `[PERSON_9a7614]`
and concludes RDK is broken.

---

## Node-to-node paths — out of scope, and why

| Path | Where | Verdict |
|---|---|---|
| `GET /chunks/:id` | `packages/rdk-node/src/http-server.ts` | Serves **public** chunks only. Public means already published to the network as plaintext, by definition — redacting there would be theatre, and would corrupt content other nodes have already indexed. |
| WS `fetch-content` | `packages/rdk-node/src/ws/handlers/fetch-content.ts` | Hands Central the chunk **as stored**: plaintext for public, ciphertext for private. Central cannot read private content, and the requesting teammate's node decrypts locally — where **its own** egress redaction then applies. Redacting here would be both useless (Central can't read it) and wrong (it would ship tokens into a peer's vault). |
| WS `fetch-document` | `packages/rdk-node/src/ws/handlers/fetch-document.ts` | Same reasoning. |
| Chunk sync to Central | `packages/rdk-node/src/sync-service.ts` | Index-time, not serving-time. The design explicitly rules out index-time redaction. |

The general principle: redaction belongs at the **consuming** node's egress, not
the **providing** node's. A chunk retrieved from a peer is redacted under the
policy of the org whose model is about to read it — which is the correct org,
because that is whose compliance obligation is in play.

---

## What is NOT protected

Stated plainly so nobody oversells this.

1. **A member with root on their own machine can patch the binary.** What this
   design rules out is bypass through any *supported* path: editing config,
   passing a flag, choosing a different model, deleting credentials, or going
   offline. Fail-closed caching covers the last two
   (`packages/rdk-node/src/redaction-policy.ts`).
2. **Redaction is not access control.** It decides what a model sees, not
   whether employee X may retrieve employee Y's chunk at all. Role-based access
   control is the natural companion feature and is out of scope here.
3. **Deterministic rules miss what they do not match.** A name not on a term
   list and not in a built-in pattern goes through. LLM-semantic detection is a
   future enhancement; v1 is deterministic because it is auditable, cheap, and
   explainable to a compliance team.
4. **The admin preview and the node engine are two copies of one algorithm.**
   `apps/api/src/redaction/engine.ts` mirrors
   `packages/rdk-core/src/redaction/redact.ts`. They are pinned to each other by
   shared fixtures — `test/redaction-fixtures.ts` in both repos, asserted by
   `redaction-parity.test.ts` / `redaction-parity.spec.ts`. Change one, change
   the other, run both.

---

## Adding a new model-facing path

1. Route the content through `packageResultsForModel()`, or build a `Redactor`
   from `getActiveRedactionPolicy()` and run every string through it.
2. Use **one** redactor per response, so a value appearing twice reads as the
   same token both times.
3. Include the `REDACTION_NOTICE` when anything was replaced, so the model
   treats tokens as opaque rather than guessing.
4. Never serialize the token map, and never log a redacted value. Counts only.
5. Add a row to the table above.
