import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installWecomGatewayFatalGuard } from '../src/im/wecom/gateway/fatal-guard.js';
import { wecomConfigId, wecomRoot } from '../src/im/wecom/config/discovery.js';
import { readWecomFleetDesiredState } from '../src/im/wecom/config/fleet-desired-state.js';
import { WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../src/im/wecom/contract/fleet-member.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * An uncaught exception or unhandled rejection in a gateway used to end the
 * process on the spot, leaving the managed core running as an orphan on the
 * core port. The gateway must stop the core first and then exit with a plain
 * failure (1) — unless it was already shutting down for a reason retrying
 * cannot fix, which keeps its no-restart code and its desired-state record.
 * The gateway runs in a child process because the guard ends its process.
 */

const roots: string[] = [];
const corePids: number[] = [];

afterEach(async () => {
  for (const pid of corePids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runGatewayThatFails(mode: 'exception' | 'rejection' | 'after-replaced') {
  const root = mkdtempSync(join(tmpdir(), 'wecom-fatal-'));
  roots.push(root);
  const port = await reserveWecomCorePort();
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    botId: `fatal-guard-${mode}-${process.pid}`,
    secretEnv: 'FATAL_GUARD_WECOM_SECRET',
    coreUrl: `http://127.0.0.1:${port}`,
    allowedUsers: ['alice'],
    stateDir: root,
    managedCore: { botId: 'local_fatal_guard', cli: 'codex', backend: 'pty', port, workingDirectory: root, stateDir: join(root, 'core-state') },
  }));
  const marker = join(root, 'core-sigterm');
  const coreScript = join(root, 'fake-core.mjs');
  writeFileSync(coreScript, [
    "import { appendFileSync } from 'node:fs';",
    "console.log('[core-only] listening on 127.0.0.1:' + process.env.BOTMUX_API_PORT + ' (bot ' + process.env.BOTMUX_API_ONLY_BOT + ', cli ' + process.env.BOTMUX_CORE_CLI + ')');",
    // Slow to stop: an error after a replacement comes while the gateway still waits for its core.
    `process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(marker)}, 'sigterm'); setTimeout(() => process.exit(0), ${mode === 'after-replaced' ? 800 : 0}); });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const source = `
    import { EventEmitter } from 'node:events';
    import { spawn } from 'node:child_process';
    const { runWecomCommand } = await import(${JSON.stringify(resolve('src/im/wecom/gateway/command.ts'))});
    class FakeSocket extends EventEmitter {
      send(data, callback) {
        const frame = JSON.parse(data);
        callback?.();
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ headers: frame.headers, errcode: 0 }))));
        if (frame.cmd === 'aibot_subscribe' && ${JSON.stringify(mode)} === 'after-replaced') {
          // Another client takes the BotID; a bug fires while the gateway shuts down.
          setTimeout(() => this.emit('message', Buffer.from(JSON.stringify({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } }))), 200);
          setTimeout(() => { throw new Error('gateway bug'); }, 400);
        } else if (frame.cmd === 'aibot_subscribe') {
          setTimeout(() => {
            if (${JSON.stringify(mode)} === 'exception') throw new Error('gateway bug');
            Promise.reject(new Error('gateway bug'));
          }, 200);
        }
      }
      terminate() { this.emit('close'); }
    }
    const code = await runWecomCommand(['--config', ${JSON.stringify(config)}], {
      socketFactory: () => { const socket = new FakeSocket(); setTimeout(() => socket.emit('open'), 10); return socket; },
      coreSpawn: (_command, _args, options) => {
        const child = spawn(process.execPath, [${JSON.stringify(coreScript)}], options);
        console.log('CORE_PID=' + child.pid);
        return child;
      },
    });
    console.log('RETURNED=' + code);
  `;
  const gateway = spawnTsEvalWithRepoImports(source, {
    cwd: resolve('.'),
    env: { ...process.env, FATAL_GUARD_WECOM_SECRET: 'fake-secret', BOTMUX_WECOM_FLEET_MEMBER: 'wecom-member' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  gateway.stdout!.on('data', chunk => {
    output += chunk;
  });
  gateway.stderr!.on('data', chunk => {
    output += chunk;
  });
  const [code] = await once(gateway, 'close');
  const corePid = Number(/CORE_PID=(\d+)/.exec(output)?.[1]);
  if (corePid) {
    corePids.push(corePid);
  }
  return { code, corePid, marker, output, configId: wecomConfigId(config) };
}

describe('WeCom gateway fatal error guard', () => {
  it.each(['exception', 'rejection'] as const)('stops the core before exiting with 1 on an unhandled %s', async mode => {
    const { code, corePid, marker, output } = await runGatewayThatFails(mode);

    expect(corePid, output).toBeGreaterThan(0);
    expect(code, output).toBe(1);
    expect(existsSync(marker) && readFileSync(marker, 'utf8'), output).toBe('sigterm');
    expect(pidAlive(corePid)).toBe(false);
  }, 60_000);

  it('an error while shutting down after a replacement keeps the no-restart exit and the stop record', async () => {
    mkdirSync(wecomRoot(), { recursive: true });
    const { code, corePid, marker, output, configId } = await runGatewayThatFails('after-replaced');

    // The guard reports the error that ended the gateway (the fixture's own).
    expect(output).toContain('gateway bug');
    expect(code, output).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    const snapshot = readWecomFleetDesiredState();
    expect(snapshot.status === 'ok' ? snapshot.connections.get(configId) : undefined).toMatchObject({ desired: 'stopped', reason: 'replaced' });
    expect(existsSync(marker) && readFileSync(marker, 'utf8'), output).toBe('sigterm');
    expect(pidAlive(corePid)).toBe(false);
  }, 60_000);
});

describe('WeCom gateway fatal error guard: its own clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function guard(options: { stopCore: () => Promise<void>; exitCode?: () => number }) {
    const events = new EventEmitter();
    const exits: number[] = [];
    const remove = installWecomGatewayFatalGuard({
      ...options,
      deadlineMs: 10_000,
      exit: code => exits.push(code),
      events,
    });
    return { events, exits, remove };
  }

  it('exits at its deadline when stopping the core never finishes', async () => {
    vi.useFakeTimers();
    const { events, exits, remove } = guard({ stopCore: () => new Promise<void>(() => {}) });
    try {
      events.emit('uncaughtException', new Error('gateway bug'));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([1]);
    } finally {
      remove();
    }
  });

  it('exits once, with the code the run settled on, as soon as the core is stopped', async () => {
    vi.useFakeTimers();
    let stopped!: () => void;
    const { events, exits, remove } = guard({
      stopCore: () => new Promise<void>(done => {
        stopped = done;
      }),
      exitCode: () => WECOM_GATEWAY_NO_RESTART_EXIT_CODE,
    });
    try {
      events.emit('unhandledRejection', new Error('gateway bug'));
      events.emit('uncaughtException', new Error('second bug while stopping'));
      await vi.advanceTimersByTimeAsync(500);
      stopped();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(exits).toEqual([WECOM_GATEWAY_NO_RESTART_EXIT_CODE]);
    } finally {
      remove();
    }
  });
});
