// packages/rdk-mcp/src/http-server.ts
// Serves .well-known/mcp.json for agent/registry discovery.
// Also serves chunk content at /chunks/:id for network retrieval.

import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { NodeConfig } from './node.js';

export function startHttpServer(config: NodeConfig, store: import('@rdk/core').LocalStore): void {
  const app = express();

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', nodeId: config.nodeId, version: '1.0.0' });
  });

  // .well-known/mcp.json — agent discovery
  app.get('/.well-known/mcp.json', (_req, res) => {
    const mcpJson = {
      name: config.nodeId === 'uninitialized' ? 'RDK Node' : `RDK Node (${config.domain})`,
      description: `RDK knowledge node. Provides pre-indexed domain knowledge via semantic retrieval. Reduces LLM token usage by serving pre-reasoned context. Domain: ${config.domain}. Query with rdk_query tool.`,
      mcp_endpoint: config.mcpPort
        ? `http://localhost:${config.mcpPort}/mcp`
        : `https://${config.nodeId}.rdk.network/mcp`,
      categories: ['knowledge-retrieval', 'rag', config.domain],
      x402_supported: true,
      version: '1.0.0',
      rdk_network: true,
      rdk_node_id: config.nodeId,
    };
    res.json(mcpJson);
  });

  // Chunk content delivery — called by central when routing retrieval to this node
  app.get('/chunks/:chunkId', (req, res) => {
    try {
      const chunk = store.getChunk(req.params.chunkId);
      if (!chunk || !chunk.isPublic) {
        return res.status(404).json({ error: 'Chunk not found or not public' });
      }
      res.json({
        id: chunk.id,
        title: chunk.title,
        content: chunk.content,
        summary: chunk.summary,
        domain: chunk.domain,
        categories: chunk.categories,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  const port = config.mcpPort ?? 3000;
  app.listen(port, () => {
    console.error(`RDK HTTP server listening on port ${port}`);
    console.error(`  .well-known: http://localhost:${port}/.well-known/mcp.json`);
  });
}
