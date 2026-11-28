import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localCliCommandForSession, localTerminalCapable, terminalLaunchArgs } from '../src/core/local-terminal-opener.js';
import type { DaemonSession } from '../src/core/types.js';

const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

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

  it('decorates TraeX resume commands with Forge launch mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-local-terminal-'));
    try {
      writeFileSync(join(dir, 'forge'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, 'forge'), 0o755);
      process.env.PATH = originalPath ? `${dir}:${originalPath}` : dir;

      const result = localCliCommandForSession(session({
        session: {
          ...session().session,
          cliId: 'traex',
          cliPathOverride: undefined,
          cliLaunchMode: 'forge-traex',
          cliSessionId: 'trae-session',
        },
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.executable).toBe('forge');
        expect(result.command).toContain("exec forge run --agent traex --agent-args 'resume trae-session'");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it('fails structured instead of fresh-launching when the NCA resume home resolves to the filesystem root', () => {
    vi.stubEnv('NCA_DATA_HOME', '/');
    vi.stubEnv('CLI_EXTRA_ARGS', undefined);
    try {
      const result = localCliCommandForSession(session({
        session: {
          ...session().session,
          cliId: 'nca',
          cliPathOverride: '/bin/echo',
          cliSessionId: '01a2182c-5933-72f2-8087-38b0469d1e05',
        },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('adapter_error');
        expect(result.detail).toContain('filesystem root');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resumes an AtomCode session via native atomcode resume command without acp- prefix', () => {
    const result = localCliCommandForSession(session({
      session: {
        ...session().session,
        cliId: 'atomcode',
        cliPathOverride: '/bin/echo',
        cliSessionId: 'acp-01a2182c-5933-72f2-8087-38b0469d1e05',
      },
    }));
    expect(result).toEqual({
      ok: true,
      mode: 'resume',
      executable: '/bin/echo',
      command: "cd '/tmp/project with space' && exec '/bin/echo' resume '01a2182c-5933-72f2-8087-38b0469d1e05'",
    });
  });

  it('falls back to launching atomcode binary when no cliSessionId exists yet', () => {
    const result = localCliCommandForSession(session({
      session: {
        ...session().session,
        cliId: 'atomcode',
        cliPathOverride: '/bin/echo',
        cliSessionId: undefined,
      },
    }));
    expect(result).toEqual({
      ok: true,
      mode: 'launch',
      executable: '/bin/echo',
      command: "cd '/tmp/project with space' && exec '/bin/echo'",
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
