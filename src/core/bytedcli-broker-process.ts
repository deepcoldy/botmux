import { spawn } from 'node:child_process';
import { constants, accessSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, delimiter, relative, resolve } from 'node:path';
import { BYTEDCLI_AUDITED_RELEASE, assertBytedcliAuditedRelease } from './bytedcli-operation-policy.js';
import type { BytedcliExecErrorCode } from '../cli/bytedcli-exec-protocol.js';

export class BytedcliBrokerError extends Error {
  constructor(readonly code: BytedcliExecErrorCode) { super(code); this.name = 'BytedcliBrokerError'; }
}
export interface BytedcliTrustedCli {
  readonly executable: string; readonly path: string; readonly version: string; readonly stillCurrent: () => boolean;
  readonly prefixArgs?: readonly string[];
  readonly protectedPaths?: readonly string[];
}
export interface BytedcliChildInvocation {
  readonly executable: string; readonly argv: readonly string[]; readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>; readonly signal: AbortSignal;
  readonly timeoutMs: number; readonly outputLimitBytes: number;
  readonly reserveOutput?: (bytes: number) => boolean; readonly onDispatch?: () => void;
}
export interface BytedcliChildResult { readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number }
export type BytedcliChildRunner = (invocation: BytedcliChildInvocation) => Promise<BytedcliChildResult>;
const networkKeys = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
export function bytedcliMinimalEnv(home: string, cwd: string, path: string, network: Readonly<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  if (!isAbsolute(home) || !isAbsolute(cwd) || !path.split(delimiter).every(dir => isAbsolute(dir) && resolve(dir) === dir)) {
    throw new BytedcliBrokerError('executor_unavailable');
  }
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: path, LANG: 'C.UTF-8', TMPDIR: home,
    BYTECLOUD_AUTH_AS: 'user', BYTEDCLI_NO_AUTO_UPGRADE: '1', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CEILING_DIRECTORIES: cwd, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'core.sshCommand', GIT_CONFIG_VALUE_3: '/usr/bin/false' };
  for (const [key, value] of Object.entries(network)) {
    if (!networkKeys.has(key) || typeof value !== 'string' || value.includes('\0')) throw new BytedcliBrokerError('executor_unavailable');
    env[key] = value;
  }
  return env;
}

/** Bounded pipes and process-group kill; close reaps the direct child and
 * destroyed streams prevent descendants from extending the deadline. */
export const runBoundedBytedcliChild: BytedcliChildRunner = async invocation => {
  if (invocation.signal.aborted) throw new BytedcliBrokerError('cancelled');
  return await new Promise((resolveResult, reject) => {
    let failure: BytedcliExecErrorCode | undefined; let total = 0; let done = false;
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const child = spawn(invocation.executable, [...invocation.argv], { cwd: invocation.cwd,
      env: { ...invocation.env }, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
      child.stdout?.destroy(); child.stderr?.destroy();
    };
    const fail = (code: BytedcliExecErrorCode) => { if (!failure) failure = code; killGroup(); };
    const abort = () => fail('cancelled'); const timer = setTimeout(() => fail('timeout'), Math.max(1, invocation.timeoutMs));
    invocation.signal.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      try { invocation.onDispatch?.(); } catch { fail('execution_stale'); }
      if (invocation.signal.aborted) abort();
    });
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (failure) return;
      if (total + chunk.length > invocation.outputLimitBytes || invocation.reserveOutput?.(chunk.length) === false) { fail('output_limit'); return; }
      total += chunk.length; target.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', chunk => collect(stdout, chunk)); child.stderr?.on('data', chunk => collect(stderr, chunk));
    const finish = (exitCode: number | null) => {
      if (done) return; done = true; clearTimeout(timer); invocation.signal.removeEventListener('abort', abort); killGroup();
      if (failure) reject(new BytedcliBrokerError(failure));
      else resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exitCode ?? 1 });
    };
    child.once('error', () => { failure = 'executor_unavailable'; finish(1); }); child.once('close', finish);
  });
};

/** Candidates and installation roots come only from trusted host setup.
 * Agent protection of these paths remains a mandatory admission check. */
