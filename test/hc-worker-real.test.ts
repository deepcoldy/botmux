/**
 * The worker's hc-specific paths against the real binary, inside the hc test
 * fence (a private core per run): the crash-diagnostic terminal and its
 * per-client attach, the RPC lifecycle's pane pid, a bwrap sandbox launched
 * through the args-file launcher, and runner control frames in the pane output.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project unit test/hc-worker-real.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { hcDiagnosticTarget, hcTerminalName, killHcTerminal, type HcTarget } from '../src/adapters/backend/hc/cli-ops.js';
import { hcControlEnv, hcCoreAddress, hcCorePaths, type HcCoreAddress } from '../src/adapters/backend/hc/core.js';
import { hcDiagnosticAttachCommand, parkHcDiagnosticTerminal } from '../src/adapters/backend/hc/diagnostic-terminal.js';
import { HcBackend } from '../src/adapters/backend/hc-backend.js';
import { RunnerControlDecoder } from '../src/adapters/cli/runner-control-channel.js';
import { hcTerminalPanePid } from '../src/codex-rpc-lifecycle.js';
import { linuxIsolationLaunchViaArgsFile } from '../src/core/linux-isolation.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';
import { isBunRuntime } from './helpers/ts-runner.js';

const realHc = process.env.BOTMUX_HC_TEST_BIN;
const canRunBwrap = process.platform === 'linux'
  && ['x64', 'arm64', 'ia32', 'arm'].includes(process.arch)
  && spawnSync('bwrap', [
    '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc',
    '--', '/bin/true',
  ], { stdio: 'ignore', timeout: 5_000 }).status === 0;

const MARKERS = `
const big = Buffer.from(JSON.stringify({ text: 'x'.repeat(48 * 1024) })).toString('base64');
const small = Buffer.from(JSON.stringify({ ok: true })).toString('base64');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('READY\\n');
process.stdin.on('data', () => {
  process.stdout.write('before\\x1b]777;botmux:result:' + big + '\\x07between\\x1b]777;botmux:done:' + small + '\\x07after\\n');
});
setInterval(() => {}, 1000);
`;

async function until(check: () => void, timeout = 15_000): Promise<void> {
  await vi.waitFor(check, { timeout, interval: 50 });
}

describe.skipIf(!realHc)('worker hc paths against the real binary', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let core: HcCoreAddress;
  const cleanups: Array<() => void> = [];

  beforeAll(() => {
    if (!process.env.BOTMUX_HC_BIN) throw new Error('the hc test fence did not set BOTMUX_HC_BIN');
    root = mkdtempSync(join(tmpdir(), 'bm-hcw-'));
    resetHcAvailabilityCache();
    const home = join(root, 'home');
    mkdirSync(home);
    env = { ...process.env, SESSION_DATA_DIR: join(root, 'botmux', 'data'), HOME: home, SHELL: '/bin/bash' };
    core = hcCoreAddress(hcCorePaths(env));
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { cleanup(); } catch { /* best effort */ }
    }
  });

  afterAll(() => {
    if (env?.BOTMUX_HC_BIN) hc(['server', 'stop']);
    resetHcAvailabilityCache();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function hc(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.env.BOTMUX_HC_BIN!, args, {
      env: hcControlEnv(env, hcCorePaths(env, { core })),
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function getTerminal(name: string): Record<string, any> | null {
    const result = hc(['--json', 'get', name]);
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  }

  function newTarget(): { sid: string; target: HcTarget } {
    const sid = randomUUID();
    return { sid, target: { backendType: 'hc', sessionName: hcTerminalName(sid), hcSession: core.hcSession, socket: core.socket } };
  }

  function runForeign(name: string): string {
    const run = hc([
      '--json', 'run', '--bg', '--name', name,
      '--label', 'botmux=1', '--label', `botmux_sid=${randomUUID()}`,
      '--no-parent', '--no-notify', '--', '/bin/sh', '-c', 'sleep 300',
    ]);
    expect(run.status, run.stderr).toBe(0);
    const address = JSON.parse(run.stdout).address as string;
    cleanups.push(() => { hc(['--json', 'kill', address]); hc(['--json', 'rm', address]); });
    return address;
  }

  function openBackend(sid: string, target: HcTarget, bin: string, args: string[]): { backend: HcBackend; output: () => string; data: string[] } {
    const backend = new HcBackend(target, { sessionId: sid, env });
    cleanups.push(() => backend.destroySession());
    const data: string[] = [];
    backend.onData(chunk => data.push(chunk));
    backend.spawn(bin, args, {
      cwd: root,
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.HOME! },
      launchShell: '/bin/bash',
      paneLaunchDir: join(root, 'launch', sid),
    });
    return { backend, data, output: () => data.join('') };
  }

  function attach(target: HcTarget, observe: boolean): { term: pty.IPty; output: () => string } {
    const command = hcDiagnosticAttachCommand(target, { observe, env });
    const term = pty.spawn(command.bin, command.args, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: root, env: command.env as Record<string, string>,
    });
    let out = '';
    term.onData(chunk => { out += chunk; });
    cleanups.push(() => { try { term.kill(); } catch { /* already gone */ } });
    return { term, output: () => out };
  }

  // bun's in-process node-pty hangs up a child that outlives its first write, so
  // the attaches see nothing there; this runs under the Node/vitest leg.
  it.skipIf(isBunRuntime())('parks the diagnostic shell as bmx-diag-<sid8> owned by the session, served to write and observe clients', async () => {
    const { sid, target } = newTarget();
    const diag = hcDiagnosticTarget(target, sid);
    const content = join(root, `diag-${sid}.ansi`);
    writeFileSync(content, '[botmux] codex exited (code: 1)\nCRASH_TAIL_MARKER\n');
    parkHcDiagnosticTerminal(diag, sid, { cwd: root, cols: 100, rows: 30, contentPath: content, env });
    cleanups.push(() => killHcTerminal(diag, sid, { env }));

    expect(diag.sessionName).toBe(`bmx-diag-${sid.slice(0, 8)}`);
    expect(getTerminal(diag.sessionName)).toMatchObject({
      state: 'live', cwd: root, keep: false, parent: null, labels: { botmux: '1', botmux_sid: sid },
    });

    const writer = attach(diag, false);
    await until(() => expect(writer.output()).toContain('CRASH_TAIL_MARKER'));
    const observer = attach(diag, true);
    await until(() => expect(observer.output()).toContain('CRASH_TAIL_MARKER'));
    observer.term.write('echo OBSERVED_$((6*7))\r');
    writer.term.write('echo TYPED_$((6*7))\r');
    await until(() => expect(writer.output()).toContain('TYPED_42'));
    await until(() => expect(observer.output()).toContain('TYPED_42'));
    expect(writer.output()).not.toContain('OBSERVED_42');
  }, 60_000);

  it('replaces its own earlier diagnostic terminal and refuses a name another session holds', () => {
    const { sid, target } = newTarget();
    const diag = hcDiagnosticTarget(target, sid);
    const content = join(root, `diag-${sid}.ansi`);
    writeFileSync(content, 'first\n');
    parkHcDiagnosticTerminal(diag, sid, { cwd: root, cols: 80, rows: 24, contentPath: content, env });
    cleanups.push(() => killHcTerminal(diag, sid, { env }));
    const first = getTerminal(diag.sessionName)!;
    parkHcDiagnosticTerminal(diag, sid, { cwd: root, cols: 80, rows: 24, contentPath: content, env });
    const second = getTerminal(diag.sessionName)!;
    expect(second).toMatchObject({ state: 'live', labels: { botmux_sid: sid } });
    expect(second.address).not.toBe(first.address);
    expect(getTerminal(first.address)).toBeNull();

    const other = newTarget();
    const foreignDiag = hcDiagnosticTarget(other.target, other.sid);
    const foreign = runForeign(foreignDiag.sessionName);
    expect(() => parkHcDiagnosticTerminal(foreignDiag, other.sid, { cwd: root, cols: 80, rows: 24, contentPath: content, env }))
      .toThrow(/已被/);
    expect(getTerminal(foreign)).toMatchObject({ state: 'live' });

    expect(killHcTerminal(diag, sid, { env })).toMatchObject({ result: 'killed' });
    expect(getTerminal(diag.sessionName)).toBeNull();
  }, 60_000);

  it("reads the pane pid only for the session's own live terminal", async () => {
    const { sid, target } = newTarget();
    const { backend, output } = openBackend(sid, target, '/bin/sh', ['-c', 'echo READY; exec sleep 300']);
    await until(() => expect(output()).toContain('READY'));
    expect(hcTerminalPanePid(target, sid, env)).toBe(backend.getChildPid());
    expect(hcTerminalPanePid(target, randomUUID(), env)).toBeUndefined();
    expect(hcTerminalPanePid(newTarget().target, sid, env)).toBeUndefined();
  }, 60_000);

  it("proves the CLI's runtime as a process_start identity, from the pane's stable pid", async () => {
    const { sid, target } = newTarget();
    const { backend, output } = openBackend(sid, target, '/bin/sh', ['-c', 'echo READY; exec sleep 300']);
    await until(() => expect(output()).toContain('READY'));
    const pid = backend.getStablePanePid()!;
    // The pane launcher execs down to the CLI: the pane's pid is a live local process running it.
    expect(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')).toEqual(['sleep', '300', '']);
    const start = readProcessStartIdentity(pid);
    expect(start).toBeTruthy();
    const scope = new WorkerSessionEventScope({ appId: 'cli_hc_identity', sessionId: sid }, { workerId: 'w', generation: 1 });
    const binding = scope.beginRuntime();
    const identityOf = loadWorkerFunction<(binding: unknown) => unknown>('runtimeIdentityForContract', {
      backend, workerSessionEventScope: scope, effectiveBackendType: 'hc', codexRpcEngine: undefined,
      lastInitConfig: { cliId: 'kimi' }, cliAdapter: undefined, readProcessStartIdentity,
    });
    expect(identityOf(binding)).toEqual({ backend: 'hc', physicalId: `${pid}:${start}`, proof: 'process_start' });
    // A worker rewiring cliPid to a wrapper's descendant leaves the pane identity alone.
    backend.cliPid = process.pid;
    expect(backend.getStablePanePid()).toBe(pid);
  }, 60_000);

  it.skipIf(!canRunBwrap)('starts a bwrap sandbox through the args-file launcher, with the pane as its stdin', async () => {
    const { sid, target } = newTarget();
    const options = [
      '--ro-bind', '/', '/',
      '--unshare-user', '--unshare-pid', '--proc', '/proc', '--dev', '/dev',
      ...Array.from({ length: 512 }, (_, index) => ['--setenv', `BOTMUX_LONG_OPTION_${index}`, `padding-${index}-${'x'.repeat(40)}`]).flat(),
    ];
    const launch = linuxIsolationLaunchViaArgsFile(
      'bwrap',
      options,
      ['/bin/sh', '-c', 'if [ -t 0 ]; then echo "STDIN_TTY $BOTMUX_LONG_OPTION_511"; fi; exec sleep 300'],
      root,
    );
    cleanups.push(launch.cleanup);
    const { output } = openBackend(sid, target, launch.bin, launch.args);
    await until(() => expect(output()).toContain(`STDIN_TTY padding-511-${'x'.repeat(40)}`));
    expect(existsSync(launch.argsFile)).toBe(false);
  }, 60_000);

  it('passes runner control frames through to the worker byte-exact', async () => {
    const { sid, target } = newTarget();
    const script = join(root, 'markers.cjs');
    writeFileSync(script, MARKERS);
    const { backend, data, output } = openBackend(sid, target, process.execPath, [script]);
    await until(() => expect(output()).toContain('READY'));
    const decoder = new RunnerControlDecoder();
    const markers: string[] = [];
    let consumed = 0;
    let visible = '';
    const drain = () => {
      for (; consumed < data.length; consumed++) visible += decoder.push(data[consumed], true, body => markers.push(body));
    };
    expect(backend.write('g')).toBe(true);
    await until(() => { drain(); expect(markers).toHaveLength(2); });
    const big = Buffer.from(JSON.stringify({ text: 'x'.repeat(48 * 1024) })).toString('base64');
    const small = Buffer.from(JSON.stringify({ ok: true })).toString('base64');
    expect(markers).toEqual([`result:${big}`, `done:${small}`]);
    expect(visible).toContain('between');
    expect(visible).not.toContain('\x1b]777;');
  }, 60_000);
});
