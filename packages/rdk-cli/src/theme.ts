// packages/rdk-cli/src/theme.ts
// Single source of truth for all CLI colors and styled output helpers.
// Import from here — never use chalk directly in command files.

import chalk from 'chalk';

const GREEN     = '#39FF6A'; // RetroDeck phosphor green — primary
const DIM_GREEN = '#1A7A35'; // darker green — secondary text
const GREY      = '#555555'; // very secondary / muted
const RED       = '#FF4444'; // errors only
const YELLOW    = '#FFD700'; // warnings, one-time notices

export const t = {
  green:   (s: string) => chalk.hex(GREEN)(s),
  heading: (s: string) => chalk.hex(GREEN).bold(s),
  dim:     (s: string) => chalk.hex(DIM_GREEN)(s),
  body:    (s: string) => chalk.white(s),
  muted:   (s: string) => chalk.hex(GREY)(s),
  warn:    (s: string) => chalk.hex(YELLOW)(s),
  error:   (s: string) => chalk.hex(RED)(s),
  bold:    (s: string) => chalk.white.bold(s),
};

export const mark = {
  ok:      () => t.green('✓'),
  pending: () => t.dim('○'),
  warn:    () => t.warn('⚠'),
  error:   () => t.error('✗'),
  arrow:   () => t.dim('→'),
};

export const divider = (width = 48) => t.dim('─'.repeat(width));

export function link(url: string): string {
  return chalk.hex(GREEN).underline(url);
}

export function kv(key: string, value: string): void {
  console.log(`  ${t.dim(key.padEnd(16))} ${t.body(value)}`);
}

export function importantValue(label: string, value: string): void {
  console.log('');
  console.log(`  ${t.dim(label)}`);
  console.log(`  ${t.warn(value)}`);
  console.log(`  ${t.muted('Save this — shown once.')}`);
  console.log('');
}

export function stepHeader(step: number, total: number, title: string): void {
  console.log('');
  console.log(t.heading(`  Step ${step} of ${total} — ${title}`));
  console.log('');
}

export function note(text: string): void {
  console.log(t.dim(`  ${text}`));
}

export function success(text: string): void {
  console.log(`  ${mark.ok()} ${t.body(text)}`);
}

export function warning(text: string): void {
  console.log(`  ${mark.warn()} ${t.warn(text)}`);
}

export function error(text: string): void {
  console.log(`  ${mark.error()} ${t.error(text)}`);
}

export interface SummaryItem {
  label: string;
  value?: string;
  done: boolean;
  action?: string;
}

export function summary(items: SummaryItem[]): void {
  console.log('');
  console.log(`  ${divider(48)}`);
  console.log(`  ${t.heading("You're set up.")}`);
  console.log('');
  for (const item of items) {
    const marker = item.done ? mark.ok() : mark.pending();
    const label  = t.dim(item.label.padEnd(18));
    const value  = item.done
      ? t.body(item.value ?? '')
      : t.muted(item.action ? `rdk ${item.action}` : '—');
    console.log(`  ${marker} ${label} ${value}`);
  }
  console.log('');
}

// ── ASCII splash ──────────────────────────────────────────────────────────────

const ASCII = [
  '  ██████╗ ██████╗ ██╗  ██╗',
  '  ██╔══██╗██╔══██╗██║ ██╔╝',
  '  ██████╔╝██║  ██║█████╔╝ ',
  '  ██╔══██╗██║  ██║██╔═██╗ ',
  '  ██║  ██║██████╔╝██║  ██╗',
  '  ╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝',
];

export function splash(version = '1.0.0'): void {
  console.log('');
  for (const line of ASCII) {
    console.log(t.green(line));
  }
  console.log('');
  console.log(t.dim('  Retrieval Development Kit  ·  by RetroDeck'));
  console.log(t.muted(`  v${version}`));
  console.log('');
}
