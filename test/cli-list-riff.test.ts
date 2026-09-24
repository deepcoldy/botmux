/**
 * CLI regression for `botmux list --plain` against active Riff sessions.
 *
 * Riff runs the CLI on a remote sandbox, so it has no local multiplexer pane
 * and `sessionPersistentTarget()` returns undefined for it — by design. A prior
 * `sessionBackingInfo()` only special-cased tmux/herdr/zellij/zmx and pty, so a
 * Riff row fell into the legacy tmux branch, force-unwrapped the undefined
 * target with `!`, and crashed in `backingProbeKey()` reading
 * `target.backendType` (TypeError). Both `--plain` and the interactive TUI share
 * that helper, so both list modes crashed.
 *
 * These tests run the SOURCE CLI through tsx against a temp data dir with a real
 * `status: active`, `backendType: 'riff'` session that has no
 * persistentBackendTarget, and assert the crash is gone and the record is not
 * mutated by the read-only list command. They fail (nonzero exit + TypeError on
 * stderr) against the pre-fix cli.ts.
 *
 * To keep the target-column assertions honest, the "riff"/"pty" substrings are
 * kept OUT of every other column (title, session id, working dir), so a matched
 * substring can only have come from the target label the fix produces.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPersistedSessionRows, seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP_ID = 'cli_list_riff_test';
const tempDirs: string[] = [];

interface StoredSession {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  workingDir?: string;
  larkAppId?: string;
  cliId?: string;
  backendType?: 'pty' | 'tmux' | 'herdr' | 'zellij' | 'zmx' | 'riff';
  persistentBackendTarget?: unknown;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(sessionId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    chatId: 'oc_list_riff_test',
    rootMessageId: 'om_list_riff_test',
    title: sessionId,
    status: 'active',
    createdAt: '2026-07-22T00:00:00.000Z',
    workingDir: '/tmp/session-wd',
    larkAppId: APP_ID,
    ...overrides,
  };
}

/** Seed the bot's real session store (`session-stores/<appId>/sessions.db`) —
 *  the only engine the CLI reads at runtime. */
function writeSessions(dataDir: string, sessions: StoredSession[]): void {
  seedPersistedSessionRows(dataDir, APP_ID, Object.fromEntries(sessions.map(s => [s.sessionId, s])));
}

/** Read the seeded store back to prove `list` did not mutate/prune any row. */
function readSessions(dataDir: string): Record<string, StoredSession> {
  return readPersistedSessionRows(dataDir, APP_ID) as Record<string, StoredSession>;
}

function runList(
  dataDir: string,
  homeDir: string,
  args: string[] = ['--plain'],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      // Hermetic HOME so the box's real ~/.botmux/bots.json can't flip the
      // multi-bot column layout under the test (os.homedir() honours $HOME on
      // POSIX). SESSION_DATA_DIR still wins for the session store regardless.
      HOME: homeDir,
      USERPROFILE: homeDir,
    };
    const child = spawnTsScript(
      CLI_PATH,
      ['list', ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('botmux list — active Riff session', () => {
  it('renders an active riff session without crashing and leaves the record intact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-riff-data-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'botmux-list-riff-home-'));
    tempDirs.push(dataDir, homeDir);
    const session = makeSession('aaaa0001-2222-3333-4444-555566667777', {
      title: 'remote-task-alpha',
      cliId: 'riff',
      backendType: 'riff',
      // No persistentBackendTarget on purpose: Riff has no local backing pane.
    });
    writeSessions(dataDir, [session]);

    const result = await runList(dataDir, homeDir);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('TypeError');
    expect(result.stderr).not.toContain('backendType');
    expect(result.stdout).toContain('remote-task-alpha');
    // 'riff' appears in no other column (id/title/dir), so a match proves the
    // target column rendered the stable non-persistent label.
    expect(result.stdout).toContain('riff');

    // list is a READ command: the active record must survive untouched.
    const stored = readSessions(dataDir);
    expect(stored[session.sessionId]).toBeDefined();
    expect(stored[session.sessionId].status).toBe('active');
    expect(stored[session.sessionId].backendType).toBe('riff');
    expect(stored[session.sessionId].persistentBackendTarget).toBeUndefined();
  });

  it('lists a mix of riff, pty and legacy (backendType-less) tmux rows without regressing the shared path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-mix-data-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'botmux-list-mix-home-'));
    tempDirs.push(dataDir, homeDir);
    const riff = makeSession('aaaa0001-0000-0000-0000-000000000001', {
      title: 'row-alpha',
      cliId: 'riff',
      backendType: 'riff',
    });
    const pty = makeSession('bbbb0002-0000-0000-0000-000000000002', {
      title: 'row-beta',
      cliId: 'claude-code',
      backendType: 'pty',
    });
    // No backendType: the legacy compatibility path (deterministic tmux target).
    const legacy = makeSession('cccc0003-0000-0000-0000-000000000003', {
      title: 'row-gamma',
      cliId: 'codex',
    });
    writeSessions(dataDir, [riff, pty, legacy]);

    const result = await runList(dataDir, homeDir);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('TypeError');
    expect(result.stdout).toContain('row-alpha');
    expect(result.stdout).toContain('row-beta');
    expect(result.stdout).toContain('row-gamma');
    // Neither substring appears in any id/title/dir column, so matches can only
    // come from the riff and pty target labels the shared list path renders —
    // proving the legacy tmux row (row-gamma) flows through without crashing it.
    expect(result.stdout).toContain('riff');
    expect(result.stdout).toContain('pty');

    // None of the three real managed sessions may be pruned or mutated by list.
    const stored = readSessions(dataDir);
    for (const s of [riff, pty, legacy]) {
      expect(stored[s.sessionId]).toBeDefined();
      expect(stored[s.sessionId].status).toBe('active');
    }
  });
});
