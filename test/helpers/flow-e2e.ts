/**
 * flow runner 进程级测试的共用夹具：起真实 runner 进程（源码经 tsx / bun）、假 agent、
 * 控制通道客户端、journal 读取与 cgroup 清理。
 */
import { afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsRunnerPrefix } from './ts-runner.js';
import { listRunContainers, probeContainerBackend, reclaimContainer, containerPath, removeRunTreeIfEmpty } from '../../src/flow/container.js';
import { loadJournal } from '../../src/flow/journal.js';
import { controlSocketPath } from '../../src/flow/paths.js';
import type { ControlRequest, ControlResponse, JournalRow, RunStatus } from '../../src/flow/types.js';

export const probed = probeContainerBackend();
export const backend = probed.kind === 'none' ? null : probed;

export const SRC_DIR = join(process.cwd(), 'src');
const children: ChildProcess[] = [];
const dirs: string[] = [];
const runIds: string[] = [];
let counter = 0;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGCONT'); } catch { /* */ }
      try { child.kill('SIGKILL'); } catch { /* */ }
      await new Promise<void>((r) => child.once('exit', () => r()));
    }
  }
  if (backend) {
    for (const runId of runIds.splice(0)) {
      for (const name of listRunContainers(backend, runId)) await reclaimContainer(backend, containerPath(backend, runId, name));
      removeRunTreeIfEmpty(backend, runId);
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface Harness {
  dataDir: string;
  slotsFile: string;
  runId: string;
  runDir: string;
  scriptPath: string;
}

export function harness(script: string): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-'));
  dirs.push(dataDir);
  const runId = `e2e-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  runIds.push(runId);
  const runDir = join(dataDir, 'flow-runs', runId);
  const scriptPath = join(dataDir, 'script.mjs');
  writeFileSync(scriptPath, script);
  return { dataDir, slotsFile: join(dataDir, 'flow-host-slots.json'), runId, runDir, scriptPath };
}

export interface RunnerProc {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: string | null }>;
}

export function startRunner(h: Harness, mode: 'run' | 'resume', env: Record<string, string> = {}, extra: Record<string, unknown> = {}): RunnerProc {
  const options = {
    runId: h.runId,
    runDir: h.runDir,
    mode,
    ...(mode === 'run' ? { script: { path: h.scriptPath, source: readFileSync(h.scriptPath, 'utf8') }, input: { topic: 'tea' } } : {}),
    cwd: h.dataDir,
    slotsFile: h.slotsFile,
    decidedBy: 'e2e',
    heartbeatIntervalMs: 1_000,
    heartbeatStaleMs: 3_000,
    lockHolderStaleMs: 3_000,
    limits: { agentTimeoutMs: 20_000, scriptSliceMs: 20_000 },
    ...extra,
  };
  const { command, prefixArgs } = tsRunnerPrefix();
  const child = spawn(command, [...prefixArgs, join(SRC_DIR, 'flow-runner.ts'), JSON.stringify(options)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOTMUX_FLOW_TS_SRC_DIR: SRC_DIR, BOTMUX_FLOW_FAKE_AGENT: 'echo', ...env },
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr!.on('data', (c: Buffer) => { err += c.toString(); });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, exit };
}

export function summaryOf(p: RunnerProc): { status: RunStatus; gen: number; returned: unknown; replay: string; counts: { started: number; ok: number; failed: number } } {
  const line = p.stdout().trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(`runner printed no summary.\nstdout:\n${p.stdout()}\nstderr:\n${p.stderr()}`);
  return JSON.parse(line);
}

export function rows(h: Harness): JournalRow[] {
  return loadJournal(h.runDir).raw.rows;
}

export async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function waitForStderr(p: RunnerProc, needle: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(() => p.stderr().includes(needle), timeoutMs, `stderr to contain ${JSON.stringify(needle)}\n${p.stderr()}`);
}

export async function control(h: Harness, request: ControlRequest): Promise<ControlResponse> {
  const path = controlSocketPath(h.runDir);
  await waitFor(() => existsSync(path), 15_000, 'control socket');
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, nl)) as ControlResponse);
    });
    socket.on('error', reject);
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
  } catch {
    return false;
  }
}

