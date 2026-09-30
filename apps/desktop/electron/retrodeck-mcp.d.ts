// @retrodeck/mcp is bundled by esbuild and publishes no type declarations.
// These are the two entry points serve.ts uses.
declare module '@retrodeck/mcp' {
  /** Starts the .well-known HTTP server; resolves to the bound port (0 if none). */
  export function startHttpServer(config: unknown, store: unknown): Promise<number>;
  /** Serves the RDK tools over stdio until the client disconnects. */
  export function startMcpServer(): Promise<void>;
}
