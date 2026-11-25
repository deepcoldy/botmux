import { afterEach, describe, expect, it } from 'vitest';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AntigravityNativeQuotaLog,
  currentAntigravityNativeQuota,
  ingestAntigravityNativeLogLine,
  type AntigravityNativeLogState,
} from '../src/services/antigravity-native-quota.js';
import { supportsAntigravityReadyFooterQuota } from '../src/adapters/cli/antigravity.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const tempDirs: string[] = [];
const openFds: number[] = [];

function makeTempDir(prefix = 'agy-native-quota-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const fd of openFds.splice(0)) {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const EXECUTOR_QUOTA_LINE = (ts: string, duration = '2h39m35s') =>
  `${ts} 200 errorreport.go:282] agent executor error: generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.`;

const INPUT_LINE = (text: string, ts = 'I1123 20:52:20.000000') =>
  `${ts} 100 input_loop.go:104] HandleUserInput called with text: ${JSON.stringify(text)}`;

describe('Antigravity native quota log reader and correlation', () => {
  it('gates shortcuts-footer quota promotion strictly to verified agy >= 1.5.15', () => {
    expect(supportsAntigravityReadyFooterQuota('1.5.15')).toBe(true);
    expect(supportsAntigravityReadyFooterQuota('1.5.16')).toBe(true);
    expect(supportsAntigravityReadyFooterQuota('1.6.0')).toBe(true);
    expect(supportsAntigravityReadyFooterQuota('2.0.0+build.1')).toBe(true);
    expect(supportsAntigravityReadyFooterQuota('1.5.14')).toBe(false);
    expect(supportsAntigravityReadyFooterQuota('1.2.13')).toBe(false);
    expect(supportsAntigravityReadyFooterQuota('unknown')).toBe(false);
    expect(supportsAntigravityReadyFooterQuota('')).toBe(false);
    expect(supportsAntigravityReadyFooterQuota(undefined)).toBe(false);
  });

  it('correlates executor ResourceExhausted 429 lines and rejects generic errorreport lines even with RESOURCE_EXHAUSTED (code 429)', () => {
    const state: AntigravityNativeLogState = { inputSequence: 0 };
    ingestAntigravityNativeLogLine(state, INPUT_LINE('do work\r\nline 2'));
    // Generic errorreport.go:282 line WITHOUT `agent executor error:` MUST be ignored.
    ingestAntigravityNativeLogLine(
      state,
      'E1123 20:52:28.100000 200 errorreport.go:282] generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Resets in 2h39m35s.: RESOURCE_EXHAUSTED (code 429)',
    );
    expect(currentAntigravityNativeQuota(state, 'do work\nline 2')).toBeUndefined();

    // Quoted/model text without transport + RESOURCE_EXHAUSTED markers MUST be ignored.
    ingestAntigravityNativeLogLine(
      state,
      'I1123 20:52:28.200000 200 output.go:42] agent executor error: Individual quota reached. Resets in 2h39m35s.',
    );
    expect(currentAntigravityNativeQuota(state, 'do work\nline 2')).toBeUndefined();

    // Real executor 429 line matches with CRLF normalization.
    ingestAntigravityNativeLogLine(state, EXECUTOR_QUOTA_LINE('E1123 20:52:28.722278'));
    const matched = currentAntigravityNativeQuota(state, 'do work\nline 2');
    expect(matched).toMatchObject({
      nativeEpisodeKey: 'log:E1123 20:52:28.722278',
      inputSequence: 1,
    });
    expect(matched?.text).toContain('Resets in 2h39m35s.');

    // Mismatched worker input fails correlation.
    expect(currentAntigravityNativeQuota(state, 'different prompt')).toBeUndefined();

    // Identical resend bumps inputSequence and invalidates the older refusal.
    ingestAntigravityNativeLogLine(state, INPUT_LINE('do work\nline 2', 'I1123 20:53:00.000000'));
    expect(currentAntigravityNativeQuota(state, 'do work\nline 2')).toBeUndefined();
  });

  it('drains >256 KiB logs from byte 0 on initial read and large incremental appends without truncation', () => {
    const root = makeTempDir();
    const reader = new AntigravityNativeQuotaLog('sess-big', root);
    mkdirSync(dirname(reader.path), { recursive: true });

    // Initial log > 370 KiB with HandleUserInput at start and quota refusal past 370 KiB.
    const noiseLine = `I1123 20:52:21.000000 100 trace.go:10] ${'x'.repeat(1000)}\n`;
    const initialContent = `${INPUT_LINE('big initial task')}\n${noiseLine.repeat(370)}${EXECUTOR_QUOTA_LINE('E1123 20:52:28.111111', '3h10m0s')}\n`;
    expect(Buffer.byteLength(initialContent, 'utf8')).toBeGreaterThan(370 * 1024);
    writeFileSync(reader.path, initialContent);

    const first = currentAntigravityNativeQuota(reader.read(), 'big initial task');
    expect(first?.nativeEpisodeKey).toBe('log:E1123 20:52:28.111111');
    expect(first?.text).toContain('3h10m0s');

    // Incremental append > 350 KiB drained in a single read().
    const appendContent = `${INPUT_LINE('second large turn', 'I1123 20:55:00.000000')}\n${noiseLine.repeat(350)}${EXECUTOR_QUOTA_LINE('E1123 20:55:10.222222', '1h20m0s')}\n`;
    writeFileSync(reader.path, initialContent + appendContent);

    const second = currentAntigravityNativeQuota(reader.read(), 'second large turn');
    expect(second?.nativeEpisodeKey).toBe('log:E1123 20:55:10.222222');
    expect(second?.text).toContain('1h20m0s');
  });

  it('resets cleanly on same-inode O_TRUNC even when replacement log is larger, and via reset()', () => {
    const root = makeTempDir();
    const reader = new AntigravityNativeQuotaLog('sess-trunc', root);
    mkdirSync(dirname(reader.path), { recursive: true });

    const small = `${INPUT_LINE('old turn')}\n${EXECUTOR_QUOTA_LINE('E1123 20:00:01.000000')}\n`;
    writeFileSync(reader.path, small);
    expect(currentAntigravityNativeQuota(reader.read(), 'old turn')?.nativeEpisodeKey).toBe('log:E1123 20:00:01.000000');

    // Shrink truncation (size < offset) resets automatically.
    const shorter = `${INPUT_LINE('short')}\n`;
    writeFileSync(reader.path, shorter);
    expect(currentAntigravityNativeQuota(reader.read(), 'short')).toBeUndefined();

    // Same-inode O_TRUNC followed by a LARGER log requires explicit reset() (spawn/kill, regression case).
    const larger = `${INPUT_LINE('new proc turn')}\n${'I1123 21:00:00.000000 1 a.go:1] pad\n'.repeat(20)}${EXECUTOR_QUOTA_LINE('E1123 21:00:05.000000', '45m')}\n`;
    writeFileSync(reader.path, larger);
    reader.reset();
    const afterReset = currentAntigravityNativeQuota(reader.read(), 'new proc turn');
    expect(afterReset?.nativeEpisodeKey).toBe('log:E1123 21:00:05.000000');
    expect(afterReset?.text).toContain('45m');
  });

  it('preserves multi-byte UTF-8 (Chinese & emoji) split across 256 KiB chunk boundaries on initial and incremental reads', () => {
    const chunkBytes = 256 * 1024;
    const targetInput = '中文任务🙂继续执行';
    const inputLine = `${INPUT_LINE(targetInput)}\n`;
    const quotaLine = `${EXECUTOR_QUOTA_LINE('E1123 22:00:01.000000', '2h')}\n`;

    // Test every split offset across the multi-byte characters in initial read.
    const markerOffset = Buffer.byteLength(INPUT_LINE('').slice(0, -1), 'utf8');
    for (const shift of [1, 2, 3, 4, 5, 6, 7]) {
      const root = makeTempDir();
      const reader = new AntigravityNativeQuotaLog(`utf8-init-${shift}`, root);
      mkdirSync(dirname(reader.path), { recursive: true });
      const padLen = chunkBytes - markerOffset - shift;
      const prefix = `${'a'.repeat(padLen - 1)}\n`;
      writeFileSync(reader.path, prefix + inputLine + quotaLine);
      const res = currentAntigravityNativeQuota(reader.read(), targetInput);
      expect(res?.nativeEpisodeKey).toBe('log:E1123 22:00:01.000000');
    }

    // Incremental read splitting multi-byte UTF-8 across chunk boundary.
    const root = makeTempDir();
    const reader = new AntigravityNativeQuotaLog('utf8-inc', root);
    mkdirSync(dirname(reader.path), { recursive: true });
    const base = 'I1123 21:00:00.000000 1 boot.go:1] ready\n';
    writeFileSync(reader.path, base);
    expect(reader.read().inputSequence).toBe(0);

    const padLen = chunkBytes - markerOffset - 2;
    const appended = `${'b'.repeat(padLen - 1)}\n${inputLine}${quotaLine}`;
    writeFileSync(reader.path, base + appended);
    const inc = currentAntigravityNativeQuota(reader.read(), targetInput);
    expect(inc?.nativeEpisodeKey).toBe('log:E1123 22:00:01.000000');
  });

  it('opts ACP runner-framed sessions out of native-log quota reading', () => {
    const root = makeTempDir();
    const reader = new AntigravityNativeQuotaLog('sess-acp', root);
    mkdirSync(dirname(reader.path), { recursive: true });
    writeFileSync(reader.path, `${INPUT_LINE('hello')}\n${EXECUTOR_QUOTA_LINE('E1123 22:00:01.000000')}\n`);

    const readNative = loadWorkerFunction<() => unknown>('readAntigravityNativeQuota', {
      cliAdapter: { id: 'antigravity', runnerFramedInput: true },
      effectiveBackendType: 'pty',
      lastInitConfig: { cliVersion: '1.5.15' },
      sessionId: 'sess-acp',
      antigravityNativeQuotaLog: reader,
      lastWrittenCliInput: { content: 'hello' },
    });
    expect(readNative()).toBeUndefined();
  });

  it('resolves worker direct-failure proof via double-birth-attested live PID without reply bridge, failing closed on missing/ambiguous/conflict/stale Web Terminal input', () => {
    const root = makeTempDir();
    const convA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const convB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const writePair = (cid: string, lines: string[]) => {
      const dir = join(root, 'brain', cid, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      const content = lines.join('\n') + '\n';
      writeFileSync(join(dir, 'transcript_full.jsonl'), content);
      writeFileSync(join(dir, 'transcript.jsonl'), content);
      return join(dir, 'transcript_full.jsonl');
    };
    const userLine = JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\ndo work\n</USER_REQUEST>',
    });
    const toolLine = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '',
      tool_calls: [{ name: 'run_command' }],
    });
    const pathA = writePair(convA, [userLine]);
    const pathB = writePair(convB, [userLine, toolLine]);

    const baseLimit = {
      limited: true as const,
      kind: 'usage' as const,
      retryAtMs: Date.now() + 60_000,
      retryLabel: '1m',
      retryReady: false,
      source: 'antigravity-native-log' as const,
      nativeEpisodeKey: 'log:E1123 20:52:28.722278',
    };

    const makeProofRunner = (opts: {
      live: { kind: 'unique'; conversationId: string } | { kind: 'ambiguous' } | { kind: 'missing' };
      storedId?: string;
      bridgePath?: string;
      attested?: { cliPid: number; cliProcStart: string; cliSpawnGeneration: number };
      birthMatches?: boolean;
      webSubmitGen?: number;
    }) => {
      const scope: Record<string, unknown> = {
        cliAdapter: { id: 'antigravity' },
        cliSpawnGeneration: 1,
        lastWrittenCliInputSpawnGen: 1,
        lastWrittenCliInputWebSubmitGen: 0,
        webTerminalSubmitGeneration: opts.webSubmitGen ?? 0,
        lastInitConfig: { cliId: 'antigravity', cliSessionId: opts.storedId, adoptMode: false },
        effectiveBackendType: 'pty',
        inputDeliveryObservedCliSessionId: undefined,
        lastSpawnEffectiveCliSessionId: opts.storedId,
        codexBridgeRolloutPath: opts.bridgePath,
        localAttestedCliProcess: opts.attested ?? { cliPid: 12345, cliProcStart: 'birth-ok', cliSpawnGeneration: 1 },
        findAttestedAntigravityConversationId: (att: { cliPid?: number; cliProcStart?: string } | undefined) => {
          if (!att?.cliPid || !att.cliProcStart || opts.birthMatches === false) return null;
          return opts.live.kind === 'unique' ? opts.live.conversationId : null;
        },
        resolveAntigravityTranscriptPath: (cid: string) => (cid === convA ? pathA : cid === convB ? pathB : null),
        lastWrittenCliInput: { content: 'do work' },
      };
      scope.currentAntigravityWrittenInput = loadWorkerFunction('currentAntigravityWrittenInput', scope);
      scope.resolveAntigravityProofTranscriptPath = loadWorkerFunction('resolveAntigravityProofTranscriptPath', scope);
      return loadWorkerFunction<(limit: typeof baseLimit) => typeof baseLimit>('withAntigravityDirectFailureProof', scope);
    };

    // Prompt-injection session with codexBridgeRolloutPath=undefined still proves clean failure via attested live PID.
    const noBridgeClean = makeProofRunner({ live: { kind: 'unique', conversationId: convA }, storedId: convA });
    expect(noBridgeClean(baseLimit).directFailure).toBe(true);

    // Stored clean A vs live progressed B conflict MUST fail closed.
    const conflict = makeProofRunner({ live: { kind: 'unique', conversationId: convB }, storedId: convA });
    expect(conflict(baseLimit).directFailure).toBeUndefined();

    // Ambiguous live PID MUST fail closed with zero fallback to stored A or bridgePath.
    const ambiguous = makeProofRunner({ live: { kind: 'ambiguous' }, storedId: convA, bridgePath: pathA });
    expect(ambiguous(baseLimit).directFailure).toBeUndefined();

    // Missing live PID or mismatched process birth MUST fail closed with zero fallback to stored A or bridgePath.
    const missingLive = makeProofRunner({ live: { kind: 'missing' }, storedId: convA, bridgePath: pathA });
    expect(missingLive(baseLimit).directFailure).toBeUndefined();

    const wrongBirth = makeProofRunner({ live: { kind: 'unique', conversationId: convA }, storedId: convA, birthMatches: false });
    expect(wrongBirth(baseLimit).directFailure).toBeUndefined();

    // After a direct Web Terminal submission, stale Lark lastWrittenCliInput cannot grant directFailure proof.
    const staleAfterWebSubmit = makeProofRunner({ live: { kind: 'unique', conversationId: convA }, storedId: convA, webSubmitGen: 1 });
    expect(staleAfterWebSubmit(baseLimit).directFailure).toBeUndefined();

    // Stale Lark lastWrittenCliInput does NOT blind readAntigravityNativeQuota after a direct Web Terminal submit.
    const logRoot = makeTempDir();
    const nativeReader = new AntigravityNativeQuotaLog('sess-webterm', logRoot);
    mkdirSync(dirname(nativeReader.path), { recursive: true });
    writeFileSync(
      nativeReader.path,
      `${INPUT_LINE('prompt typed in web terminal')}\n${EXECUTOR_QUOTA_LINE('E1125 00:02:05.000000', '1h')}\n`,
    );
    const readScope: Record<string, unknown> = {
      cliAdapter: { id: 'antigravity' },
      effectiveBackendType: 'pty',
      lastInitConfig: { cliVersion: '1.5.15' },
      sessionId: 'sess-webterm',
      antigravityNativeQuotaLog: nativeReader,
      cliSpawnGeneration: 1,
      lastWrittenCliInputSpawnGen: 1,
      lastWrittenCliInputWebSubmitGen: 0,
      webTerminalSubmitGeneration: 1,
      lastWrittenCliInput: { content: 'earlier lark message' },
    };
    readScope.currentAntigravityWrittenInput = loadWorkerFunction('currentAntigravityWrittenInput', readScope);
    const readNative = loadWorkerFunction<() => any>('readAntigravityNativeQuota', readScope);
    expect(readNative()?.nativeEpisodeKey).toBe('log:E1125 00:02:05.000000');

    // Real procfs symlink layout with 2 presence locks -> ambiguous.
    const procRoot = join(root, 'proc');
    const fdDir = join(procRoot, '55555', 'fd');
    const presenceDir = join(root, 'presence');
    mkdirSync(fdDir, { recursive: true });
    mkdirSync(presenceDir, { recursive: true });
    writeFileSync(join(presenceDir, `${convA}.lock`), '');
    writeFileSync(join(presenceDir, `${convB}.lock`), '');
    symlinkSync(join(presenceDir, `${convA}.lock`), join(fdDir, '3'));
    symlinkSync(join(presenceDir, `${convB}.lock`), join(fdDir, '4'));
    const fakeLock = openSync(join(presenceDir, `${convA}.lock`), 'r');
    openFds.push(fakeLock);
    closeSync(fakeLock);
    openFds.pop();
  });
});
