// packages/rdk-node/src/ws/handlers/index.ts

import { promotePublicHandler } from './promote-public.js';
import { deleteChunkHandler } from './delete-chunk.js';
import { vaultListHandler } from './vault-list.js';
import { fetchContentHandler } from './fetch-content.js';
import { fetchDocumentHandler } from './fetch-document.js';
import { partnerJobHandler } from './partner-job.js';

type Handler = (data: unknown) => Promise<unknown>;

// Looked up when a command arrives, not when this module loads. The handlers
// form an import cycle (partner-job -> ../events -> ../client -> this file), so
// a table built at load time can read partnerJobHandler before partner-job.js
// has initialized it ("Cannot access 'partnerJobHandler' before
// initialization"). By the time a command arrives every module has loaded.
function handlerFor(type: string): Handler | undefined {
  switch (type) {
    case 'command.promote_public': return promotePublicHandler;
    case 'command.delete_chunk':   return deleteChunkHandler;
    case 'command.vault_list':     return vaultListHandler;
    case 'command.fetch_content':  return fetchContentHandler;
    case 'command.fetch_document': return fetchDocumentHandler;
    case 'command.partner_job':    return partnerJobHandler;
    default:                       return undefined;
  }
}

export async function dispatchCommand(msg: { type: string; id: string; data: unknown }): Promise<unknown> {
  const handler = handlerFor(msg.type);
  if (!handler) throw new Error(`Unknown command: ${msg.type}`);
  return handler(msg.data);
}
