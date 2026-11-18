import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = vi.hoisted(() => ({ rollout: '', segments: [] as string[] }));
vi.mock('../src/services/transcript-resolver.js', () => ({
  resolveSessionTranscriptPath: () => ({ path: paths.rollout }),
  resolveSessionTranscriptPaths: () => paths.segments.length ? paths.segments : [paths.rollout],
  cachedTranscriptPathLookup: (_key: string, lookup: () => unknown) => lookup(),
  __resetTranscriptResolverCacheForTest: () => {},
  kimiEnvForBot: () => ({}),
}));
import { getSessionTokenUsage, __resetSessionUsageCachesForTest } from '../src/core/cost-calculator.js';
import { recordSessionUsage, recordUsageForDaemonSession, reconcileUsageForDaemonSession, __resetUsageLedgerMemoryForTest } from '../src/services/usage-ledger.js';

describe('native rollout to restored ledger', () => {
  it('recovers repeated-prefix continuation segments without double counting', () => {
    __resetUsageLedgerMemoryForTest();
    __resetSessionUsageCachesForTest();
    const root = mkdtempSync(join(tmpdir(), 'recovery-segments-'));
    try {
      const context = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n';
      const point = (input: number, hour: string) => JSON.stringify({ type: 'event_msg', timestamp: `2026-01-01T${hour}:00:00Z`,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } } }) + '\n';
      const first = join(root, 'first.jsonl');
      paths.rollout = join(root, 'second.jsonl');
      paths.segments = [first, paths.rollout];
      writeFileSync(first, context('a') + point(100, '10') + point(150, '11'));
      writeFileSync(paths.rollout, context('a') + point(100, '10') + point(150, '11') + context('b') + point(200, '12'));
      const ledgerDir = join(root, 'ledger');
      const snapshot = (input: number) => ({ in: input, out: 0, inputTokens: input, outputTokens: 0,
        cacheReadTokens: 0, cacheCreateTokens: 0, model: 'a', turns: 0 });
      recordSessionUsage({ sessionId: 'segments', cliId: 'codex', ledgerDir, usage: snapshot(100) });
      const ds = { session: { sessionId: 'segments', cliId: 'codex', cliSessionId: 'segments-native' } } as any;
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toMatchObject({ inputTokens: 50, model: 'b' });
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
    } finally { paths.segments = []; rmSync(root, { recursive: true, force: true }); }
  });
  it('retains an unresolvable interval and accounts it once after the missing checkpoint returns', () => {
    __resetUsageLedgerMemoryForTest();
    __resetSessionUsageCachesForTest();
    const root = mkdtempSync(join(tmpdir(), 'recovery-pending-'));
    try {
      paths.rollout = join(root, 'rollout.jsonl');
      const ledgerDir = join(root, 'ledger');
      const context = JSON.stringify({ type: 'turn_context', payload: { model: 'model-a' } }) + '\n';
      const point = (input: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T12:00:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } } }) + '\n';
      const ds = { session: { sessionId: 'pending', cliId: 'codex', cliSessionId: 'native' } } as any;
      const query = { cliId: 'codex' as const, sessionId: 'pending', cliSessionId: 'native', fresh: true };
      writeFileSync(paths.rollout, context + point(100));
      recordSessionUsage({ sessionId: 'pending', cliId: 'codex', usage: getSessionTokenUsage(query)!, ledgerDir });
      writeFileSync(paths.rollout, context + point(200));
      __resetSessionUsageCachesForTest();
      expect(recordUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
      const state = JSON.parse(readFileSync(join(ledgerDir, 'state-default.json'), 'utf8'));
      expect(state.sessions.pending.inputTokens).toBe(100);
      writeFileSync(paths.rollout, context + point(100) + point(200));
      __resetSessionUsageCachesForTest();
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })?.inputTokens).toBe(100);
      expect(recordUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('starts a new epoch after a reset and records later growth after restart', () => {
    __resetUsageLedgerMemoryForTest();
    __resetSessionUsageCachesForTest();
    const root = mkdtempSync(join(tmpdir(), 'recovery-reset-'));
    try {
      paths.rollout = join(root, 'rollout.jsonl');
      const ledgerDir = join(root, 'ledger');
      const context = JSON.stringify({ type: 'turn_context', payload: { model: 'model-a' } }) + '\n';
      const point = (input: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T12:00:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } } }) + '\n';
      const ds = { session: { sessionId: 'reset', cliId: 'codex', cliSessionId: 'native-reset' } } as any;
      writeFileSync(paths.rollout, context + point(100));
      recordUsageForDaemonSession(ds, { ledgerDir });
      writeFileSync(paths.rollout, context + point(20));
      __resetSessionUsageCachesForTest();
      expect(recordUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
      writeFileSync(paths.rollout, context + point(20) + point(40));
      __resetUsageLedgerMemoryForTest();
      __resetSessionUsageCachesForTest();
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toMatchObject({ inputTokens: 20, epoch: 1 });
      expect(recordUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers growth on both sides of a reset during downtime', () => {
    __resetUsageLedgerMemoryForTest();
    __resetSessionUsageCachesForTest();
    const root = mkdtempSync(join(tmpdir(), 'recovery-unseen-reset-'));
    try {
      paths.rollout = join(root, 'rollout.jsonl');
      const ledgerDir = join(root, 'ledger');
      const point = (input: number, hour: number) => JSON.stringify({
        type: 'event_msg', timestamp: `2026-01-01T${hour}:00:00Z`,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } },
      }) + '\n';
      // Corruption outside the recovered interval cannot permanently block it.
      const prefix = 'invalid old line\n' + JSON.stringify({type: 'turn_context', payload: {model: 'm'}}) + '\n'
        + point(100, 10);
      const ds = { session: { sessionId: 'unseen-reset', cliId: 'codex', cliSessionId: 'native-unseen-reset' } } as any;
      writeFileSync(paths.rollout, prefix);
      expect(recordUsageForDaemonSession(ds, { ledgerDir })?.inputTokens).toBe(100);
      writeFileSync(paths.rollout, prefix + point(150, 11) + point(20, 12) + point(100, 13));
      __resetUsageLedgerMemoryForTest();
      __resetSessionUsageCachesForTest();
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toMatchObject({inputTokens: 80, epoch: 1});
      __resetUsageLedgerMemoryForTest();
      __resetSessionUsageCachesForTest();
      writeFileSync(paths.rollout, prefix + point(150, 11) + point(20, 12) + point(100, 13) + point(120, 14));
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toMatchObject({inputTokens: 20, epoch: 1});
      const rows = readFileSync(join(ledgerDir, 'usage-2026-01-01.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(r => [r.inputTokens, r.epoch])).toEqual([[50, 0], [80, 1], [20, 1]]);
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([reconcileUsageForDaemonSession, recordUsageForDaemonSession])('keeps dates and models through %s and a process-memory reset', (record) => {
    __resetUsageLedgerMemoryForTest();
    __resetSessionUsageCachesForTest();
    const root = mkdtempSync(join(tmpdir(), 'recovery-'));
    try {
      paths.rollout = join(root, 'rollout.jsonl');
      const ledgerDir = join(root, 'ledger');
      const context = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
      const usage = (input: number, timestamp: string) => JSON.stringify({ type: 'event_msg', timestamp,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } } });
      const prefix = context('model-a') + '\n' + usage(100, '2026-01-01T10:00:00Z') + '\n';
      writeFileSync(paths.rollout, prefix);
      const ds = { larkAppId: 'test-app', workingDir: root,
        session: { sessionId: 'bot-session', cliSessionId: 'native-session', cliId: 'codex' } } as any;
      const query = { cliId: 'codex' as const, sessionId: 'bot-session', cliSessionId: 'native-session', fresh: true };
      recordSessionUsage({ sessionId: 'bot-session', cliId: 'codex', larkAppId: 'test-app',
        usage: getSessionTokenUsage(query)!, ledgerDir, now: new Date('2026-01-03T10:00:00Z') });
      writeFileSync(paths.rollout, prefix + usage(150, '2026-01-01T23:00:00Z') + '\n'
        + context('model-b') + '\n' + usage(200, '2026-01-02T01:00:00Z') + '\n');
      __resetUsageLedgerMemoryForTest();
      record(ds, { ledgerDir, now: new Date('2026-01-03T00:00:00Z') });
      const stateFile = readdirSync(ledgerDir).find(f => f.startsWith('state'))!;
      writeFileSync(join(ledgerDir, stateFile), JSON.stringify({ v: 1, sessions: {} }));
      __resetUsageLedgerMemoryForTest();
      expect(reconcileUsageForDaemonSession(ds, { ledgerDir })).toBeNull();
      const rows = readdirSync(ledgerDir).filter(f => f.startsWith('usage-')).sort().flatMap(f =>
        readFileSync(join(ledgerDir,f),'utf8').trim().split('\n').map(line => JSON.parse(line)));
      expect(rows.map(r => [r.ts, r.model, r.inputTokens])).toEqual([
        ['2026-01-01T23:00:00.000Z', 'model-a', 50], ['2026-01-02T01:00:00.000Z', 'model-b', 50],
        ['2026-01-03T10:00:00.000Z', 'model-a', 100],
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
