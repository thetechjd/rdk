// packages/rdk-cli/src/ws/handlers/index.ts

import { promotePublicHandler } from './promote-public.js';
import { deleteChunkHandler } from './delete-chunk.js';
import { vaultListHandler } from './vault-list.js';

const handlers: Record<string, (data: unknown) => Promise<unknown>> = {
  'command.promote_public': promotePublicHandler,
  'command.delete_chunk':   deleteChunkHandler,
  'command.vault_list':     vaultListHandler,
};

export async function dispatchCommand(msg: { type: string; id: string; data: unknown }): Promise<unknown> {
  const handler = handlers[msg.type];
  if (!handler) throw new Error(`Unknown command: ${msg.type}`);
  return handler(msg.data);
}
