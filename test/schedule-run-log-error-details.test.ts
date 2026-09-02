import { describe, expect, it } from 'vitest';
import { __testOnly_resolveScheduleRunLogErrorDetails as resolveErrorDetails } from '../src/daemon.js';
import { SchedulePreconditionError } from '../src/services/schedule-precondition-runner.js';

describe('scheduled-task run-log error details', () => {
  it('persists the precondition runner code and complete exit-code message', () => {
    const error = new SchedulePreconditionError(
      'non_zero_exit',
      'Scheduled task precondition failed with exit code 35',
    );

    expect(resolveErrorDetails('error', error)).toEqual({
      errorCode: 'non_zero_exit',
      error: 'Scheduled task precondition failed with exit code 35',
    });
  });

  it('keeps a diagnostic message for other precondition errors', () => {
    expect(resolveErrorDetails('error', new Error('Could not read Bash file'))).toEqual({
      errorCode: 'precondition_error',
      error: 'Could not read Bash file',
    });
  });

  it('does not change model-dispatch error logging', () => {
    expect(resolveErrorDetails('passed', new Error('model failed'))).toEqual({
      errorCode: 'model_dispatch_error',
    });
  });
});
