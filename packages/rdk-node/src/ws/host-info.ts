// packages/rdk-node/src/ws/host-info.ts
// What is running this node, as the host told us.
//
// @rdk/node runs inside both the CLI and the desktop app and cannot tell which,
// so it must not guess a version. The host injects it when it opens the Central
// session (`startWsSession({ hostVersion })`); the partner `ping` job reports it.

let hostVersion: string | null = null;

/** Record the host's version (CLI package version, or the desktop app version). */
export function setHostVersion(version: string | null | undefined): void {
  hostVersion = typeof version === 'string' && version.trim() ? version.trim() : null;
}

/** The injected host version, or null when the host never said. */
export function getHostVersion(): string | null {
  return hostVersion;
}
