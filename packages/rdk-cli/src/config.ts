// packages/rdk-cli/src/config.ts
// The config layer moved to @rdk/node so the CLI, @retrodeck/mcp, and the desktop
// app share one implementation (no more duplicated machine-key crypto). This is a
// thin re-export kept so the CLI's ~12 `./config.js` / `../config.js` importers
// don't have to change. New code should import from '@rdk/node' directly.
export * from '@rdk/node/config';
