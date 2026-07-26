import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Per-file `~/.rdk` and `~/.cryptocadet`.
 *
 * Both `src/config.ts` and `src/commands/cryptocadet.ts` read their home
 * directory into a module-level const at import time (`RDK_HOME` /
 * `CRYPTOCADET_HOME`), so these must be set in `setupFiles` — a `beforeAll`
 * would run too late. Without this, tests read and WRITE the developer's real
 * config, including live auth tokens and a real agent wallet.
 */
const rdkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-cli-test-'));
const cadetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-cadet-test-'));

process.env.RDK_HOME = rdkHome;
process.env.CRYPTOCADET_HOME = cadetHome;

// Belt and braces: if a test ever spawns the REAL CryptoCadet CLI, keep it off
// the OS keychain and out of the auto-install path.
process.env.CRYPTOCADET_INSECURE_KEYCHAIN = '1';
process.env.CRYPTOCADET_BINARY = '1';

afterAll(() => {
  fs.rmSync(rdkHome, { recursive: true, force: true });
  fs.rmSync(cadetHome, { recursive: true, force: true });
});
