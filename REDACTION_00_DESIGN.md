# Model-Facing Redaction — Design Doc
## Architecture decision document (precedes the build spec)

---

## The Problem

RDK's enterprise pitch: a company buys basic-plan seats, shares private
work product across a network of team nodes, and employees use whatever
model they want — all tapping the same shared context layer. The saving
is real: companies pay repeatedly for context (every model subscription
rebuilds it from zero); RDK makes context persistent and model-agnostic.

But this only works for companies with sensitive data IF that data can be
kept out of model context. The key realization:

> The sensitive data is NOT sensitive to the team. It is sensitive to the
> MODEL. Team members are trusted with the full document. The model is the
> untrusted party.

So the goal is NOT to redact data from humans. It is to redact data on the
path where content crosses from RDK into a model's context — and ONLY
there.

---

## Why Not the Obvious Approaches

- **Redact at index time (strip sensitive data before storing)**: WRONG
  here. Team members legitimately need the full unredacted document.
  Destroying data at index time breaks the humans who are trusted with it.
- **LLM-based semantic redaction**: self-defeating — you'd send sensitive
  content to a model to decide what to hide from a model. Also slow,
  costly, non-deterministic.
- **Redact everything everywhere**: breaks human utility.

The right model is **query-time redaction on the model-facing egress path
only**. Full content stays stored and stays available to humans;
redaction applies specifically when content is served to a model.

---

## The Trust Boundary

RDK has a clean, definitional signal for "is the consumer a model or a
human":

