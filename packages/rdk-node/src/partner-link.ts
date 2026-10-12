// packages/rdk-node/src/partner-link.ts
// Pairing this node with a partner app (`rdk link <code>`), RDK_PL_00A C1.
//
// The partner (ParlayLedger) mints a one-time pair code for a user whose
// RetroDeck account it is linked to. Redeeming it on Central, authenticated as
// this node, binds the node to that account and enables partner jobs for it.
// No RetroDeck credentials are involved: the pair code is the proof.
//
// Not to be confused with link-node.ts, which links a node to the account the
// user is signed in with (retrodeck-api `/nodes/link`).

import { loadConfig, updateConfig, type PartnerLinkConfig, type RDKConfig } from './config.js';
import { ensureManagedPartnerDir } from './ws/handlers/partner-job.js';

export interface PartnerLinkResponse {
  partnerId: string;
  partnerName: string;
  linkId: string;
  accountId: string;
  allowedJobTypes: string[];
}

/** A refusal from Central (`{ code, message }`) or a transport failure. */
export class PartnerLinkError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'PartnerLinkError';
  }
}

/** Uppercase, spaces and dashes removed: `k7q2-m9xd` → `K7Q2M9XD`. */
export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, '');
}

/** 8 Crockford base32 characters once normalized. */
export function isWellFormedPairCode(code: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalizePairCode(code));
}

async function nodeJwt(centralApiUrl: string, apiKey: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new PartnerLinkError('central_unreachable', `Could not reach RDK Central (${(e as Error).message}).`);
  }
  if (!res.ok) {
    throw new PartnerLinkError('node_auth_failed', `RDK Central did not accept this node's API key (HTTP ${res.status}).`, res.status);
  }
  const body = await res.json().catch(() => ({})) as { jwtToken?: string; token?: string };
  const jwt = body.jwtToken ?? body.token;
  if (!jwt) throw new PartnerLinkError('node_auth_failed', 'RDK Central returned no node token.');
  return jwt;
}

/** Central's `{ code, message }`, tolerating Nest's error envelope. */
async function readError(res: Response): Promise<PartnerLinkError> {
  const text = await res.text().catch(() => '');
  let code = `http_${res.status}`;
  let message = `RDK Central refused the pair code (HTTP ${res.status}).`;
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
    const c = body.code ?? body.error?.code;
    const m = body.message ?? body.error?.message;
    if (typeof c === 'string' && c) code = c;
    if (typeof m === 'string' && m) message = m;
    else if (Array.isArray(m) && m.length) message = m.join('; ');
  } catch {
    if (text.trim()) message = text.trim().slice(0, 300);
  }
  return new PartnerLinkError(code, message, res.status);
}

/** Redeem a pair code on Central as this node. */
export async function redeemPairCode(opts: {
  centralApiUrl: string;
  apiKey: string;
  pairCode: string;
}): Promise<PartnerLinkResponse> {
  const base = opts.centralApiUrl.replace(/\/+$/, '');
  const jwt = await nodeJwt(base, opts.apiKey);
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/nodes/partner-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode: normalizePairCode(opts.pairCode) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new PartnerLinkError('central_unreachable', `Could not reach RDK Central (${(e as Error).message}).`);
  }
  if (!res.ok) throw await readError(res);

  const body = await res.json().catch(() => null) as Partial<PartnerLinkResponse> | null;
  if (!body || typeof body.partnerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.partnerId)
    || typeof body.linkId !== 'string' || typeof body.accountId !== 'string') {
    throw new PartnerLinkError('invalid_response', 'RDK Central returned an unexpected pairing response.');
  }
  return {
    partnerId: body.partnerId,
    partnerName: typeof body.partnerName === 'string' && body.partnerName ? body.partnerName : body.partnerId,
    linkId: body.linkId,
    accountId: body.accountId,
    allowedJobTypes: Array.isArray(body.allowedJobTypes)
      ? body.allowedJobTypes.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

/**
 * Record a redeemed link in config (`partners.<id>`, and the account as
 * `retrodeckUserId`) and create the managed folder (mode 700).
 */
export function savePartnerLink(link: PartnerLinkResponse, now: Date = new Date()): PartnerLinkConfig {
  const config = loadConfig();
  const block: PartnerLinkConfig = {
    name: link.partnerName,
    linkId: link.linkId,
    enabled: true,
    allowedJobTypes: link.allowedJobTypes,
    linkedAt: now.toISOString(),
  };
  updateConfig({
    partners: { ...(config.partners ?? {}), [link.partnerId]: block },
    retrodeckUserId: link.accountId,
  });
  ensureManagedPartnerDir(link.partnerId);
  return block;
}

/** Enable or disable jobs for a linked partner. False when not linked. */
export function setPartnerEnabled(partnerId: string, enabled: boolean): boolean {
  const config = loadConfig();
  const current = config.partners?.[partnerId];
  if (!current || !Object.prototype.hasOwnProperty.call(config.partners, partnerId)) return false;
  updateConfig({ partners: { ...config.partners, [partnerId]: { ...current, enabled } } });
  return true;
}

/** Drop a partner's config block. False when not linked. */
export function removePartnerLink(partnerId: string): boolean {
  const config = loadConfig();
  if (!config.partners || !Object.prototype.hasOwnProperty.call(config.partners, partnerId)) return false;
  const { [partnerId]: _removed, ...rest } = config.partners;
  updateConfig({ partners: Object.keys(rest).length ? rest : undefined } as Partial<RDKConfig>);
  return true;
}
