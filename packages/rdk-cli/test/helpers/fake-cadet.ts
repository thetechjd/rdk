import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A fake `cryptocadet` executable placed on `PATH`.
 *
 * `src/commands/cryptocadet.ts` shells out to the real binary, which holds the
 * user's agent wallet and signs on-chain payments. Tests must never invoke it,
 * but the interesting behaviour lives in how RDK *interprets* its output — so we
 * mock at the process boundary rather than mocking our own module.
 *
 * The contract this fake implements is the real CLI's, including its two
 * counter-intuitive rules:
 *
 *  1. **Business failures exit 0.** `ESCALATE`, `REFUSED`, `FAILED` and
 *     `DUPLICATE` are all exit code 0 with the status on stdout JSON. Only a
 *     thrown error (bad flags, unreadable quote) exits 1 with an empty stdout.
 *     Code that branches on the exit code is wrong and these scenarios catch it.
 *  2. **`ESCALATE` is the default for realistic amounts.** The shipped policy's
 *     `requireHumanAboveTx` is 0.50 USDC, so any normal top-up needs `--approve`.
 */
export type CadetScenario =
  | 'confirmed'
  | 'pending'
  | 'duplicate'
  | 'escalate'
  | 'refused'
  | 'cap-refused'       // per-tx cap: REFUSED, not ESCALATE — clears once raised
  | 'grant-escalate'    // subs:grant needs human approval
  | 'grant-cap-refused' // subs:grant blocked by the per-tx cap
  | 'failed'
  | 'missing'; // nothing on PATH at all

export interface CadetCall {
  argv: string[];
  cwd: string;
}

export interface FakeCadet {
  dir: string;
  home: string;
  /** Every invocation, in order, so ordering and arguments can be asserted. */
  calls(): CadetCall[];
  /** Arguments of the first invocation whose verb matches. */
  callsTo(verb: string): CadetCall[];
  cleanup(): void;
}

