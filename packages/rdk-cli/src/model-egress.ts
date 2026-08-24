// packages/rdk-cli/src/model-egress.ts
//
// Deciding whether a CLI invocation is a model-facing egress path.
//
// The design's trust boundary is definitional for MCP - MCP exists to feed a
// model - and definitional the other way for the dashboard and the desktop
// content view, which exist to feed a human. `rdk query` is the one surface
// that is genuinely both: a person runs it at a terminal AND an agent shells
// out to it whenever no MCP server is configured (the rdk skill documents that
// fallback explicitly). Leaving it unredacted would leave the org's compliance
// story with a hole an employee could walk through by not configuring MCP.
//
// So it is treated as model-facing unless a human is demonstrably watching:
//
//   --json                  -> machine format, something is parsing it   -> redact
//   not isInteractive()     -> no person is watching this output        -> redact
//   --for-model             -> the caller says so                       -> redact
//   an interactive terminal -> a person is reading it                   -> full content
//
// `isInteractive()` rather than a bare stdout-TTY check, and deliberately so.
// It also treats CI=true and RDK_NON_INTERACTIVE=1 as "no human", which is
// exactly what docs/coding-agents.md tells a coding agent to set — and an agent
// that allocates a pty WOULD pass a stdout-TTY check while being the most
// model-facing caller there is. Every condition it adds only ever redacts more.
//
// A human who wants full content in a pipe reads it in the dashboard or the
// desktop app, which are unambiguously human paths and are never redacted.

import {
  REDACTION_NOTICE,
  Redactor,
  getActiveRedactionPolicy,
} from '@rdk/core';
import { installCachedRedactionPolicy, refreshRedactionPolicy } from '@rdk/node';
import { isInteractive } from './interactive.js';

export interface ModelEgress {
  /** True when this invocation is treated as feeding a model. */
  readonly forModel: boolean;
  /** True when the org policy actually replaced something. */
  readonly redacted: boolean;
  /** Redact one string. A no-op on human paths and when no policy is in force. */
  text(value: string): string;
  /** The line to print/emit telling the model tokens are opaque, or null. */
  notice(): string | null;
}

/**
 * Build the egress for one command invocation.
 *
 * One redactor per invocation, so a value appearing in two sections of one
 * answer reads as the same token - the referential consistency the design
 * requires. Reads the cached policy synchronously so enforcement never waits on
 * the network, then kicks a refresh so the NEXT invocation is current.
 */
export function modelEgress(opts: { json?: boolean; forModel?: boolean } = {}): ModelEgress {
  const forModel = opts.forModel === true || opts.json === true || !isInteractive();
  if (!forModel) return inactive(false);

  installCachedRedactionPolicy();
  // Fire and forget: a one-shot command must not pay for a round trip, and a
  // stale-but-present policy is still enforced. Failures are already silent.
  void refreshRedactionPolicy(() => {});

  const redactor = new Redactor(getActiveRedactionPolicy());
  if (!redactor.active) return inactive(true);

  return {
    forModel: true,
    get redacted() { return redactor.redactedCount > 0; },
    text: (value: string) => (value ? redactor.redact(value).content : value),
    notice: () => (redactor.redactedCount > 0 ? REDACTION_NOTICE : null),
  };
}

function inactive(forModel: boolean): ModelEgress {
  return {
    forModel,
    redacted: false,
    text: (value: string) => value,
    notice: () => null,
  };
}
