/**
 * 会话相位推导（core/session-phase.ts）：互斥且全覆盖，判定顺序就是优先级。
 * 差分测试把相位当输入轴同时喂 oracle 与路由器，从不经过 deriveSessionPhase，所以这里直接钉它。
 * Run: bun run vitest run test/session-phase.test.ts
 */
import { describe, it, expect } from 'vitest';
import { deriveSessionPhase, phaseHasLiveWorker, phaseHasSession, SESSION_PHASES } from '../src/core/session-phase.js';
import type { DaemonSession } from '../src/core/types.js';

function ds(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}): DaemonSession {
  return {
    worker: { killed: false },
    cliReady: true,
    session: { status: 'active', ...session },
    ...over,
  } as unknown as DaemonSession;
}

describe('deriveSessionPhase', () => {
  it('无会话 → none；closed 优先于一切', () => {
    expect(deriveSessionPhase(undefined)).toBe('none');
    expect(deriveSessionPhase(null)).toBe('none');
    expect(deriveSessionPhase(ds({ pendingRepo: true }, { status: 'closed' }))).toBe('closed');
  });
  it('worker 未起的几种等待态按优先级：worktreeCreating > pendingRepo > queued > dormant', () => {
    expect(deriveSessionPhase(ds({ worker: null, pendingRepo: true, worktreeCreating: true }))).toBe('worktreeCreating');
    expect(deriveSessionPhase(ds({ worker: null, pendingRepo: true, pendingRepoCommitInFlight: true }))).toBe('worktreeCreating');
    expect(deriveSessionPhase(ds({ worker: null, pendingRepo: true }))).toBe('pendingRepo');
    expect(deriveSessionPhase(ds({ worker: null }, { queued: true }))).toBe('queued');
    expect(deriveSessionPhase(ds({ worker: null }))).toBe('dormant');
    expect(deriveSessionPhase(ds({ worker: { killed: true } }))).toBe('dormant');
  });
  it('worker 活着：未 prompt_ready → spawning；首轮未发 → ready；否则 running', () => {
    expect(deriveSessionPhase(ds({ cliReady: false }))).toBe('spawning');
    expect(deriveSessionPhase(ds({ cliReady: undefined }))).toBe('spawning');
    expect(deriveSessionPhase(ds({}, { initialUserTurnPending: true }))).toBe('ready');
    expect(deriveSessionPhase(ds())).toBe('running');
  });
  it('设计 §15 记录的口径：会话内 /repo wt 在活 worker 上置位 worktreeCreating 时相位按等待态判（谓词 hasLiveWorker=false）', () => {
    expect(deriveSessionPhase(ds({ worktreeCreating: true }))).toBe('worktreeCreating');
    expect(phaseHasLiveWorker('worktreeCreating')).toBe(false);
  });
  it('两个谓词与相位表一致', () => {
    expect(SESSION_PHASES).toHaveLength(9);
    for (const p of SESSION_PHASES) {
      expect(phaseHasSession(p)).toBe(p !== 'none');
      expect(phaseHasLiveWorker(p)).toBe(p === 'spawning' || p === 'ready' || p === 'running');
    }
  });
});
