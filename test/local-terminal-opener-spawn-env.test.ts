import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

// Mock child_process so we can (a) make a terminal resolve on PATH via
// spawnSync (onPath) and (b) capture the detached spawn's env. Isolated in its
// own file so the real-spawnSync tests in local-terminal-opener.test.ts stay
// untouched.
// Plain const, deliberately NOT `vi.hoisted`: that helper is a vitest TRANSFORM
// (it physically lifts the call above the imports) and `bun test` has no
// equivalent, so the file died there. A plain const is safe under BOTH runners
// because the factory below only READS it when the mocked module is first
// resolved, which is after this statement has run. (Verified on each runner.)
const cp = {
  spawn: vi.fn(() => ({ unref: () => {} })),
  spawnSync: vi.fn(),
};

// ⚠️ The real module is spread in via a LAZY `require` inside the factory. Two
// separate reasons, both measured:
//   · bun performs real ESM named-export linking, so a factory that returns only
//     `{spawn, spawnSync}` fails the whole file with "Export named 'fork' not
//     found in module 'node:child_process'" — `src/core/self-spawn.ts` imports
//     `fork` on this module's transitive graph. vitest never checks that.
//   · `require` rather than the factory's `importOriginal` argument: that argument
//     is vitest-only (bun passes nothing, so awaiting it throws). A top-level
//     `import * as actual` fails too, because vitest hoists `vi.mock` above the
//     imports and the factory would read it before initialisation.
// Spreading widens nothing that matters: the two functions under test are still
// fully replaced, and the real ones are only reachable via names this file's code
// path never calls.
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    spawn: cp.spawn,
    spawnSync: cp.spawnSync,
  };
});

function session(overrides: Partial<DaemonSession['session']> = {}): DaemonSession {
  return {
    session: {
      sessionId: '1234567890abcdef',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: 'test',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      backendType: 'tmux',
      workingDir: '/tmp/project',
      cliId: 'codex',
      cliPathOverride: '/bin/echo',
      cliSessionId: 'codex-native-session',
      ...overrides,
    },
    worker: null,
    larkAppId: 'cli_app',
    chatId: 'oc_1',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
  } as DaemonSession;
}

describe.skipIf(process.platform !== 'linux')('openLocalTerminalForSession spawn env (linux)', () => {
  beforeEach(() => {
    cp.spawn.mockClear();
    cp.spawnSync.mockReset();
    // Two spawnSync consumers in openLocalTerminalForSession's path, both via
    // onPath(): (1) the CLI executable check `test -x /bin/echo`, and (2) the
    // terminal-candidate probes `test -x <dir>/<term>`. Report the CLI bin and
    // the first terminal candidate (xdg-terminal-exec) as present so the flow
    // reaches spawn().
    cp.spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const target = String(args?.[args.length - 1] ?? '');
      if (cmd === 'test' && target === '/bin/echo') return { status: 0, stdout: '', stderr: '' };
      const found = target.endsWith('/xdg-terminal-exec') || target === 'xdg-terminal-exec';
      return { status: found ? 0 : 1, stdout: '', stderr: '' };
    });
    vi.stubEnv('DISPLAY', ':0');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does NOT pass the PM2 graceful-exit sentinel to the launched terminal', async () => {
    const { PM2_GRACEFUL_EXIT_CODE_ENV } = await import('../src/pm2-graceful-exit.js');
    vi.stubEnv(PM2_GRACEFUL_EXIT_CODE_ENV, '90');
    const { openLocalTerminalForSession } = await import('../src/core/local-terminal-opener.js');

    const result = openLocalTerminalForSession(session());
    expect(result.ok).toBe(true);
    expect(cp.spawn).toHaveBeenCalledOnce();
    const opts = cp.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    // The detached terminal (login shell → local AI CLI) must not inherit the
    // marker, or a foreground botmux it launches would exit 90 on clean stop.
    expect(opts.env[PM2_GRACEFUL_EXIT_CODE_ENV]).toBeUndefined();
    // Sanity: unrelated env still flows through (we didn't hand it an empty env).
    expect(opts.env.DISPLAY).toBe(':0');
  });
});
