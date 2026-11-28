/**
 * Which processes of a native gateway core still count as one
 * (core/runtime-mode.ts isNativeGatewayCoreEnv), given the environment each
 * inherits: the core daemon and its workers do; its CLI sessions do not, so a
 * `botmux serve --api-only` started from inside one is a bare core; and a fleet
 * member started from such a session carries none of it. Real environment
 * builders end to end, from the env the WeCom managed-core launcher produces.
 */
import { describe, expect, it } from 'vitest';
import { buildBotWorkerEnv, buildSessionChildEnv, type EnvPolicy } from '../src/core/env-policy.js';
import { isCoreOnlyEnv, isNativeGatewayCoreEnv } from '../src/core/runtime-mode.js';
import { wecomManagedCoreEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import { scrubCoreOnlyServiceEnv } from '../src/utils/child-env.js';

const coreDaemonEnv = wecomManagedCoreEnvironment({
  managedCore: {
    botId: 'local_mark_fixture', cli: 'codex', backend: 'pty', workingDirectory: '/test/work',
    port: 19996, stateDir: '/test/core',
  },
}, { HOME: '/test/home', PATH: '/usr/bin' });

const POLICIES: ReadonlyArray<[string, EnvPolicy | undefined]> = [
  ['inherit envPolicy', undefined],
  ['strict envPolicy', { mode: 'strict' }],
];

describe('the native gateway core mark', () => {
  it('marks the core daemon the managed-core launcher starts', () => {
    expect(isNativeGatewayCoreEnv(coreDaemonEnv)).toBe(true);
  });

  it.each(POLICIES)('reaches the core workers (%s)', (_label, policy) => {
    expect(isNativeGatewayCoreEnv(buildBotWorkerEnv(coreDaemonEnv, policy))).toBe(true);
  });

  it.each(POLICIES)('stops at the CLI boundary, while the core-only mode itself may pass (%s)', (_label, policy) => {
    const worker = buildBotWorkerEnv(coreDaemonEnv, policy);
    const cli = buildSessionChildEnv(worker, policy);
    expect(isNativeGatewayCoreEnv(cli)).toBe(false);
    if (!policy) expect(isCoreOnlyEnv(cli)).toBe(true);
  });

  it('is gone from a fleet member started inside a core session', () => {
    const session = buildBotWorkerEnv(coreDaemonEnv);
    scrubCoreOnlyServiceEnv(session);
    expect(isCoreOnlyEnv(session)).toBe(false);
    expect(isNativeGatewayCoreEnv({ ...session, BOTMUX_CORE_ONLY: '1' })).toBe(false);
  });
});
