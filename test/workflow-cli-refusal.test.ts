/**
 * `botmux workflow …` refusals are printed as a message, not as an uncaught
 * exception: the main bot runs these commands and relays their output to the
 * chat, where a Bun source excerpt and stack trace is noise. A refusal still
 * fails the command (non-zero exit). Anything that is not a deliberate
 * refusal keeps its stack.
 *
 * Real CLI entry (`src/cli.ts`) in a child process with a private HOME.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { hostNew } from '../src/workflows/v3/host.js';
import { runWorkflowCliCommand } from '../src/cli/workflow.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function privateHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'botmux-wf-cli-refusal-'));
  homes.push(home);
  mkdirSync(join(home, '.botmux'), { recursive: true });
  writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([
    { larkAppId: 'cli_test', larkAppSecret: 'secret', cliId: 'claude-code', workingDir: home },
  ]));
  return home;
}

/** Run the CLI with an explicit, minimal environment (no session/turn env). */
function botmux(home: string, args: string[]) {
  const { command, prefixArgs } = tsRunnerPrefix();
  const result = spawnSync(command, [...prefixArgs, CLI, ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', HOME: home, BOTMUX_WORKFLOW_ENABLED: 'true' },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** Stack frames (`    at fn (file:line:col)`) or a runtime's source excerpt
 *  (`1045 |   code`). */
const STACK_OR_SOURCE = /^\s+at\s|^\s*\d+\s+\|/m;

describe('workflow CLI refusals', () => {
  it('approve-dag on a run that is not ready: the guard message alone, exit non-zero', () => {
    const home = privateHome();
    const base = join(home, 'runs');
    const { runId } = hostNew({ goal: 'weekly report', baseDir: base });
    const out = botmux(home, ['workflow', 'approve-dag', runId, '--base-dir', base]);
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBeNull();
    // The guard names the run's actual state.
    expect(out.stderr).toMatch(/grilling/);
    expect(out.stderr).not.toMatch(STACK_OR_SOURCE);
  }, 90_000);

  it.each([
    ['a run that does not exist', (base: string) => ['no-such-run', '--base-dir', base], /no-such-run/],
    ['no run id', () => [], /approve-dag|runId|用法/],
    ['a run id that is not one', (base: string) => ['bad/../id', '--base-dir', base], /bad\/\.\.\/id/],
  ])('approve-dag with %s: the usage message alone, exit non-zero', (_label, args, names) => {
    const home = privateHome();
    const out = botmux(home, ['workflow', 'approve-dag', ...args(join(home, 'runs'))]);
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBeNull();
    expect(out.stderr).toMatch(names);
    expect(out.stderr).not.toMatch(STACK_OR_SOURCE);
  }, 90_000);

  it('cancel of a run the caller cannot act on: the authority message alone, exit non-zero', () => {
    const home = privateHome();
    const out = botmux(home, ['workflow', 'cancel', 'no-such-run-261106-000000-000-deadbeef']);
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBeNull();
    expect(out.stderr).toMatch(/no-such-run-261106-000000-000-deadbeef/);
    expect(out.stderr).not.toMatch(STACK_OR_SOURCE);
  }, 90_000);
});

describe('runWorkflowCliCommand', () => {
  it('rethrows anything that is not a deliberate refusal, stack intact', async () => {
    const bug = new TypeError('cannot read properties of undefined');
    await expect(runWorkflowCliCommand(async () => { throw bug; })).rejects.toBe(bug);
    expect(bug.stack).toBeTruthy();
  });
});
