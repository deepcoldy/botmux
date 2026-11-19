/**
 * Fake-fleet evidence for the idle-spin guard.
 *
 * Spawns N real `sh → spinner` process trees (the same shape as a tmux pane
 * shell → traex), attributes their CPU with the production sampler, then kills
 * them and measures the aggregate again. No production directory or live CLI is
 * touched.
 *
 * Usage: bun scripts/bench-idle-spin-fleet.ts [count]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createIdleSpinSampler } from '../src/core/idle-spin-sampler.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';

const count = Math.max(1, Number(process.argv[2] ?? 20) || 20);
const trees: ChildProcess[] = [];

function startSpinner(): { pid: number; procStart: string } {
  const spin = `${JSON.stringify(process.execPath)} -e `
    + '"const end=Date.now()+6000; while(Date.now()<end){}"';
  const shell = spawn('sh', ['-c', `${spin}; true`], { detached: true, stdio: 'ignore' });
  trees.push(shell);
  return { pid: shell.pid!, procStart: readProcessStartIdentity(shell.pid!)! };
}

async function sampleCores(targets: Array<{ sessionId: string; attestation: { cliPid: number; cliProcStart: string } }>): Promise<number> {
  const sampler = createIdleSpinSampler();
  await sampler.sample(targets);
  await new Promise(resolve => setTimeout(resolve, 500));
  const sample = await sampler.sample(targets);
  let cores = 0;
  for (const session of sample.sessions.values()) cores += session.cpuPercent / 100;
  return cores;
}

try {
  const started = Array.from({ length: count }, (_, index) => {
    const tree = startSpinner();
    return { sessionId: `fake-${index}`, attestation: { cliPid: tree.pid, cliProcStart: tree.procStart } };
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  const before = await sampleCores(started);

  for (const tree of trees) {
    try { process.kill(-tree.pid!, 'SIGKILL'); } catch { /* already gone */ }
    try { tree.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const after = await sampleCores(started);

  console.log(JSON.stringify({
    fakeSpinners: count,
    coresBefore: Number(before.toFixed(2)),
    coresAfter: Number(after.toFixed(2)),
    reclaimedCores: Number((before - after).toFixed(2)),
  }, null, 2));
} finally {
  for (const tree of trees) {
    try { process.kill(-tree.pid!, 'SIGKILL'); } catch { /* already gone */ }
    try { tree.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
