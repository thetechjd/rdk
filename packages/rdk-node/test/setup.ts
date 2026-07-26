import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Give every test FILE its own `~/.rdk`.
 *
 * `config.ts` reads `process.env.RDK_HOME` into a module-level const at import
 * time, so this has to happen in `setupFiles` — a `beforeAll` would run after the
 * module under test was already evaluated with the real home directory. Getting
 * this wrong means tests read and WRITE the developer's actual RDK config,
 * including their live auth tokens.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-node-test-'));
process.env.RDK_HOME = home;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
