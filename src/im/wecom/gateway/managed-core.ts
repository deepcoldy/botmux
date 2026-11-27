import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { isStandaloneBinary, resolveEntrySpawn } from '../../../core/self-spawn.js';
import type { FleetProcessIdentityRuntime } from '../../../core/fleet-process-identity.js';
import { openRotatedAppendLog } from '../../../utils/log-rotate.js';
import { NATIVE_GATEWAY_CORE_CREDENTIAL_ENV } from '../../../core/native-gateway-credential.js';
import { wecomManagedCoreEnvironment, type WecomManagedCoreConfig } from '../config/managed-core-env.js';
import { WECOM_MANAGED_CORE_KILL_WAIT_MS, WECOM_MANAGED_CORE_STOP_GRACE_MS } from '../config/gateway-budgets.js';
import {
  forgetWecomCoreGeneration,
  reclaimWecomCoreGeneration,
  recordWecomCoreGeneration,
} from './core-generation.js';

export interface WecomManagedCoreHandle {
  stop(): Promise<void>;
  /**
   * The credential this start generated and handed to the core
   * (core/native-gateway-credential.ts): the gateway signs every request to
   * the core with it. Memory only — never logged, recorded or written.
   */
  readonly credential: string;
}

export interface WecomManagedCoreOptions {
  onExit?: (code: number | null) => void;
  signal?: AbortSignal;
  /** Injection seams: production always uses its own entrypoint and child PID. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  /** SIGTERM → SIGKILL window (default: the core's own shutdown budget). */
  shutdownTimeoutMs?: number;
  /** Wait after SIGKILL before the stop is reported as failed. */
  killWaitMs?: number;
  /**
   * Record the spawned core's birth identity in `file`, and before spawning
   * reclaim the core a previous gateway generation of `configId` left behind
   * (see core-generation.ts). Omitted: neither happens.
   */
  generation?: { file: string; configId: string; runtime?: FleetProcessIdentityRuntime };
  /** Append the core's stdout / stderr to these files (rotated on open). Omitted: discarded. */
  logFiles?: { out: string; err: string };
}

/**
 * The core binds 127.0.0.1:<port>, but free on loopback is not enough: on macOS
 * a 127.0.0.1 listener coexists with another process's 0.0.0.0 listener on the
 * same port and takes all of its loopback traffic — for instance a Feishu
 * worker's web terminal, which its daemon dials at 127.0.0.1. The port has to
 * be free on both.
 */
async function checkPort(port: number): Promise<void> {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    await new Promise<void>((done, reject) => {
      const server = createServer();
      server.once('error', () => reject(new Error('企微 core 端口已占用或不可用')));
      server.listen({ host, port, exclusive: true }, () => server.close(error => error ? reject(error) : done()));
    });
  }
}

/** Between two probes of a port a previous core may still be releasing. */
const PORT_RELEASE_POLL_MS = 50;

/**
 * A previous core that was just reclaimed is not proof that its port is free:
 * a process disappearing and its listening socket being released are not the
 * same moment. On Linux the reclaim counts the core as exited once
 * its thread-group leader is a zombie, while its other threads are still
 * exiting and the descriptor table they share — the listening socket with it —
 * is released only a few milliseconds later. So after a reclaim the port gets
 * until `waitMs` to come free, and fails as a single probe would once that runs
 * out. An abort ends the wait at once.
 */
async function waitForPort(port: number, waitMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await checkPort(port);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
    }
    await pause(Math.min(PORT_RELEASE_POLL_MS, Math.max(1, deadline - Date.now())), signal);
    if (signal?.aborted) {
      throw new Error('企微 core 启动已取消');
    }
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(done => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** The managed core settings are invalid; retrying the same configuration cannot help. */
export class WecomManagedCoreSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WecomManagedCoreSettingsError';
  }
}

