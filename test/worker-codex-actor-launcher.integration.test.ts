import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { resolveDaemonCurrentActor, snapshotProcessIdentities } from '../src/core/current-actor-attestation.js';
import { readComm } from '../src/core/session-discovery.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { stopSessionScope } from '../src/core/session-scope.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { resolveNodeExecutable, spawnNodeTsScript } from './helpers/ts-runner.js';

const tmuxAvailable = process.platform === 'linux' && probeTmuxFunctional().ok;

// 'official' models a direct npm Codex whose native leaf comm is `codex`;
// 'configured-runtime' models a renamed Codex-compatible binary (operators may
// set a custom executable): the leaf only matches through the configured
// executable name, never the static comm map.
const variants = [
  { key: 'official', leafName: 'codex' },
  { key: 'configured-runtime', leafName: 'alias-cdx' },
] as const;

for (const backendType of ['pty', 'tmux'] as const) {
  for (const variant of variants) {
    it.skipIf(process.platform !== 'linux' || (backendType === 'tmux' && !tmuxAvailable))(
      `attests tools below a Codex launcher that starts as a shell (${backendType}, ${variant.key})`,
      () => runLauncherAttestationCase(backendType, variant),
      30_000,
    );
  }
}

async function runLauncherAttestationCase(
  backendType: 'pty' | 'tmux',
  variant: { key: string; leafName: string },
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bmx-actor-launcher-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const launcherRelease = join(root, 'launch');
  const shellPidFile = join(root, 'shell-pid');
  const toolRelease = join(root, 'tool');
  const pidsFile = join(root, 'pids.json');
  const peerFile = join(root, 'peer');
  const nativeScript = join(root, 'native.cjs');
  const launcherScript = join(root, 'launcher.cjs');
  const fakeCodex = join(root, variant.leafName);
  const shellScript = join(root, 'launch.sh');
  const node = resolveNodeExecutable()!;
  const sessionId = randomUUID();
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let worker: ChildProcess | undefined;
  let cliPids: { launcher: number; native: number } | undefined;
  let peerPid: number | undefined;
  const waitFor = async (predicate: () => boolean, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline || worker?.exitCode != null) throw new Error(logs.join('') || 'worker timeout');
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const attestations = () => messages.filter(
    (m): m is Extract<WorkerToDaemon, { type: 'local_process_attestation' }> => m.type === 'local_process_attestation',
  );
  writeFileSync(nativeScript, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.title = ${JSON.stringify(variant.leafName)};
fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({launcher:process.ppid,native:process.pid}));
process.stdout.write('› Ask Codex to do anything\\r\\n  gpt-test · /tmp\\r\\n');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(toolRelease)})) return;
  clearInterval(timer);
  const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(peerFile)}, String(peer.pid));
}, 25);
setInterval(() => {}, 1000);
`);
  writeFileSync(launcherScript, `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(nativeScript)}], {stdio:'inherit'});
child.on('exit', code => process.exit(code ?? 0));
`);
  writeFileSync(shellScript, `
printf '%s\\n' "$$" > '${shellPidFile}'
while [ ! -f '${launcherRelease}' ]; do sleep 0.05; done
exec '${node}' '${launcherScript}'
`);
  writeFileSync(fakeCodex, `#!/bin/sh\nexec /bin/sh '${shellScript}'\n`);
  chmodSync(fakeCodex, 0o755);
  try {
    worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, TMUX_TMPDIR: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    worker.on('message', m => messages.push(m as WorkerToDaemon));
    worker.stdout?.on('data', b => logs.push(b.toString()));
    worker.stderr?.on('data', b => logs.push(b.toString()));
    worker.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCodex,
      // A structured runtime shadows the canonical executable into
      // cliPathOverride and narrows descendant matching to the leaf's exact
      // basename; the static 'codex' map must never match it.
      ...(variant.key === 'configured-runtime' ? {
        cliRuntime: {
          id: 'test-alias-cdx', displayName: 'Alias Codex',
          executable: fakeCodex, source: 'configured', update: { provider: 'auto' },
        },
      } : {}),
      backendType, prompt: '', turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'test',
    } satisfies DaemonToWorker);
    await waitFor(() => attestations().some(m => !!m.cliPid));
    const initial = attestations().find(m => !!m.cliPid)!;
    await waitFor(() => existsSync(shellPidFile) && Number(readFileSync(shellPidFile, 'utf8')) > 1);
    const shellPid = Number(readFileSync(shellPidFile, 'utf8'));
    expect(readComm(shellPid)).toBe('sh');
    expect(snapshotProcessIdentities(initial.cliPid!)).toContain(`${shellPid}:${readProcessStartIdentity(shellPid)}`);
    writeFileSync(launcherRelease, 'ready');
    await waitFor(() => existsSync(pidsFile));
    cliPids = JSON.parse(readFileSync(pidsFile, 'utf8'));
    await waitFor(() => attestations().some(m => m.cliPid === cliPids!.native));
    const attestation = attestations().at(-1)!;
    const ds = {
      session: { sessionId, status: 'active' },
      worker,
      chatId: 'oc_test', larkAppId: 'app_test', workerGeneration: 1,
      localProcessAttestation: { ...attestation, workerGeneration: 1 },
      managedTurnOrigin: {
        capability: 'ca'.repeat(32), turnId: 'om_next', callerOpenId: 'ou_test',
        preexistingProcessIdentities: snapshotProcessIdentities(attestation.cliPid!),
      },
      initConfig: { apiOnly: false },
    } as unknown as DaemonSession;
    writeFileSync(toolRelease, 'ready');
    await waitFor(() => existsSync(peerFile));
    peerPid = Number(readFileSync(peerFile, 'utf8'));
    const request = () => resolveDaemonCurrentActor({
      sessionId, peer: { pid: peerPid!, procStart: readProcessStartIdentity(peerPid!)! },
      findSession: () => ds,
      resolveIdentity: async () => ({ openId: 'ou_test', type: 'user', email: 'test@example.com' }),
    });
    await expect(request()).resolves.toMatchObject({ ok: true, document: { actor: { email: 'test@example.com' } } });
    expect(attestation.cliPid).toBe(cliPids!.native);
    expect(attestation.cliPid).not.toBe(cliPids!.launcher);
    // The attested leaf must be the process actually carrying the variant's
    // comm — for a configured runtime this proves resolution did not fall back
    // to the static 'codex' map.
    expect(readComm(cliPids.native)).toBe(variant.leafName);
    ds.localProcessAttestation!.workerGeneration = 0;
    await expect(request()).resolves.toMatchObject({ ok: false, error: 'current_actor_unverified' });
    ds.localProcessAttestation!.workerGeneration = 1;
    ds.localProcessAttestation!.cliProcStart = 'stale';
    await expect(request()).resolves.toMatchObject({ ok: false, error: 'current_actor_unverified' });
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>(r => worker!.once('exit', () => r()));
      worker.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    for (const pid of [peerPid, cliPids?.native, cliPids?.launcher]) {
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    }
    stopSessionScope(sessionId);
    if (backendType === 'tmux') {
      try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root }, stdio: 'ignore' }); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
