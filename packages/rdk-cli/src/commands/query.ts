// packages/rdk-cli/src/commands/query.ts
//
// The canonical query — the SAME routing as the desktop app (RDKRouter):
//   1. your local vault first (private + your own public chunks) — always free,
//   2. then the public network (tips settle server-side via RetroDeck credits),
//   3. else an LLM-fallback signal.
// This replaces the network-only network:query as the default entry point, so
// the CLI and the desktop give the SAME answer (and the same cost) for the
// same question. Every hit is labeled: yours|network · local|private|public ·
// free|tip — a user is never charged or tipped for their own content.

import { loadConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { t } from '../theme.js';
import type { NetworkChunk, QueryResult } from '@rdk/core';
import type { SearchResult } from '@rdk/core';

export async function unifiedQuery(
  query: string,
  opts: { domain?: string; topK?: number },
): Promise<void> {
  const ora = (await import('ora')).default;
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return;

  const config = loadConfig();
  const spinner = ora(`Querying: "${query}"...`).start();

  try {
    const { LocalStore, LocalEmbeddingModel, RDKRouter, keyFromHex } = await import('@rdk/core');

    // Mirror the desktop's router construction exactly (parity by construction).
    const sharedVaultKeys = Object.fromEntries(
      Object.entries(config.sharedVaultKeys ?? {}).map(([nodeId, hex]) => [nodeId, keyFromHex(hex)]),
    );
    const router = new RDKRouter({
      localStore: new LocalStore(),
      embeddingModel: new LocalEmbeddingModel(),
      centralApiUrl: config.centralApiUrl,
      centralApiKey: config.apiKey,
      nodeId: config.nodeId,
      domain: opts.domain ?? config.domain,
      topK: opts.topK ?? 5,
      vaultKey: config.vaultKeyHex ? keyFromHex(config.vaultKeyHex) : undefined,
      sharedVaultKeys,
    });

    // Hold the Central WebSocket for the life of this command. Central fetches
    // chunk content from the OWNING node while answering, so without a live
    // socket even our own published chunks come back unavailable and get
    // skipped. Defers to `rdk mcp:serve` when that already owns the connection.
    const { withWsConnection } = await import('@rdk/node/ws/ownership');
    const result: QueryResult = await withWsConnection(() => router.query(query));
    spinner.stop();

    if (result.chunks.length === 0) {
      // Distinguish "nothing matched" from "we couldn't ask" — a credit gate, an
      // expired key or an unreachable Central used to print the same line as a
      // genuine miss, which made the failure invisible.
      if (result.networkError) {
        console.log(t.warn(`Couldn't search the network: ${result.networkError}`));
        console.log(t.dim('Nothing in your local vault matched either.'));
      } else if (result.networkMessage) {
        console.log(t.warn(result.networkMessage));
      } else {
        console.log(t.warn('No confident match in your vault or on the network — ask your LLM directly.'));
      }
      if (result.unavailableChunks?.length) {
        const reasons = [...new Set(result.unavailableChunks.map((c) => c.reason ?? 'unknown'))];
        console.log(t.dim(
          `${result.unavailableChunks.length} match(es) skipped — content could not be retrieved ` +
          `(${reasons.join(', ')}).`,
        ));
      }
      return;
    }

    const fromLocal = result.source === 'private'; // wire value; presented as "your vault"
    const headline = fromLocal ? 'your vault — free' : 'the network';
    console.log(t.heading(`\nResults from ${headline} for: "${query}"\n`));

    // Lead with what could NOT be retrieved, naming it. Burying this under five
    // loosely-related hits is how "I searched for the discord spec and got
    // telegram" happens — the answer existed, and the footnote explaining why it
    // was missing came after the wrong answers.
    if (result.unavailableChunks?.length) {
      const names = [...new Set(result.unavailableChunks.map(c => c.title.split(' — ')[0]))];
      const shown = names.slice(0, 3).join(', ');
      const more = names.length > 3 ? ` +${names.length - 3} more` : '';
      const reason = result.unavailableChunks[0].reason;
      console.log(t.warn(
        `${result.unavailableChunks.length} match(es) could not be retrieved: ${shown}${more}`,
      ));
      console.log(t.dim(
        reason === 'owner_offline'
          ? '  The node publishing them is not connected right now.\n'
          : `  Reason: ${reason ?? 'unknown'}.\n`,
      ));
    }

    if (result.lowConfidence) {
      console.log(t.warn(fromLocal
        ? 'Nothing matched confidently — showing the closest things in your vault.\n'
        : 'Loose matches — nothing scored as a strong match for this query.\n'));
    }

    result.chunks.forEach((chunk, i) => {
      const score = (((chunk as { score?: number }).score ?? 0) * 100).toFixed(1);
      let owner: string; let state: string; let cost: string;
      if (fromLocal) {
        const c = chunk as SearchResult;
        owner = 'yours';
        state = c.isPublic ? 'public' : c.isLocalOnly ? 'local' : 'private';
        cost = 'free';
      } else {
        const c = chunk as NetworkChunk;
        const own = c.isOwn === true || c.nodeId === config.nodeId;
        owner = own ? 'yours' : 'network';
        state = c.isEncrypted ? 'private' : 'public';
        cost = own || !(c.tipAmountUsdc > 0) ? 'free' : `tip $${c.tipAmountUsdc.toFixed(4)} USDC`;
      }
      console.log(
        t.bold(`[${i + 1}] ${(chunk as { title?: string }).title ?? 'Untitled'}`) +
        t.dim(`  (${score}% · ${owner} · ${state} · ${cost})`),
      );
      const content = ((chunk as { content?: string; summary?: string }).content
        ?? (chunk as { summary?: string }).summary ?? '').trim();
      if (content) console.log(t.body(content));
      console.log('');
    });

    if (result.tipsPaid.length > 0) {
      const total = result.tipsPaid.reduce((s, p) => s + p.amountUsdc, 0);
      console.log(t.dim(`tips: $${total.toFixed(4)} USDC across ${result.tipsPaid.length} chunk(s)`));
    }
    // Unretrievable matches are reported ABOVE the results, named — see there.
  } catch (e) {
    spinner.fail((e as Error).message);
    process.exitCode = 1;
  }
}
