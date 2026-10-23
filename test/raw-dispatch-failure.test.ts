import { describe, expect, it } from 'vitest';
import { classifyRawDispatchFailure, rewrapSubmissionFailure } from '../src/core/raw-dispatch-failure.js';

describe('classifyRawDispatchFailure', () => {
  it('fences the runner generation on a flagged ambiguous framed submit', () => {
    const err = { name: 'SubmissionWriteError', runnerGenerationUnsafe: true };
    expect(classifyRawDispatchFailure(err, false)).toBe('fence-generation');
    expect(classifyRawDispatchFailure(err, true)).toBe('fence-generation');
  });

  it('fails the node for any other raw failure inside a workflow worker', () => {
    expect(classifyRawDispatchFailure(new Error('boom'), true)).toBe('workflow-node-fail');
    expect(classifyRawDispatchFailure({ runnerGenerationUnsafe: false }, true))
      .toBe('workflow-node-fail');
  });

  it('only notifies on ordinary interactive-session failures', () => {
    expect(classifyRawDispatchFailure(new Error('boom'), false)).toBe('notify');
    expect(classifyRawDispatchFailure(undefined, false)).toBe('notify');
    expect(classifyRawDispatchFailure(null, false)).toBe('notify');
  });
});

describe('rewrapSubmissionFailure — WAL transaction preserves the framed-runner marker (P2-3)', () => {
  it('carries runnerGenerationUnsafe=true through the rewrap so classification stays fence-generation', () => {
    const original = Object.assign(new Error('dirty frame'), { runnerGenerationUnsafe: true });
    const rewrapped = rewrapSubmissionFailure(original, 'journal-not-committed', true);
    expect(rewrapped.runnerGenerationUnsafe).toBe(true);
    expect(rewrapped.submissionStarted).toBe(true);
    expect(rewrapped.recoveryFailureReason).toBe('journal-not-committed');
    expect(rewrapped.message).toContain('dirty frame');
    expect(rewrapped.message).toContain('journal-not-committed');
    // The preserved marker must keep the caller's classification at fence.
    expect(classifyRawDispatchFailure(rewrapped, false)).toBe('fence-generation');
    expect(classifyRawDispatchFailure(rewrapped, true)).toBe('fence-generation');
  });

  it('does not fabricate the marker for a plain error', () => {
    const rewrapped = rewrapSubmissionFailure(new Error('boom'), undefined, false);
    expect(rewrapped.runnerGenerationUnsafe).toBe(false);
    expect(rewrapped.submissionStarted).toBe(false);
    expect(classifyRawDispatchFailure(rewrapped, false)).toBe('notify');
    expect(classifyRawDispatchFailure(rewrapped, true)).toBe('workflow-node-fail');
  });
});
