// packages/rdk-cli/src/prompts.ts
// Minimal interactive prompts using Node's built-in readline.
// Zero external dependencies — all styling from theme.ts.

import { createInterface, emitKeypressEvents } from 'readline';
import { t } from './theme.js';

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

/** Free-text input with optional default */
export async function input(opts: {
  message: string;
  default?: string;
  validate?: (v: string) => string | boolean;
}): Promise<string> {
  return new Promise((resolve) => {
    const iface = rl();
    const suffix = opts.default ? t.muted(` (${opts.default})`) : '';
    const prompt = `  ${t.dim('›')} ${t.body(opts.message)}${suffix} `;
    iface.question(prompt, (answer) => {
      iface.close();
      const value = answer.trim() || opts.default || '';
      if (opts.validate) {
        const result = opts.validate(value);
        if (result !== true) {
          console.log(`  ${t.error(String(result))}`);
          resolve(input(opts));
          return;
        }
      }
      resolve(value);
    });
  });
}

/** Masked password input — suppresses echo */
export async function password(opts: {
  message: string;
  validate?: (v: string) => string | boolean;
}): Promise<string> {
  const prompt = `  ${t.dim('›')} ${t.body(opts.message)} `;

  const read = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function'
    ? readHiddenTTY(prompt)
    : readHiddenFallback(prompt);

  const value = (await read).trim();
  if (opts.validate) {
    const result = opts.validate(value);
    if (result !== true) {
      console.log(`  ${t.error(String(result))}`);
      return password(opts);
    }
  }
  return value;
}

function readHiddenFallback(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const iface = rl();
    iface.question(prompt, (answer) => {
      iface.close();
      resolve(answer);
    });
  });
}

function readHiddenTTY(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const previousRawMode = stdin.isRaw;
    let value = '';
    let settled = false;

    const cleanup = () => {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(previousRawMode);
      stdin.pause();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write('\n');
      resolve(value);
    };

    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write('\n');
      process.exit(130);
    };

    const onData = (chunk: Buffer | string) => {
      const input = chunk.toString('utf8');
      for (const char of input) {
        if (char === '\u0003') abort(); // Ctrl+C
        else if (char === '\r' || char === '\n') finish();
        else if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };

    process.stdout.write(prompt);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}

/** Y/n confirm */
export async function confirm(opts: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const iface = rl();
    const hint   = opts.default !== false ? t.muted('Y/n') : t.muted('y/N');
    const prompt = `  ${t.dim('›')} ${t.body(opts.message)} ${hint} `;
    iface.question(prompt, (answer) => {
      iface.close();
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) return resolve(opts.default !== false);
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/** Numbered list selection */
export async function select<T extends string>(opts: {
  message: string;
  choices: Array<{ name: string; value: T; hint?: string } | T>;
  default?: T;
  footer?: string;
}): Promise<T> {
  const choices = opts.choices.map(c =>
    typeof c === 'string' ? { name: c, value: c as T } : c,
  );
  const defaultIdx = Math.max(0, opts.default ? choices.findIndex(c => c.value === opts.default) : 0);

  // Render one choice row. `active` = the row the cursor is on (filled ●, highlighted).
  const row = (c: { name: string; hint?: string }, i: number, active: boolean): string => {
    const marker = active ? t.green('●') : t.dim('○');
    const num    = t.dim(`${i + 1})`);
    const name   = active ? t.green(c.name) : t.body(c.name);
    const hint   = c.hint ? t.muted(`  ${c.hint}`) : '';
    return `  ${marker} ${num} ${name}${hint}`;
  };

  // Non-interactive fallback (piped stdin / no TTY): print once, read a number.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`  ${t.dim('›')} ${t.body(opts.message)}`);
    console.log('');
    choices.forEach((c, i) => console.log(row(c, i, i === defaultIdx)));
    if (opts.footer) { console.log(''); console.log(`  ${t.muted(opts.footer)}`); }
    console.log('');
    return new Promise((resolve) => {
      const iface = rl();
      const prompt = `  ${t.dim('›')} ${t.body('Choice')} ${t.muted(`(${defaultIdx + 1})`)} `;
      iface.question(prompt, (answer) => {
        iface.close();
        const trimmed = answer.trim();
        if (!trimmed) return resolve(choices[defaultIdx].value);
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= choices.length) resolve(choices[num - 1].value);
        else { console.log(`  ${t.error(`Enter a number between 1 and ${choices.length}`)}`); resolve(select(opts)); }
      });
    });
  }

  // Interactive: arrow keys (or j/k) move the ●, 1–9 jump, Enter selects.
  return new Promise<T>((resolve) => {
    let cursor = defaultIdx;
    const footerLines = opts.footer ? ['', `  ${t.muted(opts.footer)}`] : [];
    const hintLine = `  ${t.muted('↑/↓ move · 1–9 jump · enter select')}`;

    const build = (): string[] => [
      `  ${t.dim('›')} ${t.body(opts.message)}`,
      '',
      ...choices.map((c, i) => row(c, i, i === cursor)),
      ...footerLines,
      '',
      hintLine,
    ];

    let printed = 0;
    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${printed}A`); // move up over the prior render
      const lines = build();
      for (const line of lines) process.stdout.write(`\r\x1b[2K${line}\n`); // col0, clear, write
      printed = lines.length;
    };

    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
      process.stdin.pause();
    };

    const onKey = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); process.exit(130); }
      else if (key?.name === 'up' || key?.name === 'k') { cursor = (cursor - 1 + choices.length) % choices.length; draw(false); }
      else if (key?.name === 'down' || key?.name === 'j') { cursor = (cursor + 1) % choices.length; draw(false); }
      else if (str && /^[1-9]$/.test(str)) { const n = parseInt(str, 10); if (n <= choices.length) { cursor = n - 1; draw(false); } }
      else if (key?.name === 'return' || key?.name === 'enter') { cleanup(); process.stdout.write('\n'); resolve(choices[cursor].value); }
    };

    process.stdin.on('keypress', onKey);
    draw(true);
  });
}

/** Wait for the user to press Enter */
export async function pressEnter(message = 'Press Enter to continue'): Promise<void> {
  return new Promise((resolve) => {
    const iface = rl();
    iface.question(`  ${t.dim('›')} ${t.body(message)} `, () => {
      iface.close();
      resolve();
    });
  });
}
