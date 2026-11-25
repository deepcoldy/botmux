import { describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import { inheritSessionLaunchConfiguration } from '../src/core/session-launch-inheritance.js';

describe('inheritSessionLaunchConfiguration', () => {
  it('carries the protected-results isolation flag into fork and recovery sessions', () => {
    const source = {
      sandbox: 'oncall',
      sandboxWithholdBotSecret: true,
      protectedResults: true,
    } as Session;
    const target = {} as Session;
    inheritSessionLaunchConfiguration(source, target);
    expect(target.sandbox).toBe('oncall');
    expect(target.sandboxWithholdBotSecret).toBe(true);
    expect(target.protectedResults).toBe(true);
  });

  it('does not synthesize protection on an ordinary session', () => {
    const target = {} as Session;
    inheritSessionLaunchConfiguration({ sandbox: 'oncall' } as Session, target);
    expect(target.protectedResults).toBeUndefined();
  });
});
