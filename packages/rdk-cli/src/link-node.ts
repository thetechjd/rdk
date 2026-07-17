// packages/rdk-cli/src/link-node.ts
// Moved to @rdk/node so the CLI and the desktop app share one node-linking
// implementation (the desktop's native login needs it too). Thin re-export keeps
// existing CLI imports working.
export { ensureNodeLinked, type LinkResult } from '@rdk/node/link-node';