function assertWecomManagedCoreSettings(config: WecomManagedCoreConfig): void {
  const settings = config.managedCore;
  if (!settings) {
    throw new WecomManagedCoreSettingsError('未配置托管企微 core');
  }
  if (!Number.isInteger(settings.port)
    || settings.port < 1
    || settings.port > 65535
    || !/^local_[A-Za-z0-9._-]+$/.test(settings.botId)) {
    throw new WecomManagedCoreSettingsError('托管企微 core 端口或身份无效');
  }
}

/**
 * The core-only entry of the build this gateway runs from, so gateway and core
 * are always the same code: `dist/` → `dist/index-core-only.js`, the compiled
 * binary → `<binary> __core-only`, a source run (`bun src/cli.ts wecom`) →
 * `src/index-core-only.ts`. `moduleUrl` is this module's own URL in production.
 */
export function resolveWecomCoreEntry(moduleUrl: string = import.meta.url): { command: string; args: string[] } {
  const moduleFile = fileURLToPath(moduleUrl);
  // <build>/im/wecom/gateway/managed-core.{js,ts} → <build>
  const buildRoot = resolve(dirname(moduleFile), '..', '..', '..');
  const entry = resolveEntrySpawn('core-only', buildRoot);
  if (isStandaloneBinary() || !moduleFile.endsWith('.ts')) {
    return entry;
  }
  const script = entry.args[entry.args.length - 1].replace(/\.js$/, '.ts');
  // @ts-ignore — the Bun global is absent under Node/tsc.
  const bun = typeof Bun !== 'undefined';
  const loader = bun ? [] : ['--import', createRequire(moduleUrl).resolve('tsx')];
  return { command: entry.command, args: [...loader, script] };
}

function openCoreLogs(logFiles: WecomManagedCoreOptions['logFiles']): { out?: number; err?: number } {
  if (!logFiles) {
    return {};
  }
  let out: number | undefined;
  try {
    out = openRotatedAppendLog(logFiles.out);
    const err = openRotatedAppendLog(logFiles.err);
    return { out, err };
  } catch {
    if (out !== undefined) {
      closeSync(out);
    }
    console.error('[wecom] 无法打开企微 core 日志文件，core 输出将被丢弃');
    return {};
  }
}

