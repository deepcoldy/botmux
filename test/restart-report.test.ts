import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countActiveSessionsOnDisk } from '../src/services/session-store.js';
import { buildRestartReportText, sendRestartReportIfPending } from '../src/core/restart-report.js';
import { writeRestartIntentTo, restartIntentPathIn } from '../src/services/restart-intent-store.js';

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
});
