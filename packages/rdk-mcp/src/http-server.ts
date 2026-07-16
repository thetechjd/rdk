// packages/rdk-mcp/src/http-server.ts
// Moved to @rdk/node so the CLI, MCP, and desktop share one chunk-serving/discovery
// server. Thin re-export keeps @retrodeck/mcp's public API (index.ts) unchanged.
export { startHttpServer, type HttpServerConfig } from '@rdk/node/http-server';
