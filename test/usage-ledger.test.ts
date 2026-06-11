/**
 * Usage ledger tests — per-turn token usage deltas appended to daily JSONL.
 *
 * The ledger is the durable contract consumed by external trackers (kaboo):
 * each record is a self-describing JSON line with positive token deltas and
 * cumulative snapshots for self-validation.
 *
 * Run:  pnpm vitest run test/usage-ledger.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
}));

import { getSessionTokenUsage } from '../src/core/cost-calculator.js';
import {
  recordSessionUsage,
  anchorSessionUsage,
  recordUsageForDaemonSession,
  anchorUsageForDaemonSession,
  reconcileUsageForDaemonSession,
  recordSessionOwnership,
  recordOwnershipForDaemonSession,
  __resetUsageLedgerMemoryForTest,
  type UsageLedgerRecord,
} from '../src/services/usage-ledger.js';
import type { SessionTokenUsage } from '../src/core/cost-calculator.js';

function cumulative(input: number, output: number, cacheRead = 0, cacheCreate = 0, model = 'claude-opus-4-7'): SessionTokenUsage {
  return {
    in: input + cacheRead + cacheCreate,
    out: output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    model,
    turns: 1,
  };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    larkAppId: 'cli_app',
    sessionId: 'sess-1',
    cliId: 'claude-code',
    cliSessionId: 'cli-sess-1',
    chatId: 'oc_chat',
    title: '修复支付回调',
    workingDir: '/repo',
    callerOpenId: 'ou_caller',
    now: new Date('2026-06-10T12:00:00Z'),
    ...overrides,
  };
}

function ledgerLines(dir: string, date = '2026-06-10'): UsageLedgerRecord[] {
  const content = readFileSync(join(dir, `usage-${date}.jsonl`), 'utf8');
  return content.trim().split('\n').map((l) => JSON.parse(l));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
  __resetUsageLedgerMemoryForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recordSessionUsage', () => {
  it('writes the first record with the full cumulative usage as delta', () => {
    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(100, 10, 5, 2),
    });

    expect(rec).toMatchObject({
      v: 1,
      larkAppId: 'cli_app',
      sessionId: 'sess-1',
      cliId: 'claude-code',
      cliSessionId: 'cli-sess-1',
      chatId: 'oc_chat',
      title: '修复支付回调',
      workingDir: '/repo',
      callerOpenId: 'ou_caller',
      model: 'claude-opus-4-7',
      ts: '2026-06-10T12:00:00.000Z',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreateTokens: 2,
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalCacheReadTokens: 5,
      totalCacheCreateTokens: 2,
    });
    expect(rec!.recordId).toMatch(/^[0-9a-f]{32}$/);

    const lines = ledgerLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(rec);
  });

  it('emits only the positive delta on subsequent records', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const rec = recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-10T12:05:00Z'), callerOpenId: 'ou_other' }),
      ledgerDir: dir,
      usage: cumulative(250, 30),
    });

    expect(rec).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      totalInputTokens: 250,
      totalOutputTokens: 30,
      callerOpenId: 'ou_other',
    });
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it('returns null and appends nothing when usage is unchanged', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });

    expect(rec).toBeNull();
    expect(ledgerLines(dir)).toHaveLength(1);
  });

  it('resets the baseline without a record when cumulative usage shrinks', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    // /clear or transcript rotation: cumulative drops — no negative record.
    const shrunk = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(40, 5) });
    expect(shrunk).toBeNull();

    // Growth from the new baseline is measured against 40/5, not 100/10.
    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(90, 15) });
    expect(rec).toMatchObject({ inputTokens: 50, outputTokens: 10 });
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it('tracks sessions independently', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const rec = recordSessionUsage({
      ...baseArgs({ sessionId: 'sess-2', cliSessionId: 'cli-sess-2' }),
      ledgerDir: dir,
      usage: cumulative(7, 3),
    });

    expect(rec).toMatchObject({ sessionId: 'sess-2', inputTokens: 7, outputTokens: 3 });
  });

  it('rotates ledger files by UTC date', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-11T01:00:00Z') }),
      ledgerDir: dir,
      usage: cumulative(250, 30),
    });

    expect(ledgerLines(dir, '2026-06-10')).toHaveLength(1);
    expect(ledgerLines(dir, '2026-06-11')).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-')).sort()).toEqual([
      'usage-2026-06-10.jsonl',
      'usage-2026-06-11.jsonl',
    ]);
  });

  it('assigns a unique recordId per record', () => {
    const a = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const b = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(200, 20) });
    expect(a!.recordId).not.toBe(b!.recordId);
  });

  it('recovers the baseline from the ledger when state never advanced (crash replay)', () => {
    // Crash window: ledger line appended but state never advanced, then the
    // daemon restarted (in-memory latest lost too). The ledger itself is the
    // source of truth: its newest record's cumulative totals re-seed the
    // baseline, so neither a same-snapshot replay nor a grown snapshot can
    // double count the already-recorded interval.
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });

    const statePath = readdirSync(dir).find((f) => f.startsWith('state'));
    writeFileSync(join(dir, statePath!), JSON.stringify({ v: 1, sessions: {} }));
    __resetUsageLedgerMemoryForTest(); // simulate process restart

    // Same snapshot replay → nothing new to record.
    expect(recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-10T12:01:00Z') }),
      ledgerDir: dir,
      usage: cumulative(100, 10),
    })).toBeNull();

    // Grown snapshot → only the残余 delta beyond the ledger's latest totals.
    const b = recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-10T12:02:00Z') }),
      ledgerDir: dir,
      usage: cumulative(150, 15),
    });
    expect(b).toMatchObject({ inputTokens: 50, outputTokens: 5 });
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it('recovers a stale (not just missing) baseline from the ledger', () => {
    // Crash after appending 100→150 with the state save lost: state still says
    // 100 while the ledger's newest record says 150. The newer one must win.
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const statePath = join(dir, readdirSync(dir).find((f) => f.startsWith('state'))!);
    const stateAt100 = readFileSync(statePath, 'utf8');
    recordSessionUsage({ ...baseArgs({ now: new Date('2026-06-10T12:01:00Z') }), ledgerDir: dir, usage: cumulative(150, 15) });
    writeFileSync(statePath, stateAt100); // roll the state back to 100/10
    __resetUsageLedgerMemoryForTest();

    const rec = recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-10T12:02:00Z') }),
      ledgerDir: dir,
      usage: cumulative(180, 18),
    });
    expect(rec).toMatchObject({ inputTokens: 30, outputTokens: 3 });
  });

  it('does not reuse recordIds across reset epochs for identical transitions', () => {
    // 0→(100,10), then shrink-reset, then 0→(100,10) again: same totals pair
    // but a REAL second delta — the reset epoch must keep the ids distinct.
    const a = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(0, 0) }); // shrink → re-anchor
    const b = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.recordId).not.toBe(a!.recordId);
  });

  it('keeps per-bot baselines in separate state files', () => {
    recordSessionUsage({ ...baseArgs({ larkAppId: 'cli_a' }), ledgerDir: dir, usage: cumulative(100, 10) });
    recordSessionUsage({
      ...baseArgs({ larkAppId: 'cli_b', sessionId: 'sess-other' }),
      ledgerDir: dir,
      usage: cumulative(7, 3),
    });

    const stateFiles = readdirSync(dir).filter((f) => f.startsWith('state')).sort();
    expect(stateFiles.some((f) => f.includes('cli_a'))).toBe(true);
    expect(stateFiles.some((f) => f.includes('cli_b'))).toBe(true);

    // cli_b's write must not clobber cli_a's baseline: the next cli_a record
    // is still a delta, not a fresh full-cumulative dump.
    const rec = recordSessionUsage({ ...baseArgs({ larkAppId: 'cli_a' }), ledgerDir: dir, usage: cumulative(150, 12) });
    expect(rec).toMatchObject({ inputTokens: 50, outputTokens: 2 });
  });
});

describe('anchorSessionUsage', () => {
  it('sets the baseline without writing a record', () => {
    anchorSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });

    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);

    // Growth is measured from the anchored baseline, not from zero.
    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(250, 30) });
    expect(rec).toMatchObject({ inputTokens: 150, outputTokens: 20 });
  });

  it('overwrites an existing baseline (resume re-anchor)', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    // Transcript grew outside botmux (e.g. direct tmux use while daemon was
    // down) — re-anchoring on spawn keeps that growth out of the ledger.
    anchorSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(180, 25) });

    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(200, 30) });
    expect(rec).toMatchObject({ inputTokens: 20, outputTokens: 5 });
    expect(ledgerLines(dir)).toHaveLength(2);
  });
});

describe('daemon-session wrappers', () => {
  const ds = {
    larkAppId: 'cli_app',
    workingDir: '/live-repo',
    session: {
      sessionId: 'sess-1',
      cliId: 'claude-code',
      cliSessionId: 'cli-sess-1',
      chatId: 'oc_chat',
      title: '修复支付回调',
      workingDir: '/stored-repo',
      lastCallerOpenId: 'ou_last',
      creatorOpenId: 'ou_creator',
    },
  } as any;

  beforeEach(() => {
    vi.mocked(getSessionTokenUsage).mockReset();
    vi.mocked(getSessionTokenUsage).mockReturnValue(null);
  });

  it('snapshots the transcript and appends the delta record', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(100, 10));

    const rec = recordUsageForDaemonSession(ds, { ledgerDir: dir, now: new Date('2026-06-10T12:00:00Z') });

    expect(getSessionTokenUsage).toHaveBeenCalledWith({
      cliId: 'claude-code',
      sessionId: 'sess-1',
      cliSessionId: 'cli-sess-1',
      cwd: '/live-repo',
      fresh: true,
    });
    expect(rec).toMatchObject({
      sessionId: 'sess-1',
      larkAppId: 'cli_app',
      cliId: 'claude-code',
      chatId: 'oc_chat',
      title: '修复支付回调',
      workingDir: '/live-repo',
      callerOpenId: 'ou_last',
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it('does nothing when the transcript has no usage', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(null);

    expect(recordUsageForDaemonSession(ds, { ledgerDir: dir })).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);
  });

  it('anchorUsageForDaemonSession anchors without recording', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(500, 50));
    anchorUsageForDaemonSession(ds, { ledgerDir: dir });
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);

    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(620, 80));
    const rec = recordUsageForDaemonSession(ds, { ledgerDir: dir });
    expect(rec).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });
});

describe('reconcileUsageForDaemonSession (daemon restart)', () => {
  const ds = {
    larkAppId: 'cli_app',
    workingDir: '/live-repo',
    session: {
      sessionId: 'sess-r',
      cliId: 'claude-code',
      cliSessionId: 'cli-sess-r',
      chatId: 'oc_chat',
      title: '重启恢复',
      lastCallerOpenId: 'ou_last',
    },
  } as any;

  beforeEach(() => {
    vi.mocked(getSessionTokenUsage).mockReset();
    vi.mocked(getSessionTokenUsage).mockReturnValue(null);
  });

  it('records the catch-up delta when a baseline exists (turn finished while daemon was down)', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(100, 10));
    recordUsageForDaemonSession(ds, { ledgerDir: dir });

    // The in-flight turn completed inside tmux during the crash window.
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(200, 20));
    const rec = reconcileUsageForDaemonSession(ds, { ledgerDir: dir });

    expect(rec).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it('anchors without recording when the session is new to the ledger', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(500, 50));
    expect(reconcileUsageForDaemonSession(ds, { ledgerDir: dir })).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);

    // Growth after the anchor is measured from it, not from zero.
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(600, 70));
    expect(recordUsageForDaemonSession(ds, { ledgerDir: dir })).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
    });
  });
});

describe('ownership records', () => {
  it('writes a zero-delta ownership marker with a deterministic recordId', () => {
    const rec = recordSessionOwnership({
      ...baseArgs(),
      ledgerDir: dir,
    });

    expect(rec).toMatchObject({
      v: 1,
      kind: 'ownership',
      sessionId: 'sess-1',
      cliSessionId: 'cli-sess-1',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
    expect(ledgerLines(dir)).toHaveLength(1);

    // Same process: repeated markers are suppressed entirely.
    expect(recordSessionOwnership({ ...baseArgs(), ledgerDir: dir })).toBeNull();
    expect(ledgerLines(dir)).toHaveLength(1);

    // Across a restart the line may repeat, but with the SAME recordId so the
    // consumer's DedupKey collapses it.
    __resetUsageLedgerMemoryForTest();
    const again = recordSessionOwnership({ ...baseArgs({ now: new Date('2026-06-10T13:00:00Z') }), ledgerDir: dir });
    expect(again!.recordId).toBe(rec!.recordId);
  });

  it('skips when cliSessionId is unknown', () => {
    expect(recordSessionOwnership({ ...baseArgs({ cliSessionId: undefined }), ledgerDir: dir })).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);
  });

  it('ownership markers never act as recovery baselines', () => {
    // usage record 100/10, then an ownership marker (totals 0) lands AFTER it.
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    recordSessionOwnership({ ...baseArgs({ now: new Date('2026-06-10T12:30:00Z') }), ledgerDir: dir });

    // State and memory lost: recovery must use the USAGE record (100/10) as
    // baseline, not the newer zero-total ownership marker — otherwise the
    // next snapshot would re-bill the whole 150.
    const statePath = readdirSync(dir).find((f) => f.startsWith('state'));
    writeFileSync(join(dir, statePath!), JSON.stringify({ v: 1, sessions: {} }));
    __resetUsageLedgerMemoryForTest();

    const rec = recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-10T13:00:00Z') }),
      ledgerDir: dir,
      usage: cumulative(150, 15),
    });
    expect(rec).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('recordOwnershipForDaemonSession does not require a readable transcript', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(null);
    const ds = {
      larkAppId: 'cli_app',
      workingDir: '/live-repo',
      session: {
        sessionId: 'sess-own',
        cliId: 'claude-code',
        cliSessionId: 'cli-sess-own',
        chatId: 'oc_chat',
        title: '新会话',
        lastCallerOpenId: 'ou_last',
      },
    } as any;

    const rec = recordOwnershipForDaemonSession(ds, { ledgerDir: dir });
    expect(rec).toMatchObject({ kind: 'ownership', cliSessionId: 'cli-sess-own' });
  });
});
