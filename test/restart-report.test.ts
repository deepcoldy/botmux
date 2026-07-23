import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countActiveSessionsOnDisk } from '../src/services/session-store.js';
import { buildRestartReportText, fetchChangelog, sendRestartReportIfPending } from '../src/core/restart-report.js';
import {
  commitRestartIntentAttemptTo,
  restartIntentPathIn,
  writeRestartAttemptIntentTo,
  writeRestartIntentTo,
} from '../src/services/restart-intent-store.js';

function writeSessions(dir: string, name: string, sessions: Record<string, { status: string }>) {
  writeFileSync(join(dir, name), JSON.stringify(sessions));
}

describe('countActiveSessionsOnDisk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-sess-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('counts active sessions across all bots’ session files', () => {
    writeSessions(dir, 'sessions-cli_a.json', { s1: { status: 'active' }, s2: { status: 'closed' }, s3: { status: 'active' } });
    writeSessions(dir, 'sessions-cli_b.json', { s4: { status: 'active' } });
    writeSessions(dir, 'sessions.json', { s5: { status: 'active' }, s6: { status: 'closed' } });
    expect(countActiveSessionsOnDisk(dir)).toBe(4);
  });

  it('returns 0 for an empty / missing data dir', () => {
    expect(countActiveSessionsOnDisk(dir)).toBe(0);
    expect(countActiveSessionsOnDisk(join(dir, 'nope'))).toBe(0);
  });

  it('ignores non-session files and corrupt session files', () => {
    writeSessions(dir, 'sessions-cli_a.json', { s1: { status: 'active' } });
    writeFileSync(join(dir, 'schedules.json'), JSON.stringify({ x: { status: 'active' } })); // not a session file
    writeFileSync(join(dir, 'sessions-bad.json'), '{corrupt');
    expect(countActiveSessionsOnDisk(dir)).toBe(1);
  });
});

describe('buildRestartReportText', () => {
  it('plain restart: version + session count + dashboard link, no changelog', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '2.65.0',
      sessionCount: 3,
      dashboardUrl: 'http://10.0.0.1:7891/?t=abc',
    });
    expect(md).toContain('2.65.0');
    expect(md).toContain('3');
    expect(md).toContain('http://10.0.0.1:7891/?t=abc');
    expect(md.toLowerCase()).not.toContain('changelog');
  });

  it('adds a local ip:port fallback line when the dashboard link is a platform URL', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '2.65.0',
      sessionCount: 0,
      dashboardUrl: 'https://m-deadbeef.example/?t=tok',
      dashboardLocalUrl: 'http://10.0.0.1:7891/?t=tok',
    });
    expect(md).toContain('https://m-deadbeef.example/?t=tok'); // platform primary
    expect(md).toContain('http://10.0.0.1:7891/?t=tok');       // local fallback
  });

  it('omits the local fallback line when there is no platform URL (local-only host)', () => {
    const md = buildRestartReportText({
      kind: 'manual',
      version: '2.65.0',
      sessionCount: 0,
      dashboardUrl: 'http://10.0.0.1:7891/?t=tok',
    });
    // Only the single dashboard line — no separate "本地直连 / Local direct" line.
    expect(md).not.toMatch(/本地直连|Local direct/);
  });

  it('update restart: shows old→new and the changelog body', () => {
    const md = buildRestartReportText({
      kind: 'update',
      version: '2.65.0',
      sessionCount: 0,
      dashboardUrl: 'http://h/?t=x',
      oldVersion: '2.64.0',
      newVersion: '2.65.0',
      changelog: '- 修复了 X\n- 新增 Y',
    });
    expect(md).toContain('2.64.0');
    expect(md).toContain('2.65.0');
    expect(md).toContain('修复了 X');
    expect(md).toContain('新增 Y');
  });

  it('update with no changelog text still reports the version delta gracefully', () => {
    const md = buildRestartReportText({
      kind: 'update',
      version: '2.65.0',
      sessionCount: 1,
      oldVersion: '2.64.0',
      newVersion: '2.65.0',
    });
    expect(md).toContain('2.64.0');
    expect(md).toContain('2.65.0');
  });

  it('rollback restart reports the old→new delta without a changelog', () => {
    const md = buildRestartReportText({
      kind: 'rollback',
      version: '3.0.0',
      sessionCount: 0,
      oldVersion: '3.1.0',
      newVersion: '3.0.0',
      changelog: 'must not be shown',
    });
    expect(md).toContain('已回退并重启');
    expect(md).toContain('3.1.0');
    expect(md).toContain('3.0.0');
    expect(md).not.toContain('must not be shown');
  });
});

