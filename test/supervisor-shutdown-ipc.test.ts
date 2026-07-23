import { describe, expect, it } from 'vitest';
import { isExactSupervisorShutdownRequest } from '../src/core/supervisor-shutdown-ipc.js';

const identity = {
  larkAppId: 'cli_a',
  bootInstanceId: 'boot-a',
  processStartIdentity: 'birth-a',
};

describe('generation-bound supervisor shutdown request', () => {
  it('accepts only the exact in-process app/boot/birth tuple', () => {
    expect(isExactSupervisorShutdownRequest(identity, { ...identity })).toBe(true);
  });

  it('rejects a successor on the same port or reused PID', () => {
    expect(isExactSupervisorShutdownRequest(identity, {
      ...identity,
      bootInstanceId: 'boot-b',
    })).toBe(false);
    expect(isExactSupervisorShutdownRequest(identity, {
      ...identity,
      processStartIdentity: 'birth-b',
    })).toBe(false);
  });
});
