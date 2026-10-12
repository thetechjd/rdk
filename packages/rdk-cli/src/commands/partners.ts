// packages/rdk-cli/src/commands/partners.ts
// `rdk link <code>` and `rdk partners ...`: pairing this node with a partner app
// such as ParlayLedger (SPEC 02 Phase 1, RDK_PL_00A C1).

import { loadConfigOrNull, partnerDisplayName } from '../config.js';
import { t } from '../theme.js';

const NEW_CODE_HINT = 'Get a new one from your ParlayLedger dashboard.';

/** User-facing text for Central's pairing refusals. Anything unmapped prints
 *  the platform's own message. */
export function pairErrorMessage(code: string, platformMessage: string): string {
  switch (code) {
    case 'pair_code_invalid': return `That code is not valid. ${NEW_CODE_HINT}`;
    case 'pair_code_expired': return `That code expired. ${NEW_CODE_HINT}`;
    case 'pair_code_used':    return `That code was already used. ${NEW_CODE_HINT}`;
    // SPEC 01 wording, verbatim from the platform (it names `rdk init --link`).
    case 'node_owned_by_other_account': return platformMessage;
    default: return platformMessage;
  }
}

export const LINK_SUCCESS_LINES = (partnerName: string): string[] => [
  `Linked to ${partnerName}.`,
  `Picks and strategies you publish on ${partnerName} will be saved to this node and shared on the RDK network.`,
  'Keep `rdk mcp:serve` running so your publications can be retrieved and you can earn.',
];

/**
 * Redeem a pair code for this node. Returns true on success; on failure prints
 * why, sets exit code 1 and returns false (callers such as `init --link` decide
 * whether to stop).
 */
export async function linkPartner(code: string): Promise<boolean> {
  const { isOfflineNode } = await import('@rdk/node/register-node');
  const config = loadConfigOrNull();
  if (!config || isOfflineNode(config) || config.nodeId === 'headless') {
    console.error(`No node found. Run: rdk init --link ${code}`);
    process.exitCode = 1;
    return false;
  }

  const { isWellFormedPairCode, redeemPairCode, savePartnerLink, PartnerLinkError } =
    await import('@rdk/node/partner-link');
  if (!isWellFormedPairCode(code)) {
    console.error(pairErrorMessage('pair_code_invalid', ''));
    process.exitCode = 1;
    return false;
  }

  try {
    const link = await redeemPairCode({ centralApiUrl: config.centralApiUrl, apiKey: config.apiKey, pairCode: code });
    savePartnerLink(link);
    for (const line of LINK_SUCCESS_LINES(link.partnerName)) console.log(line);
    return true;
  } catch (e) {
    const message = e instanceof PartnerLinkError
      ? pairErrorMessage(e.code, e.message)
      : (e as Error).message;
    console.error(message);
    process.exitCode = 1;
    return false;
  }
}

/** `rdk partners`: linked partners with status, linked date and doc count. */
export async function partnersList(): Promise<void> {
  const { listManagedRefs } = await import('@rdk/node/ws/handlers/partner-job');
  const config = loadConfigOrNull();
  const partners = Object.entries(config?.partners ?? {});
  if (partners.length === 0) {
    console.log('No partner apps linked. Link one with: rdk link <code>');
    return;
  }
  console.log('');
  for (const [id, p] of partners) {
    const status = p.enabled ? t.green('enabled') : t.warn('disabled');
    const docs = listManagedRefs(id).length;
    const linked = (p.linkedAt ?? '').slice(0, 10) || 'unknown';
    console.log(`  ${t.bold(p.name || partnerDisplayName(id, config))} ${t.dim(`(${id})`)}`);
    console.log(`    Status:   ${status}`);
    console.log(`    Linked:   ${linked}`);
    console.log(`    Docs:     ${docs} managed document${docs === 1 ? '' : 's'}`);
    console.log('');
  }
}

/** `rdk partners enable|disable <id>`. Documents are untouched either way. */
export async function partnersSetEnabled(partnerId: string, enabled: boolean): Promise<void> {
  const { setPartnerEnabled } = await import('@rdk/node/partner-link');
  const config = loadConfigOrNull();
  if (!config) {
    console.error('No node found. Run: rdk init');
    process.exitCode = 1;
    return;
  }
  if (!setPartnerEnabled(partnerId, enabled)) {
    console.error(`${partnerId} is not linked to this node. See: rdk partners`);
    process.exitCode = 1;
    return;
  }
  const name = partnerDisplayName(partnerId, config);
  console.log(enabled
    ? `${name} jobs enabled on this node.`
    : `${name} jobs disabled on this node. Published documents stay; new jobs are refused until you run: rdk partners enable ${partnerId}`);
}

/**
 * `rdk partners remove <id> [--delete-docs]`. Without --delete-docs the files
 * and their network chunks stay; only the link block goes. With it, every
 * managed document is unpublished and deleted first.
 */
export async function partnersRemove(partnerId: string, opts: { deleteDocs?: boolean } = {}): Promise<void> {
  const { removePartnerLink } = await import('@rdk/node/partner-link');
  const config = loadConfigOrNull();
  if (!config?.partners || !Object.prototype.hasOwnProperty.call(config.partners, partnerId)) {
    console.error(`${partnerId} is not linked to this node. See: rdk partners`);
    process.exitCode = 1;
    return;
  }
  const name = partnerDisplayName(partnerId, config);

  if (opts.deleteDocs) {
    const { listManagedRefs, removeManagedDocument, managedPartnerDir } =
      await import('@rdk/node/ws/handlers/partner-job');
    const refs = listManagedRefs(partnerId);
    let removed = 0;
    for (const ref of refs) {
      try {
        await removeManagedDocument(partnerId, ref);
        removed++;
      } catch (e) {
        console.error(`Could not remove ${ref}: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }
    try {
      const fs = await import('fs');
      fs.rmSync(managedPartnerDir(partnerId), { recursive: true, force: true });
    } catch { /* folder already gone */ }
    console.log(`Unpublished and deleted ${removed} ${name} document${removed === 1 ? '' : 's'}.`);
  }

  removePartnerLink(partnerId);
  console.log(opts.deleteDocs
    ? `${name} removed from this node.`
    : `${name} removed from this node. Its documents stay on this node and on the network.`);
}
