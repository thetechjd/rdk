// packages/rdk-cli/src/version.ts
// The CLI's own version. esbuild inlines package.json into the bundle; under a
// test runner without `require` this falls back to null rather than guessing.

export function cliVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../package.json') as { version: string }).version;
  } catch {
    return null;
  }
}