describe('sendRestartReportIfPending', () => {
  const T0 = Date.parse('2026-06-07T04:00:00.000Z');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-report-'));
    vi.stubEnv('SESSION_DATA_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeWiring(over: Partial<Parameters<typeof sendRestartReportIfPending>[0]> = {}) {
    const sent: Array<{ openId: string; card: string }> = [];
    const w = {
      primaryLarkAppId: 'cli_primary',
      ownerOpenId: 'ou_owner' as string | undefined,
      dashboardUrl: 'http://10.0.0.1:7891/?t=tok',
      sendCard: async (openId: string, card: string) => { sent.push({ openId, card }); },
      now: T0 + 5_000,
      log: () => {},
      ...over,
    };
    return { w, sent };
  }

  it('consumes a fresh intent and DMs the owner a card with the session count + dashboard link', async () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: new Date(T0).toISOString() });
    writeFileSync(join(dir, 'sessions-cli_primary.json'), JSON.stringify({ s1: { status: 'active' }, s2: { status: 'active' } }));
    const { w, sent } = fakeWiring();

    await sendRestartReportIfPending(w);

    expect(sent).toHaveLength(1);
    expect(sent[0].openId).toBe('ou_owner');
    expect(sent[0].card).toContain('http://10.0.0.1:7891/?t=tok');
    expect(sent[0].card).toContain('2'); // two active sessions
    expect(existsSync(restartIntentPathIn(dir))).toBe(false); // consumed
  });

  it('stays silent when there is no intent (crash / pm2 auto-restart)', async () => {
    const { w, sent } = fakeWiring();
    await sendRestartReportIfPending(w);
    expect(sent).toHaveLength(0);
  });

  it('consumes the intent but skips the DM when no owner is configured', async () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: new Date(T0).toISOString() });
    const { w, sent } = fakeWiring({ ownerOpenId: undefined });
    await sendRestartReportIfPending(w);
    expect(sent).toHaveLength(0);
    expect(existsSync(restartIntentPathIn(dir))).toBe(false); // still consumed (no retry storm)
  });

  it('fires at most once — a second call after consume sends nothing', async () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: new Date(T0).toISOString() });
    const { w, sent } = fakeWiring();
    await sendRestartReportIfPending(w);
    await sendRestartReportIfPending(w);
    expect(sent).toHaveLength(1);
  });

  it('atomically reclaims a commit that lands after the prepared observation', async () => {
    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: new Date(T0).toISOString() },
      T0,
      'attempt-full-fleet',
    );
    const wait = vi.fn(async () => {
      // Commit occurs strictly between two report-claim operations. There is
      // no separate hasPrepared read whose false result can lose this commit.
      expect(commitRestartIntentAttemptTo(dir, 'attempt-full-fleet')).toBe(true);
    });
    const { w, sent } = fakeWiring({
      wait,
      preparedCommitWaitMs: 100,
    });

    await sendRestartReportIfPending(w);

    expect(wait).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });
});

describe('fetchChangelog', () => {
  it('adds GitHub bearer auth when githubToken is configured', async () => {
    let auth: string | null = null;
    const notes = await fetchChangelog('2.85.1', {
      auth: { env: { GITHUB_TOKEN: ' ghp_secret ' }, envFilePath: null },
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        auth = headers?.Authorization ?? headers?.authorization ?? null;
        return { ok: true, json: async () => ({ body: 'notes' }) } as Response;
      },
    });
    expect(notes).toBe('notes');
    expect(auth).toBe('Bearer ghp_secret');
  });

  it('omits GitHub bearer auth when githubToken is blank', async () => {
    let auth: string | null = 'present';
    await fetchChangelog('2.85.1', {
      auth: { env: { GITHUB_TOKEN: '   ' }, envFilePath: null },
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        auth = headers?.Authorization ?? headers?.authorization ?? null;
        return { ok: true, json: async () => ({ body: 'notes' }) } as Response;
      },
    });
    expect(auth).toBeNull();
  });

  it('uses env-file auth fallback when process env is unset', async () => {
    let auth: string | null = null;
    await fetchChangelog('2.85.1', {
      auth: {
        env: {},
        envFilePath: '/tmp/global.env',
        fileExists: () => true,
        readTextFile: () => 'GITHUB_TOKEN=ghp_from_file\n',
      },
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        auth = headers?.Authorization ?? headers?.authorization ?? null;
        return { ok: true, json: async () => ({ body: 'notes' }) } as Response;
      },
    });
    expect(auth).toBe('Bearer ghp_from_file');
  });
});
