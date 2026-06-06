// packages/rdk-cli/src/commands/init.ts
import path from 'path';
import os from 'os';
import fs from 'fs';
import { saveConfig, ensureRDKDir, configExists, loadConfig } from '../config.js';
import { requireDeps } from '../require-dep.js';
import { input, password, confirm, select, pressEnter } from '../prompts.js';
import {
  splash, stepHeader, t, divider, importantValue,
  success, note, mark, summary, link,
} from '../theme.js';

const RETRODECK_API_URL = process.env.RETRODECK_API_URL ?? 'https://api.retrodeck.ai';

function resolveCentralApiUrl(): string {
  if (process.env.RDK_CENTRAL_URL) return process.env.RDK_CENTRAL_URL;
  if (process.env.RDK_API_URL) return process.env.RDK_API_URL;
  try {
    if (configExists()) return loadConfig().centralApiUrl;
  } catch {}
  return 'https://api.rdk.network';
}

const CENTRAL_API_URL = resolveCentralApiUrl();

type VaultAdapter = 'obsidian' | 'filesystem' | 'logseq' | 'notion';

const VAULT_DEFAULTS: Record<string, string> = {
  obsidian:   path.join(os.homedir(), 'Documents', 'ObsidianVault'),
  logseq:     path.join(os.homedir(), 'logseq'),
  notion:     '',
  filesystem: path.join(os.homedir(), 'Documents', 'rdk-vault'),
};

interface AuthResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
  emailVerified: boolean;
  isNewUser: boolean;
}

interface SetupOptions {
  email: string;
  displayName: string;
  domain: string;
  auth: AuthResult;
  plan: string;
  connectVault: boolean;
  vaultAdapter: VaultAdapter;
  vaultPath: string;
  createVault: boolean;
  enableMcp: boolean;
  walletAddress: string;
  walletChain: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    const walk = (d: string): number =>
      fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
        if (e.isDirectory()) return n + walk(path.join(d, e.name));
        return /\.(md|txt|mdx)$/.test(e.name) ? n + 1 : n;
      }, 0);
    return walk(dir);
  } catch { return 0; }
}

