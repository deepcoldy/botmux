import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CodexRunnerFreshnessInputQueue,
  type CodexRunnerFreshnessState,
} from '../src/services/codex-runner-freshness.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker app-runner control-channel wiring', () => {
  it('uses the bounded decoder and resets it with worker turn state', () => {
    expect(workerSource).toContain('const appRunnerControlDecoder = new RunnerControlDecoder();');
    expect(workerSource).toContain('return appRunnerControlDecoder.push(');
    expect(workerSource).toContain('appRunnerControlDecoder.reset();');
    expect(workerSource).not.toContain('codexAppOscPending');
  });

  it('rejects marker identity mismatches and keeps dispatch authority worker-owned', () => {
    expect(workerSource).toContain('if (!identity.ok)');
    expect(workerSource).toContain('payload.dispatchAttempt !== currentBotmuxDispatchAttempt');
    expect(workerSource).toContain('const dispatchAttempt = currentBotmuxDispatchAttempt;');
    expect(workerSource).not.toContain('const dispatchAttempt = payload.dispatchAttempt');
  });

  it('holds stale-busy normal and raw input across old idle and releases only at fresh prompt-ready', () => {
    let state: CodexRunnerFreshnessState = 'stale_waiting_idle';
    const queue = new CodexRunnerFreshnessInputQueue<string, string>(
      () => state,
      next => { state = next; },
    );
    const oldRunnerWrites: string[] = [];
    const replacementWrites: string[] = [];
    // Model freshness queue hold/release semantics; production flushPending
    // delivers at most one raw input per invocation before normal inputs.
    const flush = (writes: string[]): void => {
      const raw = queue.takeRaw();
      if (raw) writes.push(`raw:${raw}`);
      let normal: string | undefined;
      while ((normal = queue.takeNormal()) !== undefined) writes.push(`normal:${normal}`);
    };

    queue.enqueueNormal('normal-one');
    queue.enqueueRaw('/raw-one');
    flush(oldRunnerWrites);
    expect(oldRunnerWrites).toEqual([]);
    expect(queue.normal).toEqual(['normal-one']);
    expect(queue.raw).toEqual(['/raw-one']);

    // The old busy runner's first idle is consumed as the reload boundary.
    expect(queue.onPromptReady()).toBe('reload');
    expect(state).toBe('restarting_fresh');
    queue.enqueueNormal('normal-during-replacement');
    queue.enqueueRaw('/raw-during-replacement');
    flush(oldRunnerWrites);
    expect(oldRunnerWrites).toEqual([]);
    expect(queue.normal).toEqual(['normal-one', 'normal-during-replacement']);
    expect(queue.raw).toEqual(['/raw-one', '/raw-during-replacement']);

    // Only the replacement's prompt-ready makes dequeue possible.
    expect(queue.onPromptReady()).toBe('publish_ready');
    expect(state).toBe('current');
    flush(replacementWrites);
    expect(replacementWrites).toEqual([
      'raw:/raw-one',
      'normal:normal-one',
      'normal:normal-during-replacement',
    ]);
    expect(queue.raw).toEqual(['/raw-during-replacement']);
    flush(replacementWrites);
    expect(replacementWrites).toEqual([
      'raw:/raw-one',
      'normal:normal-one',
      'normal:normal-during-replacement',
      'raw:/raw-during-replacement',
    ]);
    expect(queue.normal).toEqual([]);
    expect(queue.raw).toEqual([]);

    // The worker's actual queue transitions must stay wired to this tested
    // seam; source loading is intentionally avoided because worker.ts starts
    // process-wide IPC and runtime services at module evaluation time.
    expect(workerSource).toContain('freshnessInputQueue.enqueueNormal(next)');
    expect(workerSource).toContain('freshnessInputQueue.enqueueRaw(msg)');
    expect(workerSource).toContain('freshnessInputQueue.takeNormal()');
    expect(workerSource).toContain('freshnessInputQueue.takeRaw()');
    expect(workerSource).toContain('freshnessInputQueue.onPromptReady()');
    expect(workerSource).toContain(
      "restartCliProcess('stale runner reached idle', { immediate: true, preservePending: true })",
    );
  });

  it('keeps both input kinds held after replacement failure', () => {
    let state: CodexRunnerFreshnessState = 'restarting_fresh';
    const queue = new CodexRunnerFreshnessInputQueue<string, string>(
      () => state,
      next => { state = next; },
    );
    queue.enqueueNormal('normal-held');
    queue.enqueueRaw('/raw-held');

    queue.onReplacementFailed();
    expect(queue.onPromptReady()).toBe('ignore');
    expect(state).toBe('failed');
    expect(queue.takeNormal()).toBeUndefined();
    expect(queue.takeRaw()).toBeUndefined();
    expect(queue.normal).toEqual(['normal-held']);
    expect(queue.raw).toEqual(['/raw-held']);
    expect(workerSource).toContain('freshnessInputQueue.onReplacementFailed()');
  });

  it('notifies preview observers when the MODERN appTurnId final branch suppresses on explicit botmux send', () => {
    // Regression guard for F3: the modern Codex App (appTurnId) suppress branch
    // must call notifyExplicitReplyObserved, symmetric with the legacy branch —
    // otherwise a run-preview session shows "running" forever after the model's
    // explicit botmux send. Anchor on identity.turnId (unique to the appTurnId
    // branch; the legacy branch uses a bare `turnId`).
    const appTurnBranch = workerSource.slice(workerSource.indexOf('if (marker.appTurnId) {'));
    const suppressIdx = appTurnBranch.indexOf('final_output suppressed');
    expect(suppressIdx).toBeGreaterThan(-1);
    // Within the appTurnId suppress block, the very next observer notification
    // must fire against identity.turnId before emitTurnTerminal returns.
    const suppressBlock = appTurnBranch.slice(suppressIdx, suppressIdx + 600);
    expect(suppressBlock).toMatch(/notifyExplicitReplyObserved\(\s*identity\.turnId/);
    expect(suppressBlock).toContain('explicitReplyMarkerForTurnWindow(gateInput');
    // Both final branches (legacy + modern) notify — never just one.
    expect((workerSource.match(/notifyExplicitReplyObserved\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
