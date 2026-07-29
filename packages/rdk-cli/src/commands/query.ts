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
//
// A successful query returns DOCUMENTS, not chunks. Nobody asks a question
// about a chunk, and five fragments of one spec are one answer, not five.
// Network documents are saved into the vault so the answer survives the command
// that fetched it — see @rdk/node/save-retrieved.

import { loadConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { t } from '../theme.js';
import type { NetworkChunk, QueryResult, RetrievedDocument } from '@rdk/core';
import type { SearchResult } from '@rdk/core';

export async function unifiedQuery(
  query: string,
  opts: { domain?: string; topK?: number; save?: boolean },
): Promise<void> {
  const ora = (await import('ora')).default;
  const ready = await requireDeps(['@xenova/transformers'], { label: 'Embedding model' });
  if (!ready) return;

  const config = loadConfig();
  const spinner = ora(`Querying: "${query}"...`).start();

  try {
    const { LocalStore, LocalEmbeddingModel, RDKRouter, keyFromHex, groupIntoDocuments } =
      await import('@rdk/core');
    const localStore = new LocalStore();
    const embeddingModel = new LocalEmbeddingModel();

    // Mirror the desktop's router construction exactly (parity by construction).
    const sharedVaultKeys = Object.fromEntries(
      Object.entries(config.sharedVaultKeys ?? {}).map(([nodeId, hex]) => [nodeId, keyFromHex(hex)]),
    );
    const router = new RDKRouter({
      localStore,
      embeddingModel,
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
      reportUnavailable(result);
      return;
    }

    const fromLocal = result.source === 'private'; // wire value; presented as "your vault"

    // Lead with what could NOT be retrieved, naming it. Burying this under five
    // loosely-related hits is how "I searched for the discord spec and got
    // telegram" happens — the answer existed, and the footnote explaining why it
    // was missing came after the wrong answers.
    if (fromLocal) {
      printLocal(result, query, config.nodeId);
      return;
    }

    const documents = groupIntoDocuments(result.chunks as NetworkChunk[]);
    if (documents.length === 0) { reportUnavailable(result); printLocal(result, query, config.nodeId); return; }

    // Report only what we could NOT answer with. Naming a document as
    // unretrievable and then printing it — which happened whenever some of its
    // sections were served and some weren't — reads as a straight contradiction.
    reportUnavailable(result, new Set(documents.filter(d => d.contentAvailable).map(d => d.name)));

    if (result.lowConfidence) {
      console.log(t.warn('Loose matches — nothing scored as a strong match for this query.\n'));
    }

    const saved = opts.save === false
      ? documents.map(() => undefined)
      : await saveDocuments(documents, query, config, localStore, embeddingModel);

    if (documents.length === 1) {
      // One document matched — that IS the answer. Print it, don't ask.
      printDocument(documents[0], query, saved[0]);
    } else {
      // Several documents matched. Show what each one is and where it went,
      // rather than interleaving their sections into an unreadable stream.
      console.log(t.heading(`\n${documents.length} documents matched "${query}"\n`));
      documents.forEach((doc, i) => {
        console.log(
          t.bold(`[${i + 1}] ${doc.name}`) +
          t.dim(`  (${(doc.score * 100).toFixed(0)}% · ${doc.sections.length} section(s) · ` +
            `${doc.isOwn ? 'yours · free' : doc.tipUsdc > 0 ? `tip $${doc.tipUsdc.toFixed(4)}` : 'free'}` +
            `${doc.contentAvailable ? '' : ' · summary only'})`),
        );
        const best = [...doc.sections].sort((a, b) => b.score - a.score)[0];
        const lead = best?.content.trim().split('\n').find(l => l.trim() && !l.startsWith('#'));
        if (lead) console.log(t.body(`    ${lead.slice(0, 160)}${lead.length > 160 ? '…' : ''}`));
        if (saved[i]) console.log(t.dim(`    saved → ${saved[i]}`));
        console.log('');
      });
      const savedCount = saved.filter(Boolean).length;
      if (savedCount > 0) {
        const allSummaries = documents.every(d => !d.contentAvailable);
        console.log(t.dim(allSummaries
          ? `Open any of the ${savedCount} saved file(s) to read what was returned.`
          : `Open any of the ${savedCount} saved file(s) to read the whole document.`));
      }
    }

    if (result.tipsPaid.length > 0) {
      const total = result.tipsPaid.reduce((s, p) => s + p.amountUsdc, 0);
      console.log(t.dim(`\ntips: $${total.toFixed(4)} USDC across ${result.tipsPaid.length} chunk(s)`));
    }
  } catch (e) {
    spinner.fail((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Save each retrieved document into the vault and index it for local search.
 *
 * Best-effort by design: a vault that isn't configured, or a disk that won't
 * take the write, must not turn a successful, already-paid-for query into a
 * failure. The content is printed either way.
 */
async function saveDocuments(
  documents: RetrievedDocument[],
  query: string,
  config: { vaultPath?: string; nodeId?: string },
  localStore: import('@rdk/core').LocalStore,
  embeddingModel: import('@rdk/core').EmbeddingModel,
): Promise<(string | undefined)[]> {
  if (!config.vaultPath) return documents.map(() => undefined);

  const { saveRetrievedDocument } = await import('@rdk/node/save-retrieved');
  const { RDKIndexer } = await import('@rdk/core');
  const indexer = new RDKIndexer({ localStore, embeddingModel });
  const paths: (string | undefined)[] = [];

  for (const doc of documents) {
    // Own content is already in the vault — re-saving it would create a second
    // copy of a file the user wrote.
    if (doc.isOwn || doc.originNodeId === config.nodeId) { paths.push(undefined); continue; }
    try {
      const { filePath, unchanged, summaryOnly } = saveRetrievedDocument(
        doc, { vaultPath: config.vaultPath, query },
      );
      paths.push(filePath);
      // Index LOCAL-ONLY so the next query for this answers from disk, free and
      // instantly, without republishing someone else's work to the network.
      // `derivedFrom` survives the eventual edit that makes it the user's own.
      //
      // Summaries are written but never indexed: in the index a summary answers
      // future queries in place of the real document and permanently shadows it.
      if (!unchanged && !summaryOnly) {
        await indexer.indexDocument({
          content: sectionsAsMarkdown(doc),
          title: doc.name,
          docTitle: doc.name,
          sourcePath: filePath,
          sourceAdapter: 'retrieved',
          domain: doc.domain,
          isPublic: false,
          localOnly: true,
          derivedFrom: doc.sections[0]?.chunkId,
        });
      }
    } catch {
      paths.push(undefined);
    }
  }
  return paths;
}

/** The document body without its provenance frontmatter — what gets indexed. */
function sectionsAsMarkdown(doc: RetrievedDocument): string {
  const out = [`# ${doc.name}`, ''];
  for (const s of doc.sections) {
    if (s.heading && s.heading !== doc.name) out.push(`## ${s.heading}`, '');
    out.push(s.content.trim(), '');
  }
  return out.join('\n');
}

function printDocument(doc: RetrievedDocument, query: string, savedPath?: string): void {
  if (!doc.contentAvailable) {
    console.log(t.warn(`\nOnly a summary of "${doc.name}" is available — ` +
      `the node publishing it isn't serving content right now.`));
  }
  const cost = doc.isOwn ? 'yours · free' : doc.tipUsdc > 0 ? `tip $${doc.tipUsdc.toFixed(4)} USDC` : 'free';
  console.log(t.heading(`\n${doc.name}`));
  console.log(t.dim(`${(doc.score * 100).toFixed(0)}% match for "${query}" · ${doc.sections.length} section(s) · ` +
    `${doc.isOwn ? 'your vault' : `node ${doc.originNodeId.slice(0, 10)}`} · ${cost}\n`));

  for (const section of doc.sections) {
    if (section.heading && section.heading !== doc.name) console.log(t.bold(`## ${section.heading}`));
    console.log(t.body(section.content.trim()));
    console.log('');
  }

  if (savedPath) console.log(t.dim(`saved → ${savedPath}`));
}

/** The local-vault path: these are the user's own files, already on disk. */
function printLocal(result: QueryResult, query: string, nodeId?: string): void {
  console.log(t.heading(`\nResults from your vault — free — for: "${query}"\n`));
  if (result.lowConfidence) {
    console.log(t.warn('Nothing matched confidently — showing the closest things in your vault.\n'));
  }
  result.chunks.forEach((chunk, i) => {
    const c = chunk as SearchResult & NetworkChunk;
    const score = ((c.score ?? 0) * 100).toFixed(1);
    const state = c.isPublic ? 'public' : c.isLocalOnly ? 'local' : 'private';
    console.log(t.bold(`[${i + 1}] ${c.title ?? 'Untitled'}`) + t.dim(`  (${score}% · yours · ${state} · free)`));
    if (c.sourcePath) console.log(t.dim(`    ${c.sourcePath}`));
    const body = (c.content ?? c.summary ?? '').trim();
    if (body) console.log(t.body(body));
    console.log('');
  });
  void nodeId;
}

function reportUnavailable(result: QueryResult, answered = new Set<string>()): void {
  if (!result.unavailableChunks?.length) return;
  const names = [...new Set(result.unavailableChunks.map(c => c.title.split(' — ')[0]))]
    .filter(n => !answered.has(n));
  if (names.length === 0) return;
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3} more` : '';
  const reason = result.unavailableChunks[0].reason;
  console.log(t.warn(`${names.length} document(s) could not be retrieved: ${shown}${more}`));
  console.log(t.dim(
    reason === 'owner_offline'
      ? '  The node publishing them is not connected right now.\n'
      : `  Reason: ${reason ?? 'unknown'}.\n`,
  ));
}
