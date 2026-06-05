// packages/rdk-cli/src/commands/install-model.ts
import ora from 'ora';
import chalk from 'chalk';
import { execSync } from 'child_process';

export async function installModel(): Promise<boolean> {
  // Check if already installed
  try {
    await import('@xenova/transformers' as string);
    const spinner = ora('Warming up embedding model...').start();
    try {
      // Dynamically load core to avoid static import of xenova
      const core = await import('@rdk/core');
      const model = new core.LocalEmbeddingModel();
      await model.embed('test');
      spinner.succeed('Embedding model ready');
      return true;
    } catch (e) {
      spinner.warn(`Model loaded but warmup failed: ${(e as Error).message}`);
      return true;
    }
  } catch {}

  const spinner = ora('Installing embedding model (~50MB, one-time)...').start();
  try {
    execSync('npm install -g @xenova/transformers', {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
    });
    spinner.succeed('Embedding model installed. Run rdk vault:index to begin indexing.');
    return true;
  } catch (e) {
    spinner.fail(`Install failed: ${(e as Error).message}`);
    console.log(chalk.dim('  Manual: npm install -g @xenova/transformers'));
    return false;
  }
}
