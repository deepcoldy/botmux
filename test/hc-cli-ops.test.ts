import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  collectBotmuxHcTerminals,
  hcTerminalName,
  killHcTerminal,
  listBotmuxHcTerminals,
  probeHcTerminal,
  probeHcTerminals,
  type HcTarget,
} from '../src/adapters/backend/hc/cli-ops.js';
import { HC_MIN_VERSION, resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

interface FakeReply {
  out?: unknown;
  err?: unknown;
  code?: number;
  sleep?: number;
}

const SID = '0b0e7c1a-5f7e-4f53-9d55-1f2a3b4c5d6e';
const NAME = 'bmx-0b0e7c1a';

let root: string;
let bin: string;
let callLog: string;
let envLog: string;
let stdinLog: string;
let target: HcTarget;

beforeEach(() => {
  // Unix socket paths are capped at 107 bytes; keep them out of a long TMPDIR.
  root = mkdtempSync('/tmp/bmhco-');
  bin = join(root, 'herdr-core');
  callLog = join(root, 'calls.log');
  envLog = join(root, 'env.log');
  stdinLog = join(root, 'stdin.log');
  mkdirSync(join(root, 'run'));
  target = {
    backendType: 'hc',
    sessionName: NAME,
    hcSession: 'botmux',
    socket: join(root, 'run', 'herdr-core', 'botmux.sock'),
  };
  placeCoreSocket(target.socket);
  resetHcAvailabilityCache();
});

afterEach(() => {
  resetHcAvailabilityCache();
  rmSync(root, { recursive: true, force: true });
});

/** Where a core would listen; the fake binary answers in its place. */
function placeCoreSocket(socket: string): void {
  mkdirSync(dirname(socket), { recursive: true });
  writeFileSync(socket, '');
}

function fakeHc(replies: Record<string, FakeReply>): void {
  const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
  const lines = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo 'hc ${HC_MIN_VERSION.join('.')}'; exit 0; fi`,
    `echo "$*" >> '${callLog}'`,
    `env | grep -E '^_?HC_' | sort > '${envLog}'`,
    'case "$*" in',
  ];
  for (const [args, reply] of Object.entries(replies)) {
    lines.push(`  '${args}')`);
    if (args === 'connect') lines.push(`    cat > '${stdinLog}'`);
    if (reply.sleep) lines.push(`    exec sleep ${reply.sleep}`);
    if (reply.out !== undefined) lines.push(`    printf '%s\\n' '${text(reply.out)}'`);
    if (reply.err !== undefined) lines.push(`    printf '%s\\n' '${text(reply.err)}' >&2`);
    lines.push(`    exit ${reply.code ?? 0};;`);
  }
  lines.push('esac', 'exit 99', '');
  writeFileSync(bin, lines.join('\n'));
  chmodSync(bin, 0o755);
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    SESSION_DATA_DIR: join(root, 'botmux', 'data'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    BOTMUX_HC_BIN: bin,
    HC_SOCKET: '/run/user/0/herdr-core/default.sock',
    HC_TERMINAL_ID: 't9',
    ...extra,
  };
}

function calls(): string[] {
  return existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : [];
}

function terminal(state: 'live' | 'finished', labels: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    address: 't4',
    name: NAME,
    state,
    labels,
    pid: state === 'live' ? 4242 : null,
    exit_code: state === 'finished' ? 0 : null,
    signal: null,
    reason: state === 'finished' ? 'exited' : null,
    ...extra,
  };
}

const notFound = { error: { kind: 'not_found', message: 'no terminal', hint: 'see `hc ls --all`' } };
const owned = { botmux: '1', botmux_sid: SID };

describe.skipIf(process.platform !== 'linux')('probeHcTerminal', () => {
  const getArgs = (): string => `--json get ${target.sessionName}`;

  it.each([
    ['a live terminal', { out: terminal('live', owned) }, 'exists'],
    ['a finished terminal', { out: terminal('finished', owned) }, 'missing'],
    ['no such terminal', { err: notFound, code: 3 }, 'missing'],
    ['an unavailable core', { err: { error: { kind: 'unavailable', message: 'core did not start' } }, code: 5 }, 'unknown'],
    ['an unparsable answer', { out: 'not json' }, 'unknown'],
    ['a record for another name', { out: terminal('live', owned, { name: 'bmx-ffffffff' }) }, 'unknown'],
    ['a plain-text failure', { err: 'Segmentation fault', code: 139 }, 'unknown'],
  ] as const)('maps %s', (_label, reply, expected) => {
    fakeHc({ [getArgs()]: reply });

    expect(probeHcTerminal(target, { env: env() })).toBe(expected);
  });

  it('talks to the target core with a scrubbed env', () => {
    fakeHc({ [getArgs()]: { out: terminal('live', owned) } });

    probeHcTerminal(target, { env: env() });

    expect(readFileSync(envLog, 'utf8').trim().split('\n')).toEqual([
      `HC_SESSION=${target.hcSession}`,
      `HC_SOCKET=${target.socket}`,
    ]);
  });

  it('is unknown when hc does not answer in time', () => {
    fakeHc({ [getArgs()]: { sleep: 5 } });

    expect(probeHcTerminal(target, { env: env(), timeoutMs: 200 })).toBe('unknown');
  });

  it('is unknown without a usable binary', () => {
    expect(probeHcTerminal(target, { env: env({ BOTMUX_HC_BIN: join(root, 'absent') }) })).toBe('unknown');
  });

  it('never runs hc, which could start a core and create it, when the target\'s runtime dir is gone', () => {
    fakeHc({ [getArgs()]: { out: terminal('live', owned) } });
    const gone = { ...target, socket: join(root, 'gone', 'herdr-core', 'botmux.sock') };

    expect(probeHcTerminal(gone, { env: env() })).toBe('unknown');
    expect(calls()).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('killHcTerminal', () => {
  const getArgs = (): string => `--json get ${target.sessionName}`;

  it('kills and removes a live terminal of this session', () => {
    fakeHc({
      [getArgs()]: { out: terminal('live', owned) },
      '--json kill t4': { out: terminal('finished', owned, { reason: 'killed', signal: 1 }) },
      '--json rm t4': { out: { removed: 't4' } },
    });

    expect(killHcTerminal(target, SID, { env: env() })).toEqual({ result: 'killed', address: 't4' });
    expect(calls()).toEqual([getArgs(), '--json kill t4', '--json rm t4']);
  });

  it('only removes the record of a finished terminal', () => {
    fakeHc({
      [getArgs()]: { out: terminal('finished', owned) },
      '--json rm t4': { out: { removed: 't4' } },
    });

    expect(killHcTerminal(target, SID, { env: env() })).toEqual({ result: 'removed', address: 't4' });
    expect(calls()).toEqual([getArgs(), '--json rm t4']);
  });

  it('leaves another session\'s terminal alone', () => {
    fakeHc({ [getArgs()]: { out: terminal('live', { botmux: '1', botmux_sid: 'someone-else' }) } });

    expect(killHcTerminal(target, SID, { env: env() })).toEqual({
      result: 'mismatch',
      address: 't4',
      owner: 'someone-else',
    });
    expect(calls()).toEqual([getArgs()]);
  });

  it('leaves a terminal botmux did not create alone', () => {
    fakeHc({ [getArgs()]: { out: terminal('live', { botmux_sid: SID }) } });

    expect(killHcTerminal(target, SID, { env: env() })).toMatchObject({ result: 'mismatch' });
    expect(calls()).toEqual([getArgs()]);
  });

  it('reports a name hc does not know as missing', () => {
    fakeHc({ [getArgs()]: { err: notFound, code: 3 } });

    expect(killHcTerminal(target, SID, { env: env() })).toEqual({ result: 'missing' });
  });

  it('counts a record that vanished before rm as removed', () => {
    fakeHc({
      [getArgs()]: { out: terminal('finished', owned) },
      '--json rm t4': { err: notFound, code: 3 },
    });

    expect(killHcTerminal(target, SID, { env: env() })).toEqual({ result: 'removed', address: 't4' });
  });

  it('is unknown when rm is refused', () => {
    fakeHc({
      [getArgs()]: { out: terminal('live', owned) },
      '--json kill t4': { out: terminal('finished', owned) },
      '--json rm t4': { err: { error: { kind: 'live', message: 't4 is live' } }, code: 1 },
    });

    expect(killHcTerminal(target, SID, { env: env() })).toMatchObject({ result: 'unknown' });
  });

  it('is unknown when the core cannot be reached', () => {
    fakeHc({ [getArgs()]: { err: { error: { kind: 'unavailable', message: 'no core' } }, code: 5 } });

    expect(killHcTerminal(target, SID, { env: env() })).toMatchObject({ result: 'unknown' });
  });

  it('refuses without a session id', () => {
    fakeHc({});

    expect(killHcTerminal(target, '', { env: env() })).toMatchObject({ result: 'unknown' });
    expect(calls()).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('listBotmuxHcTerminals', () => {
  it('lists botmux terminals from every state with their session ids', () => {
    fakeHc({
      connect: {
        out: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            terminals: [
              terminal('live', owned),
              terminal('finished', { botmux: '1', botmux_sid: 'other-sid' }, { address: 't2', name: 'bmx-other', signal: 9, reason: 'killed' }),
              terminal('live', owned, { address: 'laptop/t1' }),
              terminal('live', { botmux_sid: SID }, { address: 't3' }),
            ],
          },
        },
      },
    });

    const listing = listBotmuxHcTerminals({ hcSession: target.hcSession, socket: target.socket }, { env: env() });

    expect(listing).toEqual({
      ok: true,
      terminals: [
        {
          address: 't4',
          name: target.sessionName,
          sessionId: SID,
          state: 'live',
          pid: 4242,
          exitCode: null,
          signal: null,
          reason: null,
        },
        {
          address: 't2',
          name: 'bmx-other',
          sessionId: 'other-sid',
          state: 'finished',
          pid: null,
          exitCode: 0,
          signal: 9,
          reason: 'killed',
        },
      ],
    });
    const request = JSON.parse(readFileSync(stdinLog, 'utf8'));
    expect(request).toMatchObject({ method: 'terminal.list', params: { all: true, labels: { botmux: '1' } } });
  });

  it('defaults to the botmux core of the env', () => {
    fakeHc({ connect: { out: { jsonrpc: '2.0', id: 1, result: { terminals: [] } } } });

    expect(listBotmuxHcTerminals(undefined, { env: env() })).toEqual({ ok: true, terminals: [] });
    expect(readFileSync(envLog, 'utf8')).toContain(`HC_SOCKET=${join(root, 'run', 'herdr-core')}/`);
  });

  it('fails when the core refuses the request', () => {
    fakeHc({
      connect: {
        out: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'core is stopping', data: { kind: 'unavailable' } } },
      },
    });

    expect(listBotmuxHcTerminals(undefined, { env: env() }).ok).toBe(false);
  });

  it('fails without a usable binary', () => {
    expect(listBotmuxHcTerminals(undefined, { env: env({ BOTMUX_HC_BIN: join(root, 'absent') }) }).ok).toBe(false);
  });
});

describe('hcTerminalName', () => {
  it('names a session\'s terminal like its tmux session, so a name fits both', () => {
    expect(hcTerminalName(SID)).toBe(NAME);
  });
});

describe.skipIf(process.platform !== 'linux')('probeHcTerminals', () => {
  const ls = '--json ls --all';
  const core = (): { hcSession: string; socket: string } => ({ hcSession: target.hcSession, socket: target.socket });

  it('answers every name from one listing: only a live local terminal exists', () => {
    fakeHc({
      [ls]: {
        out: {
          terminals: [
            terminal('live', {}, { address: 't1', name: 'bmx-live' }),
            terminal('finished', {}, { address: 't2', name: 'bmx-done' }),
            terminal('live', {}, { address: 'laptop/t3', name: 'bmx-remote' }),
            terminal('live', {}, { address: 't5', name: null }),
          ],
        },
      },
    });

    const probes = probeHcTerminals(core(), ['bmx-live', 'bmx-done', 'bmx-remote', 'bmx-none', 'bmx-live'], { env: env() });

    expect(Object.fromEntries(probes)).toEqual({
      'bmx-live': 'exists',
      'bmx-done': 'missing',
      'bmx-remote': 'missing',
      'bmx-none': 'missing',
    });
    expect(calls()).toEqual([ls]);
    expect(readFileSync(envLog, 'utf8')).toContain(`HC_SOCKET=${target.socket}\n`);
  });

  it.each([
    ['the core cannot be reached', { err: { error: { kind: 'unavailable', message: 'no core', hint: null } }, code: 5 }],
    ['the reply has no terminal list', { out: { ok: true } }],
    ['a row cannot be read', { out: { terminals: [terminal('live', {}, { name: 'bmx-live' }), { name: 'bmx-other' }] } }],
  ] as const)('leaves every name unknown when %s', (_label, reply) => {
    fakeHc({ [ls]: reply });

    const probes = probeHcTerminals(core(), ['bmx-live', 'bmx-other'], { env: env() });

    expect(Object.fromEntries(probes)).toEqual({ 'bmx-live': 'unknown', 'bmx-other': 'unknown' });
  });

  it('does not run hc for no names', () => {
    fakeHc({ [ls]: { out: { terminals: [] } } });

    expect(probeHcTerminals(core(), [], { env: env() }).size).toBe(0);
    expect(calls()).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('collectBotmuxHcTerminals', () => {
  function fakeCores(replies: Record<string, FakeReply>): void {
    const lines = [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo 'hc ${HC_MIN_VERSION.join('.')}'; exit 0; fi`,
      'cat > /dev/null',
      `echo "$HC_SESSION $HC_SOCKET $*" >> '${callLog}'`,
      'case "$HC_SOCKET" in',
    ];
    for (const [socket, reply] of Object.entries(replies)) {
      lines.push(`  '${socket}')`);
      if (reply.out !== undefined) lines.push(`    printf '%s\\n' '${JSON.stringify(reply.out)}'`);
      if (reply.err !== undefined) lines.push(`    printf '%s\\n' '${JSON.stringify(reply.err)}' >&2`);
      lines.push(`    exit ${reply.code ?? 0};;`);
    }
    lines.push('esac', 'exit 99', '');
    writeFileSync(bin, lines.join('\n'));
    chmodSync(bin, 0o755);
  }

  const listing = (terminals: unknown[]): FakeReply => ({ out: { jsonrpc: '2.0', id: 1, result: { terminals } } });

  it('lists each core once and tags every owned terminal with the core it lives on', () => {
    const a = { hcSession: 'botmux', socket: target.socket };
    const b = { hcSession: 'other', socket: join(root, 'run', 'herdr-core', 'other.sock') };
    placeCoreSocket(b.socket);
    fakeCores({
      [a.socket]: listing([
        terminal('live', owned),
        terminal('finished', { botmux: '1' }, { address: 't6', name: 'bmx-nosid' }),
        terminal('live', { botmux: '1', botmux_sid: 'sid-unnamed' }, { address: 't7', name: null }),
      ]),
      [b.socket]: listing([terminal('finished', { botmux: '1', botmux_sid: 'sid-b' }, { address: 't1', name: 'bmx-sid-b' })]),
    });

    const sweep = collectBotmuxHcTerminals([a, b, { ...a }], { env: env() });

    expect(sweep).toEqual({
      terminals: [
        { sessionId: SID, target: { backendType: 'hc', sessionName: NAME, ...a }, address: 't4', state: 'live' },
        { sessionId: 'sid-b', target: { backendType: 'hc', sessionName: 'bmx-sid-b', ...b }, address: 't1', state: 'finished' },
      ],
      failures: [],
    });
    expect(calls()).toEqual([`botmux ${a.socket} connect`, `other ${b.socket} connect`]);
  });

  it('reports a core that gives no listing instead of treating it as empty', () => {
    const a = { hcSession: 'botmux', socket: target.socket };
    const b = { hcSession: 'other', socket: join(root, 'run', 'herdr-core', 'other.sock') };
    placeCoreSocket(b.socket);
    fakeCores({
      [a.socket]: { err: { error: { kind: 'unavailable', message: 'no core', hint: null } }, code: 5 },
      [b.socket]: listing([terminal('live', owned)]),
    });

    const sweep = collectBotmuxHcTerminals([a, b], { env: env() });

    expect(sweep.failures).toEqual([{ core: a, reason: expect.any(String) }]);
    expect(sweep.terminals.map(entry => entry.target.socket)).toEqual([b.socket]);
  });
});

