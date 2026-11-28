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

  it('carries strict cold-start proof into native fork and clean recovery children', () => {
    const source = {
      sandbox: 'oncall', bytecloudBrokerStrict: true, bytecloudBrokerColdStart: true,
    } as Session;
    const fork = { cliSessionId: 'native-source' } as Session;
    inheritSessionLaunchConfiguration(source, fork);
    expect(fork.bytecloudBrokerStrict).toBe(true);
    expect(fork.bytecloudBrokerColdStart).toBe(true);
    const coldStartGuardRejects = !fork.bytecloudBrokerColdStart
      && !!(fork.workerGeneration || fork.cliSessionId || fork.adoptedFrom);
    expect(coldStartGuardRejects).toBe(false);

    const recovery = {} as Session;
    inheritSessionLaunchConfiguration(source, recovery);
    expect(recovery.bytecloudBrokerStrict).toBe(true);
    expect(recovery.bytecloudBrokerColdStart).toBe(true);
  });

  it('does not synthesize protection on an ordinary session', () => {
    const target = {} as Session;
    inheritSessionLaunchConfiguration({ sandbox: 'oncall' } as Session, target);
    expect(target.protectedResults).toBeUndefined();
  });
});
