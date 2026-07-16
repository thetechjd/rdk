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
  | { type: 'command.fetch_content';  id: string; data: { chunkIds: string[]; requesterId: string; requesterTeamKeyId: string | null } };

// Outbound: node → RDK Central
export type OutboundEvent =
  | { type: 'node.heartbeat' }
  | { type: 'chunk.indexed';           data: { chunkId: string; isPublic: boolean; titleHash: string } }
  | { type: 'chunk.deleted';           data: { chunkId: string } }
  | { type: 'chunk.visibility_changed'; data: { chunkId: string; isPublic: boolean } };
