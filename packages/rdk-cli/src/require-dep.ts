// packages/rdk-cli/src/require-dep.ts
// On-demand dependency installer.
// Every command that needs a heavy package calls requireDep() first.
// If the package is missing, the user is shown what it is, why it's needed,
// how big it is, and asked to confirm before installing.
//
// Tiers:
//   Tier 1 (always installed): commander, chalk, ora, better-sqlite3, gray-matter, glob
//   Tier 2 (vault:connect):    @rdk/adapter-obsidian, @rdk/adapter-notion, chokidar
//   Tier 3 (network:join):     @xenova/transformers, @modelcontextprotocol/sdk
//   Tier 4 (tips:enable):      ethers

import { execSync } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import os from 'os';
import fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';

// CLI package root: dist/../ = packages/rdk-cli/
// Used as the --prefix for npm installs so packages land on the resolution path.
const CLI_PKG_DIR = path.resolve(__dirname, '..');

/**
 * For @rdk/* packages, walk up from the CLI's real __dirname to find the
 * monorepo's packages/ directory and return the local source path.
 * Returns null when running outside a workspace (e.g. after a real npm install -g).
 */
function findLocalWorkspacePackage(packageName: string): string | null {
  const dirName = packageName.replace('@rdk/', 'rdk-');
  const realDir = (() => { try { return fs.realpathSync(__dirname); } catch { return __dirname; } })();
  let dir = realDir;
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'packages', dirName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/** Symlink a workspace package into CLI_PKG_DIR/node_modules so Node can find it. */
function linkWorkspacePackage(packageName: string, localPath: string): void {
  const parts = packageName.split('/'); // ['@rdk', 'adapter-obsidian']
  const scopeDir = path.join(CLI_PKG_DIR, 'node_modules', parts[0]);
  const linkTarget = path.join(scopeDir, parts[1]);
  if (fs.existsSync(linkTarget)) return;
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(localPath, linkTarget, 'dir');
}

/** The ~/.rdk directory doubles as a clean install target for npm packages. */
const RDK_HOME = path.join(os.homedir(), '.rdk');

function ensureRdkPackageJson(): void {
  const pkgFile = path.join(RDK_HOME, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    fs.mkdirSync(RDK_HOME, { recursive: true });
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'rdk-runtime', version: '1.0.0', private: true }, null, 2));
  }
}

/**
 * After installing pkg to ~/.rdk/node_modules/, create a symlink so Node can find it.
 *
 * Target selection:
 * - In a workspace (monorepo), symlink into the monorepo root's node_modules/.
 *   This makes the package visible to ALL workspace packages (e.g. @rdk/core
 *   needs @xenova/transformers but lives in packages/rdk-core/, not packages/rdk-cli/).
 * - In a production global install, symlink into CLI_PKG_DIR/node_modules/ where
 *   @rdk/core is already a direct dependency and shares the same node_modules tree.
 */
function symlinkRdkDep(packageName: string): void {
  const parts = packageName.split('/');
  const rdkModules = path.join(RDK_HOME, 'node_modules');
  const targetModules = path.join(findMonorepoRoot() ?? CLI_PKG_DIR, 'node_modules');

  if (parts.length === 1) {
    const src = path.join(rdkModules, parts[0]);
    const dst = path.join(targetModules, parts[0]);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, 'dir');
  } else {
    const src = path.join(rdkModules, parts[0], parts[1]);
    const dst = path.join(targetModules, parts[0], parts[1]);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.mkdirSync(path.join(targetModules, parts[0]), { recursive: true });
      fs.symlinkSync(src, dst, 'dir');
    }
  }
}

function findMonorepoRoot(): string | null {
  const realDir = (() => { try { return fs.realpathSync(CLI_PKG_DIR); } catch { return CLI_PKG_DIR; } })();
  // Walk up from packages/rdk-cli/ looking for a workspace root marker
  let dir = path.dirname(realDir); // packages/
  dir = path.dirname(dir);         // rdk/ (potential monorepo root)
  if (
    fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) ||
    fs.existsSync(path.join(dir, 'packages'))
  ) {
    return dir;
  }
  return null;
}

export interface DepSpec {
  package: string;           // npm package name
  version?: string;          // version constraint e.g. "^6.14.1"
  reason: string;            // one-line human explanation
  size: string;              // approximate download size e.g. "~50MB"
  global?: boolean;          // install with -g (default: false, installs locally)
  testImport?: string;       // module to try importing (defaults to package name)
}

// Package registry — every on-demand dep defined in one place
export const DEPS: Record<string, DepSpec> = {
  '@xenova/transformers': {
    package: '@xenova/transformers',
    version: '^2.17.2',
    reason: 'local embedding model (all-MiniLM-L6-v2) for semantic search',
    size: '~50MB',
    testImport: '@xenova/transformers',
  },
  '@modelcontextprotocol/sdk': {
    package: '@modelcontextprotocol/sdk',
    version: '^1.12.1',
    reason: 'MCP server protocol — connects your node to Claude Desktop',
    size: '~2MB',
  },
  'ethers': {
    package: 'ethers',
    version: '^6.14.1',
    reason: 'on-chain USDC tip settlement (Base / Ethereum / Polygon)',
    size: '~15MB',
  },
  '@rdk/adapter-obsidian': {
    package: '@rdk/adapter-obsidian',
    reason: 'Obsidian vault adapter — wikilinks, frontmatter, graph indexing',
    size: '~1MB',
  },
  '@rdk/adapter-filesystem': {
    package: '@rdk/adapter-filesystem',
    reason: 'filesystem vault adapter — .md, .txt, .mdx file indexing',
    size: '~1MB',
  },
  '@rdk/adapter-notion': {
    package: '@rdk/adapter-notion',
    reason: 'Notion vault adapter — database + page indexing via Notion API',
    size: '~2MB',
  },
  '@rdk/adapter-logseq': {
    package: '@rdk/adapter-logseq',
    reason: 'Logseq vault adapter — block format, page references',
    size: '~1MB',
  },
  '@rdk/mcp': {
    package: '@rdk/mcp',
    reason: 'MCP server — exposes vault tools to Claude Desktop',
    size: '~1MB',
  },
  '@rdk/x402': {
    package: '@rdk/x402',
    reason: 'x402 tip client — on-chain USDC batch settlement',
    size: '~1MB',
  },
  'chokidar': {
    package: 'chokidar',
    version: '^3.6.0',
    reason: 'file system watcher — auto re-index vault when files change',
    size: '<1MB',
  },
};

