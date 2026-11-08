import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppControlProofDeadline,
  codexAppSignedStateReadiness,
} from '../src/utils/codex-app-control.js';
import {
  CodexRunnerFreshnessInputQueue,
  type CodexRunnerFreshnessState,
} from '../src/services/codex-runner-freshness.js';
import { RunnerControlDecoder, RUNNER_CONTROL_PREFIX, RUNNER_CONTROL_END } from '../src/adapters/cli/runner-control-channel.js';

describe('Codex App runner control-channel primitives', () => {
  it('keeps the proof timer armed for acceptingInput:false and clears it only for true', async () => {
    vi.useFakeTimers();
    const deadline = new CodexAppControlProofDeadline();
    try {
      const falseTimedOut = vi.fn();
      deadline.arm(falseTimedOut, 100);
      expect(codexAppSignedStateReadiness({ busy: false, acceptingInput: false })).toBe('waiting');
      await vi.advanceTimersByTimeAsync(100);
      expect(falseTimedOut).toHaveBeenCalledTimes(1);

      const missingTimedOut = vi.fn();
      deadline.arm(missingTimedOut, 100);
      expect(codexAppSignedStateReadiness({ busy: false })).toBe('invalid');
      await vi.advanceTimersByTimeAsync(100);
      expect(missingTimedOut).toHaveBeenCalledTimes(1);

      const readyTimedOut = vi.fn();
      deadline.arm(readyTimedOut, 100);
      expect(codexAppSignedStateReadiness({ busy: false, acceptingInput: true })).toBe('ready');
      deadline.clear();
      await vi.advanceTimersByTimeAsync(100);
      expect(readyTimedOut).not.toHaveBeenCalled();
    } finally {
      deadline.clear();
      vi.useRealTimers();
    }
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
  });

  it('decodes a dsh final OSC frame without leaking control bytes to display', () => {
    // Behavioral mirror of the worker's splitCodexAppControl: when the cliId
    // is in the decode set, a `final` frame is stripped from the display
    // stream and handed to the marker callback.
    const decoder = new RunnerControlDecoder();
    const markers: Array<{ kind: string; payload: unknown }> = [];
    const content = '你好，我是 dsh。';
    const frame = `${RUNNER_CONTROL_PREFIX}final:${Buffer.from(JSON.stringify({ content })).toString('base64')}${RUNNER_CONTROL_END}`;
    const display = decoder.push(frame, true, body => {
      const colon = body.indexOf(':');
      markers.push({ kind: body.slice(0, colon), payload: JSON.parse(Buffer.from(body.slice(colon + 1), 'base64').toString('utf8')) });
    });
    expect(display).toBe('');
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('final');
    expect((markers[0].payload as { content: string }).content).toBe(content);
  });
});