| Path | Consumer | Redaction |
|------|----------|-----------|
| MCP `rdk:query` via `rdk mcp:serve` | a MODEL (that's what MCP is) | APPLY |
| Dashboard / desktop app reading | a HUMAN | full content, no redaction |
| Any future model-facing path (e.g. desktop "query with local model") | a MODEL | APPLY |

The rule is NOT literally "the MCP path." It's **"any path where content
enters a model's context."** MCP is the primary one today. The redaction
must be a function that every model-facing egress calls, so future
model-facing paths inherit it and can't bypass it.

---

## The Design

### 1. Full content stays on the node, unredacted

Nothing changes about storage. The node holds the complete document.
Humans retrieving via dashboard/desktop get everything. This is the whole
point — the team is trusted.

### 2. Redaction applies at the model-facing egress (on-node, at mcp:serve)

When content is served to a model via `rdk mcp:serve`'s `rdk:query`, the
node runs the content through the org's redaction rules BEFORE returning
it into the model's context.

**On-node, not Central.** The redaction happens at the node's mcp:serve
layer, consistent with the architecture where Central holds metadata/
routing and nodes hold content. The raw data never needs to leave the
node even to Central. The policy travels to the node; enforcement is
local.

### 3. Tokenize, don't strip (consistent pseudonymization)

Replace sensitive spans with stable tokens, not blanks:

```
raw (on node, for humans):
  "Customer Jane Doe (SSN 123-45-6789) disputed invoice #4471"

served to a model via rdk:query:
  "Customer [PERSON_a8f3] (SSN [SSN_b2e1]) disputed invoice [INVOICE_c9d4]"
```

Why tokenize rather than strip:
- The model stays USEFUL — it can reason about the content, answer
  questions, maintain context. "[PERSON_a8f3] disputed an invoice" is
  workable; "[REDACTED] disputed an invoice" loses the thread.
- **Referential consistency**: the same raw value always maps to the same
  token, so the model can follow references across a session ("what did
  [PERSON_a8f3] want?") without ever knowing who that is.
- The token→value map stays ON THE NODE, accessible only to authorized
  humans. If a human needs the real value, they read the actual document.
  The map is never served to a model and never synced to Central.

### 4. Tell the model redaction happened

The MCP response includes a note that some values were redacted per org
policy, so the model treats tokens as opaque references rather than
hallucinating around them or "helpfully" trying to fill in the blanks.

```
[note: some values in this content have been redacted per your
organization's policy. tokens like [PERSON_a8f3] are opaque, consistent
references — treat them as stable identifiers, do not guess their values.]
```

### 5. Org-level policy, inherited by every node

The redaction rules are an ORG-LEVEL policy set by the org admin (whoever
purchased the team seats). Every node in the org's network inherits and
enforces the same policy.

This is what makes it a compliance story rather than a toy: the admin
sets the policy once, and every employee's node — including nodes that
join later — enforces it on model-facing egress. One employee CANNOT pipe
sensitive data into their personal ChatGPT, because their node applies
the org policy on the MCP path regardless of which model is asking.

Policy distribution: the admin defines rules; Central stores the org's
policy and syncs it to member nodes (the rules themselves aren't
sensitive — pattern definitions and term lists — so syncing them is
fine). Nodes cache the policy and enforce locally. This fits the "Central
holds policy/metadata, nodes hold content and enforce" split.

---

## Rule Model (Deterministic, Auditable)

Start with deterministic, explainable rules — enterprises need to audit
what their redaction does, and "we send your data to a model to decide"
is a hard sell.

Rule types:
- **Built-in pattern library**: SSN, credit card, phone, email, API keys/
  tokens, IP addresses, common PII formats — toggleable on/off
- **Custom regex**: org-specific patterns (customer-ID format, internal
  codenames matching a pattern)
- **Custom term lists**: explicit terms/phrases to redact (project
  codenames, specific names, salary figures)

Each rule has:
- A **type/pattern** (what to match)
- A **token prefix** (what the replacement looks like: PERSON, SSN,
  INTERNAL, etc.)
- Applies to the **private category** for the org's network

LLM-based semantic detection is explicitly a FUTURE enhancement, not v1 —
deterministic first because it's auditable, cheap, fast, and
enterprise-explainable.

---

## What This Is Not (Scope Boundaries)

- **Not access control.** Redaction protects against sensitive spans
  reaching a model's context. It does NOT decide whether employee X can
  retrieve employee Y's chunk at all — that's role-based access control, a
  separate (complementary) feature. Flag it as the natural companion but
  it's out of scope here.
- **Not index-time redaction.** Content is stored whole; redaction is a
  serving-time transform on model-facing paths only.
- **Not human-facing.** Dashboard and desktop reads get full content.

---

## Decisions (Locked)

1. Redaction lives ON-NODE at the mcp:serve egress (not Central routing).
2. Org-level policy, set by the admin who bought the team seats, synced
   from Central to all member nodes, enforced locally.
3. Tokenize (consistent pseudonymization), not strip. Token→value map
   stays on-node, never served to a model, never synced.
4. Deterministic rules (pattern library + regex + term lists) for v1;
   LLM-semantic detection is a future enhancement.
5. MCP responses note that redaction occurred so models treat tokens as
   opaque.
6. Redaction is a function EVERY model-facing egress path calls, so new
   model paths (e.g. desktop local-model query) inherit it and can't
   bypass.

---

## Why This Makes RDK Enterprise-Viable

Without this, "share your team's private work across nodes and use any
model" is a non-starter for any company with compliance requirements —
sensitive data would flow into arbitrary model contexts. With it, the
company gets: shared persistent context across models and seats (the cost
saving), AND a deterministic, admin-controlled, org-wide guarantee that
sensitive data never enters a model's context (the compliance story).
That combination is the wedge that makes RDK a viable alternative to
paying for multiple model seats per employee.

---

## Implementation Notes (added during the build)

Three decisions were made while building that the design above does not
settle, and that anyone auditing this feature needs to know:

**Tokens are a KEYED hash, not a plain one.** A truncated unkeyed hash of
a nine-digit SSN is recoverable by brute force from the token alone, which
would defeat the whole exercise. Each node generates a token salt once
(`~/.rdk/redaction-salt`, mode 0600) and derives tokens as
`HMAC-SHA256(salt, prefix + value)`. The salt is never synced and never
served, so tokens are stable across sessions on one node and meaningless
across nodes.

**Effective policy is a UNION across orgs.** A user can belong to several
orgs (their own, plus each team that invited them). Their node enforces
the union of those rule sets. This is what makes "a member cannot weaken
the policy" structurally true rather than a matter of endpoint
permissions: the only edit a member can make to their own org's rules is
an addition to what applies to them.

**Enforcement fails closed.** The cached policy is installed before a node
can serve anything, and a failed refresh — unreachable API, expired
session, deleted credentials, outdated server — keeps the cached policy in
force. Only the API affirmatively saying "no policy applies" turns
enforcement off.

The enumeration of every path content can take out of a node, and what
happens on each, is in `REDACTION_EGRESS_AUDIT.md`.
