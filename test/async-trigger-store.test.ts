/**
 * Unit tests for async-trigger-store: recordPending, recordCompleted, lookup,
 * deleteResults — the durable backing that lets trigger-result survive a daemon
 * restart (design A).
 *
 * Uses a real temp directory with vi.mock to redirect config.session.dataDir,
 * mirroring frozen-card-store.test.ts.
 *
 * Run:  pnpm vitest run test/async-trigger-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  recordPending,
  recordCompleted,
  recordFailedStrict,
  recordTerminalFailureStrict,
  recordInterruptedStrict,
  lookup,
  lookupStrict,
  deleteResults,
  recordSteerParked,
  followSteerParkedChain,
} from '../src/services/async-trigger-store.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'async-trigger-store-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('recordPending + lookup', () => {
  it('returns undefined for an unknown session', () => {
    expect(lookup('nope')).toBeUndefined();
  });

  it('records a pending trigger and resolves it by sessionId (latest)', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    const got = lookup('sess1');
    expect(got?.triggerId).toBe('trg_a');
    expect(got?.result.status).toBe('pending');
    expect(got?.result.createdAt).toBe(1000);
  });

  it('resolves by explicit triggerId even when not the latest', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    recordPending('sess1', 'trg_b', 2000, 'cli_test');
    // latest is trg_b
    expect(lookup('sess1')?.triggerId).toBe('trg_b');
    // explicit still finds trg_a
    const a = lookup('sess1', 'trg_a');
    expect(a?.triggerId).toBe('trg_a');
    expect(a?.result.status).toBe('pending');
  });

  it('returns undefined for an unknown triggerId on a known session', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    expect(lookup('sess1', 'trg_missing')).toBeUndefined();
  });
});

describe('recordCompleted', () => {
  it('marks a previously-pending trigger completed with content', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    recordCompleted('sess1', 'trg_a', 'BOTMUX_RUN_OK', 5000, 'cli_test');
    const got = lookup('sess1', 'trg_a');
    expect(got?.result.status).toBe('completed');
    expect(got?.result.content).toBe('BOTMUX_RUN_OK');
    expect(got?.result.completedAt).toBe(5000);
    // createdAt preserved from the pending record
    expect(got?.result.createdAt).toBe(1000);
  });

  it('records completed even with no prior pending entry', () => {
    recordCompleted('sess1', 'trg_a', 'late', 5000, 'cli_test');
    const got = lookup('sess1', 'trg_a');
    expect(got?.result.status).toBe('completed');
    expect(got?.result.content).toBe('late');
    expect(got?.result.createdAt).toBe(5000);
  });

  it('persists content across a fresh load (simulated restart)', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    recordCompleted('sess1', 'trg_a', 'survives restart', 5000, 'cli_test');
    // A brand-new lookup reads from disk (no in-memory state in this module).
    const got = lookup('sess1');
    expect(got?.result.status).toBe('completed');
    expect(got?.result.content).toBe('survives restart');
  });
});

describe('owner stamping (cross-bot isolation)', () => {
  it('recordPending stamps ownerLarkAppId and lookup returns it', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_botA');
    expect(lookup('sess1')?.ownerLarkAppId).toBe('cli_botA');
  });

  it('recordCompleted stamps ownerLarkAppId', () => {
    recordCompleted('sess1', 'trg_a', 'x', 5000, 'cli_botA');
    expect(lookup('sess1')?.ownerLarkAppId).toBe('cli_botA');
  });

  it('persists per-turn usage and returns it on lookup (survives reload)', () => {
    const usage = { inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreateTokens: 0 };
    recordCompleted('sess1', 'trg_a', 'done', 5000, 'cli_botA', usage);
    expect(lookup('sess1')?.result.usage).toEqual(usage);
  });

  it('omits usage when none is recorded', () => {
    recordCompleted('sess1', 'trg_a', 'done', 5000, 'cli_botA');
    expect(lookup('sess1')?.result.usage).toBeUndefined();
  });

  it('owner persists across pending → completed', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_botA');
    recordCompleted('sess1', 'trg_a', 'x', 5000, ''); // no owner on completion (legacy-unstamped)
    expect(lookup('sess1')?.ownerLarkAppId).toBe('cli_botA'); // preserved from pending
  });

  it('lookup returns undefined ownerLarkAppId when never stamped (legacy file)', () => {
    recordPending('sess1', 'trg_a', 1000, ''); // no owner (legacy-unstamped)
    expect(lookup('sess1')?.ownerLarkAppId).toBeUndefined();
  });
});

describe('deleteResults', () => {
  it('removes the persisted file', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    const fp = join(tempDir, 'async-triggers', 'sess1.json');
    expect(existsSync(fp)).toBe(true);
    deleteResults('sess1');
    expect(existsSync(fp)).toBe(false);
    expect(lookup('sess1')).toBeUndefined();
  });

  it('does not throw when the file is absent', () => {
    expect(() => deleteResults('never')).not.toThrow();
  });
});

describe('robustness', () => {
  it('atomic write leaves no .tmp behind', () => {
    recordPending('sess1', 'trg_a', 1000, 'cli_test');
    expect(existsSync(join(tempDir, 'async-triggers', 'sess1.json.tmp'))).toBe(false);
  });

  it('returns undefined on a corrupt file rather than throwing', () => {
    const dir = join(tempDir, 'async-triggers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{{not json', 'utf-8');
    expect(lookup('bad')).toBeUndefined();
  });

  it('isolates different sessions', () => {
    recordCompleted('sess1', 'trg_a', 'one', 1, 'cli_test');
    recordCompleted('sess2', 'trg_b', 'two', 2, 'cli_test');
    expect(lookup('sess1')?.result.content).toBe('one');
    expect(lookup('sess2')?.result.content).toBe('two');
    deleteResults('sess1');
    expect(lookup('sess1')).toBeUndefined();
    expect(lookup('sess2')?.result.content).toBe('two');
  });

  it('handles session ids with :: separators', () => {
    const sid = 'om_root::cli_app';
    recordCompleted(sid, 'trg_x', 'ok', 9, 'cli_test');
    expect(lookup(sid)?.result.content).toBe('ok');
  });
});

describe('recordFailedStrict (authoritative dispatch_unknown terminal)', () => {
  it('writes a durable failed(dispatch_unknown) that lookup surfaces', () => {
    recordFailedStrict('sessF', 'trg_f', 7000, 'cli_test', 'dispatch_unknown');
    const r = lookup('sessF', 'trg_f')?.result;
    expect(r?.status).toBe('failed');
    expect(r?.errorCode).toBe('no_output');
    expect(r?.reason).toBe('dispatch_unknown');
  });

  it('COMPLETED WINS: does not overwrite an existing completed result', () => {
    recordCompleted('sessC', 'trg_c', 'the answer', 5000, 'cli_test');
    recordFailedStrict('sessC', 'trg_c', 6000, 'cli_test'); // must be a no-op
    expect(lookup('sessC', 'trg_c')?.result.status).toBe('completed');
    expect(lookup('sessC', 'trg_c')?.result.content).toBe('the answer');
  });

  it('LATE COMPLETED WINS: a completed arriving after failed overwrites it', () => {
    recordFailedStrict('sessL', 'trg_l', 6000, 'cli_test');
    expect(lookup('sessL', 'trg_l')?.result.status).toBe('failed');
    recordCompleted('sessL', 'trg_l', 'done late', 7000, 'cli_test');
    expect(lookup('sessL', 'trg_l')?.result.status).toBe('completed');
  });

  it('STRICT READ: throws on a corrupt existing file (never overwrites it as empty)', () => {
    mkdirSync(join(tempDir, 'async-triggers'), { recursive: true });
    writeFileSync(join(tempDir, 'async-triggers', 'sessCorrupt.json'), '{ not json', 'utf-8');
    expect(() => recordFailedStrict('sessCorrupt', 'trg_x', 8000, 'cli_test')).toThrow();
    // The corrupt file is left intact for a human — not silently replaced.
    expect(existsSync(join(tempDir, 'async-triggers', 'sessCorrupt.json'))).toBe(true);
  });

  it('OWNER PROOF: refuses to overwrite a file owned by a different bot', () => {
    recordCompleted('sessO', 'trg_o', 'x', 5000, 'cli_ownerA');
    expect(() => recordFailedStrict('sessO', 'trg_o', 6000, 'cli_ownerB')).toThrow(/owner mismatch/);
    // ownerA's data intact.
    expect(lookup('sessO', 'trg_o')?.result.status).toBe('completed');
  });

  it('requires ownerLarkAppId', () => {
    expect(() => recordFailedStrict('sessN', 'trg_n', 1, '')).toThrow(/ownerLarkAppId/);
  });
});

describe('recordTerminalFailureStrict (explicit worker terminal)', () => {
  it('persists the structured terminal code and preserves createdAt', () => {
    recordPending('sessT', 'trg_t', 1000, 'cli_test');
    recordTerminalFailureStrict('sessT', 'trg_t', 7000, 'cli_test', 'provider_unexpected_eof');

    expect(lookup('sessT', 'trg_t')?.result).toEqual({
      status: 'failed',
      createdAt: 1000,
      failedAt: 7000,
      errorCode: 'trigger_failed',
      reason: 'turn_terminal',
      terminalErrorCode: 'provider_unexpected_eof',
    });
  });

  it('keeps a completed result stronger than a late failure terminal', () => {
    recordCompleted('sessTC', 'trg_tc', 'done', 5000, 'cli_test');
    expect(recordTerminalFailureStrict(
      'sessTC', 'trg_tc', 7000, 'cli_test', 'provider_server_error',
    )).toBe('already_completed');
    expect(lookup('sessTC', 'trg_tc')?.result.status).toBe('completed');
  });
});

describe('recordInterruptedStrict', () => {
  it('persists an exact interrupt and preserves the original creation instant', () => {
    recordPending('sessI', 'trg_i', 1000, 'cli_test');
    expect(recordInterruptedStrict('sessI', 'trg_i', 7000, 'cli_test')).toBe('written_failed');
    expect(lookup('sessI', 'trg_i')?.result).toMatchObject({
      status: 'interrupted', createdAt: 1000, interruptedAt: 7000,
    });
  });

  it('does not overwrite an interrupt with a late final or worker terminal', () => {
    recordPending('sessIL', 'trg_i', 1000, 'cli_test');
    recordInterruptedStrict('sessIL', 'trg_i', 7000, 'cli_test');
    recordCompleted('sessIL', 'trg_i', 'late answer', 8000, 'cli_test');
    recordTerminalFailureStrict('sessIL', 'trg_i', 9000, 'cli_test', 'provider_error');
    expect(lookup('sessIL', 'trg_i')?.result.status).toBe('interrupted');
  });
});

describe('recordSteerParked (HTTP steer group restart insurance)', () => {
  it('parks a pending member behind its successor and survives a fresh lookup', () => {
    recordPending('sessS', 'trg_root', 1000, 'cli_test');
    recordPending('sessS', 'trg_head', 2000, 'cli_test');
    recordSteerParked('sessS', 'trg_root', 'trg_head', 1500, 'cli_test');
    const parked = lookup('sessS', 'trg_root');
    expect(parked?.result.status).toBe('pending');
    expect(parked?.result.steerParkedBy).toBe('trg_head');
    // createdAt is preserved, not reset to the park time.
    expect(parked?.result.createdAt).toBe(1000);
  });

  it('never overwrites a terminal member with a park marker (terminal wins)', () => {
    recordPending('sessS2', 'trg_done', 1000, 'cli_test');
    recordCompleted('sessS2', 'trg_done', 'answer', 2000, 'cli_test');
    recordSteerParked('sessS2', 'trg_done', 'trg_next', 2500, 'cli_test');
    const got = lookup('sessS2', 'trg_done');
    expect(got?.result.status).toBe('completed');
    expect(got?.result.content).toBe('answer');
    expect(got?.result.steerParkedBy).toBeUndefined();
  });

  it('chains N parked members: resolving the real final completes every member by recordCompleted', () => {
    recordPending('sessS3', 'trg_1', 1000, 'cli_test');
    recordPending('sessS3', 'trg_2', 2000, 'cli_test');
    recordPending('sessS3', 'trg_3', 3000, 'cli_test');
    recordSteerParked('sessS3', 'trg_1', 'trg_2', 1100, 'cli_test');
    recordSteerParked('sessS3', 'trg_2', 'trg_3', 2100, 'cli_test');
    // Real merged final lands on the last member.
    recordCompleted('sessS3', 'trg_3', 'merged answer', 4000, 'cli_test');
    // The exported chain walk finds the first TERMINAL successor; poll-time
    // resolution then mirrors that outcome onto each parked member.
    for (const member of ['trg_1', 'trg_2']) {
      const terminal = followSteerParkedChain('sessS3', member);
      if (terminal?.result.status === 'completed') {
        recordCompleted('sessS3', member, terminal.result.content ?? '', terminal.result.completedAt ?? 0, 'cli_test');
      }
    }
    expect(lookup('sessS3', 'trg_1')?.result.content).toBe('merged answer');
    expect(lookup('sessS3', 'trg_2')?.result.content).toBe('merged answer');
    expect(lookup('sessS3', 'trg_3')?.result.content).toBe('merged answer');
  });

  it('followSteerParkedChain has no hop-count cap: a long (>8) chain still reaches the terminal', () => {
    const COUNT = 12;
    recordPending('sessLong', 'trg0', 1000, 'cli_test');
    for (let i = 0; i < COUNT; i++) {
      recordPending('sessLong', `trg${i + 1}`, 1000 + i, 'cli_test');
      recordSteerParked('sessLong', `trg${i}`, `trg${i + 1}`, 1000 + i, 'cli_test');
    }
    recordCompleted('sessLong', `trg${COUNT}`, 'far merged answer', 9000, 'cli_test');
    const hit = followSteerParkedChain('sessLong', 'trg0');
    expect(hit?.triggerId).toBe(`trg${COUNT}`);
    expect(hit?.result.status).toBe('completed');
    expect(hit?.result.content).toBe('far merged answer');
  });

  it('followSteerParkedChain returns undefined on a corrupt on-disk cycle (never loops)', () => {
    recordPending('sessCyc', 'a', 1000, 'cli_test');
    recordPending('sessCyc', 'b', 1000, 'cli_test');
    recordSteerParked('sessCyc', 'a', 'b', 1100, 'cli_test');
    recordSteerParked('sessCyc', 'b', 'a', 1200, 'cli_test');
    expect(followSteerParkedChain('sessCyc', 'a')).toBeUndefined();
  });

  it('followSteerParkedChain returns undefined when a hop is missing or the chain ends pending', () => {
    recordPending('sessMiss', 'p1', 1000, 'cli_test');
    recordSteerParked('sessMiss', 'p1', 'gone', 1100, 'cli_test');
    expect(followSteerParkedChain('sessMiss', 'p1')).toBeUndefined();

    recordPending('sessEnd', 'e1', 1000, 'cli_test');
    recordPending('sessEnd', 'e2', 1000, 'cli_test');
    recordSteerParked('sessEnd', 'e1', 'e2', 1100, 'cli_test'); // e2 has no pointer, no terminal
    expect(followSteerParkedChain('sessEnd', 'e1')).toBeUndefined();
  });

  it('followSteerParkedChain returns a failed terminal successor (not just completed)', () => {
    recordPending('sessF', 'f1', 1000, 'cli_test');
    recordPending('sessF', 'f2', 1000, 'cli_test');
    recordSteerParked('sessF', 'f1', 'f2', 1100, 'cli_test');
    recordTerminalFailureStrict('sessF', 'f2', 2000, 'cli_test', 'provider_500');
    const hit = followSteerParkedChain('sessF', 'f1');
    expect(hit?.triggerId).toBe('f2');
    expect(hit?.result.status).toBe('failed');
    expect(hit?.result.terminalErrorCode).toBe('provider_500');
  });

  it('strict loader accepts the parked shape and rejects a marker on a non-pending record', () => {
    recordPending('sessS4', 'trg_p', 1000, 'cli_test');
    recordSteerParked('sessS4', 'trg_p', 'trg_q', 1200, 'cli_test');
    expect(lookupStrict('sessS4', 'trg_p')?.result.steerParkedBy).toBe('trg_q');
    // Hand-write a corrupt marker: steerParkedBy on a completed record is invalid.
    const dir = join(tempDir, 'async-triggers');
    const fp = join(dir, 'sessS4.json');
    const file = JSON.parse(readFileSync(fp, 'utf-8'));
    file.results.trg_bad = { status: 'completed', createdAt: 1, completedAt: 2, steerParkedBy: 'trg_q' };
    writeFileSync(fp, JSON.stringify(file));
    expect(() => lookupStrict('sessS4', 'trg_bad')).toThrow();
  });
});
