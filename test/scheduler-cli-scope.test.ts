/**
 * `botmux schedule add` rejects malformed scheduling flags in-process, before it
 * infers a chat or contacts the daemon. Driven through the real CLI outside any
 * session, in a throwaway HOME, so nothing here can ever create a task: every run
 * exits 1 — either at the flag under test, or (for valid flags) later, at the
 * chat-id inference. Naming the offending flag is what tells the two apart.
 *
 * What accepted flags turn into (execution position, followActive, model, the task
 * id) is decided daemon-side by SCHEDULE_DELEGATED_ADD_ROUTE — see
 * schedule-delegation-route.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

function scheduleAdd(...flags: string[]): { status: number | null; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'botmux-schedule-cli-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, BOTMUX_HOME: join(home, '.botmux'), SESSION_DATA_DIR: join(home, 'data'),
  };
  for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_TURN_ID', 'BOTS_CONFIG']) delete env[key];
  const run = spawnSyncTsScript('src/cli.ts', ['schedule', 'add', '10m', 'check the build', ...flags], {
    env, encoding: 'utf8', timeout: 90_000,
  });
  return { status: run.status, stderr: String(run.stderr) };
}

const mentionsIdFlag = /(?<![\w-])--id\b/;

describe('botmux schedule add flag validation', () => {
  it('lets well-formed --id / --reasoning-effort / --topic --follow-active through to chat inference', () => {
    const run = scheduleAdd('--id', 'deadbeef', '--reasoning-effort', 'high', '--topic', '--follow-active');
    expect(run.status).toBe(1);
    expect(run.stderr).not.toMatch(mentionsIdFlag);
    expect(run.stderr).not.toContain('--reasoning-effort');
    expect(run.stderr).not.toContain('--follow-active');
  }, 120_000);

  it('accepts only an explicit 8-hex --id', () => {
    for (const id of ['NOTHEX', 'deadbeef0', 'DEADBEEF']) {
      const run = scheduleAdd('--id', id);
      expect(run.status, id).toBe(1);
      expect(run.stderr, id).toMatch(mentionsIdFlag);
    }
  }, 300_000);

  it('rejects an unknown --reasoning-effort level', () => {
    const run = scheduleAdd('--reasoning-effort', 'bogus');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--reasoning-effort');
  }, 120_000);

  it('refuses --follow-active together with --top-level or --new-topic', () => {
    for (const position of ['--top-level', '--new-topic']) {
      const run = scheduleAdd('--follow-active', position);
      expect(run.status, position).toBe(1);
      expect(run.stderr, position).toContain('--follow-active');
    }
  }, 240_000);
});
