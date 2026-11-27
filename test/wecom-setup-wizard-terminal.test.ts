// The WeCom wizard on a real terminal: its selectors (raw mode) and its text
// questions (one readline each) share stdin. A raw selector hands stdin back
// still flowing, with the listener an earlier readline left behind; unless the
// wizard pauses stdin after each pick, the process never exits once the wizard
// has returned. The onboarding client here is a fake: nothing reaches a
// Dashboard or the network.
import * as pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBunRuntime, nodeTsRunnerPrefix } from './helpers/ts-runner.js';
import { t } from '../src/i18n/index.js';

const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RETURNED = '[[wizard-returned';

function wizardScript(): string {
  const root = mkdtempSync(join(tmpdir(), 'wecom-wizard-terminal-'));
  roots.push(root);
  const wizard = pathToFileURL(resolve('src/cli/wecom/setup-wizard.ts')).href;
  // .mts: outside the repo there is no package.json saying "module", and the script uses top-level await.
  const script = join(root, 'run-wizard.mts');
  writeFileSync(script, `
import { runWecomQrSetup } from ${JSON.stringify(wizard)};
const job = (status: string) => ({ id: 'wecom-11111111-1111-4111-8111-111111111111', platform: 'wecom', status, createdAt: 1, updatedAt: 2, resumeUntil: 3, cliId: 'codex', workingDir: '/tmp', externalBotCreated: false, saved: false, retryable: false });
const calls: string[] = [];
const client = {
  list: async () => [],
  start: async () => { calls.push('start'); return job('starting'); },
  get: async () => job('completed'),
  action: async () => { calls.push('action'); return job('cancelled'); },
};
const code = await runWecomQrSetup({ connect: async () => client as never, sleep: async () => {} });
process.stdout.write('\\n${RETURNED} ' + code + ' ' + (calls.join(',') || '-') + ']]\\n');
// No process.exit: the test checks that the process ends on its own.
`);
  return script;
}

// bun's in-process node-pty delivers no onData (see session-picker-responsive);
// the wizard itself always runs under Node+tsx here.
describe.runIf(!isBunRuntime())('WeCom setup wizard on a real terminal', () => {
  it('Esc in the CLI selector ends the wizard with 0, creates nothing, and the process exits by itself', async () => {
    const { command, prefixArgs } = nodeTsRunnerPrefix();
    const child = pty.spawn(command, [...prefixArgs, wizardScript()], {
      cwd: resolve('.'),
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
      cols: 120,
      rows: 40,
      name: 'xterm-256color',
    });
    cleanups.push(() => { try { child.kill(); } catch { /* already exited */ } });
    let output = '';
    let exited = false;
    child.onData(chunk => { output += chunk; });
    child.onExit(() => { exited = true; });
    const waitFor = async (done: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (done()) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return done();
    };

    // First a text question (a readline), then the CLI selector (raw mode).
    expect(await waitFor(() => output.includes('机器人名称'), 40_000), output.slice(-2000)).toBe(true);
    child.write('\r');
    const hint = t('setup.select.hint');
    expect(await waitFor(() => output.includes(t('setup.cli.select_title')) && output.includes(hint), 20_000)).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    child.write('\x1b');

    expect(await waitFor(() => output.includes(RETURNED), 20_000)).toBe(true);
    expect(output).toContain(`${RETURNED} 0 -]]`);
    expect(await waitFor(() => exited, 15_000)).toBe(true);
  }, 120_000);
});
