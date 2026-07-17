// packages/rdk-node/src/index.ts
// @rdk/node — the headless, UI-agnostic orchestration layer shared by the CLI,
// @retrodeck/mcp, and the desktop app. Consumes @rdk/core primitives; adds the
// config, network client, sync, and WebSocket glue that used to live (and drift)
// inside the CLI and MCP packages.
export * from './config.js';
export { SyncService, type SyncConfig } from './sync-service.js';
export { CentralClient } from './central-client.js';
// RetroDeck API (account / plans / balance / top-up / subscription) — a different
// service from RDK Central, with its own token. Namespaced to avoid collisions.
export * as retrodeck from './retrodeck-client.js';
export { RetrodeckAuthError, type ApiPlan, type BalanceInfo } from './retrodeck-client.js';
export type { CentralClientConfig, EarningsSummary, AccountInfo } from './central-client.js';
export { NodeController } from './node-controller.js';
export type { NodeControllerOptions, NodeRuntimeStatus, NodeLogger } from './node-controller.js';

// Node network runtime — WebSocket control channel + command handlers.
export { RdkWebSocketClient, getWsClient } from './ws/client.js';
export { dispatchCommand } from './ws/handlers/index.js';
export * as wsEvents from './ws/events.js';
export type { WsMessage } from './ws/protocol.js';
