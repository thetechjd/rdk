// packages/rdk-cli/src/commands/service/index.ts

import { t, mark } from '../../theme.js';
import { getAdapter, detectPlatform } from './platform.js';

export async function serviceInstall(): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'unsupported') {
    console.error(t.error('  Unsupported platform.'));
    console.error(t.dim('  Supported: macOS, Linux (systemd), Windows.'));
    return;
  }

  console.error('');
  console.error(t.heading(`  Installing RDK auto-start (${platform})`));
  console.error('');

  try {
    const adapter = await getAdapter();
    await adapter.install();
    console.error('');
    console.error(t.green(`  ${mark.ok()} RDK is now running in the background`));
    console.error(t.green(`  ${mark.ok()} RDK will auto-start when your computer boots`));
    console.error('');
    console.error(t.dim('  Check status: rdk service:status'));
    console.error(t.dim('  Stop:         rdk service:stop'));
    console.error(t.dim('  Uninstall:    rdk service:uninstall'));
    console.error('');
  } catch (e) {
    console.error(t.error(`  Install failed: ${(e as Error).message}`));
  }
}

export async function serviceUninstall(): Promise<void> {
  const { confirm } = await import('../../prompts.js');
  const confirmed = await confirm({
    message: 'Stop RDK and remove auto-start?',
    default: false,
  });
  if (!confirmed) return;

  try {
    const adapter = await getAdapter();
    await adapter.uninstall();
    console.error('');
    console.error(t.green(`  ${mark.ok()} RDK auto-start removed`));
    console.error('');
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}

export async function serviceStart(): Promise<void> {
  try {
    const adapter = await getAdapter();
    await adapter.start();
    console.error(t.green(`  ${mark.ok()} RDK started`));
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}

export async function serviceStop(): Promise<void> {
  try {
    const adapter = await getAdapter();
    await adapter.stop();
    console.error(t.green(`  ${mark.ok()} RDK stopped`));
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}

export async function serviceStatus(): Promise<void> {
  try {
    const adapter = await getAdapter();
    const status  = await adapter.status();

    console.error('');
    console.error(t.heading('  RDK Service Status'));
    console.error('');

    const installLabel = status.installed
      ? t.green('installed')
      : t.dim('not installed');
    console.error(`  ${t.dim('auto-start:')}  ${installLabel}`);

    const runLabel = status.running
      ? t.green(`running (pid: ${status.pid ?? '?'})`)
      : t.dim('stopped');
    console.error(`  ${t.dim('state:')}       ${runLabel}`);

    if (status.lastError) {
      console.error(`  ${t.dim('last error:')}  ${t.warn(status.lastError)}`);
    }
    console.error('');

    if (!status.installed) {
      console.error(t.dim('  Enable auto-start: rdk service:install'));
      console.error('');
    }
  } catch (e) {
    console.error(t.error((e as Error).message));
  }
}
