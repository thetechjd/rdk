// packages/rdk-node/src/ws/events.ts
// Outbound event helpers called from indexer callbacks and handlers.

import crypto from 'crypto';
import { getWsClient } from './client.js';

export function pushChunkIndexed(chunk: {
  id: string;
  title: string;
  isPublic: boolean;
}): void {
  const client = getWsClient();
  if (!client?.isConnected()) return;

  const titleHash = crypto.createHash('sha256')
    .update(chunk.title)
    .digest('hex')
    .slice(0, 16);

  client.send({
    type: 'chunk.indexed',
    data: { chunkId: chunk.id, isPublic: chunk.isPublic, titleHash },
  });
}

export function pushChunkDeleted(chunkId: string): void {
  const client = getWsClient();
  if (!client?.isConnected()) return;
  client.send({ type: 'chunk.deleted', data: { chunkId } });
}
