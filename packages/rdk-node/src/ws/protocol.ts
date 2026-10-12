// packages/rdk-node/src/ws/protocol.ts
// Mirror of the RDK Central WebSocket protocol. Keep in sync with server.

export interface WsMessage {
  type: string;
  id?: string;
  replyTo?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

// Inbound: RDK Central → node
export type InboundCommand =
  | { type: 'command.promote_public'; id: string; data: { chunkId: string } }
  | { type: 'command.delete_chunk';   id: string; data: { chunkId: string } }
  | { type: 'command.vault_list';     id: string; data: Record<string, never> }
  | { type: 'command.fetch_content';  id: string; data: { chunkIds: string[]; requesterId: string; requesterTeamKeyId: string | null } }
  | { type: 'command.fetch_document'; id: string; data: { documentHashes: string[]; requesterId: string; requesterUserId: string | null } }
  | { type: 'command.partner_job';    id: string; data: PartnerJobCommand };

// ── Partner jobs (RDK_PL_00A C2) ───────────────────────────────────────────
// A partner app (ParlayLedger) queues a job on Central; Central relays it to
// the paired node as `command.partner_job`. The result travels back as the
// `ack` data, a failure as `error` with one of the codes below.

export type PartnerJobType = 'publish_doc' | 'unpublish_doc' | 'ping';

export interface PartnerJobCommand {
  jobId: string;
  partnerId: string;
  jobType: PartnerJobType | string;
  payload: unknown;
  issuedAt?: string;
}

export interface PublishDocPayload {
  ref: string;            // pub_<ULID>
  filename: string;       // `${ref}.md`
  markdown: string;
  contentHash: string;    // 'sha256:<hex>' of the markdown UTF-8 bytes
  categories: string[];
  domain: string;
  visibility: 'public';
  pin: boolean;
}

export interface UnpublishDocPayload { ref: string }

export interface PublishDocResult {
  ref: string;
  contentHash: string;
  chunkHashes: string[];
  /** Equal to chunkHashes: the node only knows content hashes. Central may
   *  substitute its own row ids before emitting job.completed. */
  chunkIds: string[];
  indexedAt: string;
}

export type UnpublishDocResult =
  | { ref: string; removedChunkHashes: string[] }
  | { ref: string; alreadyRemoved: true };

export interface PingResult {
  cliVersion: string | null;
  serving: boolean;
  publicChunks: number;
  partnerDocs: number;
}

/** Terminal: Central marks the job failed. */
export const PARTNER_TERMINAL_CODES = [
  'partner_not_linked', 'partner_disabled', 'job_type_not_allowed', 'invalid_payload',
  'content_hash_mismatch', 'doc_too_large', 'invalid_filename', 'pinning_unavailable',
  'plan_limit_reached',
] as const;
/** Transient: Central re-queues the job. */
export const PARTNER_TRANSIENT_CODES = ['rate_limited', 'node_busy'] as const;
export type PartnerJobErrorCode =
  | typeof PARTNER_TERMINAL_CODES[number]
  | typeof PARTNER_TRANSIENT_CODES[number];

/** Fallback `error.code` for a handler failure that carries no code of its own. */
export const COMMAND_FAILED = 'COMMAND_FAILED';

// Outbound: node → RDK Central
export type OutboundEvent =
  | { type: 'node.heartbeat' }
  | { type: 'chunk.indexed';           data: { chunkId: string; isPublic: boolean; titleHash: string } }
  | { type: 'chunk.deleted';           data: { chunkId: string } }
  | { type: 'chunk.visibility_changed'; data: { chunkId: string; isPublic: boolean } };