const FAKE_SOURCE = String.raw`
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const verb = argv[0] ?? '';
const scenario = process.env.FAKE_CADET_SCENARIO ?? 'confirmed';
const home = process.env.CRYPTOCADET_HOME;
const log = process.env.FAKE_CADET_LOG;

if (log) {
  fs.appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
}

const out = (o) => { process.stdout.write(JSON.stringify(o, null, 2)); };

// --version is probed by cadetVersion(); must satisfy MIN_CRYPTOCADET (0.2.1).
if (verb === '--version' || verb === '-v') {
  out({ version: process.env.FAKE_CADET_VERSION ?? '0.2.1' });
  process.exit(0);
}

// policy:show doubles as the "is the binary present?" probe on POSIX.
if (verb === 'policy:show') {
  if (!home || !fs.existsSync(path.join(home, 'policy.json'))) {
    // The real CLI throws when uninitialized: message on stderr, exit 1.
    process.stderr.write('error: not initialized\n');
    process.exit(1);
  }
  out(JSON.parse(fs.readFileSync(path.join(home, 'policy.json'), 'utf8')));
  process.exit(0);
}

if (verb === 'init') {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    serverBaseUrl: 'http://127.0.0.1:14000',
    chainId: 84532,
  }, null, 2));
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({
    version: 1,
    chainId: 84532,
    allowlist: { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6, feeOnTransfer: false } },
    recipients: [],
    requireHumanAboveTx: { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': '500000' },
  }, null, 2));
  if (argv.includes('--json')) {
    out({
      fresh: true, role: 'buyer', network: 'base-sepolia', chainId: 84532,
      agentAddress: process.env.FAKE_CADET_AGENT ?? '0x1111111111111111111111111111111111111111',
      keychainBackend: 'memory', keychainAvailable: true,
    });
  }
  process.exit(0);
}

// Funding is a human action: the user sends USDC, THEN confirms. We model that
// with a marker written by topup:request, so an initially-underfunded wallet
// becomes funded on the next read. Without it, ensureFunded's unbounded
// for(;;) loop spins forever against a permanently-zero balance.
// (No backticks in this string -- it lives inside a String.raw template.)
const fundedMarker = home ? path.join(home, '.funded') : null;
const isFunded = () => fundedMarker && fs.existsSync(fundedMarker);

if (verb === 'wallet:show') {
  const funded = process.env.FAKE_CADET_BALANCE ?? '100000000';
  const initial = process.env.FAKE_CADET_SPENDABLE ?? funded;
  const amount = isFunded() ? funded : initial;
  out({
    agentAddress: process.env.FAKE_CADET_AGENT ?? '0x1111111111111111111111111111111111111111',
    chainId: 84532,
    tokens: [{
      token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      symbol: 'USDC',
      balance: amount,
      reserve: '0',
      spendable: amount,
    }],
  });
  process.exit(0);
}

if (verb === 'topup:request') {
  if (fundedMarker) fs.writeFileSync(fundedMarker, '1');
  out({
    agentAddress: process.env.FAKE_CADET_AGENT ?? '0x1111111111111111111111111111111111111111',
    lines: [],
    needsTopup: false,
    note: 'fake',
  });
  process.exit(0);
}

// A raised per-tx cap persists, like the real policy file — so the retry after
// policy:set succeeds where the first attempt was refused.
const capMarker = home ? path.join(home, '.cap-raised') : null;
const capRaised = () => capMarker && fs.existsSync(capMarker);

if (verb === 'policy:set') {
  const need = ['--kind', '--token'].filter((f) => !argv.includes(f));
  if (need.length) { process.stderr.write('error: missing ' + need.join(',') + '\n'); process.exit(1); }
  if (capMarker) fs.writeFileSync(capMarker, '1');
  out({ kind: argv[argv.indexOf('--kind') + 1], ok: true });
  process.exit(0);
}

if (verb === 'checkout') {
  const approved = argv.includes('--approve') || argv.includes('--yes');
  const quoteId = 'quote_fake_1';
  // ESCALATE flips to CONFIRMED once the human approves — mirroring the real gate.
  let effective = scenario === 'escalate' && approved ? 'confirmed' : scenario;
  // A per-tx cap REFUSES rather than escalating, and clears once raised.
  if (effective === 'cap-refused' && capRaised()) effective = 'confirmed';
  switch (effective) {
    case 'confirmed': out({ status: 'CONFIRMED', quoteId, txHash: '0x' + 'ab'.repeat(32) }); break;
    case 'pending':   out({ status: 'PENDING',   quoteId, txHash: '0x' + 'cd'.repeat(32) }); break;
    case 'duplicate': out({ status: 'DUPLICATE', quoteId, row: { quote_id: quoteId, status: 'CONFIRMED' } }); break;
    case 'escalate':  out({ status: 'ESCALATE',  quoteId, reason: 'above human-confirm threshold' }); break;
    case 'refused':   out({ status: 'REFUSED',   quoteId, reason: 'recipient not allowlisted 0xdead' }); break;
    case 'cap-refused': out({ status: 'REFUSED', quoteId, reason: 'perTx cap exceeded: limit 1.000000 USDC' }); break;
    default:          out({ status: 'FAILED',    quoteId, reason: 'broadcast failed: insufficient funds for gas' });
  }
  process.exit(0); // ALWAYS 0 — business outcome is on stdout, not the exit code.
}

if (verb === 'subs:grant') {
  const need = ['--token', '--collector', '--cap'].filter((f) => !argv.includes(f));
  if (need.length) { process.stderr.write('error: missing ' + need.join(',') + '\n'); process.exit(1); }
  const approved = argv.includes('--approve') || argv.includes('--yes');
  // The approval runs through the same policy gate as a payment, so it reports
  // business outcomes on stdout with exit 0 exactly like checkout does.
  if (scenario === 'grant-escalate' && !approved) {
    out({ status: 'ESCALATE', reason: 'above human-confirm threshold' });
    process.exit(0);
  }
  if (scenario === 'grant-cap-refused') {
    out({ status: 'REFUSED', reason: 'perTx cap exceeded: limit 1.000000 USDC' });
    process.exit(0);
  }
  if (scenario === 'failed' || scenario === 'refused') {
    process.stderr.write('error: token not allowlisted\n');
    process.exit(1);
  }
  out({
    token: argv[argv.indexOf('--token') + 1],
    collector: argv[argv.indexOf('--collector') + 1],
    cap: argv[argv.indexOf('--cap') + 1],
    txHash: '0x' + 'ef'.repeat(32),
  });
  process.exit(0);
}

process.stderr.write('error: unknown verb ' + verb + '\n');
process.exit(1);
`;