describe.skipIf(process.platform !== 'linux')('a core with neither a socket nor a holder', () => {
  const get = `--json get ${NAME}`;

  beforeEach(() => {
    rmSync(target.socket);
  });

  it('answers missing and empty without running hc, which would start a core from this env', () => {
    fakeHc({
      [get]: { out: terminal('live', owned) },
      '--json ls --all': { out: { terminals: [terminal('live', owned)] } },
      connect: { out: { jsonrpc: '2.0', id: 1, result: { terminals: [terminal('live', owned)] } } },
    });

    expect(probeHcTerminal(target, { env: env() })).toBe('missing');
    expect(Object.fromEntries(probeHcTerminals(target, [NAME], { env: env() }))).toEqual({ [NAME]: 'missing' });
    expect(killHcTerminal(target, SID, { env: env() })).toEqual({ result: 'missing' });
    expect(listBotmuxHcTerminals(target, { env: env() })).toEqual({ ok: true, terminals: [] });
    expect(calls()).toEqual([]);
  });

  it.each([
    ['the socket of a killed core', 'botmux.sock'],
    ['a holder still keeping programs', 'botmux.holder.0a1b2c3d.sock'],
    ['an older holder', 'botmux.holder.sock'],
  ])('is asked of hc when %s is there', (_label, file) => {
    fakeHc({ [get]: { out: terminal('live', owned) } });
    writeFileSync(join(dirname(target.socket), file), '');

    expect(probeHcTerminal(target, { env: env() })).toBe('exists');
    expect(calls()).toEqual([get]);
  });

  it('is not mistaken for running by another core\'s holder in the same dir', () => {
    fakeHc({ [get]: { out: terminal('live', owned) } });
    writeFileSync(join(dirname(target.socket), 'other.holder.0a1b2c3d.sock'), '');

    expect(probeHcTerminal(target, { env: env() })).toBe('missing');
    expect(calls()).toEqual([]);
  });
});