/** Owns only the child it creates. External coreUrl services never enter this module. */
export async function startWecomManagedCore(
  config: WecomManagedCoreConfig,
  options: WecomManagedCoreOptions = {},
): Promise<WecomManagedCoreHandle> {
  assertWecomManagedCoreSettings(config);
  const settings = config.managedCore!;
  const graceMs = options.shutdownTimeoutMs ?? WECOM_MANAGED_CORE_STOP_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? WECOM_MANAGED_CORE_KILL_WAIT_MS;
  if (options.signal?.aborted) {
    throw new Error('企微 core 启动已取消');
  }
  const previous = options.generation
    ? await reclaimWecomCoreGeneration({
      file: options.generation.file,
      configId: options.generation.configId,
      graceMs,
      killWaitMs,
      signal: options.signal,
      runtime: options.generation.runtime,
    })
    : 'none';
  if (options.signal?.aborted) {
    throw new Error('企微 core 启动已取消');
  }
  if (previous === 'reclaimed') {
    // The previous core exited a moment ago; its port may lag behind.
    await waitForPort(settings.port, killWaitMs, options.signal);
  } else {
    await checkPort(settings.port);
  }
  if (options.signal?.aborted) {
    throw new Error('企微 core 启动已取消');
  }
  const env = wecomManagedCoreEnvironment(config, options.env ?? process.env);
  // A fresh credential for every core this gateway starts. Set after the
  // environment above dropped every inherited BOTMUX_* key, so a same-named
  // variable from the gateway's own environment never reaches the core.
  const credential = randomBytes(32).toString('base64url');
  env[NATIVE_GATEWAY_CORE_CREDENTIAL_ENV] = credential;
  const entry = resolveWecomCoreEntry();
  const logs = openCoreLogs(options.logFiles);
  let child: ChildProcess;
  try {
    child = (options.spawn ?? spawn)(entry.command, entry.args, {
      cwd: settings.workingDirectory,
      env,
      stdio: ['ignore', 'pipe', logs.err ?? 'pipe'],
    });
  } catch (error) {
    if (logs.out !== undefined) {
      closeSync(logs.out);
    }
    throw error;
  } finally {
    // The child holds its own copy of the stderr descriptor.
    if (logs.err !== undefined) {
      closeSync(logs.err);
    }
  }
  const generation = options.generation;
  const corePid = child.pid;
  if (generation && corePid) {
    const recorded = recordWecomCoreGeneration({
      file: generation.file,
      configId: generation.configId,
      corePid,
      coreBotId: settings.botId,
      port: settings.port,
      stateDir: resolve(settings.stateDir),
      runtime: generation.runtime,
    });
    if (!recorded) {
      console.error('[wecom] 无法记录企微 core 的进程身份；若网关被强制结束，需手动结束遗留的 core');
    }
  }
  let exited = child.exitCode !== null || child.signalCode !== null;
  let stopping = false;
  let ready = false;
  let stopPromise: Promise<void> | undefined;
  let exitedResolve!: () => void;
  const exit = new Promise<void>(done => {
    exitedResolve = done;
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const readiness = new Promise<void>((done, reject) => {
    readyResolve = done;
    readyReject = reject;
  });
  if (logs.out !== undefined && child.stdout) {
    const outFd = logs.out;
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        writeSync(outFd, chunk);
      } catch {
        /* a full disk must not stall the core's stdout */
      }
    });
    child.stdout.once('close', () => closeSync(outFd));
  } else if (logs.out !== undefined) {
    closeSync(logs.out);
  }
  const lines = child.stdout ? createInterface({ input: child.stdout }) : undefined;
  const expected = `[core-only] listening on 127.0.0.1:${settings.port} (bot ${settings.botId}, cli ${settings.cli})`;
  lines?.on('line', line => {
    if (!stopping && !exited && line === expected) {
      ready = true;
      readyResolve();
    }
  });
  // Without a log file, drain stderr so a chatty core never blocks on a full pipe.
  child.stderr?.resume();
  const onExit = (code: number | null) => {
    if (exited) {
      return;
    }
    exited = true;
    exitedResolve();
    lines?.close();
    if (generation && corePid) {
      forgetWecomCoreGeneration(generation.file, corePid);
    }
    if (!ready) {
      readyReject(new Error('企微 core 在就绪前退出'));
    } else if (!stopping) {
      options.onExit?.(code);
    }
  };
  child.once('exit', onExit);
  child.on('error', () => {
    readyReject(new Error('无法启动或停止企微 core 子进程'));
    // Spawn failures have no PID. A later kill error must never masquerade as exit.
    if (!child.pid) {
      onExit(null);
    }
  });
  if (exited) {
    exitedResolve();
    readyReject(new Error('企微 core 在就绪前退出'));
  }
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopping = true;
    readyReject(new Error('企微 core 启动已取消'));
    options.signal?.removeEventListener('abort', abort);
    stopPromise = (async () => {
      if (exited) {
        return;
      }
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = (ms: number) => new Promise<boolean>(done => {
        timer = setTimeout(() => done(false), ms);
        void exit.then(() => {
          clearTimeout(timer);
          done(true);
        });
      });
      if (await wait(graceMs)) {
        return;
      }
      child.kill('SIGKILL');
      if (!await wait(killWaitMs)) {
        throw new Error('企微 core 子进程未能退出');
      }
    })();
    return stopPromise;
  };
  const abort = () => {
    void stop().catch(() => {});
  };
  // Kept after readiness on purpose: aborting the signal is also how the gateway
  // starts stopping a running core when its own shutdown begins.
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }
  const timeout = setTimeout(() => readyReject(new Error('企微 core 就绪超时')), options.startupTimeoutMs ?? 60000);
  try {
    await readiness;
    if (stopping || exited) {
      throw new Error('企微 core 启动已取消');
    }
    return { stop, credential };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
