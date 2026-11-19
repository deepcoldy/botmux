import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdleSpinSampler } from '../src/core/idle-spin-sampler.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';

interface ProcNode {
  pid: number;
  ppid: number;
  start: number;
  utime: number;
  stime: number;
  /** Extra task ids whose `children` file lists this pid's children. */
  childThreads?: number[];
  children?: number[];
}

const roots: string[] = [];

function statLine(node: Pick<ProcNode, 'pid' | 'ppid' | 'start' | 'utime' | 'stime'>): string {
  // After `(comm)`: state ppid ... utime(index 11) stime(12) ... starttime(19) ...
  return `${node.pid} (fake) S ${node.ppid} 0 0 0 0 0 0 0 0 0 `
    + `${node.utime} ${node.stime} 0 0 20 0 1 0 ${node.start} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
}

function makeProcRoot(nodes: ProcNode[], systemTicks = 10_000): string {
  const root = mkdtempSync(join(tmpdir(), 'idle-spin-proc-'));
  roots.push(root);
  writeFileSync(join(root, 'stat'), `cpu  ${systemTicks} 0 0 0 0 0 0 0 0 0\n`);
  for (const node of nodes) {
    const dir = join(root, String(node.pid), 'task', String(node.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, String(node.pid), 'stat'), statLine(node));
    writeFileSync(join(dir, 'children'), (node.children ?? []).join(' '));
    for (const tid of node.childThreads ?? []) {
      const threadDir = join(root, String(node.pid), 'task', String(tid));
      mkdirSync(threadDir, { recursive: true });
      writeFileSync(join(threadDir, 'children'), (node.children ?? []).join(' '));
      writeFileSync(join(threadDir, 'stat'), statLine({ ...node, pid: node.pid }));
    }
  }
  return root;
}

function updateTicks(root: string, pid: number, ticks: number, systemTicks: number): void {
  const path = join(root, String(pid), 'stat');
  // Preserve ppid/start from the existing line.
  const existing = statLineFromFile(path);
  writeFileSync(path, statLine({ ...existing, utime: ticks, stime: 0 }));
  writeFileSync(join(root, 'stat'), `cpu  ${systemTicks} 0 0 0 0 0 0 0 0 0\n`);
}

function statLineFromFile(path: string): ProcNode {
  const raw = readFileSync(path, 'utf8');
  const parts = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  return {
    pid: Number(raw.slice(0, raw.indexOf('(')).trim()),
    ppid: Number(parts[1]),
    start: Number(parts[19]),
    utime: Number(parts[11]),
    stime: Number(parts[12]),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('idle-spin sampler', () => {
  it('attributes the attestation CLI subtree CPU (sh → traex leaf)', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0, children: [102] },
      { pid: 102, ppid: 101, start: 1002, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{
      sessionId: 's1',
      workerPid: 100,
      attestation: { cliPid: 100, cliProcStart: '1000' },
    }];
    await sampler.sample(targets);
    updateTicks(root, 102, 100, 11_000);
    const sample = await sampler.sample(targets);
    expect(sample.invalid.size).toBe(0);
    const session = sample.sessions.get('s1');
    expect(session?.pids).toBe(3);
    expect(session?.confidence).toBe('attestation');
    // 100 ticks / 1000 host ticks × 4 cores × 100 = 40% of one core.
    expect(session?.cpuPercent).toBeCloseTo(40, 5);
  });

  it('counts the enginePid sibling subtree as well', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
      { pid: 200, ppid: 1, start: 2000, utime: 0, stime: 0, children: [201] },
      { pid: 201, ppid: 200, start: 2001, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{
      sessionId: 's1',
      attestation: { cliPid: 100, cliProcStart: '1000', enginePid: 200, engineProcStart: '2000' },
    }];
    await sampler.sample(targets);
    updateTicks(root, 201, 200, 11_000);
    const sample = await sampler.sample(targets);
    expect(sample.invalid.size).toBe(0);
    expect(sample.sessions.get('s1')?.pids).toBe(4);
    expect(sample.sessions.get('s1')?.cpuPercent).toBeCloseTo(80, 5);
  });

  it('dedupes worker + attestation pids and keeps the union', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{
      sessionId: 's1',
      workerPid: 100,
      attestation: { cliPid: 100, cliProcStart: '1000' },
    }];
    await sampler.sample(targets);
    writeFileSync(join(root, 'stat'), 'cpu  11000 0 0 0 0 0 0 0 0 0\n');
    const sample = await sampler.sample(targets);
    expect(sample.sessions.get('s1')?.pids).toBe(2);
  });

  it('falls back to a validated marker when attestation is absent', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{ sessionId: 's1' }];
    const markers = new Map([[100, { sessionId: 's1', procStart: '1000' }]]);
    await sampler.sample(targets, markers);
    updateTicks(root, 101, 50, 11_000);
    const sample = await sampler.sample(targets, markers);
    expect(sample.sessions.get('s1')?.confidence).toBe('marker');
    expect(sample.sessions.get('s1')?.cpuPercent).toBeCloseTo(20, 5);
  });

  it('fails closed when an attestation pid has no birth stamp', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const sample = await sampler.sample([{
      sessionId: 's1',
      attestation: { cliPid: 100 },
    }]);
    expect(sample.invalid.get('s1')).toBe('attestation_missing_proc_start');
  });

  it('ignores a legacy marker without a birth stamp', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const sample = await sampler.sample(
      [{ sessionId: 's1' }],
      new Map([[100, { sessionId: 's1' }]]),
    );
    expect(sample.invalid.get('s1')).toBe('no_attestation_or_marker');
  });

  it('fails closed on a procStart mismatch', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const sample = await sampler.sample([{
      sessionId: 's1',
      attestation: { cliPid: 100, cliProcStart: '9999' },
    }]);
    expect(sample.invalid.get('s1')).toBe('proc_start_mismatch');
  });

  it('fails closed on an attestation workerGeneration mismatch', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const sample = await sampler.sample([{
      sessionId: 's1',
      workerGeneration: 3,
      attestation: { workerGeneration: 2, cliPid: 100, cliProcStart: '1000' },
    }]);
    expect(sample.invalid.get('s1')).toBe('attestation_generation_mismatch');
  });

  it('removes a pid claimed by two sessions (ambiguous ownership)', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [
      { sessionId: 's1', attestation: { cliPid: 100, cliProcStart: '1000' } },
      { sessionId: 's2', attestation: { cliPid: 100, cliProcStart: '1000' } },
    ];
    const sample = await sampler.sample(targets);
    expect(sample.invalid.get('s1')).toBe('ambiguous_pid');
    expect(sample.invalid.get('s2')).toBe('ambiguous_pid');
  });

  it('falls back to a full ppid scan when children files are unavailable', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0, children: [102] },
      { pid: 102, ppid: 101, start: 1002, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({
      procRoot: root,
      cpuCount: 4,
      platform: 'linux',
      childrenSupported: false,
    });
    const targets = [{
      sessionId: 's1',
      attestation: { cliPid: 100, cliProcStart: '1000' },
    }];
    await sampler.sample(targets);
    updateTicks(root, 102, 100, 11_000);
    const sample = await sampler.sample(targets);
    expect(sample.invalid.size).toBe(0);
    expect(sample.sessions.get('s1')?.pids).toBe(3);
    expect(sample.sessions.get('s1')?.cpuPercent).toBeCloseTo(40, 5);
  });

  // Root bypasses DAC (chmod 000 stays readable), so EACCES can only be
  // reproduced as an unprivileged user — same guard as cli-send-hook-context.
  it.skipIf(process.getuid?.() === 0)('fails closed when a children file is unreadable (EACCES)', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
    ]);
    const childrenPath = join(root, '100', 'task', '100', 'children');
    const original = readFileSync(childrenPath, 'utf8');
    try {
      chmodSync(childrenPath, 0o000);
      const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
      const sample = await sampler.sample([{
        sessionId: 's1',
        attestation: { cliPid: 100, cliProcStart: '1000' },
      }]);
      expect(sample.sessions.has('s1')).toBe(false);
      expect(sample.invalid.has('s1')).toBe(true);
    } finally {
      chmodSync(childrenPath, 0o644);
      writeFileSync(childrenPath, original);
    }
  });

  it('fails closed instead of truncating an oversized process tree', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101, 102] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
      { pid: 102, ppid: 100, start: 1002, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({
      procRoot: root,
      cpuCount: 4,
      platform: 'linux',
      maxPidsPerSession: 2,
    });
    const sample = await sampler.sample([{
      sessionId: 's1',
      attestation: { cliPid: 100, cliProcStart: '1000' },
    }]);
    expect(sample.invalid.get('s1')).toBe('process_tree_overflow');
  });

  it('discovers children forked by a non-main thread on a full scan', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, childThreads: [777], children: [101] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
    ]);
    // Main thread has no children; only thread 777 does.
    writeFileSync(join(root, '100', 'task', '100', 'children'), '');
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{
      sessionId: 's1',
      attestation: { cliPid: 100, cliProcStart: '1000' },
    }];
    await sampler.sample(targets);
    writeFileSync(join(root, 'stat'), 'cpu  11000 0 0 0 0 0 0 0 0 0\n');
    const sample = await sampler.sample(targets);
    expect(sample.invalid.size).toBe(0);
    expect(sample.sessions.get('s1')?.pids).toBe(2);
  });

  it('counts live CLI children, excluding the other roots and the worker subtree', async () => {
    const root = makeProcRoot([
      // cliPid 100 → background shell 101, plus the engine root 200.
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, children: [101, 200] },
      { pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 },
      { pid: 200, ppid: 100, start: 2000, utime: 0, stime: 0 },
      // The worker's own helpers are not CLI work.
      { pid: 300, ppid: 1, start: 3000, utime: 0, stime: 0, children: [301] },
      { pid: 301, ppid: 300, start: 3001, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{
      sessionId: 's1',
      workerPid: 300,
      attestation: { cliPid: 100, cliProcStart: '1000', enginePid: 200, engineProcStart: '2000' },
    }];
    expect(sampler.liveCliChildren(targets).get('s1')).toBe(1);
    writeFileSync(join(root, '100', 'task', '100', 'children'), '200');
    expect(sampler.liveCliChildren(targets).get('s1')).toBe(0);
  });

  it('reads CLI children fresh even when the cached subtree has not seen them yet', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0, childThreads: [105] },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{ sessionId: 's1', attestation: { cliPid: 100, cliProcStart: '1000' } }];
    await sampler.sample(targets);
    writeFileSync(join(root, 'stat'), 'cpu  11000 0 0 0 0 0 0 0 0 0\n');
    await sampler.sample(targets);
    // A worker thread (not the main thread) starts a background shell after
    // the subtree was cached; an ordinary sample would not rescan thread 105.
    mkdirSync(join(root, '101', 'task', '101'), { recursive: true });
    writeFileSync(join(root, '101', 'stat'), statLine({ pid: 101, ppid: 100, start: 1001, utime: 0, stime: 0 }));
    writeFileSync(join(root, '101', 'task', '101', 'children'), '');
    writeFileSync(join(root, '100', 'task', '105', 'children'), '101');
    expect(sampler.liveCliChildren(targets).get('s1')).toBe(1);
  });

  it('fails closed (null) for a recycled CLI root or a missing attestation pid', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const counts = sampler.liveCliChildren([
      { sessionId: 'recycled', attestation: { cliPid: 100, cliProcStart: '999' } },
      { sessionId: 'gone', attestation: { cliPid: 4242, cliProcStart: '1' } },
      { sessionId: 'unproven', workerPid: 100 },
    ]);
    expect(counts.get('recycled')).toBeNull();
    expect(counts.get('gone')).toBeNull();
    expect(counts.get('unproven')).toBeNull();
    const darwin = createIdleSpinSampler({ procRoot: root, platform: 'darwin' });
    expect(darwin.liveCliChildren([{ sessionId: 'mac', attestation: { cliPid: 100, cliProcStart: '1000' } }]).get('mac')).toBeNull();
  });

  it('a host-only sample does not inflate the next session sample', async () => {
    const root = makeProcRoot([
      { pid: 100, ppid: 1, start: 1000, utime: 0, stime: 0 },
    ]);
    const sampler = createIdleSpinSampler({ procRoot: root, cpuCount: 4, platform: 'linux' });
    const targets = [{ sessionId: 's1', attestation: { cliPid: 100, cliProcStart: '1000' } }];
    await sampler.sample(targets);
    updateTicks(root, 100, 100, 11_000);
    await sampler.sample([]);
    updateTicks(root, 100, 200, 12_000);
    // 100 ticks per 1000 host ticks × 4 cores = 40% in every window. Dividing
    // the 200-tick pid delta (since the first sample) by the 1000-tick host
    // delta (since the host-only sample) would report 80%.
    const afterHostOnly = await sampler.sample(targets);
    expect(afterHostOnly.sessions.get('s1')?.cpuPercent ?? 0).toBeLessThanOrEqual(40);
    updateTicks(root, 100, 300, 13_000);
    const next = await sampler.sample(targets);
    expect(next.sessions.get('s1')?.cpuPercent).toBeCloseTo(40, 5);
  });

  it('is unsupported (fail closed) on non-Linux platforms', async () => {
    const sampler = createIdleSpinSampler({ platform: 'darwin' });
    const sample = await sampler.sample([{ sessionId: 's1' }]);
    expect(sample.supported).toBe(false);
    expect(sample.sessions.size).toBe(0);
  });

  it('attributes a real tmux-like parent shell with a CPU-spinning child', async () => {
    // A real process tree: sh (parent, attestation root) → spin child. The
    // shell keeps itself alive with a second command so it cannot `exec` the
    // child away.
    const spin = `${JSON.stringify(process.execPath)} -e `
      + `"const end=Date.now()+1500; while(Date.now()<end){}"`;
    const shell = spawn('sh', ['-c', `${spin}; true`], { detached: true, stdio: 'ignore' });
    const pid = shell.pid!;
    const procStart = readProcessStartIdentity(pid);
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const sampler = createIdleSpinSampler();
      const targets = [{ sessionId: 'real', attestation: { cliPid: pid, cliProcStart: procStart } }];
      await sampler.sample(targets);
      await new Promise(resolve => setTimeout(resolve, 400));
      const sample = await sampler.sample(targets);
      expect(sample.invalid.size).toBe(0);
      const measured = sample.sessions.get('real');
      expect(measured?.pids).toBeGreaterThanOrEqual(2);
      expect(measured?.cpuPercent).toBeGreaterThan(5);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      try { shell.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  it.skipIf(process.platform !== 'linux')('sees a real live child of the CLI process (background-task shape)', async () => {
    // `sh` keeps running after `sleep` returns, so it cannot exec it away:
    // the same shape as a TRAE background shell left under the traex process.
    const withChild = spawn('sh', ['-c', 'sleep 30; true'], { detached: true, stdio: 'ignore' });
    const childless = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const counts = createIdleSpinSampler().liveCliChildren([
        { sessionId: 'with-child', attestation: { cliPid: withChild.pid!, cliProcStart: readProcessStartIdentity(withChild.pid!) } },
        { sessionId: 'childless', attestation: { cliPid: childless.pid!, cliProcStart: readProcessStartIdentity(childless.pid!) } },
      ]);
      expect(counts.get('with-child')).toBe(1);
      expect(counts.get('childless')).toBe(0);
    } finally {
      for (const child of [withChild, childless]) {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
  });
});
