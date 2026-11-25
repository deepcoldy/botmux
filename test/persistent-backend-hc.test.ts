/**
 * hc (herdr-core) through the daemon's persistent-backend dispatch: which core
 * a session's terminal is looked up and ended on, and that every answer hc
 * cannot vouch for fails closed. A fake `herdr-core` keyed on the socket it is
 * pointed at stands in for the cores.
 *
 * Run:  npx vitest run --project unit test/persistent-backend-hc.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { backendType: undefined } })),
}));

import {
  getSessionPersistentBackendType,
  isSuspendableBackendType,
  killPersistentBackendTarget,
  killPersistentSession,
  persistentBackendTargetKey,
  persistentSessionName,
  probePersistentBackendTarget,
  probePersistentBackendTargetAfterKill,
  probePersistentBackendTargets,
  probePersistentSession,
  probePersistentSessions,
  resolvePersistentBackendTarget,
  shutdownBackendDisposition,
} from '../src/core/persistent-backend.js';
import type { PersistentBackendTarget } from '../src/adapters/backend/types.js';
import { HC_MIN_VERSION, resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

type HcTarget = Extract<PersistentBackendTarget, { backendType: 'hc' }>;

interface FakeReply {
  out?: unknown;
  err?: unknown;
  code?: number;
}

const SID = '0b0e7c1a-5f7e-4f53-9d55-1f2a3b4c5d6e';
const NAME = 'bmx-0b0e7c1a';
const ENV_KEYS = ['BOTMUX_HC_BIN', 'XDG_RUNTIME_DIR', 'SESSION_DATA_DIR'] as const;

let root: string;
let bin: string;
let callLog: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let home: { hcSession: string; socket: string };
let other: { hcSession: string; socket: string };
let sockets: Server[];

beforeEach(async () => {
  // Unix socket paths are capped at 107 bytes; keep them out of a long TMPDIR.
  root = mkdtempSync('/tmp/bmhcp-');
  bin = join(root, 'herdr-core');
  callLog = join(root, 'calls.log');
  mkdirSync(join(root, 'run'));
  mkdirSync(join(root, 'run2'));
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.BOTMUX_HC_BIN = bin;
  process.env.XDG_RUNTIME_DIR = join(root, 'run');
  process.env.SESSION_DATA_DIR = join(root, 'botmux', 'data');
  home = { hcSession: 'botmux', socket: join(root, 'run', 'herdr-core', 'botmux.sock') };
  other = { hcSession: 'botmux', socket: join(root, 'run2', 'herdr-core', 'botmux.sock') };
  // Where the cores would listen: hc is never run for a core without a socket or a holder.
  sockets = [];
  for (const core of [home, other]) {
    mkdirSync(dirname(core.socket), { recursive: true });
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(core.socket, resolve);
    });
    sockets.push(server);
  }
  resetHcAvailabilityCache();
});

afterEach(async () => {
  await Promise.all(sockets.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetHcAvailabilityCache();
  rmSync(root, { recursive: true, force: true });
});

/** Replies keyed `<socket> <args>`; every call is logged the same way. */
function fakeHc(replies: Record<string, FakeReply>): void {
  const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
  const lines = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo 'hc ${HC_MIN_VERSION.join('.')}'; exit 0; fi`,
    `echo "$HC_SOCKET $*" >> '${callLog}'`,
    'case "$HC_SOCKET $*" in',
  ];
  for (const [call, reply] of Object.entries(replies)) {
    lines.push(`  '${call}')`);
    if (reply.out !== undefined) lines.push(`    printf '%s\\n' '${text(reply.out)}'`);
    if (reply.err !== undefined) lines.push(`    printf '%s\\n' '${text(reply.err)}' >&2`);
    lines.push(`    exit ${reply.code ?? 0};;`);
  }
  lines.push('esac', 'exit 99', '');
  writeFileSync(bin, lines.join('\n'));
  chmodSync(bin, 0o755);
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

const owned = { botmux: '1', botmux_sid: SID };
const notFound = { err: { error: { kind: 'not_found', message: 'no terminal', hint: null } }, code: 1 };
const unavailable = { err: { error: { kind: 'unavailable', message: 'no core', hint: null } }, code: 5 };

function hcTarget(core: { hcSession: string; socket: string }, sessionName = NAME): HcTarget {
  return { backendType: 'hc', sessionName, ...core };
}

function ds(backendType: string): any {
  return { larkAppId: 'app1', initConfig: undefined, session: { sessionId: SID, backendType } };
}

describe('hc session lifecycle', () => {
  it('keeps an hc session\'s terminal across a daemon shutdown', () => {
    expect(isSuspendableBackendType('hc')).toBe(true);
    expect(getSessionPersistentBackendType(ds('hc'))).toBe('hc');
    expect(shutdownBackendDisposition(ds('hc'))).toBe('detach');
  });

  it('names the terminal of a session like every other persistent backend', () => {
    expect(persistentSessionName('hc', SID)).toBe(persistentSessionName('tmux', SID));
  });
});

describe('resolvePersistentBackendTarget for hc', () => {
  it('pins a row that recorded no core to this process\'s botmux core', () => {
    expect(resolvePersistentBackendTarget('hc', SID)).toEqual(hcTarget(home));
  });

  it('keeps the core a row recorded, though this process would pick another', () => {
    const recorded = hcTarget({ hcSession: 'old', socket: other.socket });

    expect(resolvePersistentBackendTarget('hc', SID, recorded)).toEqual(recorded);
  });

  it.each([
    ['of another backend', { backendType: 'tmux', sessionName: NAME }],
    ['without a socket', { backendType: 'hc', sessionName: NAME, hcSession: 'botmux' }],
    ['with an empty socket', { backendType: 'hc', sessionName: NAME, hcSession: 'botmux', socket: '' }],
    ['with a blank core session', { backendType: 'hc', sessionName: NAME, hcSession: ' ', socket: '/tmp/bmhc-elsewhere/botmux.sock' }],
  ])('falls back to the botmux core for a recorded target %s', (_label, recorded) => {
    expect(resolvePersistentBackendTarget('hc', SID, recorded as PersistentBackendTarget)).toEqual(hcTarget(home));
  });

  it('fails closed without running hc on a host that names no core', () => {
    fakeHc({});
    process.env.XDG_RUNTIME_DIR = join(root, 'x'.repeat(120));

    const target = resolvePersistentBackendTarget('hc', SID);

    expect(target).toMatchObject({ backendType: 'hc', sessionName: NAME, socket: '' });
    expect(probePersistentBackendTarget(target)).toBe('unknown');
    expect(() => killPersistentBackendTarget(target, SID)).toThrow();
    expect(calls()).toEqual([]);
  });
});

describe('probePersistentBackendTarget for hc', () => {
  it('looks the terminal up by name on the target\'s own core', () => {
    fakeHc({ [`${other.socket} --json get ${NAME}`]: { out: terminal('live', owned) } });

    expect(probePersistentBackendTarget(hcTarget(other))).toBe('exists');
    expect(calls()).toEqual([`${other.socket} --json get ${NAME}`]);
  });

  it('finds the terminal gone once a kill ended it', () => {
    fakeHc({ [`${other.socket} --json get ${NAME}`]: notFound });

    expect(probePersistentBackendTargetAfterKill(hcTarget(other), { sleep: () => {} })).toBe('missing');
  });
});

describe('killPersistentBackendTarget for hc', () => {
  const get = (): string => `${other.socket} --json get ${NAME}`;

  it('refuses without the complete session id, before running hc', () => {
    fakeHc({ [get()]: { out: terminal('live', owned) } });

    expect(() => killPersistentBackendTarget(hcTarget(other))).toThrow();
    expect(calls()).toEqual([]);
  });

  it('ends and removes this session\'s terminal on the target\'s core', () => {
    fakeHc({
      [get()]: { out: terminal('live', owned) },
      [`${other.socket} --json kill t4`]: { out: terminal('finished', owned, { reason: 'killed', signal: 1 }) },
      [`${other.socket} --json rm t4`]: { out: { removed: 't4' } },
    });

    killPersistentBackendTarget(hcTarget(other), SID);

    expect(calls()).toEqual([get(), `${other.socket} --json kill t4`, `${other.socket} --json rm t4`]);
  });

  it('accepts a terminal that is already gone', () => {
    fakeHc({ [get()]: notFound });

    expect(() => killPersistentBackendTarget(hcTarget(other), SID)).not.toThrow();
  });

  it('refuses another session\'s terminal under the same name and leaves it running', () => {
    fakeHc({ [get()]: { out: terminal('live', { botmux: '1', botmux_sid: '0b0e7c1a-ffff-4f53-9d55-1f2a3b4c5d6e' }) } });

    expect(() => killPersistentBackendTarget(hcTarget(other), SID)).toThrow();
    expect(calls()).toEqual([get()]);
  });

  it('fails closed when the core does not answer', () => {
    fakeHc({ [get()]: unavailable });

    expect(() => killPersistentBackendTarget(hcTarget(other), SID)).toThrow();
  });
});

describe('name-only hc operations', () => {
  it('probe this process\'s botmux core', () => {
    fakeHc({ [`${home.socket} --json get ${NAME}`]: { out: terminal('finished', owned) } });

    expect(probePersistentSession('hc', NAME)).toBe('missing');
    expect(calls()).toEqual([`${home.socket} --json get ${NAME}`]);
  });

  it('end a terminal on that core only for its owning session', () => {
    fakeHc({
      [`${home.socket} --json get ${NAME}`]: { out: terminal('finished', owned) },
      [`${home.socket} --json rm t4`]: { out: { removed: 't4' } },
    });

    expect(() => killPersistentSession('hc', NAME)).toThrow();
    expect(calls()).toEqual([]);

    killPersistentSession('hc', NAME, SID);
    expect(calls()).toEqual([`${home.socket} --json get ${NAME}`, `${home.socket} --json rm t4`]);
  });
});

describe('batched hc probes', () => {
  const listing = (...rows: unknown[]): FakeReply => ({ out: { terminals: rows } });

  it('answer names on the botmux core from one listing', () => {
    fakeHc({
      [`${home.socket} --json ls --all`]: listing(
        terminal('live', owned, { address: 't1', name: 'bmx-live' }),
        terminal('finished', owned, { address: 't2', name: 'bmx-done' }),
      ),
    });

    const probes = probePersistentSessions('hc', ['bmx-live', 'bmx-done', 'bmx-none', 'bmx-live']);

    expect(Object.fromEntries(probes)).toEqual({ 'bmx-live': 'exists', 'bmx-done': 'missing', 'bmx-none': 'missing' });
    expect(calls()).toEqual([`${home.socket} --json ls --all`]);
  });

  it('list each core once and keep one name on two cores apart', () => {
    fakeHc({
      [`${home.socket} --json ls --all`]: listing(terminal('live', owned, { name: 'bmx-a' })),
      [`${other.socket} --json ls --all`]: listing(terminal('finished', owned, { name: 'bmx-a' }), terminal('live', owned, { address: 't5', name: 'bmx-b' })),
    });
    const targets = [
      hcTarget(home, 'bmx-a'),
      hcTarget(other, 'bmx-a'),
      hcTarget(other, 'bmx-b'),
      hcTarget(home, 'bmx-a'),
    ];

    const probes = probePersistentBackendTargets(targets);

    expect(persistentBackendTargetKey(targets[0]!)).toBe(persistentBackendTargetKey(targets[3]!));
    expect(persistentBackendTargetKey(targets[0]!)).not.toBe(persistentBackendTargetKey(targets[1]!));
    expect(probes.size).toBe(3);
    expect(targets.map(target => probes.get(persistentBackendTargetKey(target)))).toEqual(['exists', 'missing', 'exists', 'exists']);
    expect(calls().sort()).toEqual([`${home.socket} --json ls --all`, `${other.socket} --json ls --all`].sort());
  });

  it('leave a core\'s names unknown when its listing fails, without touching the other core\'s', () => {
    fakeHc({
      [`${home.socket} --json ls --all`]: unavailable,
      [`${other.socket} --json ls --all`]: listing(terminal('live', owned, { name: 'bmx-a' })),
    });
    const targets = [hcTarget(home, 'bmx-a'), hcTarget(other, 'bmx-a')];

    const probes = probePersistentBackendTargets(targets);

    expect(targets.map(target => probes.get(persistentBackendTargetKey(target)))).toEqual(['unknown', 'exists']);
  });
});
