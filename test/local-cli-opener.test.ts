/**
 * local-cli-opener: local terminal command construction and launch guards.
 * Run: pnpm vitest run test/local-cli-opener.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appleScriptQuote,
  buildItermAppleScript,
  buildLocalCliOpenCommand,
  buildTerminalAppleScript,
  isLocalCliOpenCapable,
  isLocalCliOpenReady,
  LOCAL_CLI_IDS,
  openLocalCliInIterm,
  preflightLocalCliOpen,
  shellQuote,
  supportsLocalCliOpen,
} from '../src/services/local-cli-opener.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { DaemonSession } from '../src/core/types.js';

async function withCommandFileTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'botmux-local-cli-opener-test-'));
  vi.stubEnv('TMPDIR', root);
  try {
    return await run(root);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}

function ds(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '',
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
    workerPort: null,
    workerToken: null,
    workingDir: "/tmp/project's dir",
    session: {
      sessionId: 'botmux sid',
      cliSessionId: "native'id",
      cliId: 'codex',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'task',
      status: 'active',
      createdAt: new Date().toISOString(),
      workingDir: '/tmp/ignored',
    },
    ...overrides,
  } as DaemonSession;
}

describe('local-cli-opener', () => {
  it('keeps GUI Linux hosts ineligible for the macOS-only iTerm opener', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('DISPLAY', ':0');

    expect(isLocalCliOpenCapable()).toBe(false);

    platform.mockRestore();
    vi.unstubAllEnvs();
  });

  it('resume mode supports every adapter with a portable local resume command', () => {
    for (const cliId of LOCAL_CLI_IDS) {
      const result = buildLocalCliOpenCommand(ds({
        session: { ...ds().session, cliId, cliSessionId: 'ses_nativeid' },
      }), {
        mode: 'resume',
        adapterFactory: (id) => createCliAdapterSync(id, '/bin/echo'),
      });

      expect(supportsLocalCliOpen(cliId)).toBe(true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.command).not.toContain('attach-session');
      }
    }
    for (const cliId of ['codex-app', 'gemini', 'mira', 'mir']) {
      expect(supportsLocalCliOpen(cliId)).toBe(false);
    }
  });

  it('quotes shell arguments for cwd and resume id', () => {
    expect(shellQuote("a'b c")).toBe("'a'\\''b c'");

    const result = buildLocalCliOpenCommand(ds(), {
      mode: 'resume',
      adapterFactory: () => ({
        buildResumeCommand: () => "codex resume native'id",
      }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/tmp/project'\\''s dir' && codex resume 'native'\\''id'",
    });
  });

  it('attach mode opens a managed tmux session with exact target syntax', () => {
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume should-not-run' }));
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, sessionId: 'abcdef123456', backendType: 'tmux', cliSessionId: undefined },
    }), { mode: 'attach', adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "tmux attach-session -t '=bmx-abcdef12'",
    });
    expect(result.ok && result.command).not.toContain("-t 'bmx-abcdef12'");
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(isLocalCliOpenReady(ds({
      session: { ...ds().session, sessionId: 'abcdef123456', backendType: 'tmux', cliSessionId: undefined },
    }), { mode: 'attach', adapterFactory })).toBe(true);
  });

  it('attach mode opens a managed Herdr session with official session attach', () => {
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume should-not-run' }));
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, sessionId: 'abcdef123456', backendType: 'herdr', cliSessionId: undefined },
    }), { mode: 'attach', adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "herdr session attach 'bmx-abcdef12'",
    });
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('attach mode opens a managed ZMX session with an existing-only guard', () => {
    vi.stubEnv('ZMX_DIR', '/tmp/zmx socket');
    vi.stubEnv('ZMX_SESSION', 'outer');
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume should-not-run' }));
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, sessionId: 'abcdef123456', backendType: 'zmx', cliSessionId: undefined },
    }), { mode: 'attach', adapterFactory });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toContain('unset ZMX_SESSION ZMX_SESSION_PREFIX');
      expect(result.command).toContain("export ZMX_DIR='/tmp/zmx socket'");
      expect(result.command).toContain("grep -Fqx -- 'bmx-abcdef12'");
      expect(result.command).toContain("exec zmx attach 'bmx-abcdef12' /bin/sh -c 'exit 75'");
    }
    expect(adapterFactory).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('attach mode opens adopted Herdr by exact scoped terminal id when available', () => {
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'herdr', herdrSessionName: 'dev', herdrTerminalId: 'terminal_1', cwd: '/repo' },
      session: { ...ds().session, backendType: 'herdr', cliSessionId: undefined },
    }), { mode: 'attach' });

    expect(result).toEqual({
      ok: true,
      command: "herdr --session 'dev' terminal attach 'terminal_1'",
    });
  });

  it('attach mode fails closed for adopted Herdr session-only or pane-only metadata', () => {
    const sessionOnly = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'herdr', herdrSessionName: 'dev-session', cwd: '/repo' },
      session: { ...ds().session, backendType: 'herdr', cliSessionId: undefined },
    }), { mode: 'attach' });

    expect(sessionOnly).toMatchObject({ ok: false, error: 'missing_attach_target' });
    expect(!sessionOnly.ok && sessionOnly.message).toContain('scoped session and terminal');

    const paneOnly = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'herdr', herdrPaneId: 'pane_1', cwd: '/repo' },
      session: { ...ds().session, backendType: 'herdr', cliSessionId: undefined },
    }), { mode: 'attach' });

    expect(paneOnly).toMatchObject({ ok: false, error: 'missing_attach_target' });
    expect(!paneOnly.ok && paneOnly.message).toContain('scoped session and terminal');
  });

  it('attach mode fails closed for adopted tmux instead of trusting stale pane metadata', () => {
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', originalCliPid: 1234, cliId: 'codex', cwd: '/repo' },
      session: { ...ds().session, backendType: 'tmux', cliSessionId: undefined },
    }), { mode: 'attach' });

    expect(result).toMatchObject({ ok: false, error: 'missing_attach_target' });
    expect(!result.ok && result.message).toContain('stale or reused');
  });

  it('attach mode fails closed for unsupported or unreliable targets without resume fallback', () => {
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume should-not-run' }));
    const zellij = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'zellij', cliSessionId: 'native-ready' },
    }), { mode: 'attach', adapterFactory });
    expect(zellij).toMatchObject({ ok: false, error: 'unsupported_backend' });

    const pty = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'pty', cliSessionId: 'native-ready' },
    }), { mode: 'attach', adapterFactory });
    expect(pty).toMatchObject({ ok: false, error: 'unsupported_backend' });

    const adoptedTmux = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'codex', cwd: '/repo' },
      session: { ...ds().session, backendType: 'tmux', cliSessionId: 'native-ready' },
    }), { mode: 'attach', adapterFactory });
    expect(adoptedTmux).toMatchObject({ ok: false, error: 'missing_attach_target' });
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('resume mode uses adapter resume for managed tmux sessions instead of attach', () => {
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume native-managed' }));
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'tmux', cliSessionId: 'native-managed' },
    }), { mode: 'resume', adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "cd '/tmp/project'\\''s dir' && codex resume 'native-managed'",
    });
    expect(adapterFactory).toHaveBeenCalledWith('codex');
    expect(result.ok && result.command).not.toContain('tmux');
    expect(result.ok && result.command).not.toContain('attach');
  });

  it('uses adapter resume for adopted tmux sessions and falls back to adopted session id', () => {
    const adapterFactory = vi.fn((cliId) => ({
      buildResumeCommand: ({ cliSessionId }: { cliSessionId?: string }) => `${cliId} resume ${cliSessionId}`,
    }));
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/repo', sessionId: 'adopt-native' },
      workingDir: undefined,
      session: { ...ds().session, cliId: 'traex', cliSessionId: undefined, workingDir: undefined },
    }), { mode: 'resume', adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "cd '/repo' && traex resume 'adopt-native'",
    });
    expect(adapterFactory).toHaveBeenCalledWith('traex');
    expect(result.ok && result.command).not.toContain('tmux');
    expect(result.ok && result.command).not.toContain('attach');
  });

  it('prefers adopted session id over a stale prior cliSessionId', () => {
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'codex', cwd: '/repo', sessionId: 'current-adopt-native' },
      workingDir: undefined,
      session: {
        ...ds().session,
        cliId: 'codex',
        cliSessionId: 'stale-prior-native',
        workingDir: undefined,
      },
    }), {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: ({ cliSessionId }) => `codex resume ${cliSessionId}` }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/repo' && codex resume 'current-adopt-native'",
    });
    expect(result.ok && result.command).not.toContain('stale-prior-native');
    expect(result.ok && result.command).not.toContain('tmux');
  });

  it('falls back to persisted adopted metadata when live adopted metadata is absent', () => {
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: undefined,
      workingDir: undefined,
      session: {
        ...ds().session,
        cliId: 'codex',
        cliSessionId: undefined,
        workingDir: undefined,
        adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'codex', cwd: '/persisted', sessionId: 'persisted-native' },
      },
    }), {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: ({ cliSessionId }) => `codex resume ${cliSessionId}` }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/persisted' && codex resume 'persisted-native'",
    });
  });

  it('returns a clear error when adapter cannot resolve a resume id', () => {
    const result = buildLocalCliOpenCommand(ds(), {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: () => null }),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('missing_resume_id');
  });

  it('reports readiness only after a native resume target is available', () => {
    const pending = ds({ session: { ...ds().session, cliSessionId: undefined } });
    const adapterFactory = () => ({
      buildResumeCommand: ({ cliSessionId }: { cliSessionId?: string }) =>
        cliSessionId ? `codex resume ${cliSessionId}` : null,
    });

    expect(isLocalCliOpenReady(pending, { mode: 'resume', adapterFactory })).toBe(false);
    expect(preflightLocalCliOpen(pending, { mode: 'resume', adapterFactory })).toMatchObject({
      ok: false,
      error: 'missing_resume_id',
    });

    pending.session.cliSessionId = 'native-ready';
    expect(isLocalCliOpenReady(pending, { mode: 'resume', adapterFactory })).toBe(true);
  });

  it('treats adopted ids and oh-my-pi continue as ready resume targets', () => {
    const adopted = ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/repo', sessionId: 'adopt-native' },
      workingDir: undefined,
      session: { ...ds().session, cliId: 'traex', cliSessionId: undefined, workingDir: undefined },
    });
    expect(isLocalCliOpenReady(adopted, {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: ({ cliSessionId }) => `traex resume ${cliSessionId}` }),
    })).toBe(true);

    const ohMyPi = ds({
      session: { ...ds().session, cliId: 'oh-my-pi', cliSessionId: undefined },
    });
    expect(isLocalCliOpenReady(ohMyPi, {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: () => 'omp --continue' }),
    })).toBe(true);
  });

  it('rejects unsupported adapter resume commands, including URL schemes', () => {
    const unsupported = buildLocalCliOpenCommand(ds(), {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: () => 'codex --resume sid' }),
    });
    expect(unsupported.ok).toBe(false);
    expect(!unsupported.ok && unsupported.error).toBe('missing_resume_id');
    expect(!unsupported.ok && unsupported.message).toContain('unsupported resume command');

    const scheme = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, cliId: 'traex', cliSessionId: 'native1' },
    }), {
      mode: 'resume',
      adapterFactory: () => ({ buildResumeCommand: () => 'traex://resume/native1' }),
    });
    expect(scheme.ok).toBe(false);
    expect(!scheme.ok && scheme.error).toBe('missing_resume_id');
    expect(!scheme.ok && scheme.message).toContain('unsupported resume command');
  });

  it('escapes AppleScript string literals used by terminal launch scripts', () => {
    expect(appleScriptQuote('echo "x" \\ done')).toBe('"echo \\"x\\" \\\\ done"');
    expect(buildItermAppleScript('echo "x"')).toContain('write text "echo \\"x\\""');
    expect(buildTerminalAppleScript('echo "x"')).toContain('do script "echo \\"x\\""');
  });

  it('rejects non-macOS before probing local terminal apps', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume sid' }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'linux',
      runOsascript,
      adapterFactory,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('unsupported_platform');
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(runOsascript).not.toHaveBeenCalled();
  });

  it('launches iTerm by absolute app path first', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      mode: 'resume',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript).toHaveBeenCalledTimes(1);
    expect(runOsascript.mock.calls[0][0][0]).toBe('-e');
    const script = runOsascript.mock.calls[0][0][1];
    expect(script).toContain('tell application "/Applications/iTerm.app"');
    expect(script).toContain("codex resume 'sid'");
  });

  it('tries iTerm absolute path, bundle id, then app name before Terminal fallback', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'path failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'bundle id failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'name failed' })
      .mockResolvedValueOnce({ ok: true });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      mode: 'resume',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript.mock.calls[0][0][1]).toContain('tell application "/Applications/iTerm.app"');
    expect(runOsascript.mock.calls[1][0][1]).toContain('tell application id "com.googlecode.iterm2"');
    expect(runOsascript.mock.calls[2][0][1]).toContain('tell application "iTerm"');
    expect(runOsascript.mock.calls[3][0][1]).toContain('tell application "/System/Applications/Utilities/Terminal.app"');
  });

  it('tries Terminal bundle id after the absolute Terminal path fails', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'path failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'bundle id failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'name failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'terminal path failed' })
      .mockResolvedValueOnce({ ok: true });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      mode: 'resume',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript.mock.calls[4][0][1]).toContain('tell application id "com.apple.Terminal"');
  });

  it('reports a local terminal error when neither iTerm nor Terminal.app can be opened', async () => {
    await withCommandFileTempRoot(async () => {
      const runOsascript = vi.fn(async () => ({ ok: false, stderr: 'automation denied' }));
      const scriptPaths: string[] = [];
      const runOpenCommand = vi.fn(async (args: string[]) => {
        scriptPaths.push(args[2]);
        return { ok: false, stderr: 'open failed' };
      });
      const result = await openLocalCliInIterm(ds(), {
        platform: 'darwin',
        mode: 'resume',
        runOsascript,
        runOpenCommand,
        adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBe('terminal_unavailable');
      expect(!result.ok && result.message).toContain('AppleScript or Launch Services');
      expect(!result.ok && result.message).toContain('iTerm: open failed');
      expect(!result.ok && result.message).toContain('Terminal.app: open failed');
      expect(runOsascript).toHaveBeenCalledTimes(5);
      expect(runOpenCommand).toHaveBeenCalledTimes(2);
      expect(runOpenCommand.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
        ['-b', 'com.googlecode.iterm2'],
        ['-b', 'com.apple.Terminal'],
      ]);
      expect(scriptPaths[0]).toBe(scriptPaths[1]);
      expect(existsSync(dirname(scriptPaths[0]))).toBe(false);
    });
  });

  it('falls back to an async iTerm Launch Services request with a self-cleaning command file', async () => {
    await withCommandFileTempRoot(async (root) => {
      const fakeBin = mkdtempSync(join(root, 'bin-'));
      symlinkSync('/usr/bin/true', join(fakeBin, 'codex'));
      const runOsascript = vi.fn(async () => ({ ok: false, stderr: 'automation denied (-1743)' }));
      const runOpenCommand = vi.fn(async () => ({ ok: true }));
      const result = await openLocalCliInIterm(ds({ workingDir: root }), {
        platform: 'darwin',
        mode: 'resume',
        runOsascript,
        runOpenCommand,
        adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
      });

      expect(result.ok).toBe(true);
      expect(runOsascript).toHaveBeenCalledTimes(5);
      expect(runOpenCommand).toHaveBeenCalledTimes(1);
      const args = runOpenCommand.mock.calls[0][0];
      const scriptPath = args[2];
      const scriptDir = dirname(scriptPath);
      expect(args.slice(0, 2)).toEqual(['-b', 'com.googlecode.iterm2']);
      expect(scriptPath).toMatch(/botmux-open-command-.*open-cli\.command$/);
      expect(statSync(scriptPath).mode & 0o777).toBe(0o700);
      const script = readFileSync(scriptPath, 'utf8');
      const cleanup = `/bin/rm -rf -- '${scriptDir}' >/dev/null 2>&1 || true`;
      expect(script).toContain('#!/bin/bash\ncd /\n');
      expect(script).toContain(cleanup);
      expect(script.indexOf(cleanup)).toBeLessThan(script.indexOf("codex resume 'sid'"));
      execFileSync(scriptPath, [], { env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` } });
      expect(existsSync(scriptDir)).toBe(false);
    });
  });

  it('falls back to Terminal.app when iTerm is unavailable through Launch Services', async () => {
    await withCommandFileTempRoot(async () => {
      const runOsascript = vi.fn(async () => ({ ok: false, stderr: 'automation denied (-1743)' }));
      const runOpenCommand = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, stderr: 'iTerm is not installed' })
        .mockResolvedValueOnce({ ok: true });
      const result = await openLocalCliInIterm(ds(), {
        platform: 'darwin',
        mode: 'resume',
        runOsascript,
        runOpenCommand,
        adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
      });

      expect(result.ok).toBe(true);
      expect(runOpenCommand).toHaveBeenCalledTimes(2);
      expect(runOpenCommand.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
        ['-b', 'com.googlecode.iterm2'],
        ['-b', 'com.apple.Terminal'],
      ]);
      expect(runOpenCommand.mock.calls[0][0][2]).toBe(runOpenCommand.mock.calls[1][0][2]);
    });
  });

  it('sweeps stale command dirs without touching similarly named botmux temp dirs', async () => {
    await withCommandFileTempRoot(async (root) => {
      const stale = mkdtempSync(join(root, 'botmux-open-command-'));
      const legacyStale = mkdtempSync(join(root, 'botmux-open-'));
      const recent = mkdtempSync(join(root, 'botmux-open-command-'));
      const unrelated = mkdtempSync(join(root, 'botmux-open-local-cli-'));
      const similarlyNamed = join(root, 'botmux-open-command-user-data');
      mkdirSync(similarlyNamed);
      const sentinel = join(similarlyNamed, 'keep.txt');
      writeFileSync(sentinel, 'keep');
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      utimesSync(stale, old, old);
      utimesSync(legacyStale, old, old);
      utimesSync(unrelated, old, old);
      utimesSync(similarlyNamed, old, old);

      const result = await openLocalCliInIterm(ds(), {
        platform: 'darwin',
        mode: 'resume',
        runOsascript: vi.fn(async () => ({ ok: false, stderr: 'automation denied' })),
        runOpenCommand: vi.fn(async () => ({ ok: false, stderr: 'open failed' })),
        adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
      });

      expect(result.ok).toBe(false);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(legacyStale)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
    });
  });

  it('launches TRAE in iTerm with traex resume instead of URL schemes', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds({
      session: { ...ds().session, cliId: 'traex', cliSessionId: 'trae-native' },
    }), {
      platform: 'darwin',
      mode: 'resume',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'traex resume trae-native' }),
    });

    expect(result.ok).toBe(true);
    const script = runOsascript.mock.calls[0][0][1];
    expect(script).toContain('tell application "/Applications/iTerm.app"');
    expect(script).toContain("traex resume 'trae-native'");
    expect(script).not.toMatch(/\b(?:trae|traex):\/\//);
  });
});
