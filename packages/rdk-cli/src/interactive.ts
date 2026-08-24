export function isInteractive(): boolean {
  return process.stdin.isTTY === true
    && process.stdout.isTTY === true
    && process.env.RDK_NON_INTERACTIVE !== '1'
    && process.env.CI !== 'true';
}

export const HEADLESS_CREDENTIAL_ERROR =
  'No RDK credentials found. Set RDK_API_KEY (dashboard.retrodeck.ai → settings → API key) ' +
  'or provide RDK_CONFIG_PATH. Interactive setup (rdk init) requires a terminal.';
