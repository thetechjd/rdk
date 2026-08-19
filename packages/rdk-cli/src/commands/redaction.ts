// packages/rdk-cli/src/commands/redaction.ts
//
// What the org's model-facing redaction policy is doing on THIS node.
//
// Two audiences. A member wants to know what a model sees when it queries their
// node - so `--test` shows exactly that, on text they supply, using the policy
// actually in force rather than a server-side approximation. An admin wants to
// confirm a policy change reached the fleet, and this is the node-side half of
// that answer.
//
// This command never prints a token map. Resolving a token back to a value is
// something a human does by opening the source document, which they can already
// read in full - printing the mapping here would put the sensitive values in
// shell history for no gain.

import { Redactor, getActiveRedactionPolicy } from '@rdk/core';
import { refreshRedactionPolicy, redactionStatus } from '@rdk/node';
import { t, divider, kv } from '../theme.js';

export async function redactionStatusCommand(opts: { test?: string; json?: boolean } = {}): Promise<void> {
  await refreshRedactionPolicy(() => {});
  const status = redactionStatus();
  const policy = getActiveRedactionPolicy();

  const byType = policy.rules
    .filter((rule) => rule.enabled !== false)
    .reduce<Record<string, number>>((counts, rule) => {
      counts[rule.ruleType] = (counts[rule.ruleType] ?? 0) + 1;
      return counts;
    }, {});

  const preview = opts.test !== undefined
    ? new Redactor(policy).redact(opts.test)
    : undefined;

  if (opts.json) {
    console.log(JSON.stringify({
      enabled: status.enabled,
      version: status.version,
      ruleCount: status.ruleCount,
      rulesByType: byType,
      orgs: status.orgs,
      fetchedAt: status.fetchedAt,
      ...(preview ? { test: { input: opts.test, output: preview.content, redacted: preview.redacted } } : {}),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(t.heading('  Model-facing redaction'));
  console.log(divider(46));
  console.log('');

  if (!status.enabled) {
    console.log(t.dim('  No org redaction policy applies to this node.'));
    console.log(t.dim('  Content is served to models exactly as it is stored.'));
    console.log('');
    if (preview) printPreview(opts.test!, preview.content, preview.redacted);
    return;
  }

  kv('Status', t.green('enforced on every model-facing query'));
  kv('Policy', status.version ?? 'unknown');
  kv('Rules', `${status.ruleCount} active` + (
    Object.keys(byType).length > 0
      ? ` (${Object.entries(byType).map(([type, count]) => `${count} ${type}`).join(', ')})`
      : ''
  ));
  if (status.orgs.length > 0) {
    kv('From', status.orgs.map((org) => org.name ?? org.id).join(', '));
  }
  kv('Last synced', status.fetchedAt ? new Date(status.fetchedAt).toLocaleString() : 'never');
  console.log('');
  console.log(t.dim('  Your own reads are unaffected — the dashboard, the desktop app and'));
  console.log(t.dim('  rdk vault:search all return the full document. Redaction applies only'));
  console.log(t.dim('  where content would enter a model\'s context.'));
  console.log('');

  if (preview) printPreview(opts.test!, preview.content, preview.redacted);
}

function printPreview(input: string, output: string, redacted: boolean): void {
  console.log(t.heading('  What a model would receive'));
  console.log('');
  console.log(t.dim('  in : ') + t.body(input));
  console.log(t.dim('  out: ') + (redacted ? t.warn(output) : t.body(output)));
  console.log('');
  if (!redacted) console.log(t.dim('  Nothing in that text matched a rule.'));
  console.log('');
}
