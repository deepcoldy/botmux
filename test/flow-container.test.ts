/**
 * cgroup 容器：创建、入容器、递归回收、run 级树扫描、逃逸检测、证伪探测（§6.3）。
 *
 * 需要 Linux 且 cgroupfs 可写（本宿主：v1 freezer、root）。不可用时整组跳过——
 * 跳过不等于验证过，CI 上要有可写 cgroup 才算跑过这组。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addPidToContainer,
  containerGen,
  containerName,
  containerPath,
  createContainerDir,
  isSubtreeEmpty,
  listRunContainers,
  probeContainerBackend,
  readProcessCgroupPath,
  reclaimContainer,
  reclaimForeignContainers,
  removeRunTreeIfEmpty,
  runFalsificationProbe,
  runTreePath,
  scanEscapes,
  subtreeProcs,
  type ContainerBackend,
} from '../src/flow/container.js';
import { FLOW_ATTEMPT_ENV_KEY } from '../src/flow/types.js';

const probed = probeContainerBackend();
const backend: ContainerBackend | null = probed.kind === 'none' ? null : probed;
const describeIf = backend ? describe : describe.skip;

const children: ChildProcess[] = [];
const runIds: string[] = [];
let counter = 0;
function newRunId(): string {
  const id = `test-${process.pid}-${Date.now()}-${counter++}`;
  runIds.push(id);
  return id;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await new Promise<void>((r) => child.once('exit', () => r()));
    }
  }
  if (backend) {
    for (const runId of runIds.splice(0)) {
      for (const name of listRunContainers(backend, runId)) await reclaimContainer(backend, containerPath(backend, runId, name));
      removeRunTreeIfEmpty(backend, runId);
    }
  }
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 在容器里起一个 sh，它再派生：setsid 双 fork、空 env 的孤儿、普通子进程。 */
async function spawnTreeInContainer(path: string, runId: string): Promise<{ shell: ChildProcess; pidsFile: string }> {
  const pidsFile = `/tmp/.botmux-flow-test-pids-${process.pid}-${counter++}`;
  const script = [
    'read _go',
    // 空 env 的 setsid 孤儿：脱离进程树、无标记
    `env -i setsid sh -c 'echo $$ >> ${pidsFile}; exec sleep 300' &`,
    // 带标记的普通后代
    `sh -c 'echo $$ >> ${pidsFile}; exec sleep 300' &`,
    `echo $$ >> ${pidsFile}`,
    'exec sleep 300',
  ].join('\n');
  const shell = spawn('sh', ['-c', script], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [FLOW_ATTEMPT_ENV_KEY]: `${runId}/#0/1-1` } });
  children.push(shell);
  addPidToContainer(path, shell.pid!);
  shell.stdin!.write('go\n');
  shell.stdin!.end();
  // 等三个 pid 都登记
  for (let i = 0; i < 100; i++) {
    try {
      if (readFileSync(pidsFile, 'utf8').trim().split('\n').length >= 3) break;
    } catch { /* not yet */ }
    await sleep(50);
  }
  return { shell, pidsFile };
}

