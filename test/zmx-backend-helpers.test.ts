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
  buildReattachArgs,
  buildZmxLaunchFiles,
  findSessionPid,
  parseZmxList,
  parseZmxShortList,
  terminalOscColorQueryReplies,
  tmuxKeyToBytes,
  zmxControlEnv,
  ZmxBackend,
} from '../src/adapters/backend/zmx-backend.js';
import { parseZmxVersion, probeZmxFunctional, zmxEnv } from '../src/setup/ensure-zmx.js';

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
    } as any);

    expect(env.ZMX_SESSION).toBeUndefined();
    expect(env.ZMX_SESSION_PREFIX).toBeUndefined();
    expect(env.ZMX_DIR).toBe('/tmp/zmx');
    expect(env.PATH).toContain('/bin');
    expect(env.PATH).toContain('.local/share/mise/shims');
  });

  it('requires both version and list to succeed', () => {
    execFileSyncMock.mockReturnValueOnce('zmx 0.6.0\n' as any);
    execFileSyncMock.mockReturnValueOnce('' as any);

    expect(probeZmxFunctional()).toEqual({ ok: true, version: 'zmx 0.6.0' });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'zmx', ['version'], expect.any(Object));
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'zmx', ['list'], expect.any(Object));
  });

  it('parses real multiline output and rejects unsupported or malformed versions', () => {
    expect(parseZmxVersion('zmx\t\t0.6.0\nghostty_vt\tdev\n')).toEqual([0, 6, 0]);
    expect(parseZmxVersion('zmx 0.7.1')).toEqual([0, 7, 1]);
    expect(parseZmxVersion('unknown')).toBeNull();

    execFileSyncMock.mockReturnValueOnce('zmx 0.5.9\n' as any);
    expect(probeZmxFunctional()).toEqual({
      ok: false,
      reason: 'zmx >= 0.6.0 才受支持（当前 0.5.9）',
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValueOnce('garbage\n' as any);
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

  it('answers OSC color queries without treating color setters as queries', () => {
    expect(terminalOscColorQueryReplies(10, '?')).toEqual([
      '\x1b]10;rgb:a9a9/b1b1/d6d6\x1b\\',
    ]);
    expect(terminalOscColorQueryReplies(4, '1;?;255;?')).toEqual([
      '\x1b]4;1;rgb:f7f7/7676/8e8e\x1b\\',
      '\x1b]4;255;rgb:eeee/eeee/eeee\x1b\\',
    ]);
    expect(terminalOscColorQueryReplies(10, '?;?')).toEqual([
      '\x1b]10;rgb:a9a9/b1b1/d6d6\x1b\\',
      '\x1b]11;rgb:1a1a/1b1b/2626\x1b\\',
    ]);
    expect(terminalOscColorQueryReplies(11, '#000000')).toEqual([]);
    expect(terminalOscColorQueryReplies(4, '1;?;2;#ffffff')).toEqual([
      '\x1b]4;1;rgb:f7f7/7676/8e8e\x1b\\',
    ]);
  });

  it('parses session pid from zmx list details', () => {
    execFileSyncMock.mockReturnValueOnce('other\nbmx-abcd1234\n' as any);
    execFileSyncMock.mockReturnValueOnce(
      '  name=other\tpid=11\tclients=0\n' +
      '  name=bmx-abcd1234\tpid=4242\tclients=1\tcmd=codex\n' as any,
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
    execFileSyncMock.mockReturnValueOnce('bmx-other\n' as any);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-target\terr=Timeout\tcmd=agent --pid=999\n' +
      '  name=bmx-other\tpid=42\tcmd=agent bmx-target pid=777\n' as any,
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
    execFileSyncMock.mockReturnValueOnce('bmx-good\n' as any);
    execFileSyncMock.mockReturnValueOnce(
      'warning: partial response\n  name=bmx-good\tpid=42\tclients=1\n' as any,
    );
    expect(ZmxBackend.probeSession('bmx-other')).toBe('unknown');
  });

  it('does not classify an errored target as missing', () => {
    execFileSyncMock.mockReturnValueOnce('' as any);
    execFileSyncMock.mockReturnValueOnce('  name=bmx-timeout\terr=Timeout\n' as any);
    expect(ZmxBackend.probeSession('bmx-timeout')).toBe('unknown');
  });

  it('does not trust a healthy-looking full row that is absent from --short', () => {
    execFileSyncMock.mockReturnValueOnce('bmx-real\n' as any);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-real\tpid=11\tclients=0\tcmd=agent --prompt first\n' +
      '  name=bmx-forged\tpid=999\tclients=0\n' as any,
    );
    expect(ZmxBackend.probeSession('bmx-forged')).toBe('unknown');
  });

  it('lists botmux sessions from the authoritative short list', () => {
    execFileSyncMock.mockReturnValueOnce('bmx-abcd1234\nnotes\nbmx-deadbeef\n' as any);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-abcd1234\tpid=11\tclients=0\n' +
      '  name=notes\tpid=12\tclients=0\n' +
      '  name=bmx-deadbeef\tpid=13\tclients=1\n' as any,
    );

    expect(ZmxBackend.listBotmuxSessions()).toEqual(['bmx-abcd1234', 'bmx-deadbeef']);
  });

  it('builds a race-safe attach command and strips nested-session identity', () => {
    expect(buildReattachArgs('bmx-abcd1234')).toEqual([
      'attach', 'bmx-abcd1234', '/bin/sh', '-c', 'exit 75',
    ]);

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
    const readyMarker = '\x1b]5150;botmux-zmx-ready=0123456789abcdef0123456789abcdef\x1b\\';
    const completionMarker = '\x1b]5150;botmux-zmx-started=0123456789abcdef0123456789abcdef\x1b\\';
    const releaseToken = 'fedcba9876543210fedcba9876543210';
    const argv = buildFreshAttachArgs('bmx-abcd1234', bootstrapPath);
    const files = buildZmxLaunchFiles(
      'codex',
      ['--flag', 'private prompt'],
      opts,
      payloadPath,
      readyMarker,
      completionMarker,
      releaseToken,
    );

    expect(argv).toEqual(['attach', 'bmx-abcd1234', '/bin/sh', bootstrapPath]);
    expect(argv.join(' ')).not.toContain('private prompt');
    expect(files.bootstrap).not.toContain('private prompt');
    expect(files.bootstrap).not.toContain('session-secret');
    expect(files.bootstrap).not.toContain("yes ' quoted");
    expect(files.bootstrap).toContain(payloadPath);
    expect(files.bootstrap).toContain(`printf '%s' '${readyMarker}'`);
    expect(files.bootstrap).toContain(`printf '%s' '${completionMarker}'`);
    expect(files.bootstrap).toContain(`release_line" = '${releaseToken}'`);
    expect(files.bootstrap).toContain('bootstrap-watchdog');
    expect(files.bootstrap).toContain('sleep 8');
    expect(files.bootstrap).toContain('stty -echo');
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