export async function discoverBytedcliTrustedCli(options: {
  readonly candidates: readonly string[]; readonly installationRoots: readonly string[]; readonly path: string;
  readonly runtimeExecutable: string;
  readonly probeHome: string; readonly probeCwd: string; readonly signal: AbortSignal; readonly run?: BytedcliChildRunner;
}): Promise<BytedcliTrustedCli> {
  const owned = (path: string) => {
    const stat = statSync(path); return !(stat.mode & 0o022) && (!process.getuid || stat.uid === 0 || stat.uid === process.getuid());
  };
  if (!isAbsolute(options.runtimeExecutable)) throw new BytedcliBrokerError('executor_unavailable');
  const runtime = realpathSync(options.runtimeExecutable);
  accessSync(runtime, constants.X_OK);
  if (!statSync(runtime).isFile() || !owned(runtime) || !owned(dirname(runtime))) throw new BytedcliBrokerError('executor_unavailable');
  const path = [dirname(runtime), ...options.path.split(delimiter)].join(delimiter);
  if (!path.split(delimiter).every(dir => isAbsolute(dir) && owned(realpathSync(dir)))) throw new BytedcliBrokerError('executor_unavailable');
  for (const candidate of options.candidates) {
    let entrypoint: string; let installationRoot: string; let stillCurrent: () => boolean;
    try {
      if (!isAbsolute(candidate)) continue; entrypoint = realpathSync(candidate);
      installationRoot = options.installationRoots.map(root => realpathSync(root)).find(root => {
        const rel = relative(root, entrypoint); return rel && !rel.startsWith('..') && !isAbsolute(rel);
      })!;
      if (!installationRoot || !owned(installationRoot) || !owned(entrypoint) || !statSync(entrypoint).isFile()) continue;
      const snapshots = new Map<string, { dev: number; ino: number; mode: number; uid: number; size?: number; mtimeMs?: number; ctimeMs?: number }>();
      // Ownership above the configured trust root can legitimately belong to
      // another host administrator. Freeze those ancestors rather than assuming
      // every mount point is owned by this daemon's OS account.
      for (const leaf of [entrypoint, runtime, ...path.split(delimiter).map(dir => realpathSync(dir))]) {
        let cursor = leaf;
        for (;;) {
          const stat = lstatSync(cursor);
          const stickyHostTmp = stat.isDirectory() && (stat.mode & 0o1000) && stat.uid === 0;
          if ((stat.mode & 0o022) && !stickyHostTmp) throw new Error('unsafe_install_ancestor');
          snapshots.set(cursor, { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid,
            ...(stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } : {}) });
          if (dirname(cursor) === cursor) break; cursor = dirname(cursor);
        }
      }
      stillCurrent = () => {
        try {
          if (realpathSync(candidate) !== entrypoint || realpathSync(options.runtimeExecutable) !== runtime) return false;
          for (const [file, before] of snapshots) {
            const now = lstatSync(file);
            if (now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode || now.uid !== before.uid
              || (before.size !== undefined && (now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs))) return false;
          }
          return true;
        } catch { return false; }
      };
    } catch { continue; }
    const run = options.run ?? runBoundedBytedcliChild;
    const invocation = { executable: runtime, cwd: options.probeCwd, env: bytedcliMinimalEnv(options.probeHome, options.probeCwd, path),
      signal: options.signal, timeoutMs: 5000, outputLimitBytes: 4096 };
    const runtimeResult = await run({ ...invocation, argv: ['-p', 'JSON.stringify({node:process.release.name,major:Number(process.versions.node.split(".")[0]),bun:!!process.versions.bun})'] });
    let runtimeInfo: { node?: string; major?: number; bun?: boolean };
    try { runtimeInfo = JSON.parse(runtimeResult.stdout.toString()); } catch { throw new BytedcliBrokerError('executor_unavailable'); }
    if (runtimeResult.exitCode !== 0 || runtimeInfo.node !== 'node' || runtimeInfo.bun || !runtimeInfo.major || runtimeInfo.major < 22) {
      throw new BytedcliBrokerError('executor_unavailable');
    }
    const result = await run({ ...invocation, argv: [entrypoint, '--version'] });
    if (result.exitCode !== 0 || !stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
    assertBytedcliAuditedRelease(result.stdout.toString().trim());
    return Object.freeze({ executable: runtime, prefixArgs: Object.freeze([entrypoint]), path, version: BYTEDCLI_AUDITED_RELEASE,
      protectedPaths: Object.freeze([installationRoot, runtime, dirname(runtime)]), stillCurrent });
  }
  throw new BytedcliBrokerError('executor_unavailable');
}
