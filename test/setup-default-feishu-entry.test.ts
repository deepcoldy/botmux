// `botmux setup` without --platform is the Feishu wizard: piped answers
// (non-TTY) keep working exactly as before WeCom existed, and a terminal goes
// straight into the Feishu flow with no platform step in front of it. On a
// terminal the Feishu app source menu ends with a WeCom section — a separator
// row, then "scan to create" (the same QR flow as `--platform wecom`) and
// "enter BotID/Secret"; piped input never sees it.
import * as pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { isBunRuntime, nodeTsRunnerPrefix, spawnTsScript } from './helpers/ts-runner.js';
import { shippedText, type Locale } from '../src/i18n/index.js';

const CLI = resolve('src/cli.ts');
const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh, unconfigured host: the wizard's first menu is the Feishu app source. */
function freshHostEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'setup-default-entry-'));
  roots.push(home);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    BOTS_CONFIG: join(home, 'bots.json'),
    SESSION_DATA_DIR: join(home, 'data'),
    TERM: 'xterm-256color',
  };
  for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_SEND_RELAY', 'BOTMUX_DAEMON_IPC_PORT']) delete env[key];
  return env;
}

/** Resolve once `done(output)` holds; reject as soon as the process exits first. */
function waitForOutput(
  subscribe: (onData: (chunk: string) => void, onExit: (code: number | null) => void) => void,
  done: (output: string) => boolean,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let output = '';
    let settled = false;
    subscribe(chunk => {
      output += chunk;
      if (!settled && done(output)) {
        settled = true;
        resolveOutput(output);
      }
    }, code => {
      if (settled) return;
      settled = true;
      reject(new Error(`setup exited (code ${code}) before its first menu: ${JSON.stringify(output.slice(-800))}`));
    });
  });
}

describe('botmux setup without --platform (non-TTY, piped input)', () => {
  it.each([
    { args: [] as string[], locale: 'zh' as Locale },
    { args: ['--lang', 'en'], locale: 'en' as Locale },
    { args: ['--platform', 'feishu'], locale: 'zh' as Locale },
  ])('reads piped answers in the Feishu wizard: $args', async ({ args, locale }) => {
    const child: ChildProcess = spawnTsScript(CLI, ['setup', ...args], {
      env: freshHostEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(() => child.kill('SIGKILL'));
    // Every non-TTY menu ends with this prompt and then waits for a piped line.
    const promptPrefix = shippedText('setup.select.choose_prompt', locale).split('{max}')[0];
    const output = await waitForOutput((onData, onExit) => {
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', onData);
      child.once('exit', onExit);
    }, text => text.includes(promptPrefix));
    // The first menu waiting for input belongs to the Feishu wizard.
    expect(output).toContain(shippedText('setup.wizard.title', locale));
  }, 60_000);
});

// bun's in-process node-pty delivers no onData (see session-picker-responsive);
// the CLI itself always runs under Node+tsx here.
describe.runIf(!isBunRuntime())('botmux setup without --platform (TTY)', () => {
  it('opens the Feishu app source menu directly, ending with the WeCom section', async () => {
    const { command, prefixArgs } = nodeTsRunnerPrefix();
    const child = pty.spawn(command, [...prefixArgs, CLI, 'setup'], {
      cwd: resolve('.'),
      env: freshHostEnv(),
      cols: 120,
      rows: 30,
      name: 'xterm-256color',
    });
    cleanups.push(() => { try { child.kill(); } catch { /* already exited */ } });
    // The interactive selector paints this hint under the title of every frame
    // and the footer below the items; the first frame is the first question
    // setup asks, complete once its footer is painted.
    const hint = shippedText('setup.select.hint', 'zh');
    const footer = shippedText('setup.menu.footer_cancel', 'zh');
    const output = await waitForOutput((onData, onExit) => {
      child.onData(onData);
      child.onExit(event => onExit(event.exitCode));
    }, text => text.includes(hint) && text.indexOf(footer, text.indexOf(hint)) !== -1);
    const firstFrame = output.indexOf(hint);
    expect(output.slice(0, firstFrame)).toContain(shippedText('setup.wizard.title', 'zh'));
    expect(output.slice(0, firstFrame)).toContain(shippedText('setup.credentials.source_title', 'zh'));
    const items = output.slice(firstFrame, output.indexOf(footer, firstFrame));
    // Feishu's three sources, then the section row, then its two WeCom items.
    const manual = items.indexOf(shippedText('setup.credentials.manual', 'zh'));
    const section = items.indexOf(shippedText('setup.platform.source_wecom_section', 'zh'), manual);
    const qr = items.indexOf(shippedText('setup.platform.source_wecom_qr', 'zh'), section);
    const wecomManual = items.indexOf(shippedText('setup.platform.source_wecom_manual', 'zh'), qr);
    expect(manual).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(manual);
    expect(qr).toBeGreaterThan(section);
    expect(wecomManual).toBeGreaterThan(qr);
  }, 60_000);
});
