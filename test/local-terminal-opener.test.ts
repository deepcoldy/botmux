import { afterEach, describe, expect, it, vi } from 'vitest';
import { localCliCommandForSession, localTerminalCapable, terminalLaunchArgs } from '../src/core/local-terminal-opener.js';
import type { DaemonSession } from '../src/core/types.js';

function session(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: '1234567890abcdef',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: 'test',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      backendType: 'tmux',
      workingDir: '/tmp/project with space',
      cliId: 'codex',
      cliPathOverride: '/bin/echo',
      cliSessionId: 'codex-native-session',
    },
    worker: null,
    workerPort: 7891,
    workerToken: 'tok',
    larkAppId: 'cli_app',
    chatId: 'oc_1',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
    ...overrides,
  } as DaemonSession;
}

describe('localCliCommandForSession', () => {
  it('builds a native CLI resume command instead of attaching botmux tmux', () => {
    const result = localCliCommandForSession(session());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('resume');
      expect(result.command).toContain("cd '/tmp/project with space'");
      expect(result.command).toContain("exec '/bin/echo' resume codex-native-session");
      expect(result.command).not.toContain('tmux attach-session');
    }
  });

  it('builds a Claude Code resume command from cliSessionId', () => {
    const result = localCliCommandForSession(session({
      session: { ...session().session, cliId: 'claude-code', cliPathOverride: '/bin/echo', cliSessionId: 'claude-session-1' },
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('resume');
      expect(result.command).toContain("exec '/bin/echo' --resume claude-session-1");
    }
  });

  it('decorates resume commands with wrapperCli', () => {
    const result = localCliCommandForSession(session({
      session: { ...session().session, cliId: 'codex', cliPathOverride: undefined, cliSessionId: 'codex-native-session', wrapperCli: 'sh' },
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executable).toBe('sh');
      expect(result.command).toContain('exec sh resume codex-native-session');
    }
  });

  it('reports a missing local CLI executable', () => {
    const result = localCliCommandForSession(session({
      session: { ...session().session, cliId: 'traex', cliPathOverride: '/definitely/missing/traex', cliSessionId: 'trae-session' },
    }));

    expect(result).toEqual({
      ok: false,
      error: 'cli_unavailable',
      cliId: 'traex',
      executable: '/definitely/missing/traex',
    });
  });
});

describe('terminalLaunchArgs', () => {
  it('forwards via -e for the xterm lineage (konsole/alacritty/xterm) and unknown emulators', () => {
    for (const term of ['konsole', 'alacritty', 'xterm', 'foot']) {
      expect(terminalLaunchArgs(term, 'zsh', 'echo hi')).toEqual(['-e', 'zsh', '-lc', 'echo hi']);
    }
  });

  it('uses -- for gnome-terminal and -x for xfce4-terminal', () => {
    expect(terminalLaunchArgs('gnome-terminal', 'zsh', 'echo hi')).toEqual(['--', 'zsh', '-lc', 'echo hi']);
    expect(terminalLaunchArgs('xfce4-terminal', 'zsh', 'echo hi')).toEqual(['-x', 'zsh', '-lc', 'echo hi']);
  });

  it('passes the command positionally for kitty and xdg-terminal-exec', () => {
    expect(terminalLaunchArgs('kitty', 'zsh', 'echo hi')).toEqual(['zsh', '-lc', 'echo hi']);
    expect(terminalLaunchArgs('xdg-terminal-exec', 'zsh', 'echo hi')).toEqual(['zsh', '-lc', 'echo hi']);
  });
});

// macOS is unconditionally capable, so the env-driven cases only run on Linux.
describe.skipIf(process.platform !== 'linux')('localTerminalCapable (linux)', () => {
  afterEach(() => vi.unstubAllEnvs());

  function clearGuiEnv() {
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'BOTMUX_TERMINAL', 'TERMINAL']) {
      vi.stubEnv(key, undefined);
    }
  }

  it('is false on headless hosts', () => {
    clearGuiEnv();
    expect(localTerminalCapable()).toBe(false);
  });

  it('is true with a GUI session or an explicit terminal override', () => {
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'BOTMUX_TERMINAL', 'TERMINAL']) {
      clearGuiEnv();
      vi.stubEnv(key, key.endsWith('TERMINAL') ? 'kitty' : ':0');
      expect(localTerminalCapable()).toBe(true);
    }
  });
});
