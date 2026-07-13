import { describe, expect, it } from 'vitest';
import { cliRequiresNativeSessionId, isResumeCapableCli } from '../src/dashboard/web/workflows.js';

describe('dashboard workflow resume capabilities', () => {
  it('treats kiro-cli as resumable only with a native cliSessionId', () => {
    expect(isResumeCapableCli('kiro-cli')).toBe(true);
    expect(cliRequiresNativeSessionId('kiro-cli')).toBe(true);
  });
});