export async function runInit(nonInteractive?: {
  email?: string; domain?: string; vault?: string; path?: string;
}): Promise<void> {
  const ora = (await import('ora')).default;

  splash();

  if (nonInteractive?.email) {
    const spinner = ora('  Creating account...').start();
    try {
      const res = await fetch(`${RETRODECK_API_URL}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: nonInteractive.email,
          password: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
          displayName: nonInteractive.email.split('@')[0],
        }),
      });
      if (!res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        throw new Error(ct.includes('application/json') ? await res.text() : `HTTP ${res.status} from ${RETRODECK_API_URL} — set RETRODECK_API_URL env var`);
      }
      const data = await res.json() as { userId: string; accessToken: string; refreshToken: string };
      spinner.succeed('  Account created');
      await runFullSetup({
        email: nonInteractive.email,
        displayName: nonInteractive.email.split('@')[0],
        domain: nonInteractive.domain ?? 'general',
        auth: { ...data, emailVerified: false, isNewUser: true },
        plan: 'free',
        connectVault: true,
        vaultAdapter: (nonInteractive.vault ?? 'filesystem') as VaultAdapter,
        vaultPath: nonInteractive.path ?? VAULT_DEFAULTS['filesystem'],
        createVault: false,
        enableMcp: true,
        walletAddress: '',
        walletChain: 'base',
      });
    } catch (e) {
      spinner.fail(`  Account creation failed: ${(e as Error).message}`);
    }
    return;
  }

  // ── Step 1: Account ───────────────────────────────────────────────────────
  stepHeader(1, 6, 'Account');

  const email = await input({
    message: 'Email:',
    validate: v => (v.includes('@') && v.includes('.')) || 'Enter a valid email address',
  });

  const auth: AuthResult = {
    userId: '',
    accessToken: '',
    refreshToken: '',
    emailVerified: false,
    isNewUser: false,
  };

  let emailExists = false;
  try {
    const chkRes = await fetch(
      `${RETRODECK_API_URL}/api/v1/auth/check-email?email=${encodeURIComponent(email)}`,
    );
    if (chkRes.ok) {
      const chkData = await chkRes.json() as { exists: boolean };
      emailExists = chkData.exists;
    }
  } catch {}

  if (emailExists) {
    note('Account found — enter your password to log in.');
    console.log('');
    let attempts = 0;
    let loginOk = false;

    while (attempts < 3 && !loginOk) {
      const pw = await password({ message: 'Password:' });
      const spinner = ora('  Logging in...').start();
      try {
        const res = await fetch(`${RETRODECK_API_URL}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pw }),
        });
        if (!res.ok) {
          spinner.fail('  Invalid password.');
          attempts++;
          if (attempts < 3) note(`${3 - attempts} attempt(s) remaining.`);
          console.log('');
          continue;
        }
        const data = await res.json() as { accessToken: string; refreshToken: string };
        auth.accessToken = data.accessToken;
        auth.refreshToken = data.refreshToken;
        auth.isNewUser = false;
        spinner.succeed('  Logged in');
        loginOk = true;
        try {
          const meRes = await fetch(`${RETRODECK_API_URL}/api/v1/users/me`, {
            headers: { Authorization: `Bearer ${data.accessToken}` },
          });
          if (meRes.ok) {
            const me = await meRes.json() as { user: { id: string; emailVerified: boolean } };
            auth.userId = me.user.id;
            auth.emailVerified = me.user.emailVerified;
          }
        } catch {}
      } catch {
        spinner.fail('  Login failed — check your connection.');
        attempts++;
      }
    }

    if (!loginOk) {
      console.log(`\n  ${t.error('Too many failed attempts. Run rdk init again.')}\n`);
      process.exit(1);
    }
  } else {
    const pw = await password({
      message: 'Password:',
      validate: v => v.length >= 8 || 'Password must be at least 8 characters',
    });
    await password({
      message: 'Confirm password:',
      validate: v => v === pw || 'Passwords do not match',
    });

    const defaultName = email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '');
    let displayName = await input({
      message: 'Display name:',
      default: defaultName,
      validate: v => v.length >= 3 || 'Display name must be at least 3 characters',
    });

    try {
      const nameRes = await fetch(
        `${RETRODECK_API_URL}/api/v1/users/check-display-name?name=${encodeURIComponent(displayName)}`,
      );
      if (nameRes.ok) {
        const nameData = await nameRes.json() as { available: boolean; suggestion: string };
        if (!nameData.available) {
          note(`Name taken — using "${nameData.suggestion}" instead`);
          displayName = nameData.suggestion;
        }
      }
    } catch {}

    const spinner = ora('  Creating account...').start();
    try {
      const res = await fetch(`${RETRODECK_API_URL}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pw, displayName }),
      });
      if (!res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        const body = ct.includes('application/json')
          ? ((await res.json() as { message?: string }).message ?? `HTTP ${res.status}`)
          : `HTTP ${res.status} — server returned non-JSON (is RETRODECK_API_URL set correctly? got: ${(await res.text()).slice(0, 80)})`;
        throw new Error(body);
      }
      const data = await res.json() as { userId: string; accessToken: string; refreshToken: string };
      auth.userId = data.userId;
      auth.accessToken = data.accessToken;
      auth.refreshToken = data.refreshToken;
      auth.emailVerified = false;
      auth.isNewUser = true;
      spinner.succeed(`  Account created — verification email sent to ${email}`);
    } catch (e) {
      spinner.fail(`  Registration failed: ${(e as Error).message}`);
      if (RETRODECK_API_URL === 'https://api.retrodeck.ai') {
        console.error(t.dim('  Hint: production API is not deployed. Run with:'));
        console.error(t.dim('  RETRODECK_API_URL=http://localhost:3001 rdk init'));
      }
      process.exit(1);
    }
  }

  const domain = await select({
    message: 'Knowledge domain:',
    choices: [
      { name: 'Engineering / Dev', value: 'engineering' },
      { name: 'Fintech / Finance',  value: 'fintech' },
      { name: 'Legal',              value: 'legal' },
      { name: 'Healthcare',         value: 'healthcare' },
      { name: 'Marketing',          value: 'marketing' },
      { name: 'Education',          value: 'education' },
      { name: 'Research',           value: 'research' },
      { name: 'General',            value: 'general' },
    ],
    default: 'general',
  });

  let displayName = email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '');
  if (!auth.isNewUser && auth.accessToken) {
    try {
      const meRes = await fetch(`${RETRODECK_API_URL}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (meRes.ok) {
        const me = await meRes.json() as { user: { displayName: string } };
        displayName = me.user.displayName;
      }
    } catch {}
  }

  console.log(`\n  ${mark.ok()} ${t.body('Account ready')}`);

  // ── Step 2: Vault ─────────────────────────────────────────────────────────
  stepHeader(2, 6, 'Knowledge Vault');
  note('A vault is a folder of notes RDK can learn from.');
  note('Works with Obsidian, Logseq, or any .md file folder.');
  console.log('');

  const connectVault = await confirm({ message: 'Connect a vault?', default: true });

  let vaultAdapter: VaultAdapter = 'filesystem';
  let vaultPath = '';
  let createVault = false;

  if (connectVault) {
    vaultAdapter = await select<VaultAdapter>({
      message: 'Vault tool:',
      choices: [
        { name: 'Obsidian',                    value: 'obsidian' },
        { name: 'Plain folder (.md / .txt)',   value: 'filesystem' },
        { name: 'Logseq',                      value: 'logseq' },
        { name: 'Notion',                      value: 'notion' },
      ],
    });

    if (vaultAdapter !== 'notion') {
      const defaultPath = VAULT_DEFAULTS[vaultAdapter];
      const pathExists = defaultPath && fs.existsSync(defaultPath);
      const inputPath = await input({
        message: `Vault path:`,
        default: pathExists ? defaultPath : '',
      });
      if (!inputPath.trim()) {
        vaultPath = defaultPath || path.join(os.homedir(), 'Documents', 'rdk-vault');
        createVault = true;
      } else {
        vaultPath = inputPath.trim().replace(/^~/, os.homedir());
        createVault = !fs.existsSync(vaultPath);
      }
    }
  }

  // ── Step 3: Enable MCP ────────────────────────────────────────────────────
  stepHeader(3, 6, 'Enable MCP');
  note('MCP connects your vault to Claude Desktop so Claude can');
  note('query your knowledge directly (~50MB download, one-time).');
  console.log('');

  const enableMcp = await confirm({ message: 'Enable MCP?', default: true });

  // ── Step 4: Wallet ────────────────────────────────────────────────────────
  stepHeader(4, 6, 'Tip Wallet (optional)');
  note('When other agents retrieve your knowledge, they pay a small');
  note('USDC tip to your wallet automatically.');
  console.log('');

  let walletAddress = '';
  let walletChain = 'base';

  const addWallet = await confirm({ message: 'Add a wallet to receive tips?', default: false });
  if (addWallet) {
    const ora2 = (await import('ora')).default;
    for (let attempt = 0; attempt < 3; attempt++) {
      const addr = await input({
        message: 'Wallet address (0x...):',
        validate: v => {
          if (!v.startsWith('0x')) return 'Must start with 0x';
          if (v.length !== 42) return 'Must be 42 characters (0x + 40 hex)';
          if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return 'Invalid hex characters';
          return true;
        },
      });
      walletChain = await select({
        message: 'Chain:',
        choices: [
          { name: 'Base',     value: 'base',     hint: 'recommended — low fees' },
          { name: 'Ethereum', value: 'ethereum' },
          { name: 'Polygon',  value: 'polygon' },
        ],
        default: 'base',
      });
      const spinner = ora2('  Registering wallet...').start();
      try {
        const res = await fetch(`${RETRODECK_API_URL}/api/v1/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
          body: JSON.stringify({ address: addr, chain: walletChain }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        walletAddress = addr;
        spinner.succeed('  Wallet registered');
        break;
      } catch (e) {
        spinner.warn(`  Wallet registration failed: ${(e as Error).message}`);
        if (attempt === 2) note('Skipping wallet — add one later with: rdk tips:enable');
        else note('Try again or press Ctrl+C to skip.');
        console.log('');
      }
    }
  }

  // ── Step 5: Plan & Billing ────────────────────────────────────────────────
  stepHeader(5, 6, 'Plan');

  let plan = 'free';

  try {
    const ora3 = (await import('ora')).default;
    const plansRes = await fetch(`${RETRODECK_API_URL}/api/v1/plans`);
    if (plansRes.ok) {
      const plans = await plansRes.json() as Array<{
        id: string; name: string;
        price_monthly: number; max_queries_day: number; max_chunks: number;
      }>;

      if (plans.length > 0) {
        const pricingUrl = process.env.PRICING_URL ?? 'https://retrodeck.ai/#pricing';
        plan = await select({
          message: 'Choose a plan:',
          choices: plans.map(p => {
            const price = p.price_monthly === 0 ? 'Free' : `$${p.price_monthly}/mo`;
            const q = p.max_queries_day >= 1000 ? `${(p.max_queries_day / 1000).toFixed(0)}K` : String(p.max_queries_day);
            const c = p.max_chunks >= 1_000_000 ? `${(p.max_chunks / 1_000_000).toFixed(0)}M` : `${(p.max_chunks / 1000).toFixed(0)}K`;
            return {
              name: `${p.name.padEnd(12)} ${price}`,
              value: p.id,
              hint: `${q} queries/day, ${c} chunks`,
            };
          }),
          default: 'free',
          footer: `More info: ${pricingUrl}`,
        });

        if (plan !== 'free') {
          const interval = await select<'monthly' | 'yearly'>({
            message: 'Billing interval:',
            choices: [
              { name: 'Monthly', value: 'monthly' },
              { name: 'Yearly',  value: 'yearly', hint: 'save ~17%' },
            ],
            default: 'monthly',
          });

          const spinner = ora3('  Creating checkout session...').start();
          try {
            const selRes = await fetch(`${RETRODECK_API_URL}/api/v1/plans/select`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
              body: JSON.stringify({ planId: plan, interval }),
            });
            if (!selRes.ok) throw new Error(`HTTP ${selRes.status}`);
            const selData = await selRes.json() as { checkoutUrl: string | null };
            spinner.stop();

            if (selData.checkoutUrl) {
              console.log('');
              note('Open this link to complete payment:');
              console.log(`  ${link(selData.checkoutUrl)}`);
              console.log('');
              await pressEnter('Press Enter when payment is complete:');

              let paid = false;
              for (let i = 0; i < 10 && !paid; i++) {
                await sleep(3000);
                try {
                  const verRes = await fetch(`${RETRODECK_API_URL}/api/v1/plans/verify-payment`, {
                    headers: { Authorization: `Bearer ${auth.accessToken}` },
                  });
                  if (verRes.ok) {
                    const ver = await verRes.json() as { plan: { name: string }; paid: boolean };
                    if (ver.paid) {
                      success(`${ver.plan.name} plan activated`);
                      paid = true;
                    }
                  }
                } catch {}
              }
              if (!paid) {
                note('Payment not confirmed — continuing on Free plan');
                plan = 'free';
              }
            }
          } catch (e) {
            spinner.warn(`  Checkout failed: ${(e as Error).message}. Continuing on Free plan.`);
            plan = 'free';
          }
        } else {
          try {
            await fetch(`${RETRODECK_API_URL}/api/v1/plans/select`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
              body: JSON.stringify({ planId: 'free' }),
            });
          } catch {}
        }
      }
    }
  } catch {
    note('Could not load plans — continuing with Free plan.');
  }

  // ── Step 6: Credit Balance ────────────────────────────────────────────────
  stepHeader(6, 6, 'Query Credits');
  note('Credits fund your network queries. When your balance runs');
  note("low, you'll get an email alert.");
  console.log('');

  const creditChoice = await select({
    message: 'Set a credit limit (maximum you\'ll spend):',
    choices: [
      { name: '$5',   value: '5' },
      { name: '$20',  value: '20' },
      { name: '$50',  value: '50' },
      { name: '$100', value: '100' },
      { name: 'Other amount (whole dollars)', value: 'other' },
      { name: 'Skip for now', value: 'skip', hint: 'can query once you add credits' },
    ],
    default: 'skip',
  });

  if (creditChoice === 'skip') {
    try {
      await fetch(`${RETRODECK_API_URL}/api/v1/balances/set-limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
        body: JSON.stringify({ limitUsd: 0 }),
      });
    } catch {}
  } else {
    let creditAmount = 0;
    if (creditChoice === 'other') {
      const amtStr = await input({
        message: 'Enter amount ($):',
        validate: v => {
          const n = parseInt(v, 10);
          return (Number.isInteger(n) && n > 0) || 'Enter a whole number greater than 0';
        },
      });
      creditAmount = parseInt(amtStr, 10);
    } else {
      creditAmount = parseInt(creditChoice, 10);
    }

    try {
      await fetch(`${RETRODECK_API_URL}/api/v1/balances/set-limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
        body: JSON.stringify({ limitUsd: creditAmount }),
      });
    } catch {}

    console.log('');
    const payMethod = await select<'stripe' | 'cryptocadet'>({
      message: `Add $${creditAmount} credits via:`,
      choices: [
        { name: 'Credit card', value: 'stripe',     hint: 'Stripe' },
        { name: 'Crypto',      value: 'cryptocadet', hint: 'CryptoCadet' },
      ],
      default: 'stripe',
    });

    const ora4 = (await import('ora')).default;
    const topupSpinner = ora4('  Creating checkout session...').start();
    try {
      const topupRes = await fetch(`${RETRODECK_API_URL}/api/v1/balances/topup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
        body: JSON.stringify({ amountUsd: creditAmount, method: payMethod }),
      });
      if (!topupRes.ok) throw new Error(`HTTP ${topupRes.status}`);
      const topupData = await topupRes.json() as { checkoutUrl: string | null };
      topupSpinner.stop();

      if (topupData.checkoutUrl) {
        console.log('');
        note(payMethod === 'cryptocadet' ? 'Complete checkout at:' : 'Open this link to complete payment:');
        console.log(`  ${link(topupData.checkoutUrl)}`);
        console.log('');
        await pressEnter('Press Enter when payment is complete:');

        let topupOk = false;
        for (let i = 0; i < 10 && !topupOk; i++) {
          await sleep(3000);
          try {
            const verRes = await fetch(`${RETRODECK_API_URL}/api/v1/balances/verify-topup`, {
              headers: { Authorization: `Bearer ${auth.accessToken}` },
            });
            if (verRes.ok) {
              const ver = await verRes.json() as { completed: boolean };
              if (ver.completed) {
                success(`$${creditAmount} credits added`);
                topupOk = true;
              }
            }
          } catch {}
        }
        if (!topupOk) {
          note('Payment not confirmed — add credits later at retrodeck.ai/dashboard');
        }
      }
    } catch (e) {
      topupSpinner.warn(`  Could not start checkout: ${(e as Error).message}`);
    }

    console.log('');
    note('Set a low balance alert threshold.');
    note("You'll get an email when your balance drops below this amount.");
    note(`Must be less than your $${creditAmount} limit.`);
    console.log('');

    let alertThreshold = 0;
    for (;;) {
      const alertStr = await input({ message: 'Alert at ($0 = no alerts):', default: '0' });
      const alertVal = parseFloat(alertStr || '0');
      if (isNaN(alertVal) || alertVal < 0) {
        console.log(`  ${t.error('Enter a number >= 0')}`);
        continue;
      }
      if (alertVal >= creditAmount) {
        console.log(`  ${t.error(`Alert threshold must be less than your $${creditAmount} credit limit`)}`);
        continue;
      }
      alertThreshold = alertVal;
      break;
    }

    if (alertThreshold > 0) {
      try {
        await fetch(`${RETRODECK_API_URL}/api/v1/balances/set-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` },
          body: JSON.stringify({ thresholdUsd: alertThreshold }),
        });
      } catch {}
    }
  }

  await runFullSetup({
    email, displayName, domain, auth, plan,
    connectVault, vaultAdapter, vaultPath, createVault,
    enableMcp, walletAddress, walletChain,
  });
}

