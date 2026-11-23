import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import {
  ensureHcConfig,
  ensureHcCore,
  hcControlEnv,
  hcCorePaths,
  hcHolderSocketPrefix,
  hcPaneXdgRestore,
  queryHcCoreStatus,
} from '../src/adapters/backend/hc/core.js';
import { HC_MIN_VERSION, resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';
import { DEFAULT_RENDER_COLS, DEFAULT_RENDER_ROWS } from '../src/utils/render-dimensions.js';

const floor = HC_MIN_VERSION.join('.');
const belowFloor = [HC_MIN_VERSION[0], HC_MIN_VERSION[1], HC_MIN_VERSION[2] - 1].join('.');

let root: string;

beforeEach(() => {
  // Unix socket paths are capped at 107 bytes; keep them out of a long TMPDIR.
  root = mkdtempSync('/tmp/bmhck-');
  resetHcAvailabilityCache();
});

afterEach(() => {
  resetHcAvailabilityCache();
  rmSync(root, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function tomlKeys(text: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) keys[match[1]] = match[2];
  }
  return keys;
}

describe('hcControlEnv', () => {
  const core = { session: 'botmux', socket: '/tmp/r/herdr-core/botmux.sock', configHome: '/tmp/c' };

  it('drops inherited hc, tmux and botmux-managed keys and pins the core identity', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/someone',
      HC_SOCKET: '/run/user/0/herdr-core/default.sock',
      HC_SESSION: 'default',
      HC_TERMINAL_ID: 't3',
      HC_TERMINAL_SOCKET: '/run/user/0/herdr-core/default.holder.0badc0de.sock',
      HC_SCOPE: 't3',
      HC_FUTURE_KEY: 'x',
      _HC_INTERNAL: 'x',
      TMUX: '/tmp/tmux-0/default,1,0',
      TMUX_PANE: '%1',
      BOTMUX_SESSION_ID: 'sid',
      SESSION_DATA_DIR: '/data',
      BOTS_CONFIG: '/bots.json',
      XDG_CONFIG_HOME: '/home/someone/.config',
    };

    const env = hcControlEnv(base, core);

    for (const key of [
      'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'HC_FUTURE_KEY', '_HC_INTERNAL',
      'TMUX', 'TMUX_PANE', 'BOTMUX_SESSION_ID', 'SESSION_DATA_DIR', 'BOTS_CONFIG',
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(env.HC_SESSION).toBe(core.session);
    expect(env.HC_SOCKET).toBe(core.socket);
    expect(env.XDG_CONFIG_HOME).toBe(core.configHome);
    expect(env.HOME).toBe(base.HOME);
    expect(base.HC_SOCKET).toBe('/run/user/0/herdr-core/default.sock');
  });

  it('keeps provider credentials for the agents the core runs', () => {
    const env = hcControlEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' }, core);

    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.OPENAI_API_KEY).toBe('o');
  });

  it('derives the identity from the env when none is given', () => {
    const runtime = join(root, 'run');
    const env = hcControlEnv({ PATH: '/usr/bin', XDG_RUNTIME_DIR: runtime, SESSION_DATA_DIR: join(root, 'b', 'data') });

    expect(env.HC_SOCKET?.startsWith(`${runtime}/`)).toBe(true);
    expect(env.XDG_CONFIG_HOME?.startsWith(join(root, 'b'))).toBe(true);
  });

  it('gives every daemon on one socket the same state dir, whatever its HOME, XDG_STATE_HOME or data root', () => {
    const runtime = join(root, 'run');
    const daemons: NodeJS.ProcessEnv[] = [
      { PATH: '/usr/bin', HOME: join(root, 'a'), XDG_STATE_HOME: join(root, 'a', 'state'), XDG_RUNTIME_DIR: runtime, SESSION_DATA_DIR: join(root, 'a', 'data') },
      { PATH: '/usr/bin', HOME: join(root, 'b'), XDG_RUNTIME_DIR: runtime, SESSION_DATA_DIR: join(root, 'b', 'data') },
      { PATH: '/usr/bin', XDG_RUNTIME_DIR: runtime },
    ];

    const envs = daemons.map(daemon => hcControlEnv(daemon));

    expect(new Set(envs.map(env => env.HC_SOCKET)).size).toBe(1);
    expect(new Set(envs.map(env => env.XDG_STATE_HOME)).size).toBe(1);
    expect(envs[0]!.XDG_STATE_HOME?.startsWith(`${runtime}/`)).toBe(true);
  });

  it('keeps the state dir with the socket: a frozen core keeps its own, another runtime dir gets another', () => {
    const frozen = { hcSession: 'botmux', socket: join(root, 'old', 'herdr-core', 'botmux.sock') };
    const now = { PATH: '/usr/bin', XDG_RUNTIME_DIR: join(root, 'new') };

    const onFrozen = hcControlEnv(now, hcCorePaths(now, { core: frozen }));
    const onCurrent = hcControlEnv(now);

    expect(onFrozen.XDG_STATE_HOME?.startsWith(join(root, 'old', 'herdr-core'))).toBe(true);
    expect(onCurrent.XDG_STATE_HOME?.startsWith(join(root, 'new', 'herdr-core'))).toBe(true);
  });
});

describe('hcPaneXdgRestore', () => {
  const core = { session: 'botmux', socket: '/tmp/r/herdr-core/botmux.sock', configHome: '/tmp/c' };

  function paneEnv(worker: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const pane = hcControlEnv(worker, core);
    const { set, unset } = hcPaneXdgRestore(worker);
    for (const key of unset) delete pane[key];
    return { ...pane, ...set };
  }

  it.each([
    ['set', { XDG_CONFIG_HOME: '/home/u/.config', XDG_STATE_HOME: '/home/u/.state', XDG_DATA_HOME: '/home/u/.data' }],
    ['unset', {}],
    ['partly set, one of them empty', { XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '/home/u/.cache' }],
  ] as const)('hands a pane the worker\'s own XDG dirs when they are %s', (_label, xdg) => {
    const worker: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u', ...xdg };
    const pane = paneEnv(worker);

    const keys = new Set([...Object.keys(worker), ...Object.keys(hcControlEnv(worker, core))]
      .filter(key => key.startsWith('XDG_')));
    for (const key of keys) expect(pane[key], key).toBe(worker[key]);
  });
});

describe('hcCorePaths', () => {
  it('puts the socket under XDG_RUNTIME_DIR and the config beside the botmux data dir', () => {
    const paths = hcCorePaths({ XDG_RUNTIME_DIR: '/tmp/r', SESSION_DATA_DIR: '/srv/botmux/data' });

    expect(paths.runtimeDir).toBe('/tmp/r');
    expect(paths.socket.startsWith('/tmp/r/herdr-core/')).toBe(true);
    expect(paths.socket.endsWith('.sock')).toBe(true);
    expect(paths.configHome.startsWith('/srv/botmux/')).toBe(true);
    expect(paths.configHome.startsWith('/srv/botmux/data')).toBe(false);
  });

  it('falls back to /run/user/<uid> without an absolute XDG_RUNTIME_DIR', () => {
    expect(hcCorePaths({}, { uid: 4242 }).runtimeDir).toBe('/run/user/4242');
    expect(hcCorePaths({ XDG_RUNTIME_DIR: 'relative/run' }, { uid: 4242 }).runtimeDir).toBe('/run/user/4242');
  });

  it('takes a target\'s frozen core as given, whatever the env says now', () => {
    const core = { hcSession: 'botmux', socket: '/tmp/old/herdr-core/botmux.sock' };
    const paths = hcCorePaths({ XDG_RUNTIME_DIR: '/tmp/new', SESSION_DATA_DIR: '/srv/botmux/data' }, { core });

    expect(paths).toMatchObject({ session: 'botmux', socket: core.socket, runtimeDir: '/tmp/old' });
    expect(paths.configHome.startsWith('/srv/botmux/')).toBe(true);
    expect(() => hcCorePaths({}, { core: { ...core, socket: 'herdr-core/botmux.sock' } })).toThrow();
    expect(() => hcCorePaths({}, { core: { ...core, socket: `/${'r'.repeat(107)}/botmux.sock` } })).toThrow();
  });

  it('accepts exactly up to the byte limit of the longest holder socket path', () => {
    // A holder listens on `<prefix minus .sock>.<8 hex>.sock`: 9 bytes past the prefix.
    const overhead = hcCorePaths({ XDG_RUNTIME_DIR: '/x' }).holderSocket.length - '/x'.length + 9;
    const fits = `/${'r'.repeat(107 - overhead - 1)}`;

    expect(hcCorePaths({ XDG_RUNTIME_DIR: fits }).socket.startsWith(fits)).toBe(true);
    expect(() => hcCorePaths({ XDG_RUNTIME_DIR: `${fits}r` })).toThrow();
    expect(() => hcCorePaths({ XDG_RUNTIME_DIR: `${fits.slice(0, -1)}é` })).toThrow();
  });
});

describe('hcHolderSocketPrefix', () => {
  it('replaces the last extension the way Rust with_extension does', () => {
    expect(hcHolderSocketPrefix('/r/herdr-core/botmux.sock')).toBe('/r/herdr-core/botmux.holder.sock');
    expect(hcHolderSocketPrefix('/r/a.b.sock')).toBe('/r/a.b.holder.sock');
    expect(hcHolderSocketPrefix('/r.d/sock')).toBe('/r.d/sock.holder.sock');
    expect(hcHolderSocketPrefix('/r/.sock')).toBe('/r/.sock.holder.sock');
  });
});

describe('ensureHcConfig', () => {
  it('writes the botmux settings privately', () => {
    const configHome = join(root, 'config');

    const result = ensureHcConfig(configHome);

    expect(result.written).toBe(true);
    expect(result.path).toBe(join(configHome, 'herdr-core', 'config.toml'));
    expect(tomlKeys(readFileSync(result.path, 'utf8'))).toEqual({
      notes: 'false',
      headless: `"${DEFAULT_RENDER_COLS}x${DEFAULT_RENDER_ROWS}"`,
      history_mb: '5',
    });
    expect(mode(join(configHome, 'herdr-core'))).toBe(0o700);
    expect(mode(result.path)).toBe(0o600);
  });

  it('leaves an up-to-date file in place and only tightens its permissions', () => {
    const configHome = join(root, 'config');
    const { path } = ensureHcConfig(configHome);
    const inode = statSync(path).ino;
    chmodSync(path, 0o644);
    chmodSync(join(configHome, 'herdr-core'), 0o755);

    expect(ensureHcConfig(configHome).written).toBe(false);
    expect(statSync(path).ino).toBe(inode);
    expect(mode(path)).toBe(0o600);
    expect(mode(join(configHome, 'herdr-core'))).toBe(0o700);
  });

  it('replaces a file with other settings', () => {
    const configHome = join(root, 'config');
    const { path } = ensureHcConfig(configHome);
    writeFileSync(path, 'socket = "/run/user/0/herdr-core/default.sock"\n');

    expect(ensureHcConfig(configHome).written).toBe(true);
    expect(tomlKeys(readFileSync(path, 'utf8'))).not.toHaveProperty('socket');
  });

  it('replaces a symlink without writing through it', () => {
    const configHome = join(root, 'config');
    const outside = join(root, 'outside.toml');
    writeFileSync(outside, 'notes = true\n');
    mkdirSync(join(configHome, 'herdr-core'), { recursive: true });
    const path = join(configHome, 'herdr-core', 'config.toml');
    symlinkSync(outside, path);

    expect(ensureHcConfig(configHome).written).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('notes = true\n');
  });
});

describe.skipIf(process.platform !== 'linux')('queryHcCoreStatus and ensureHcCore against a fake core', () => {
  let shortRoot: string;
  let servers: Server[];

  beforeEach(() => {
    // Unix socket paths are capped at 107 bytes; keep them out of a long TMPDIR.
    shortRoot = mkdtempSync('/tmp/bmhcu-');
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    rmSync(shortRoot, { recursive: true, force: true });
  });

  function fakeCore(socket: string, reply: ((request: string) => string) | null): Promise<void> {
    mkdirSync(join(socket, '..'), { recursive: true });
    const server = createServer(conn => {
      let buffered = '';
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        buffered += chunk;
        if (reply && buffered.includes('\n')) conn.end(`${reply(buffered)}\n`);
      });
      conn.on('error', () => {});
    });
    servers.push(server);
    return new Promise(resolve => server.listen(socket, () => resolve()));
  }

  function statusReply(version: string, pid = 4321): (request: string) => string {
    return request => {
      const { id, method } = JSON.parse(request);
      if (method !== 'server.status') return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } });
      return JSON.stringify({ jsonrpc: '2.0', id, result: { version, pid, live: 0, finished: 0 } });
    };
  }

  /** A binary that passes discovery and records any other invocation. */
  function fakeBin(onOther: string): { bin: string; log: string } {
    const bin = join(shortRoot, 'herdr-core');
    const log = join(shortRoot, 'calls.log');
    writeFileSync(bin, [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo 'hc ${floor}'; exit 0; fi`,
      `echo "$*" >> '${log}'`,
      onOther,
      '',
    ].join('\n'));
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  function coreEnv(bin: string): NodeJS.ProcessEnv {
    const runtime = join(shortRoot, 'run');
    mkdirSync(runtime, { recursive: true });
    return {
      PATH: '/usr/bin:/bin',
      HOME: join(shortRoot, 'home'),
      XDG_RUNTIME_DIR: runtime,
      SESSION_DATA_DIR: join(shortRoot, 'botmux', 'data'),
      BOTMUX_HC_BIN: bin,
    };
  }

  it('reports a socket nobody listens on as absent', async () => {
    await expect(queryHcCoreStatus(join(shortRoot, 'none.sock'))).resolves.toMatchObject({ state: 'absent' });
  });

  it('reads the version and pid of a running core', async () => {
    const socket = join(shortRoot, 'core.sock');
    await fakeCore(socket, statusReply(floor, 99));

    await expect(queryHcCoreStatus(socket)).resolves.toEqual({ state: 'running', version: floor, pid: 99 });
  });

  it('gives up on a core that never answers', async () => {
    const socket = join(shortRoot, 'mute.sock');
    await fakeCore(socket, null);

    await expect(queryHcCoreStatus(socket, 200)).resolves.toMatchObject({ state: 'error' });
  });

  it('joins a running core without starting one', async () => {
    const { bin, log } = fakeBin('exit 1');
    const env = coreEnv(bin);
    await fakeCore(hcCorePaths(env).socket, statusReply(floor, 77));

    await expect(ensureHcCore({ env })).resolves.toMatchObject({ version: floor, pid: 77, started: false, bin });
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(hcCorePaths(env).configHome, 'herdr-core', 'config.toml'))).toBe(true);
  });

  it('joins the core a target was frozen on, not the one this env would pick', async () => {
    const { bin, log } = fakeBin('exit 1');
    const env = coreEnv(bin);
    const frozen = join(shortRoot, 'old-run', 'herdr-core', 'botmux.sock');
    await fakeCore(frozen, statusReply(floor, 55));

    await expect(ensureHcCore({ env, core: { hcSession: 'botmux', socket: frozen } }))
      .resolves.toMatchObject({ socket: frozen, pid: 55, started: false });
    expect(existsSync(log)).toBe(false);
  });

  it('refuses a running core below the version floor and leaves it alone', async () => {
    const { bin, log } = fakeBin('exit 1');
    const env = coreEnv(bin);
    await fakeCore(hcCorePaths(env).socket, statusReply(belowFloor));

    await expect(ensureHcCore({ env })).rejects.toThrow(belowFloor);
    expect(existsSync(log)).toBe(false);
  });

  it('starts an absent core with the control env and surfaces hc\'s failure', async () => {
    const { bin, log } = fakeBin([
      'env | grep -E "^(HC_|XDG_CONFIG_HOME=|XDG_STATE_HOME=|BOTMUX)" | sort >> "$0.env"',
      'echo \'{"error":{"kind":"unavailable","message":"core did not come up","hint":null}}\' >&2',
      'exit 5',
    ].join('\n'));
    const env = {
      ...coreEnv(bin),
      HC_SOCKET: '/run/user/0/herdr-core/default.sock',
      HC_TERMINAL_ID: 't1',
      XDG_STATE_HOME: join(shortRoot, 'home', '.local', 'state'),
    };
    const paths = hcCorePaths(env);

    await expect(ensureHcCore({ env })).rejects.toThrow('core did not come up');
    expect(readFileSync(log, 'utf8').trim()).toBe('--json server start');
    expect(readFileSync(`${bin}.env`, 'utf8').trim().split('\n')).toEqual([
      `HC_SESSION=${paths.session}`,
      `HC_SOCKET=${paths.socket}`,
      `XDG_CONFIG_HOME=${paths.configHome}`,
      `XDG_STATE_HOME=${paths.stateHome}`,
    ]);
    expect(paths.stateHome).not.toBe(env.XDG_STATE_HOME);
  });

  it('refuses to start without the runtime directory', async () => {
    const { bin, log } = fakeBin('exit 0');
    const env = { ...coreEnv(bin), XDG_RUNTIME_DIR: join(shortRoot, 'gone') };

    await expect(ensureHcCore({ env })).rejects.toThrow();
    expect(existsSync(log)).toBe(false);
  });
});
