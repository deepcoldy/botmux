import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import {
  killPrivateTmuxServer,
  parseLsofTmuxServers,
  reapRegisteredTestProcesses,
  registerSandboxScriptForCleanup,
  registerTmuxServer,
  testProcessIdentity,
} from '../scripts/test-process-reaper.mjs';
import {
  applyTmuxFenceEnv,
  createTmuxFence,
  realTmuxBinary,
  teardownTmuxFence,
  tmuxFenceShimScript,
  TMUX_SERVER_LOG_BASENAME,
} from './helpers/tmux-fence.js';

const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const serverIdentities = new Map<number, string | null>();
const realTmux = realTmuxBinary();
const linux = process.platform === 'linux';

function root(prefix: string): string {
  const dir = mkdtempSync(prefix);
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  const exits: Promise<unknown>[] = [];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      exits.push(once(child, 'exit').catch(() => undefined));
      child.kill('SIGKILL');
    }
  }
  await Promise.all(exits);
  for (const [pid, identity] of serverIdentities) {
    if (identity && testProcessIdentity(pid) === identity) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startServer(socket: string, tmux = realTmux!): number {
  mkdirSync(dirname(socket), { recursive: true });
  const started = spawnSync(tmux, ['-S', socket, 'new-session', '-d', '-s', 'reaper-probe', 'sleep 60'], {
    encoding: 'utf8', env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
  });
  expect(started.status, started.stderr).toBe(0);
  const query = spawnSync(realTmux!, ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' });
  const pid = Number(query.stdout.trim());
  expect(pid).toBeGreaterThan(1);
  serverIdentities.set(pid, testProcessIdentity(pid));
  return pid;
}

function alive(pid: number): boolean {
  const identity = testProcessIdentity(pid);
  return identity !== null && !identity.startsWith('zombie|');
}

describe.skipIf(!linux || !realTmux)('private test process reaping', () => {
  it('reaps the original server pid when kill-server fails', () => {
    const dir = root('/tmp/bmx-reaper-kill-failure-');
    const socket = join(dir, 'socket');
    const pid = startServer(socket);
    const wrapper = join(dir, 'tmux-fails-kill');
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "-S" ] && [ "$3" = "kill-server" ]; then exit 42; fi\nexec ${JSON.stringify(realTmux!)} "$@"\n`);
    chmodSync(wrapper, 0o755);

    const result = killPrivateTmuxServer(wrapper, socket, {
      serverLog: join(dir, TMUX_SERVER_LOG_BASENAME),
    });

    expect(result.ok).toBe(true);
    expect(result.killServerStatus).toBe(42);
    expect(alive(pid)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('reaps through the fence registry after the custom socket directory is deleted', () => {
    const scratch = root('/tmp/bmx-reaper-scratch-');
    const fence = createTmuxFence({ ...process.env, BOTMUX_TMUX_FENCE_PARENT: scratch });
    const env = { ...process.env };
    applyTmuxFenceEnv(fence, env);
    expect(fence.binDir).not.toBeNull();
    const custom = root('/tmp/bmx-reaper-custom-socket-');
    const socket = join(custom, 'socket');
    const shim = join(fence.binDir!, 'tmux');
    const pid = startServer(socket, shim);
    expect(readFileSync(join(fence.root, TMUX_SERVER_LOG_BASENAME), 'utf8')).toContain(`pending\t${socket}`);

    rmSync(custom, { recursive: true, force: true });
    expect(existsSync(socket)).toBe(false);
    teardownTmuxFence(fence);

    expect(alive(pid)).toBe(false);
    expect(existsSync(fence.root)).toBe(false);
    expect(env.BOTMUX_TMUX_SERVER_LOG).toContain(fence.root);
  });

  it('rechecks a pending socket after its announcing client exits in a single sweep', async () => {
    for (let round = 0; round < 8; round++) {
      const dir = root('/tmp/bmx-reaper-client-exit-');
      const socket = join(dir, 'socket');
      const serverLog = join(dir, TMUX_SERVER_LOG_BASENAME);
      writeFileSync(serverLog, '');
      const delayedReal = join(dir, 'delayed-real-tmux');
      writeFileSync(delayedReal, `#!/bin/sh\nsleep 1\nexec ${JSON.stringify(realTmux!)} "$@"\n`, { mode: 0o755 });
      const shim = join(dir, 'tmux');
      writeFileSync(shim, tmuxFenceShimScript(delayedReal, [], join(dir, 'denied.log'), serverLog), { mode: 0o755 });
      chmodSync(shim, 0o755);
      const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };
      const client = spawn(shim, ['-S', socket, 'new-session', '-d', '-s', 'late', 'sleep 60'], {
        stdio: 'ignore', detached: true, env,
      });
      children.add(client);
      const exited = once(client, 'exit');
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (readFileSync(serverLog, 'utf8').includes(`pending\t${socket}\t${client.pid}\n`)) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        expect(readFileSync(serverLog, 'utf8')).toContain(`pending\t${socket}\t${client.pid}\n`);
        const result = reapRegisteredTestProcesses(dir);
        await exited;
        expect(result.tmuxFailed).toEqual([]);
        const query = spawnSync(realTmux!, ['-S', socket, 'display-message', '-p', '#{pid}'], {
          encoding: 'utf8', env, timeout: 3_000,
        });
        expect(query.status, `round ${round}: ${query.stdout}\n${query.stderr}`).not.toBe(0);
      } finally {
        if (client.exitCode === null && client.signalCode === null) {
          client.kill('SIGKILL');
          await exited;
        }
        const query = spawnSync(realTmux!, ['-S', socket, 'display-message', '-p', '#{pid}'], {
          encoding: 'utf8', env, timeout: 3_000,
        });
        if (query.status === 0) {
          const pid = Number(query.stdout.trim());
          serverIdentities.set(pid, testProcessIdentity(pid));
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('refuses to signal a pid whose recorded start identity does not match', () => {
    const dir = root('/tmp/bmx-reaper-identity-');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.add(child);
    expect(child.pid).toBeGreaterThan(1);
    writeFileSync(join(dir, TMUX_SERVER_LOG_BASENAME), `${child.pid}\tnot-the-live-start-identity\t/tmp/private-socket\n`);

    const result = reapRegisteredTestProcesses(dir);

    expect(result.tmuxFailed).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
    child.kill('SIGKILL');
  });

  it('reaps sandbox processes by their unique script path after the directory is gone', async () => {
    const registry = root('/tmp/bmx-reaper-sandbox-registry-');
    const lab = root('/tmp/sbx-life-reaper-');
    const script = join(lab, 'fake-cli');
    const ready = join(registry, 'fake-cli-ready');
    writeFileSync(script, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)}, '1');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const env = { ...process.env, BOTMUX_TEST_SANDBOX_SCRIPT_LOG: join(registry, 'sandbox-scripts.log') };
    registerSandboxScriptForCleanup(script, env);
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    children.add(child);
    expect(child.pid).toBeGreaterThan(1);
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    expect(existsSync(ready)).toBe(true);
    rmSync(lab, { recursive: true, force: true });

    const result = reapRegisteredTestProcesses(registry);

    expect(result.sandboxFailed).toEqual([]);
    expect(result.sandboxPids).toContain(child.pid);
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('uses the fenced env registry when the socket vanished before direct cleanup', () => {
    const registry = root('/tmp/bmx-reaper-env-registry-');
    const custom = root('/tmp/bmx-reaper-env-socket-');
    const socket = join(custom, 'socket');
    const pid = startServer(socket);
    const env = { ...process.env, BOTMUX_TMUX_SERVER_LOG: join(registry, TMUX_SERVER_LOG_BASENAME) };
    registerTmuxServer(realTmux!, socket, { env });
    rmSync(custom, { recursive: true, force: true });
    const wrapper = join(registry, 'tmux-fails-kill');
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "-S" ] && [ "$3" = "kill-server" ]; then exit 42; fi\nexec ${JSON.stringify(realTmux!)} "$@"\n`);
    chmodSync(wrapper, 0o755);

    const result = killPrivateTmuxServer(wrapper, socket, { env });

    expect(result.ok).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('keeps cleanup failed when ps inspection fails instead of proving death', () => {
    const dir = root('/tmp/bmx-reaper-ps-failure-');
    const fakeBin = join(dir, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.add(child);
    const identity = testProcessIdentity(child.pid!);
    expect(identity).not.toBeNull();
    writeFileSync(join(dir, TMUX_SERVER_LOG_BASENAME), `${child.pid}\t${identity}\t/tmp/private-socket\n`);
    const previousPath = process.env.PATH;
    let result: ReturnType<typeof reapRegisteredTestProcesses>;
    try {
      process.env.PATH = fakeBin;
      result = reapRegisteredTestProcesses(dir);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(result!.tmuxFailed.map(ref => ref.pid)).toContain(child.pid);
    expect(alive(child.pid!)).toBe(true);
    child.kill('SIGKILL');
  });

  it('execs the real client so a caller timeout cannot leave it running behind the shim', () => {
    const dir = root('/tmp/bmx-reaper-exec-timeout-');
    const fakeReal = join(dir, 'real-tmux');
    const marker = join(dir, 'client-finished');
    const clientPidFile = join(dir, 'client.pid');
    writeFileSync(fakeReal, `#!/bin/sh
if [ "$3" = "display-message" ]; then echo 1; exit 0; fi
echo $$ > ${JSON.stringify(clientPidFile)}
sleep 1
echo done > ${JSON.stringify(marker)}
`);
    chmodSync(fakeReal, 0o755);
    const shim = join(dir, 'tmux');
    writeFileSync(shim, tmuxFenceShimScript(fakeReal, [], join(dir, 'denied.log'), join(dir, TMUX_SERVER_LOG_BASENAME)));
    chmodSync(shim, 0o755);

    const result = spawnSync(shim, ['-S', join(dir, 'socket'), 'new-session', '-d'], {
      encoding: 'utf8', timeout: 100, killSignal: 'SIGKILL',
    });
    if (existsSync(clientPidFile)) {
      const pid = Number(readFileSync(clientPidFile, 'utf8'));
      serverIdentities.set(pid, testProcessIdentity(pid));
    }
    expect(result.signal).toBe('SIGKILL');
    for (let attempt = 0; attempt < 20; attempt++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe('non-Linux lsof discovery', () => {
  it('matches only requested private sockets and refuses unknown identities', () => {
    const output = [
      'p42', 'ctmux: server', 'n/tmp/private-socket (deleted)',
      'p43', 'ctmux: server', 'n/tmp/unrelated-socket',
      'p44', 'ctmux: server', 'n/tmp/unknown-identity',
    ].join('\n');
    const identity = (pid: number) => pid === 44 ? null : `start-${pid}|tmux: server`;

    const found = parseLsofTmuxServers(output, new Set(['/tmp/private-socket']), identity);
    expect(found).toEqual({ ok: true, refs: [{ pid: 42, identity: 'start-42|tmux: server', socket: '/tmp/private-socket' }] });

    const unknown = parseLsofTmuxServers(output, new Set(['/tmp/private-socket', '/tmp/unknown-identity']), identity);
    expect(unknown.ok).toBe(false);
    expect(unknown.refs.map(ref => ref.pid)).toEqual([42]);
  });
});
