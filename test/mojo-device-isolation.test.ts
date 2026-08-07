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
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => { throw new Error('bot deregistered'); },
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