describeIf('cgroup 容器（真实内核路径）', () => {
  it('能力探测报告一条可用路径；容器名与代次解析', () => {
    expect(['cgroup2-kill', 'cgroup2-freeze', 'cgroup1-freezer']).toContain(backend!.kind);
    expect(containerName(2, 0)).toBe('c-2-0');
    expect(containerName(2, 'probe')).toBe('c-2-probe');
    expect(containerGen('c-3-7')).toBe(3);
    expect(containerGen('c-3-probe')).toBe(3);
    expect(containerGen('other')).toBeNull();
  });

  it('创建 → 入容器 → 后代（含空 env 的 setsid 孤儿）都在容器内 → 递归回收后子树为空且目录已删', async () => {
    const runId = newRunId();
    const path = containerPath(backend!, runId, containerName(1, 0));
    createContainerDir(path);
    const { shell, pidsFile } = await spawnTreeInContainer(path, runId);
    const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
    expect(pids.length).toBeGreaterThanOrEqual(3);
    const inContainer = subtreeProcs(path).flatMap((e) => e.pids);
    for (const pid of pids) expect(inContainer, `pid ${pid} should be in the container`).toContain(pid);
    expect(readProcessCgroupPath(backend!, shell.pid!)).toContain(`/botmux-flow/${runId}/c-1-0`);

    const result = await reclaimContainer(backend!, path);
    expect(result).toMatchObject({ ok: true });
    expect((result as { killed: number }).killed).toBeGreaterThanOrEqual(3);
    expect(existsSync(path)).toBe(false);
    await sleep(100);
    for (const pid of pids) expect(pidAlive(pid), `pid ${pid} should be dead`).toBe(false);
  }, 30_000);

  it('冻结期间持续 fork 的进程树仍以子树为空结束', async () => {
    const runId = newRunId();
    const path = containerPath(backend!, runId, containerName(1, 1));
    createContainerDir(path);
    const bomb = spawn('sh', ['-c', 'read _go; while true; do sleep 0.02 & done'], { stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(bomb);
    addPidToContainer(path, bomb.pid!);
    bomb.stdin!.write('go\n');
    bomb.stdin!.end();
    await sleep(300);
    expect(isSubtreeEmpty(path)).toBe(false);
    const result = await reclaimContainer(backend!, path);
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  it('cooperative 档下进程建出子组并放入后代：递归回收后子树为空、rmdir 干净', async () => {
    const runId = newRunId();
    const path = containerPath(backend!, runId, containerName(1, 2));
    createContainerDir(path);
    const sub = join(path, 'nested');
    const inner = spawn('sh', ['-c', `read _go; mkdir -p ${sub}; echo $$ > ${sub}/cgroup.procs; exec sleep 300`], { stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(inner);
    addPidToContainer(path, inner.pid!);
    inner.stdin!.write('go\n');
    inner.stdin!.end();
    for (let i = 0; i < 100 && !existsSync(sub); i++) await sleep(20);
    await sleep(100);
    expect(subtreeProcs(path).some((e) => e.node === sub && e.pids.includes(inner.pid!))).toBe(true);
    const result = await reclaimContainer(backend!, path);
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(sub)).toBe(false);
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  it('run 级树扫描只回收非本代次的容器；不存在的容器回收直接成功', async () => {
    const runId = newRunId();
    const old = containerPath(backend!, runId, containerName(1, 0));
    const mine = containerPath(backend!, runId, containerName(2, 0));
    createContainerDir(old);
    createContainerDir(mine);
    const oldProc = spawn('sleep', ['300'], { stdio: 'ignore' });
    const myProc = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(oldProc, myProc);
    addPidToContainer(old, oldProc.pid!);
    addPidToContainer(mine, myProc.pid!);
    expect(listRunContainers(backend!, runId)).toEqual(['c-1-0', 'c-2-0']);
    const results = await reclaimForeignContainers(backend!, runId, 2);
    expect(results).toEqual([{ container: 'c-1-0', result: expect.objectContaining({ ok: true }) }]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(pidAlive(myProc.pid!)).toBe(true);
    expect(await reclaimContainer(backend!, containerPath(backend!, runId, 'c-9-9'))).toEqual({ ok: true, killed: 0, cycles: 0 });
    expect(removeRunTreeIfEmpty(backend!, runId)).toBe(false); // mine 还在
  }, 30_000);

  it('逃逸检测：带标记但 cgroup 不在 run 树下的进程被列出', async () => {
    const runId = newRunId();
    const path = containerPath(backend!, runId, containerName(1, 0));
    createContainerDir(path);
    const escapee = spawn('sleep', ['300'], { stdio: 'ignore', env: { [FLOW_ATTEMPT_ENV_KEY]: `${runId}/#0/1-1` } });
    const contained = spawn('sleep', ['300'], { stdio: 'ignore', env: { [FLOW_ATTEMPT_ENV_KEY]: `${runId}/#1/1-1` } });
    children.push(escapee, contained);
    addPidToContainer(path, contained.pid!);
    await sleep(50);
    const escapes = scanEscapes(backend!, runId, FLOW_ATTEMPT_ENV_KEY);
    expect(escapes.map((e) => e.pid)).toEqual([escapee.pid]);
    expect(escapes[0]!.attempt).toBe('#0/1-1');
    expect(scanEscapes(backend!, 'some-other-run', FLOW_ATTEMPT_ENV_KEY)).toEqual([]);
  }, 30_000);

  it('证伪探测：root 下迁出成功 → cooperative 且 probe.migratedOut；探测容器随后回收', async () => {
    const runId = newRunId();
    mkdirSync(runTreePath(backend!, runId), { recursive: true });
    const verdict = await runFalsificationProbe(backend!, runId, 1);
    expect(verdict.containment).toBe('cooperative');
    expect(verdict.boundary).toBe('none');
    expect(verdict.probe.attempted).toBe(true);
    if (process.getuid?.() === 0) {
      expect(verdict.probe.migratedOut).toBe(true);
      expect(verdict.probe.observedCgroup).toBe(`/botmux-flow/${runId}`);
    } else {
      expect(verdict.probe.error).toMatch(/denied/);
    }
    expect(existsSync(containerPath(backend!, runId, 'c-1-probe'))).toBe(false);
    expect(listRunContainers(backend!, runId)).toEqual([]);
  }, 30_000);
});

describe('容器不可用时', () => {
  it('probe 结果形态稳定', () => {
    if (backend) {
      expect(backend.base.endsWith('/botmux-flow')).toBe(true);
    } else {
      expect(probed).toMatchObject({ kind: 'none', reason: expect.any(String) });
    }
  });
});
