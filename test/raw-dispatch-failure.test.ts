import { describe, expect, it } from 'vitest';
import { classifyRawDispatchFailure } from '../src/core/raw-dispatch-failure.js';

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