const CADET_BINARIES = ['cryptocadet', 'ccx', 'cryptocadet.cmd', 'ccx.cmd', 'cryptocadet.exe'];

/**
 * Drop every PATH entry that already contains a real CryptoCadet binary.
 *
 * Developers working on this integration usually have `@cryptocadet/cli`
 * installed globally (`~/.local/bin/cryptocadet`, Homebrew, npm -g). Without this,
 * the `missing` scenario silently finds the REAL binary, the test passes for the
 * wrong reason locally, and — far worse — a test meant to run offline could reach
 * a live wallet. Tests must behave identically on a clean CI runner and a
 * developer laptop.
 */
function pathWithoutRealCadet(): string {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => {
      if (!dir) return false;
      return !CADET_BINARIES.some((bin) => {
        try {
          return fs.existsSync(path.join(dir, bin));
        } catch {
          return false;
        }
      });
    })
    .join(path.delimiter);
}

export interface InstallFakeCadetOptions {
  scenario?: CadetScenario;
  /** Pre-create config.json/policy.json so `ensureInitialized()` short-circuits. */
  initialized?: boolean;
  version?: string;
  agentAddress?: string;
  /** Spendable USDC in base units, as `wallet:show` reports it. */
  spendable?: string;
}

/**
 * Install the fake on `PATH` and point `CRYPTOCADET_HOME` at a temp dir.
 *
 * Caller must have set `CRYPTOCADET_HOME` before importing the module under test
 * (see `test/setup.ts`) — this function reuses that value so the module-level
 * const in `cryptocadet.ts` stays consistent with what the fake writes.
 */
export function installFakeCadet(opts: InstallFakeCadetOptions = {}): FakeCadet {
  const scenario = opts.scenario ?? 'confirmed';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cadet-bin-'));
  const home = process.env.CRYPTOCADET_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cadet-home-'));
  const logPath = path.join(dir, 'calls.jsonl');
  const originalPath = process.env.PATH ?? '';

  fs.writeFileSync(logPath, '');
  // Always scrub first, so a globally-installed CryptoCadet can never be reached.
  process.env.PATH = pathWithoutRealCadet();
  process.env.CRYPTOCADET_HOME = home;
  process.env.FAKE_CADET_LOG = logPath;
  process.env.FAKE_CADET_SCENARIO = scenario;
  if (opts.version) process.env.FAKE_CADET_VERSION = opts.version;
  if (opts.agentAddress) process.env.FAKE_CADET_AGENT = opts.agentAddress;
  if (opts.spendable) process.env.FAKE_CADET_SPENDABLE = opts.spendable;

  if (scenario !== 'missing') {
    const script = path.join(dir, 'fake-cadet.mjs');
    fs.writeFileSync(script, FAKE_SOURCE);

    // POSIX shim. `findBin()` probes with spawnSync and treats any non-ENOENT
    // result as "found", so this must be executable.
    fs.writeFileSync(path.join(dir, 'cryptocadet'), `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'ccx'), `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });

    // Windows: `findBin()` uses `where`, which only resolves PATHEXT entries.
    fs.writeFileSync(path.join(dir, 'cryptocadet.cmd'), `@node "${script}" %*\r\n`);
    fs.writeFileSync(path.join(dir, 'ccx.cmd'), `@node "${script}" %*\r\n`);

    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  }

  if (opts.initialized) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ serverBaseUrl: 'http://127.0.0.1:14000', chainId: 84532 }),
    );
    fs.writeFileSync(
      path.join(home, 'policy.json'),
      JSON.stringify({ version: 1, chainId: 84532, recipients: [] }),
    );
  }

  const readCalls = (): CadetCall[] =>
    fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CadetCall);

  return {
    dir,
    home,
    calls: readCalls,
    callsTo: (verb: string) => readCalls().filter((c) => c.argv[0] === verb),
    cleanup() {
      process.env.PATH = originalPath;
      delete process.env.FAKE_CADET_LOG;
      delete process.env.FAKE_CADET_SCENARIO;
      delete process.env.FAKE_CADET_VERSION;
      delete process.env.FAKE_CADET_AGENT;
      delete process.env.FAKE_CADET_SPENDABLE;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(home, 'config.json'), { force: true });
      fs.rmSync(path.join(home, 'policy.json'), { force: true });
      fs.rmSync(path.join(home, '.funded'), { force: true });
    },
  };
}
