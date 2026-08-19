// packages/rdk-core/src/redaction/active-policy.ts
//
// The org policy currently in force on THIS node.
//
// Why a module-level holder rather than a constructor argument threaded through
// every call site: design decision 6 says redaction must be something a new
// model-facing egress path INHERITS, not something its author has to remember
// to wire up. Every serving function defaults its policy argument to
// `getActiveRedactionPolicy()`, so a path added later redacts unless someone
// explicitly opts it out - which is a visible, reviewable act.
//
// The node runtime (@rdk/node's redaction-policy sync) owns setting this. Core
// never fetches anything; it only enforces what it has been handed.

import { DISABLED_REDACTION_POLICY, type RedactionPolicy } from './types.js';

let active: RedactionPolicy = DISABLED_REDACTION_POLICY;

/**
 * Install the org policy this node enforces on model-facing egress.
 *
 * Called at node startup with the on-disk cached policy BEFORE any query can be
 * served, then again whenever a refresh brings a new version.
 */
export function setActiveRedactionPolicy(policy: RedactionPolicy | null | undefined): void {
  active = policy ?? DISABLED_REDACTION_POLICY;
}

/** The policy every model-facing egress path applies. Never null. */
export function getActiveRedactionPolicy(): RedactionPolicy {
  return active;
}

/** True when this node has an org policy that would actually change content. */
export function redactionIsActive(): boolean {
  return active.enabled && active.rules.some((rule) => rule.enabled !== false);
}
