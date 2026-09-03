import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync, spawn } from 'node:child_process';
import {
  buildFreshAttachArgs,
  buildZmxLaunchFiles,
  findSessionPid,
  normaliseZmxHistory,
  parseZmxList,
  parseZmxShortList,
  tmuxKeyToBytes,
  zmxControlEnv,
  zmxFreshSessionEnv,
  ZmxBackend,
} from '../src/adapters/backend/zmx-backend.js';
import {
  parseZmxVersion,
  probeZmxFunctional,
  probeZmxVersion,
  zmxEnv,
} from '../src/setup/ensure-zmx.js';

const execFileSyncMock = vi.mocked(execFileSync);
const tempDirs: string[] = [];
const realFishShell = ['/bin/fish', '/usr/bin/fish'].find(path => existsSync(path));

beforeEach(() => {
  execFileSyncMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeExecutableShell(name: 'fish' | 'sh'): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-zmx-shell-'));
  tempDirs.push(dir);
  const shellPath = join(dir, name);
  writeFileSync(shellPath, '#!/bin/sh\nexit 0\n');
  chmodSync(shellPath, 0o755);
  return shellPath;
}

function waitForFileContent(path: string, expected: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastObserved = '<missing>';
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = readFileSync(path, 'utf8');
        lastObserved = JSON.stringify(value);
        if (value === expected) {
          resolve();
          return;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          lastObserved = `<read error: ${err instanceof Error ? err.message : String(err)}>`;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(
          `Timed out waiting for ${path} to contain ${JSON.stringify(expected)}; last observed ${lastObserved}`,
        ));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(
        `Timed out after ${timeoutMs}ms waiting for generated ZMX launch to exit; ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      ));
    }, timeoutMs);
    child.once('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('zmx env/probe helpers', () => {
  it('strips inherited session vars but preserves the socket dir', () => {
    const env = zmxEnv({
      PATH: '/bin',
      ZMX_SESSION: 'parent',
      ZMX_SESSION_PREFIX: 'dev-',
      ZMX_DIR: '/tmp/zmx',
    } as NodeJS.ProcessEnv);

    expect(env.ZMX_SESSION).toBeUndefined();
    expect(env.ZMX_SESSION_PREFIX).toBeUndefined();
    expect(env.ZMX_DIR).toBe('/tmp/zmx');
    expect(env.PATH).toContain('/bin');
    expect(env.PATH).toContain('.local/share/mise/shims');
  });

  // `zmx version` is not a pure print: it resolves and touches the socket dir.
  // A read-only ZMX_DIR / a stale XDG_RUNTIME_DIR (systemd --user without
  // lingering) therefore exits non-zero on a perfectly healthy install. Only
  // ENOENT may be reported as "not on PATH" — anything else must surface the
  // real cause, or a Linux operator reinstalls zmx forever chasing the wrong bug.
  it('reports the real cause instead of blaming PATH when the socket dir is unusable', () => {
    vi.stubEnv('ZMX_DIR', '/tmp/zmx-readonly');
    const failure: any = new Error('Command failed');
    failure.status = 1;
    failure.stderr = Buffer.from('error: ReadOnlyFileSystem\n');
    execFileSyncMock.mockImplementationOnce(() => { throw failure; });

    const result = probeZmxVersion();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('ReadOnlyFileSystem');
      expect(result.reason).not.toContain('不在 PATH 上');
      // The effective socket-dir source is actionable on a headless daemon.
      expect(result.reason).toContain('ZMX_DIR=/tmp/zmx-readonly');
    }
  });

  it('still blames PATH only for a genuine ENOENT', () => {
    const failure: any = new Error('spawn zmx ENOENT');
    failure.code = 'ENOENT';
    execFileSyncMock.mockImplementationOnce(() => { throw failure; });

    expect(probeZmxVersion()).toEqual({ ok: false, reason: 'zmx 二进制不在 PATH 上' });
  });

  it('reports a probe timeout as a timeout rather than a missing binary', () => {
    const failure: any = new Error('ETIMEDOUT');
    failure.killed = true;
    failure.signal = 'SIGTERM';
    execFileSyncMock.mockImplementationOnce(() => { throw failure; });

    const result = probeZmxVersion();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('超时');
      expect(result.reason).not.toContain('不在 PATH 上');
    }
  });

  it('requires the compatible version and a functional list command', () => {
    execFileSyncMock.mockReturnValueOnce('zmx 0.7.1\n' as never);
    execFileSyncMock.mockReturnValueOnce('' as never);

    expect(probeZmxFunctional()).toEqual({ ok: true, version: 'zmx 0.7.1' });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'zmx', ['version'], expect.any(Object));
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'zmx', ['list'], expect.any(Object));
  });

  it('can enforce the protocol version without requiring a list probe', () => {
    execFileSyncMock.mockReturnValueOnce('zmx 0.7.2\n' as never);
    expect(probeZmxVersion()).toEqual({ ok: true, version: 'zmx 0.7.2' });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith('zmx', ['version'], expect.any(Object));
  });

  it('parses versions but rejects releases without the required send contract', () => {
    expect(parseZmxVersion('zmx\t\t0.6.0\nghostty_vt\tdev\n')).toEqual([0, 6, 0]);
    expect(parseZmxVersion('zmx 0.7.1')).toEqual([0, 7, 1]);
    expect(parseZmxVersion('unknown')).toBeNull();

    execFileSyncMock.mockReturnValueOnce('zmx 0.6.99\n' as never);
    expect(probeZmxFunctional()).toEqual({
      ok: false,
      reason: 'zmx >= 0.7.0 才受支持（当前 0.6.99；需要 send 不抢占 client leadership 的行为，输出由 history 获取）',
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    // 0.7.0 is the exact floor: upstream commit 8ba312d7 ("fix(send): preserve
    // client leadership") shipped in that release, so it must be ACCEPTED.
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValueOnce(
      'zmx\t\t0.7.0\nghostty_vt\tdev\nsocket_dir\t/tmp/zmx-501\nlog_dir\t/tmp/zmx-501/logs\n' as never,
    );
    execFileSyncMock.mockReturnValueOnce('' as never);
    // The reported version is normalised to one line: the raw `zmx version`
    // blob would leak socket_dir/log_dir through the Dashboard API.
    expect(probeZmxFunctional()).toEqual({ ok: true, version: 'zmx 0.7.0' });
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);

    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValueOnce('garbage\n' as never);
    expect(probeZmxFunctional()).toEqual({
      ok: false,
      reason: '无法解析 zmx 版本：garbage',
    });
  });
});

describe('zmx backend pure helpers', () => {
  it('maps tmux-style special keys to terminal bytes', () => {
    expect(tmuxKeyToBytes('Enter')).toBe('\r');
    expect(tmuxKeyToBytes('C-c')).toBe('\x03');
    expect(tmuxKeyToBytes('C-j')).toBe('\x0a');
    expect(tmuxKeyToBytes('M-b')).toBe('\x1bb');
    expect(tmuxKeyToBytes('M-Enter')).toBe('\x1b\r');
    expect(tmuxKeyToBytes('PPage')).toBe('\x1b[5~');
    expect(tmuxKeyToBytes('NPage')).toBe('\x1b[6~');
    expect(tmuxKeyToBytes('weird')).toBe('weird');
  });

  it('normalises plain history and repeated CR boundaries consistently', () => {
    expect(normaliseZmxHistory('one\ntwo\r\nthree')).toBe('one\r\ntwo\r\nthree');
    expect(normaliseZmxHistory('one\r\r\ntwo')).toBe('one\r\ntwo');
  });

  it('parses session pid from zmx list details', () => {
    execFileSyncMock.mockReturnValueOnce('other\nbmx-abcd1234\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      '  name=other\tpid=11\tclients=0\n' +
      '  name=bmx-abcd1234\tpid=4242\tclients=1\tcmd=codex\n' as never,
    );

    expect(findSessionPid('bmx-abcd1234')).toBe(4242);
  });

  it('parses healthy and unhealthy rows from the full list', () => {
    expect(parseZmxList(
      '  name=bmx-abcd1234\tpid=42\tclients=1\n' +
      '  name=my notes\tpid=43\tclients=0\n' +
      '  name=bmx-timeout\terr=Timeout\n',
    )).toEqual({
      sessions: ['bmx-abcd1234', 'my notes'],
      unhealthySessions: ['bmx-timeout'],
      malformedLines: [],
    });
  });

  it('only reads ZMX status from the second tab field', () => {
    expect(parseZmxList(
      '  name=bmx-healthy\tpid=123\tclients=1\tstart_dir=/tmp/err=logs\tcmd=agent --prompt err=retry\n' +
      '  name=bmx-unhealthy\terr=Timeout pid=999\tcmd=agent pid=123\n',
    )).toEqual({
      sessions: ['bmx-healthy'],
      unhealthySessions: ['bmx-unhealthy'],
      malformedLines: [],
    });
  });

  it('accepts literal-newline command continuations without reading their status text', () => {
    expect(parseZmxList(
      '  name=bmx-healthy\tpid=123\tclients=1\tcmd=agent --prompt first\n' +
      'second err=retry pid=999\n' +
      'name=literal prompt text, not a record\n' +
      'name=literal\tfield\tpid=999\n' +
      '  name=bmx-unhealthy\terr=Timeout\n',
    )).toEqual({
      sessions: ['bmx-healthy'],
      unhealthySessions: ['bmx-unhealthy'],
      malformedLines: [],
    });
  });

  it('parses short-list names strictly', () => {
    expect(parseZmxShortList('bmx-one\nmy notes\n')).toEqual({
      sessions: ['bmx-one', 'my notes'],
      malformedLines: [],
    });
    expect(parseZmxShortList('bmx-one\nwarning:\tpartial\n')).toEqual({
      sessions: ['bmx-one'],
      malformedLines: ['warning:\tpartial'],
    });
  });

  it('does not infer a session pid from cwd or argv fields', () => {
    execFileSyncMock.mockReturnValueOnce('bmx-other\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-target\terr=Timeout\tcmd=agent --pid=999\n' +
      '  name=bmx-other\tpid=42\tcmd=agent bmx-target pid=777\n' as never,
    );
    expect(findSessionPid('bmx-target')).toBeNull();
  });

  it('fails closed when full-list output is malformed', () => {
    expect(parseZmxList('')).toEqual({
      sessions: [],
      unhealthySessions: [],
      malformedLines: [],
    });
    expect(parseZmxList('warning: partial response\n')).toEqual({
      sessions: [],
      unhealthySessions: [],
      malformedLines: ['warning: partial response'],
    });
    execFileSyncMock.mockReturnValueOnce('bmx-good\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      'warning: partial response\n  name=bmx-good\tpid=42\tclients=1\n' as never,
    );
    expect(ZmxBackend.probeSession('bmx-other')).toBe('unknown');
  });

  it('does not classify an errored target as missing', () => {
    execFileSyncMock.mockReturnValueOnce('' as never);
    execFileSyncMock.mockReturnValueOnce('  name=bmx-timeout\terr=Timeout\n' as never);
    expect(ZmxBackend.probeSession('bmx-timeout')).toBe('unknown');
  });

  it('does not trust a healthy-looking full row absent from --short', () => {
    execFileSyncMock.mockReturnValueOnce('bmx-real\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-real\tpid=11\tclients=0\tcmd=agent --prompt first\n' +
      '  name=bmx-forged\tpid=999\tclients=0\n' as never,
    );
    expect(ZmxBackend.probeSession('bmx-forged')).toBe('unknown');
  });

  it('lists botmux sessions from the authoritative short list', () => {
    execFileSyncMock.mockReturnValueOnce('bmx-abcd1234\nnotes\nbmx-deadbeef\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-abcd1234\tpid=11\tclients=0\n' +
      '  name=notes\tpid=12\tclients=0\n' +
      '  name=bmx-deadbeef\tpid=13\tclients=1\n' as never,
    );

    expect(ZmxBackend.listBotmuxSessions()).toEqual(['bmx-abcd1234', 'bmx-deadbeef']);
  });

  it('waits through a transient stale socket when confirming a managed kill', () => {
    const name = 'bmx-abcd1234';
    const sessionId = 'abcd1234-1111-2222-3333-444444444444';
    const rootPid = process.ppid;
    const launchPid = process.pid;
    let killed = false;
    let staleProbe = true;
    execFileSyncMock.mockImplementation((file, argv) => {
      if (file === '/usr/bin/ps' || file === '/bin/ps') {
        return `${rootPid}\n`;
      }
      const [command, ...args] = argv as string[];
      if (command === 'list' && args[0] === '--short') {
        if (killed && staleProbe) {
          staleProbe = false;
          throw new Error('stale socket');
        }
        return killed ? '' : `${name}\n`;
      }
      if (command === 'list') {
        return killed ? '' : `  name=${name}\tpid=${rootPid}\tclients=0\tcmd=codex\n`;
      }
      if (command === 'get' && args[1] === 'botmux.transport') return 'tail-send-v1\n';
      if (command === 'get' && args[1] === 'botmux.session') return `${sessionId}\n`;
      if (command === 'get' && args[1] === 'botmux.launch_pid') return `${launchPid}\n`;
      if (command === 'get' && args[1] === 'botmux.gate_nonce') {
        return '0123456789abcdef0123456789abcdef\n';
      }
      if (command === 'kill') {
        killed = true;
        return `killed session ${name}\n`;
      }
      throw new Error(`unexpected zmx command: ${argv.join(' ')}`);
    });

    expect(() => ZmxBackend.killManagedSession(name, sessionId, rootPid)).not.toThrow();
    expect(killed).toBe(true);
    expect(staleProbe).toBe(false);
  });

  it('fails closed when a managed session is replaced during kill confirmation', () => {
    const name = 'bmx-abcd1234';
    const sessionId = 'abcd1234-1111-2222-3333-444444444444';
    const rootPid = process.ppid;
    const launchPid = process.pid;
    let killed = false;
    execFileSyncMock.mockImplementation((file, argv) => {
      if (file === '/usr/bin/ps' || file === '/bin/ps') {
        return `${rootPid}\n`;
      }
      const [command, ...args] = argv as string[];
      if (command === 'list' && args[0] === '--short') return `${name}\n`;
      if (command === 'list') {
        const pid = killed ? rootPid + 1 : rootPid;
        return `  name=${name}\tpid=${pid}\tclients=0\tcmd=codex\n`;
      }
      if (command === 'get' && args[1] === 'botmux.transport') return 'tail-send-v1\n';
      if (command === 'get' && args[1] === 'botmux.session') {
        return killed ? 'abcd1234-9999-8888-7777-666666666666\n' : `${sessionId}\n`;
      }
      if (command === 'get' && args[1] === 'botmux.launch_pid') return `${launchPid}\n`;
      if (command === 'get' && args[1] === 'botmux.gate_nonce') {
        return '0123456789abcdef0123456789abcdef\n';
      }
      if (command === 'kill') {
        killed = true;
        return '';
      }
      throw new Error(`unexpected zmx command: ${argv.join(' ')}`);
    });

    expect(() => ZmxBackend.killManagedSession(name, sessionId, rootPid))
      .toThrow(/同名会话替换/);
    expect(killed).toBe(true);
  });

  it('builds a private file gate and strips nested-session identity', () => {
    const opts = {
      cwd: '/tmp/work',
      cols: 80,
      rows: 24,
      env: {
        PATH: '/bin',
        ZMX_SESSION: 'outer',
        BOTMUX_SESSION_ID: 'session-secret',
        BOTMUX_CORE_ONLY: '1',
        SESSION_DATA_DIR: '/tmp/core-only/data',
      },
      injectEnv: {
        ZMX_SESSION: 'evil',
        ZMX_SESSION_PREFIX: 'evil-',
        SAFE_FLAG: "yes ' quoted",
      },
      launchShell: makeExecutableShell('sh'),
    };
    const bootstrapPath = '/tmp/private/bootstrap.sh';
    const payloadPath = '/tmp/private/payload.sh';
    const readyPath = '/tmp/private/ready';
    const releasePath = '/tmp/private/release';
    const readyNonce = '0123456789abcdef0123456789abcdef';
    const releaseToken = 'fedcba9876543210fedcba9876543210';
    const argv = buildFreshAttachArgs('bmx-abcd1234', bootstrapPath);
    const files = buildZmxLaunchFiles(
      'codex',
      ['--flag', 'private prompt'],
      opts,
      payloadPath,
      readyPath,
      readyNonce,
      releasePath,
      releaseToken,
    );

    expect(argv).toEqual(['attach', 'bmx-abcd1234', '/bin/sh', bootstrapPath]);
    expect(argv.join(' ')).not.toContain('private prompt');
    expect(files.bootstrap).not.toContain('private prompt');
    expect(files.bootstrap).not.toContain('session-secret');
    expect(files.bootstrap).not.toContain("yes ' quoted");
    // The pane scrubs BOTMUX_CORE_ONLY / SESSION_DATA_DIR before launching the
    // CLI, so ZMX must bake the host-resolved dedicated wrapper dir into its
    // shell script just like tmux does. Otherwise a same-HOME shared wrapper
    // could shadow this core-only daemon's build.
    expect(files.bootstrap).toContain('/tmp/core-only/data/bin');
    expect(files.bootstrap).not.toContain('/.botmux/bin');
    expect(files.bootstrap).toContain(payloadPath);
    expect(files.bootstrap).toContain(readyPath);
    expect(files.bootstrap).toContain(releasePath);
    expect(files.bootstrap).toContain(readyNonce);
    expect(files.bootstrap).toContain(releaseToken);
    expect(files.bootstrap)
      .toContain(`botmux-zmx-private-release-gate-v1:${readyNonce}`);
    // The ZMX forkpty child already owns the correct slave descriptor. Reopening
    // `/dev/tty` changes fd 0 into a Darwin kqueue-incompatible descriptor.
    expect(files.bootstrap).not.toContain('exec </dev/tty');
    expect(files.bootstrap).toContain('cli_pid_path=');
    expect(files.bootstrap).toContain('"$$" > "$cli_pid_path"');
    expect(files.bootstrap).toContain('/bin/sh -c ');
    expect(files.bootstrap).toContain('\ncli_status=$?\nrm -f -- "$cli_pid_path"\nwhile ! sleep 3; do :; done\n');
    expect(files.bootstrap).not.toContain('botmux-zmx-ready=');
    expect(files.bootstrap).not.toContain('stty');
    expect(files.payload).toContain('private prompt');
    expect(files.payload).toContain('BOTMUX_SESSION_ID=session-secret');
    expect(files.payload).toContain("SAFE_FLAG=yes '");
    expect(files.payload).not.toContain('ZMX_SESSION=evil');
    expect(files.payload).not.toContain('ZMX_SESSION_PREFIX=evil-');

    const controlEnv = zmxControlEnv(opts);
    expect(controlEnv.BOTMUX_SESSION_ID).toBeUndefined();
    expect(controlEnv.SAFE_FLAG).toBeUndefined();
    expect(controlEnv.ZMX_SESSION).toBeUndefined();
    expect(controlEnv.PATH).toContain('/bin');
  });

  it('pins TERM in the fresh-session create client env (zmx sessions inherit it verbatim)', () => {
    const opts = {
      cwd: '/tmp/work',
      cols: 80,
      rows: 24,
      env: { PATH: '/bin', BOTMUX_SESSION_ID: 'session-secret' },
    };
    // No TERM inherited (the pm2-boundary scrub removed it from the
    // daemon/worker env): the pin supplies the constant instead of leaving
    // the whole session TERM-less — CLIs would fail supports-color detection
    // and render colorless.
    const env = zmxFreshSessionEnv(opts);
    expect(env.TERM).toBe('xterm-256color');
    // Still a control-env superset: payload-delivered keys stay stripped.
    expect(env.BOTMUX_SESSION_ID).toBeUndefined();
    // An inherited invoker TERM is overridden by the same constant every
    // other backend PTY already forces — deterministic, invoker-independent.
    expect(zmxFreshSessionEnv({ ...opts, env: { PATH: '/bin', TERM: 'xterm-ghostty' } }).TERM)
      .toBe('xterm-256color');
    // Source pin: only the one-shot create client (whose env becomes the
    // session env) spawns with the pinned env; control clients (get/set/
    // list/kill) keep the unpinned zmxControlEnv.
    const src = readFileSync(new URL('../src/adapters/backend/zmx-backend.ts', import.meta.url), 'utf-8');
    const spawnAt = src.indexOf("spawnSync('zmx', buildFreshAttachArgs(");
    expect(spawnAt).toBeGreaterThan(-1);
    expect(src.slice(spawnAt, src.indexOf('});', spawnAt))).toContain('env: zmxFreshSessionEnv(opts)');
  });

  it('keeps the POSIX ZMX payload path sourced through the user shell with the argv sentinel', () => {
    const shShell = makeExecutableShell('sh');
    const opts = {
      cwd: '/tmp/posix-work',
      cols: 80,
      rows: 24,
      env: { PATH: '/bin' },
      launchShell: shShell,
    };
    const payloadPath = '/tmp/private/payload.sh';

    const files = buildZmxLaunchFiles(
      'codex',
      ['--flag', 'private prompt'],
      opts,
      payloadPath,
      '/tmp/private/ready',
      '0123456789abcdef0123456789abcdef',
      '/tmp/private/release',
      'fedcba9876543210fedcba9876543210',
    );

    expect(files.payload).toContain('set -- ');
    expect(files.payload).toContain('private prompt');
    expect(files.bootstrap).toContain('. "$payload" || exit 126');
    expect(files.bootstrap).toContain(payloadPath);
  });

  it('renders a fish-compatible ZMX payload without POSIX source or argv sentinel', () => {
    const fishShell = makeExecutableShell('fish');
    const opts = {
      cwd: '/tmp/fish work',
      cols: 80,
      rows: 24,
      env: {
        PATH: '/bin',
        BOTMUX_SESSION_ID: 'fish-session-secret',
      },
      injectEnv: {
        SAFE_FLAG: "yes ' quoted",
      },
      launchShell: fishShell,
    };
    const payloadPath = '/tmp/private/payload.fish';

    const files = buildZmxLaunchFiles(
      'codex',
      ['--flag', 'private prompt'],
      opts,
      payloadPath,
      '/tmp/private/ready',
      '0123456789abcdef0123456789abcdef',
      '/tmp/private/release',
      'fedcba9876543210fedcba9876543210',
    );

    expect(files.payload).toContain('set -g __botmux_zmx_argv ');
    expect(files.payload).toContain('private prompt');
    expect(files.payload).toContain('fish-session-secret');
    expect(files.payload).not.toContain('set -- ');
    expect(files.bootstrap).toContain(fishShell);
    expect(files.bootstrap).toContain('cd -- $argv[1]; or exit');
    expect(files.bootstrap).toContain('set argv $payload_argv');
    expect(files.bootstrap).toContain('set -e argv[1]');
    expect(files.bootstrap).toContain('exec /usr/bin/env $argv');
    expect(files.bootstrap).not.toContain('. "$payload" || exit 126');
    expect(files.bootstrap).not.toContain(`_ '${payloadPath}'`);
  });

  it.skipIf(!realFishShell)('executes generated fish launch files with cwd/env/argv from the payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-zmx-fish-live-'));
    tempDirs.push(root);
    const workDir = join(root, 'work dir');
    const launchDir = join(root, 'launch');
    mkdirSync(workDir);
    mkdirSync(launchDir);
    const bootstrapPath = join(launchDir, 'bootstrap.sh');
    const payloadPath = join(launchDir, 'payload.fish');
    const readyPath = join(launchDir, 'ready');
    const releasePath = join(launchDir, 'release');
    const releaseTempPath = join(launchDir, 'release.tmp');
    const outputPath = join(root, 'cli-output.txt');
    const readyNonce = '0123456789abcdef0123456789abcdef';
    const releaseToken = 'fedcba9876543210fedcba9876543210';
    const files = buildZmxLaunchFiles(
      '/bin/sh',
      [
        '-c',
        `printf 'PWD:%s\nSAFE:%s\nARG:%s\n' "$PWD" "$SAFE_FLAG" "$1" > '${outputPath}'`,
        'cli-zero',
        'fish-arg',
      ],
      {
        cwd: workDir,
        cols: 80,
        rows: 24,
        env: { PATH: '/usr/bin:/bin' },
        injectEnv: { SAFE_FLAG: 'fish-safe' },
        launchShell: realFishShell,
      },
      payloadPath,
      readyPath,
      readyNonce,
      releasePath,
      releaseToken,
    );
    writeFileSync(payloadPath, files.payload, { mode: 0o600 });
    writeFileSync(bootstrapPath, files.bootstrap, { mode: 0o700 });

    const child = spawn('/bin/sh', [bootstrapPath], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Starts at spawn: 5s readiness + 3s history grace + 2s execution/scheduler slack.
    // The outer 12s test deadline leaves roughly 2s for assertions and cleanup.
    const exitPromise = waitForExit(child, 10_000);
    try {
      await waitForFileContent(readyPath, `${readyNonce}\n`, 5000);
      writeFileSync(releaseTempPath, `${releaseToken}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(releaseTempPath, releasePath);
      const result = await exitPromise;

      expect(result).toMatchObject({ code: 0 });
      expect(result.stderr).not.toContain(payloadPath);
      expect(readFileSync(outputPath, 'utf8')).toBe(`PWD:${workDir}\nSAFE:fish-safe\nARG:fish-arg\n`);
      expect(existsSync(payloadPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 12_000);
});
