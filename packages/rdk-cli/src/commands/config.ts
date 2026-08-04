// packages/rdk-cli/src/commands/config.ts
//
// User-facing settings only. Secrets — apiKey, vaultKeyHex, sharedVaultKeys,
// retrodeck tokens — are deliberately not reachable from here: they are owned by
// init / account:login / *:rotate, and reading them through a command would put
// them into shell history, CI logs and terminal scrollback.
//
// The allowlist is the security boundary. A generic "set any key" command would
// let a typo or a hostile prompt overwrite the node identity or the vault key.

import { loadConfig, updateConfig } from '../config.js';
import type { RDKConfig } from '../config.js';
import { t } from '../theme.js';

type Setting = {
  /** Field on RDKConfig this dotted key maps to. */
  field: keyof RDKConfig;
  type: 'boolean' | 'number' | 'string';
  describe: string;
  /** Reject values that are syntactically fine but wrong. */
  validate?: (v: unknown) => string | undefined;
};

const SETTINGS: Record<string, Setting> = {
  'query.autoRetrieve': {
    field: 'queryAutoRetrieve',
    type: 'boolean',
    describe: 'Let `rdk query` retrieve the best match without asking',
  },
  'query.maxTip': {
    field: 'queryMaxTipUsdc',
    type: 'number',
    describe: 'Ceiling in USDC on a tip settled without a human choosing',
    validate: (v) => (v as number) < 0 ? 'must not be negative' : undefined,
  },
  'domain': {
    field: 'domain',
    type: 'string',
    describe: 'Default domain filter for queries and indexing',
  },
  'autoSync': {
    field: 'autoSync',
    type: 'boolean',
    describe: 'Sync the vault to the network in the background',
  },
  'syncIntervalMinutes': {
    field: 'syncIntervalMinutes',
    type: 'number',
    describe: 'Minutes between background syncs',
    validate: (v) => (v as number) < 1 ? 'must be at least 1' : undefined,
  },
  'defaultVisibility': {
    field: 'defaultVisibility',
    type: 'string',
    describe: 'Visibility for new indexing: private or public',
    validate: (v) => v === 'private' || v === 'public' ? undefined : "must be 'private' or 'public'",
  },
};

function parse(raw: string, setting: Setting): { value: unknown } | { error: string } {
  if (setting.type === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return { value: true };
    if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return { value: false };
    return { error: 'expected true or false' };
  }
  if (setting.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: 'expected a number' };
    return { value: n };
  }
  return { value: raw };
}

function show(value: unknown): string {
  return value === undefined ? t.dim('(unset)') : String(value);
}

export async function showConfig(): Promise<void> {
  const config = loadConfig();
  console.log(t.heading('\n  Settings\n'));
  const width = Math.max(...Object.keys(SETTINGS).map(k => k.length));
  for (const [key, setting] of Object.entries(SETTINGS)) {
    console.log(`  ${key.padEnd(width)}  ${show(config[setting.field])}`);
    console.log(t.dim(`  ${' '.repeat(width)}  ${setting.describe}`));
  }
  console.log(t.dim('\n  Change one with: rdk config:set <key> <value>\n'));
}

export async function getConfigValue(key: string): Promise<void> {
  const setting = SETTINGS[key];
  if (!setting) {
    console.log(t.error(`Unknown setting "${key}".`));
    console.log(t.dim(`  Settable: ${Object.keys(SETTINGS).join(', ')}`));
    process.exitCode = 1;
    return;
  }
  console.log(show(loadConfig()[setting.field]));
}

export async function setConfigValue(key: string, raw: string): Promise<void> {
  const setting = SETTINGS[key];
  if (!setting) {
    console.log(t.error(`Unknown setting "${key}".`));
    console.log(t.dim(`  Settable: ${Object.keys(SETTINGS).join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const parsed = parse(raw, setting);
  if ('error' in parsed) {
    console.log(t.error(`${key}: ${parsed.error}, got "${raw}".`));
    process.exitCode = 1;
    return;
  }

  const invalid = setting.validate?.(parsed.value);
  if (invalid) {
    console.log(t.error(`${key}: ${invalid}.`));
    process.exitCode = 1;
    return;
  }

  updateConfig({ [setting.field]: parsed.value } as Partial<RDKConfig>);
  console.log(t.green(`  ${key} = ${String(parsed.value)}`));

  // Turning on unattended retrieval is authorising spend. Say so, and point at
  // the ceiling, rather than letting it become true silently in a config file.
  if (key === 'query.autoRetrieve' && parsed.value === true) {
    const ceiling = loadConfig().queryMaxTipUsdc;
    console.log(t.dim('  `rdk query` will now retrieve the best match without asking, settling any tip.'));
    console.log(ceiling === undefined
      ? t.warn('  No ceiling set — bound it with: rdk config:set query.maxTip 0.01')
      : t.dim(`  Tips above $${ceiling.toFixed(4)} USDC are still refused.`));
  }
}