/** Check if a package is importable without installing it */
export async function isInstalled(packageName: string): Promise<boolean> {
  try {
    await import(packageName);
    return true;
  } catch {
    return false;
  }
}

/** Ensure a dep is installed. Prompts user if missing. Returns true if ready. */
export async function requireDep(
  depKey: string,
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  const spec = DEPS[depKey];
  if (!spec) throw new Error(`Unknown dep key: ${depKey}`);

  const testPkg = spec.testImport ?? spec.package;
  if (await isInstalled(testPkg)) return true;

  if (!opts.silent) {
    console.log('');
    console.log(chalk.yellow('  Additional component needed:'));
    console.log(`  ${chalk.bold(spec.package)} ${chalk.dim(`(${spec.size})`)}`);
    console.log(`  ${chalk.dim(spec.reason)}`);
    console.log('');
  }

  const confirmed = await confirm(`  Install now?`);
  if (!confirmed) {
    console.log(chalk.dim(`  Skipped. Install manually: npm install ${spec.package}`));
    return false;
  }

  return installDep(spec);
}

/** Ensure multiple deps are installed. Shows one combined prompt if any are missing. */
export async function requireDeps(
  depKeys: string[],
  opts: { label?: string } = {},
): Promise<boolean> {
  const missing: DepSpec[] = [];

  for (const key of depKeys) {
    const spec = DEPS[key];
    if (!spec) throw new Error(`Unknown dep key: ${key}`);
    const testPkg = spec.testImport ?? spec.package;
    if (!(await isInstalled(testPkg))) {
      missing.push(spec);
    }
  }

  if (missing.length === 0) return true;

  const totalSize = missing.map(d => d.size).join(' + ');
  console.log('');
  console.log(chalk.yellow(`  ${opts.label ?? 'Components needed'}:`));
  for (const dep of missing) {
    console.log(`  ${chalk.bold(dep.package)} ${chalk.dim(`(${dep.size})`)} — ${chalk.dim(dep.reason)}`);
  }
  console.log(`  ${chalk.dim(`Total: ${totalSize}`)}`);
  console.log('');

  const confirmed = await confirm('  Install now?');
  if (!confirmed) {
    console.log(chalk.dim('  Skipped. Run again and choose Y when ready.'));
    return false;
  }

  for (const dep of missing) {
    const ok = await installDep(dep);
    if (!ok) return false;
  }

  return true;
}

/** Install a single dep with progress spinner */
async function installDep(spec: DepSpec): Promise<boolean> {
  const spinner = ora(`Installing ${spec.package}...`).start();

  try {
    // @rdk/* packages: in a workspace context these live on disk already.
    // Create a symlink into the CLI's node_modules so Node can resolve them.
    // Their transitive deps (glob, gray-matter, @rdk/core, etc.) are already
    // wired up by pnpm in their own node_modules/ directories.
    if (spec.package.startsWith('@rdk/')) {
      const localPath = findLocalWorkspacePackage(spec.package);
      if (localPath) {
        linkWorkspacePackage(spec.package, localPath);
        spinner.succeed(`${spec.package} linked`);
        return true;
      }
    }

    // For npm packages: install to ~/.rdk/ (which has a clean package.json with no
    // workspace:* deps), then symlink the result into CLI_PKG_DIR/node_modules/ so
    // Node's module resolution path (rooted at the CLI's real __dirname) can find it.
    ensureRdkPackageJson();
    const pkg = spec.version ? `${spec.package}@${spec.version}` : spec.package;
    // Use --save so packages persist in ~/.rdk/package.json across CLI sessions.
    // Without --save, npm treats them as extraneous and removes them on the next install.
    execSync(`npm install --save ${pkg}`, {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
      cwd: RDK_HOME,
    });
    // sharp (required by @xenova/transformers) often installs without its prebuilt
    // binary on newer Node versions. Rebuild it so the binary is available.
    if (spec.package === '@xenova/transformers') {
      try {
        execSync('npm rebuild sharp', { stdio: 'pipe', cwd: RDK_HOME, timeout: 120000 });
      } catch { /* sharp may not be present if install skipped it — non-fatal */ }
    }
    symlinkRdkDep(spec.package);
    spinner.succeed(`${spec.package} installed`);
    return true;
  } catch (e) {
    spinner.fail(`Failed to install ${spec.package}: ${(e as Error).message}`);
    console.log(chalk.dim(`  Manual install: npm install ${spec.package}`));
    return false;
  }
}

/** Simple Y/n prompt */
async function confirm(question: string): Promise<boolean> {
  // If not a TTY (e.g. piped), default to yes
  if (!process.stdin.isTTY) return true;

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${chalk.dim('[Y/n]')} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}
