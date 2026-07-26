import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Give the main-process suite its own `~/.rdk`.
 *
 * `@rdk/node/config` captures `RDK_HOME` in a module-level const at import time,
 * so this must run in `setupFiles` — a `beforeAll` would be too late, and the
 * tests would read and WRITE the developer's real config, including live tokens.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-desktop-test-'));
process.env.RDK_HOME = home;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
