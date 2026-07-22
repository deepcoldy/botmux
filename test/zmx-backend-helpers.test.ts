import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import {
  buildFreshAttachArgs,
  buildZmxLaunchFiles,
  findSessionPid,
  normaliseZmxHistory,
  parseZmxList,
  parseZmxShortList,
  tmuxKeyToBytes,
  zmxControlEnv,
  ZmxBackend,
} from '../src/adapters/backend/zmx-backend.js';
import {
  parseZmxVersion,
  probeZmxFunctional,
  probeZmxVersion,
  zmxEnv,
} from '../src/setup/ensure-zmx.js';

const execFileSyncMock = vi.mocked(execFileSync);

beforeEach(() => {
  execFileSyncMock.mockReset();
});

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
      reason: 'zmx >= 0.7.1 才受支持（当前 0.6.99；需要包含 PR #202 的 send 行为，输出由 history 获取）',
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValueOnce('zmx 0.7.0\n' as never);
    expect(probeZmxFunctional()).toEqual({
      ok: false,
      reason: 'zmx >= 0.7.1 才受支持（当前 0.7.0；需要包含 PR #202 的 send 行为，输出由 history 获取）',
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

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
    let killed = false;
    let staleProbe = true;
    execFileSyncMock.mockImplementation((_file, argv) => {
      const [command, ...args] = argv as string[];
      if (command === 'list' && args[0] === '--short') {
        if (killed && staleProbe) {
          staleProbe = false;
          throw new Error('stale socket');
        }
        return killed ? '' : `${name}\n`;
      }
      if (command === 'list') {
        return killed ? '' : `  name=${name}\tpid=4242\tclients=0\tcmd=codex\n`;
      }
      if (command === 'get' && args[1] === 'botmux.transport') return 'tail-send-v1\n';
      if (command === 'get' && args[1] === 'botmux.session') return `${sessionId}\n`;
      if (command === 'kill') {
        killed = true;
        return `killed session ${name}\n`;
      }
      throw new Error(`unexpected zmx command: ${argv.join(' ')}`);
    });

    expect(() => ZmxBackend.killManagedSession(name, sessionId, 4242)).not.toThrow();
    expect(killed).toBe(true);
    expect(staleProbe).toBe(false);
  });

  it('fails closed when a managed session is replaced during kill confirmation', () => {
    const name = 'bmx-abcd1234';
    const sessionId = 'abcd1234-1111-2222-3333-444444444444';
    let killed = false;
    execFileSyncMock.mockImplementation((_file, argv) => {
      const [command, ...args] = argv as string[];
      if (command === 'list' && args[0] === '--short') return `${name}\n`;
      if (command === 'list') {
        const pid = killed ? 5252 : 4242;
        return `  name=${name}\tpid=${pid}\tclients=0\tcmd=codex\n`;
      }
      if (command === 'get' && args[1] === 'botmux.transport') return 'tail-send-v1\n';
      if (command === 'get' && args[1] === 'botmux.session') {
        return killed ? 'abcd1234-9999-8888-7777-666666666666\n' : `${sessionId}\n`;
      }
      if (command === 'kill') {
        killed = true;
        return '';
      }
      throw new Error(`unexpected zmx command: ${argv.join(' ')}`);
    });

    expect(() => ZmxBackend.killManagedSession(name, sessionId, 4242)).toThrow(/同名会话替换/);
    expect(killed).toBe(true);
  });

  it('builds a private file gate and strips nested-session identity', () => {
    const opts = {
      cwd: '/tmp/work',
      cols: 80,
      rows: 24,
      env: { PATH: '/bin', ZMX_SESSION: 'outer', BOTMUX_SESSION_ID: 'session-secret' },
      injectEnv: {
        ZMX_SESSION: 'evil',
        ZMX_SESSION_PREFIX: 'evil-',
        SAFE_FLAG: "yes ' quoted",
      },
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
    expect(files.bootstrap).toContain(payloadPath);
    expect(files.bootstrap).toContain(readyPath);
    expect(files.bootstrap).toContain(releasePath);
    expect(files.bootstrap).toContain(readyNonce);
    expect(files.bootstrap).toContain(releaseToken);
    expect(files.bootstrap).toContain('exec </dev/tty');
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
});
