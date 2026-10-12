// packages/rdk-core/src/partners.ts
// Where partner-managed documents live, and how everything else recognises them.
//
// A partner app (ParlayLedger) publishes documents to this node through partner
// jobs. Each one is a file under `<RDK_HOME>/partners/<partnerId>/`, written and
// indexed by the partner-job handler alone. Vault adapters and vault re-index
// must never pick these files up, duplicate them, or delete them: they normally
// sit under a dot-path (`~/.rdk`) that every scanner skips, but a vault rooted
// at or above `~/.rdk` would expose them, so the check is explicit.

import os from 'os';
import path from 'path';

/** `sourceAdapter` prefix for chunks a partner job indexed: `partner:<id>`. */
export const PARTNER_SOURCE_ADAPTER_PREFIX = 'partner:';

/** Partner ids are slugs; anything else is refused before it reaches a path. */
export const PARTNER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function rdkHome(): string {
  return process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk');
}

/** `<RDK_HOME>/partners`: the root of every partner's managed folder. */
export function partnerDocsRoot(): string {
  return path.resolve(rdkHome(), 'partners');
}

/** `<RDK_HOME>/partners/<partnerId>`. Throws on a non-slug id. */
export function partnerDocsDir(partnerId: string): string {
  if (!PARTNER_ID_PATTERN.test(partnerId)) throw new Error(`Invalid partner id: ${partnerId}`);
  return path.join(partnerDocsRoot(), partnerId);
}

/** True when `filePath` is inside the managed partner folder tree. */
export function isManagedPartnerPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const rel = path.relative(partnerDocsRoot(), path.resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True for chunks/documents a partner job indexed. */
export function isPartnerSourceAdapter(sourceAdapter: string | undefined | null): boolean {
  return !!sourceAdapter && sourceAdapter.startsWith(PARTNER_SOURCE_ADAPTER_PREFIX);
}