async function runFullSetup(opts: SetupOptions): Promise<void> {
  const ora = (await import('ora')).default;

  console.log('');
  console.log(`  ${divider(46)}`);
  console.log('');
  ensureRDKDir();

  let nodeId = `local-${Date.now()}`;
  let apiKey  = `rdk_local_${Math.random().toString(36).slice(2)}`;
  let rdkJwtToken = '';

  const regSpinner = ora('  Registering RDK node...').start();
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/v1/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: opts.email,
        displayName: opts.displayName,
        contributionDomain: opts.domain,
        walletAddress: opts.walletAddress || undefined,
        walletChain: opts.walletChain,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json() as { nodeId: string; apiKey: string };
    nodeId = data.nodeId;
    apiKey = data.apiKey;
    regSpinner.succeed('  RDK node registered');
  } catch (e) {
    regSpinner.fail(`  Node registration failed: ${(e as Error).message}`);
    regSpinner.warn(`  Tried: ${CENTRAL_API_URL} — set RDK_CENTRAL_URL to override`);
    regSpinner.warn('  Running in offline mode (vault search only, no network sync)');
  }

  importantValue('RDK API key:', apiKey);

  if (!nodeId.startsWith('local-')) {
    try {
      const authRes = await fetch(`${CENTRAL_API_URL}/api/v1/nodes/auth`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (authRes.ok) {
        const authData = await authRes.json() as { jwtToken: string };
        rdkJwtToken = authData.jwtToken;
      }
    } catch {}
  }

  if (opts.auth.userId && rdkJwtToken) {
    try {
      await fetch(`${CENTRAL_API_URL}/api/v1/nodes/${nodeId}/link-retrodeck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rdkJwtToken}` },
        body: JSON.stringify({ retrodeckUserId: opts.auth.userId }),
      });
    } catch {}
  }

  if (opts.auth.accessToken && !nodeId.startsWith('local-')) {
    try {
      await fetch(`${RETRODECK_API_URL}/api/v1/nodes/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.auth.accessToken}` },
        body: JSON.stringify({
          nodeId,
          apiKeyHint: apiKey.slice(0, 12),
          displayName: opts.displayName,
          domain: opts.domain,
        }),
      });
    } catch {}
  }

  saveConfig({
    nodeId,
    apiKey,
    centralApiUrl: CENTRAL_API_URL,
    retrodeckUserId: opts.auth.userId || undefined,
    retrodeckApiUrl: RETRODECK_API_URL,
    retrodeckAccessToken: opts.auth.accessToken || undefined,
    retrodeckRefreshToken: opts.auth.refreshToken || undefined,
    emailVerified: opts.auth.emailVerified ?? false,
    plan: opts.plan ?? 'free',
    vaultAdapter: opts.connectVault ? opts.vaultAdapter : 'filesystem',
    vaultPath: opts.vaultPath,
    domain: opts.domain,
    walletAddress: opts.walletAddress || undefined,
    walletChain: opts.walletChain,
    mcpPort: 4242,
    createdAt: new Date().toISOString(),
  });
  success('Config saved to ~/.rdk/config.json');

  if (opts.connectVault && opts.createVault && opts.vaultPath && opts.vaultAdapter !== 'notion') {
    fs.mkdirSync(opts.vaultPath, { recursive: true });
    fs.writeFileSync(path.join(opts.vaultPath, 'Welcome to RDK.md'), [
      '# Welcome to RDK',
      '',
      'This is your RDK knowledge vault.',
      'Add .md files here and run `rdk vault:index` to make them searchable.',
      '',
      `Created: ${new Date().toLocaleDateString()}`,
    ].join('\n'));
    success(`Vault created at ${opts.vaultPath}`);
  }

  let adapterReady = false;
  if (opts.connectVault) {
    console.log('');
    adapterReady = await requireDeps(
      [`@rdk/adapter-${opts.vaultAdapter}`],
      { label: `Vault adapter (${opts.vaultAdapter})` },
    );
  }

  let mcpReady = false;
  if (opts.enableMcp) {
    console.log('');
    mcpReady = await requireDeps(
      ['@xenova/transformers', '@modelcontextprotocol/sdk'],
      { label: 'MCP components' },
    );
  }

  if (adapterReady && opts.vaultPath && opts.vaultAdapter !== 'notion') {
    const fileCount = countFiles(opts.vaultPath);
    if (fileCount > 0) {
      const indexSpinner = ora(`  Indexing vault (${fileCount} files)...`).start();
      try {
        const adapterKey = `@rdk/adapter-${opts.vaultAdapter}`;
        const mod = await import(adapterKey);
        const adapter = new mod.default();
        await adapter.connect({ vaultPath: opts.vaultPath, domain: opts.domain });
        const result = await adapter.indexAll({ isPublic: true });
        indexSpinner.succeed(`  Indexed ${result.filesProcessed} files → ${result.chunksIndexed} chunks`);
      } catch (e) {
        indexSpinner.warn(`  Index skipped: ${(e as Error).message}`);
      }
    } else {
      note('Vault is empty — add .md files and run: rdk vault:index');
    }
  }

  summary([
    { label: 'Account',    value: `${opts.email} (${opts.plan} plan)`, done: true },
    { label: 'Vault',      value: opts.vaultAdapter,                    done: opts.connectVault },
    { label: 'MCP',        value: 'enabled',                            done: mcpReady },
    { label: 'Tip wallet', done: !!opts.walletAddress, action: 'tips:enable' },
  ]);

  if (mcpReady) {
    console.log(`  ${t.heading('Start the MCP server:')}`);
    console.log(`  ${t.green('rdk mcp:serve')}`);
    console.log('');
    note('Add to claude_desktop_config.json:');
    note('{ "mcpServers": { "rdk": {');
    note('  "command": "rdk", "args": ["mcp:serve"] } } }');
  }

  console.log('');
  console.log(`  ${t.dim('Manage your account:')} ${link('https://retrodeck.ai/dashboard')}`);
  console.log(`  ${divider(48)}\n`);
}
