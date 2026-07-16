// packages/rdk-mcp/src/sync-service.ts
// Moved to @rdk/node so the CLI, MCP, and desktop share one sync implementation.
// Thin re-export keeps @retrodeck/mcp's public API (index.ts) unchanged.
export { SyncService, type SyncConfig } from '@rdk/node';
