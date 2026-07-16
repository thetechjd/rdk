// packages/rdk-node/src/http-server.ts
// Serves .well-known/mcp.json for agent/registry discovery, and public chunk
// content at /chunks/:id for cross-node retrieval. Moved here from @retrodeck/mcp
// so the CLI's mcp:serve and the desktop's node runtime share one implementation.
// Config is a minimal structural type (not MCP's NodeConfig) to stay UI/host-agnostic.

import express from 'express';
import type { LocalStore } from '@rdk/core';

export interface HttpServerConfig {
  nodeId: string;
  domain: string;
  mcpPort?: number;
}

export function startHttpServer(config: HttpServerConfig, store: LocalStore): Promise<number> {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', nodeId: config.nodeId, version: '1.0.0' });
  });

  app.get('/.well-known/mcp.json', (_req, res) => {
    // mcp_endpoint is filled in after we know the actual bound port
    res.json({
      name: config.nodeId === 'uninitialized' ? 'RDK Node' : `RDK Node (${config.domain})`,
      description: `RDK knowledge node. Domain: ${config.domain}. Query with rdk_query tool.`,
      categories: ['knowledge-retrieval', 'rag', config.domain],
      x402_supported: true,
      version: '1.0.0',
      rdk_network: true,
      rdk_node_id: config.nodeId,
    });
  });

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

  const startPort = config.mcpPort ?? 4242;
  const maxPort = startPort + 10;

  return new Promise<number>((resolve, reject) => {
    function tryListen(port: number): void {
      if (port > maxPort) {
        const msg = `no free port found in ${startPort}–${maxPort}`;
        console.error(`RDK HTTP server: ${msg}, discovery endpoint unavailable`);
        resolve(-1); // non-fatal — MCP stdio continues without discovery
        return;
      }
      const server = app.listen(port);
      server.on('listening', () => {
        console.error(`RDK HTTP server listening on port ${port}`);
        console.error(`  .well-known: http://localhost:${port}/.well-known/mcp.json`);
        resolve(port);
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`RDK HTTP server: port ${port} in use, trying ${port + 1}...`);
          tryListen(port + 1);
        } else {
          console.error(`RDK HTTP server error: ${err.message}`);
          reject(err);
        }
      });
    }
    tryListen(startPort);
  });
}
