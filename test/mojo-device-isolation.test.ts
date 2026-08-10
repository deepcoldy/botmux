/**
 * Device-isolation classification for mojo sessions.
 *
 * Review found that the worker's sandbox gate was fixed while this classifier
 * still ignored `wrapperCli`, so a wrapped session — one that can re-enable host
 * execution via `env AGENT_LOCAL_DAEMON=1 mojo` — was still labelled `safe_remote`
 * and could have device credentials activated around a live local child.
 *
 * Run:  pnpm vitest run test/mojo-device-isolation.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Controllable: the classifier now also reads the LIVE launcher env for a frozen
// session (env is deliberately not frozen, since the JWT must stay rotatable), so a
// permanently-throwing getBot would make every frozen case fail closed and hide
// what these tests are actually about.
let liveBotConfig: Record<string, unknown> | undefined = {};
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => {
    if (!liveBotConfig) throw new Error('bot deregistered');
    return { config: liveBotConfig };
  },
}));

import { resolveRemoteExecutionProven } from '../src/core/device-isolation-daemon.js';

/** Minimal DaemonSession shape the classifier reads. */
function ds(opts: {
  backendType?: string;
  backendConfig?: Record<string, unknown>;
  mojoIdentity?: Record<string, unknown>;
  wrapperCli?: string;
  initWrapperCli?: string;
}): never {
  return {
    larkAppId: 'app_x',
    initConfig: opts.backendConfig || opts.initWrapperCli
      ? {
        backendType: opts.backendType ?? 'mojo',
        ...(opts.backendConfig ? { backendConfig: opts.backendConfig } : {}),
        ...(opts.initWrapperCli ? { wrapperCli: opts.initWrapperCli } : {}),
      }
      : undefined,
    session: {
      sessionId: 'sid-x',
      backendType: opts.backendType ?? 'mojo',
      ...(opts.mojoIdentity ? { mojoIdentity: opts.mojoIdentity } : {}),
      ...(opts.wrapperCli ? { wrapperCli: opts.wrapperCli } : {}),
    },
  } as never;
}

beforeEach(() => { liveBotConfig = {}; });

describe('resolveRemoteExecutionProven', () => {
  it('riff is always remote', () => {
    expect(resolveRemoteExecutionProven(ds({ backendType: 'riff' }))).toBe(true);
  });

  it('non-remote backends are never remote', () => {
    expect(resolveRemoteExecutionProven(ds({ backendType: 'tmux' }))).toBe(false);
  });

  it('a cloud mojo session with no wrapper is remote', () => {
    expect(resolveRemoteExecutionProven(ds({ backendConfig: { cloud: true } }))).toBe(true);
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(true);
  });

  it('a frozen cloud session is NOT remote once the LIVE launcher env can redirect it', () => {
    // The cold-refork attack, at the layer review said mislabels it `safe_remote`:
    // `env` is not part of the frozen identity, so it is re-merged from live bot
    // config on refork. A redirected PATH must void the proof here too, or device
    // credentials get activated around a local child running unknown code.
    liveBotConfig = { mojo: { env: { PATH: '/tmp/fake-mojo' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);

    // Same through the TOP-LEVEL per-bot env, which lands in the same child env.
    liveBotConfig = { env: { LD_PRELOAD: '/tmp/x.so' } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);

    // The CANONICAL credential variable alone stays provable.
    liveBotConfig = { mojo: { env: { X_JWT_TOKEN: 'tok' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(true);

    // But a config-named credential key does NOT buy an exemption here either.
    // This is the alias bypass at the device-isolation layer: if `jwtEnv` widened
    // the allowlist, `jwtEnv: 'PATH'` would be classified safe_remote and activate
    // device credentials around a local child running an operator-chosen binary.
    liveBotConfig = { mojo: { jwtEnv: 'MY_JWT', env: { MY_JWT: 'tok' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
    liveBotConfig = { mojo: { jwtEnv: 'PATH', env: { PATH: '/tmp/fake-mojo' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
  });

  it('a frozen session whose bot is gone fails closed', () => {
    // No way to read the launcher env, so nothing can be proven.
    liveBotConfig = undefined;
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
  });

  it('a WRAPPED cloud session is NOT remote — from initConfig', () => {
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true, localDaemon: false },
      initWrapperCli: 'env AGENT_LOCAL_DAEMON=1 mojo',
    }))).toBe(false);
  });

  it('a WRAPPED cloud session is NOT remote — from the frozen session field', () => {
    // wrapperCli lives on the top-level session, not inside the mojo block or the
    // frozen identity, so it has to be folded in explicitly.
    expect(resolveRemoteExecutionProven(ds({
      mojoIdentity: { cloud: true, localDaemon: false },
      wrapperCli: 'env AGENT_LOCAL_DAEMON=1 mojo',
    }))).toBe(false);
  });

  it('any wrapper voids the proof, not just an obviously hostile one', () => {
    expect(resolveRemoteExecutionProven(ds({
      mojoIdentity: { cloud: true },
      wrapperCli: 'ttadk mojo',
    }))).toBe(false);
  });

  it('localDaemon still voids the proof', () => {
    expect(resolveRemoteExecutionProven(ds({
      mojoIdentity: { cloud: true, localDaemon: true },
    }))).toBe(false);
  });

  it('an unset cloud flag is not remote', () => {
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: {} }))).toBe(false);
  });

  it('fails closed when the bot is deregistered and nothing is frozen', () => {
    expect(resolveRemoteExecutionProven(ds({}))).toBe(false);
  });
});
