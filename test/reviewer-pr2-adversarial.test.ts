import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTraexRuntimeDomain } from '../src/services/traex-runtime-domain.js';
import { acquireTraexRuntimeLease, acquireTraexRuntimeOccupancy, computeTraexInstallSignature, precheckTraexRuntime } from '../src/services/traex-runtime-gate.js';
import { acquireTraexRuntimeStart, markTraexRuntimeRunning, releaseTraexRuntime } from '../src/services/traex-runtime-registry.js';
import { comboKeyFromHashes, materializeTraexSnapshot, __testOnly_resetTraexSnapshotCache } from '../src/services/traex-runtime-snapshot.js';
import { observeTraexInstall, __testOnly_resetTraexInstallWatch } from '../src/services/traex-install-watch.js';
import { resolveInstallIdentity } from '../src/services/cli-install-identity.js';
import { resolveCommandEntry, resolveCommandReal } from '../src/adapters/cli/registry.js';
import { buildSessionChildEnv } from '../src/core/env-policy.js';
import { resolveTraexChildHome } from '../src/services/traex-paths.js';
import { config } from '../src/config.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';

let root: string;
let authority: ScheduleAuthorityStore | undefined;
const APP = 'cli_review_pr2';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-pr2-adversarial-'));
  __testOnly_resetTraexSnapshotCache();
  __testOnly_resetTraexInstallWatch();
});
afterEach(() => {
  scheduler.stopScheduler();
  scheduler.setScheduleAuthorityStore(null);
  authority?.close();
  authority = undefined;
  rmSync(root, { recursive: true, force: true });
});
function release(name = 'A') {
  const dir = mkdtempSync(join(root, 'release-'));
  rewrite(dir, name);
  return dir;
}
function rewrite(dir: string, content: string) {
  writeFileSync(join(dir, 'traex'), `traex-${content}`);
  writeFileSync(join(dir, 'traex-code-mode-host'), `helper-${content}`);
  writeFileSync(join(dir, 'trae-installation.json'), JSON.stringify({ version: content }));
}
function domain() {
  const resolution = resolveTraexRuntimeDomain(join(root, 'home'));
  if (resolution.kind !== 'ready') throw new Error('domain resolution failed');
  return resolution.domain;
}
function hash(file: string) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function actualKey(dir: string) {
  return comboKeyFromHashes({ traex: hash(join(dir, 'traex')), helper: hash(join(dir, 'traex-code-mode-host')), installation: hash(join(dir, 'trae-installation.json')) });
}
function task() {
  config.session.dataDir = join(root, 'data');
  scheduleStore.setScheduleScope(APP);
  authority = ScheduleAuthorityStore.open(config.session.dataDir);
  authority.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(authority);
  scheduler.setOwnerFilter(APP, true);
  return scheduler.addTask({ id: 'rvpr2001', name: 'review handoff', schedule: 'every 30m', prompt: 'original prompt', workingDir: root, chatId: 'oc_A', chatIds: ['oc_A', 'oc_B'], larkAppId: APP });
}
async function flush() {
  await Promise.resolve(); await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('PR2 independent runtime adversarial review', () => {
  it('continues observing the configured install after execution switches to a snapshot', async () => {
    const source = release();
    const snapshot = await materializeTraexSnapshot({ releaseDir: source, snapshotsRoot: join(root, 'snapshots') });
    const running = resolveInstallIdentity(snapshot.traexPath)!;
    // spawnCli replaces cliAdapter with the snapshot adapter; attestation then
    // reports cliAdapter.resolvedBin as cliInstallEntry, exactly this path.
    const ds = { localProcessAttestation: { cliExe: running, cliInstallEntry: snapshot.traexPath } } as any;
    rewrite(source, 'B');
    expect(observeTraexInstall(ds, 'traex').state).toBe('stale');
  });

  it('does not register old content and exec changed bytes for fixed or hash-only launches', async () => {
    const source = release();
    const oldKey = actualKey(source);
    await acquireTraexRuntimeStart(domain(), { occupantId: 'old-A', comboKey: oldKey, workerPid: process.pid, daemonPid: process.pid });
    let changed = false;
    const result = await acquireTraexRuntimeLease({
      traeHome: join(root, 'home'), releaseDir: source, executablePath: join(source, 'traex'),
      fixedPath: true, fixedExecutablePath: join(source, 'traex'),
      workerPid: process.pid, daemonPid: process.pid,
      abort: () => { if (!changed) { changed = true; rewrite(source, 'B'); } return undefined; },
    });
    expect(result.kind).toBe('granted');
    if (result.kind !== 'granted') throw new Error('expected grant for recorded A');
    // This is the exact path that would be exec'd, now carrying content B,
    // while the still-running A occupant was accepted as compatible.
    expect(result.lease.snapshot.comboKey).toBe(actualKey(source));
  });

  it('does not retain a dead CLI occupant merely because its daemon is still alive', async () => {
    const d = domain();
    const deadPid = 2_000_000_000;
    await acquireTraexRuntimeStart(d, { occupantId: 'dead-cli', comboKey: 'A', workerPid: deadPid, daemonPid: process.pid });
    await markTraexRuntimeRunning(d, 'dead-cli', { cliPid: deadPid });
    // Models SIGKILL of a worker/CLI while its bot daemon continues to serve.
    const next = await acquireTraexRuntimeStart(d, { occupantId: 'new-cli', comboKey: 'B', workerPid: process.pid, daemonPid: process.pid });
    expect(next.decision).toBe('start');
  });

  it('does not allow an unknown occupant through an equal install-signature precheck', async () => {
    const source = release();
    const signature = computeTraexInstallSignature(source)!;
    await acquireTraexRuntimeStart(domain(), { occupantId: 'unknown', comboKey: '', installSignature: signature, workerPid: process.pid, daemonPid: process.pid });
    expect(precheckTraexRuntime({ traeHome: join(root, 'home'), releaseDir: source }).state).toBe('blocked');
  });

  it('fails closed when a registry occupant cannot be normalized', async () => {
    const d = domain();
    writeFileSync(d.registryPath, JSON.stringify({ version: 1, occupants: [{ occupantId: 'possibly-live', comboKey: 'A', phase: 'running', cliPid: process.pid }] }));
    const next = await acquireTraexRuntimeStart(d, { occupantId: 'new-B', comboKey: 'B', workerPid: process.pid, daemonPid: process.pid });
    expect(next.decision).not.toBe('start');
  });
});

describe('PR2 independent scheduler adversarial review', () => {
  it('retains ambiguous and still-waiting target ownership after replay is refused', async () => {
    const t = task();
    let calls = 0;
    scheduler.setExecuteCallback(async (current, context) => {
      if (++calls === 1) {
        scheduler.parkDeferredRun(current.id, context, { runId: context.runId, detail: 'handoff', targets: { oc_A: 'waiting', oc_B: 'waiting' }, targetTurnIds: { oc_A: `schedule:${t.id}:a`, oc_B: `schedule:${t.id}:b` } });
        return 'deferred';
      }
      const parked = scheduler.getRuntimeTask(current.id, APP)!.deferredRun;
      if (parked?.targets.oc_A === 'ambiguous') throw new Error('ambiguous target cannot replay');
      return 'executed';
    });
    scheduler.runNow(t.id);
    await flush();
    const runId = scheduler.getRuntimeTask(t.id, APP)!.deferredRun!.runId;
    expect(scheduler.markDeferredTargetDispatching(t.id, runId, 'oc_A', `schedule:${t.id}:a`, APP)).toBe(true);
    expect(scheduler.recoverDeferredRunOnStartup(t.id, APP)).toBe(true);
    scheduler.runNow(t.id);
    await flush();
    expect(scheduler.getRuntimeTask(t.id, APP)?.deferredRun?.targets).toEqual({ oc_A: 'ambiguous', oc_B: 'waiting' });
  });

  it('writes recoverable target dispatching facts before the first run sends anything', async () => {
    const t = task();
    let persistedBeforeSend: boolean | undefined;
    scheduler.setExecuteCallback(async (current, context) => {
      persistedBeforeSend = scheduler.markDeferredTargetDispatching(current.id, context.runId, 'oc_A', `schedule:${t.id}:first`, APP);
      // Simulated external effect, then another target defers. No daemon copy
      // is used: these are exactly the real helpers called before the IPC.
      scheduler.parkDeferredRun(current.id, context, { runId: context.runId, detail: 'waiting B', targets: { oc_A: 'dispatched', oc_B: 'waiting' } });
      return 'deferred';
    });
    expect(scheduler.runNow(t.id).ok).toBe(true);
    await flush();
    expect(persistedBeforeSend).toBe(true);
  });

  it('keeps a parked target waiting when the worker gate defers after dispatch accounting', async () => {
    const t = task();
    scheduler.setExecuteCallback(async (current, context) => {
      scheduler.parkDeferredRun(current.id, context, { runId: context.runId, detail: 'handoff',
        targets: { oc_A: 'dispatched', oc_B: 'waiting' },
        targetTurnIds: { oc_A: `schedule:${t.id}:a`, oc_B: `schedule:${t.id}:b` } });
      return 'deferred';
    });
    scheduler.runNow(t.id);
    await flush();
    const runId = scheduler.getRuntimeTask(t.id, APP)!.deferredRun!.runId;
    expect(scheduler.noteWorkerRuntimeDeferred(t.id, runId, 'oc_A', `schedule:${t.id}:a`, APP)).toBe(true);
    // A worker-held target is `held`, not `waiting`: a retry must not re-dispatch it.
    expect(scheduler.getRuntimeTask(t.id, APP)?.deferredRun?.targets.oc_A).toBe('held');
    // A different turn id must not move the target.
    expect(scheduler.noteWorkerRuntimeDeferred(t.id, runId, 'oc_A', 'schedule:other', APP)).toBe(false);
  });

  it('keeps the exact accepted prompt when a partially dispatched run retries after edits', async () => {
    const t = task();
    let count = 0;
    let retriedPrompt: string | undefined;
    let retriedRun: string | undefined;
    scheduler.setExecuteCallback(async (current, context) => {
      if (++count === 1) {
        scheduler.parkDeferredRun(current.id, context, { runId: context.runId, detail: 'A sent B waiting', targets: { oc_A: 'dispatched', oc_B: 'waiting' }, targetTurnIds: { oc_A: `schedule:${t.id}:a`, oc_B: `schedule:${t.id}:b` } });
        return 'deferred';
      }
      retriedPrompt = current.prompt;
      retriedRun = context.runId;
      return 'executed';
    });
    scheduler.runNow(t.id);
    await flush();
    const acceptedRun = scheduler.getRuntimeTask(t.id, APP)!.deferredRun!.runId;
    expect(scheduler.updateTask(t.id, { prompt: 'edited prompt' }).ok).toBe(true);
    scheduler.runNow(t.id);
    await flush();
    expect(retriedRun).toBe(acceptedRun);
    expect(retriedPrompt).toBe('original prompt');
  });
});

async function liveRuntime(home: string, key: string) {
  const resolution = resolveTraexRuntimeDomain(home);
  if (resolution.kind !== 'ready') throw new Error('domain unavailable');
  await acquireTraexRuntimeStart(resolution.domain, {
    occupantId: 'old-A', comboKey: key, workerPid: process.pid, daemonPid: process.pid,
  });
  await markTraexRuntimeRunning(resolution.domain, 'old-A', { cliPid: process.pid });
  return resolution.domain;
}

describe('PR2 round2 protocol wiring', () => {
  it('does not authorize a fresh opaque launcher beside a live incompatible runtime', async () => {
    const home = join(root, 'home');
    await liveRuntime(home, 'A');
    // The wrapper/forge new-exec path calls occupancy WITHOUT the
    // existing-runtime bypass; an unprovable new start must wait/refuse.
    const next = await acquireTraexRuntimeOccupancy({
      traeHome: home, releaseDir: release('B'), workerPid: process.pid, daemonPid: process.pid,
    });
    expect(next.kind).toBe('blocked');
  });

  it('registers an already-alive adopted runtime as unknown without authorizing a parallel start', async () => {
    const home = join(root, 'home');
    const adopted = await acquireTraexRuntimeOccupancy({
      traeHome: home, releaseDir: release('A'), workerPid: process.pid, daemonPid: process.pid,
      existingRuntime: true,
    });
    expect(adopted.kind).toBe('granted');
    // A later unprovable new exec must wait for that unknown occupant.
    const fresh = await acquireTraexRuntimeOccupancy({
      traeHome: home, releaseDir: release('B'), workerPid: process.pid, daemonPid: process.pid,
    });
    expect(fresh.kind).toBe('blocked');
  });

  it('observes an entry symlink switching releases with the production attestation shape', async () => {
    const a = release('A');
    const b = release('B');
    const selected = join(root, 'selected-traex');
    symlinkSync(join(a, 'traex'), selected);
    // Production configuredEntry keeps the updatable alias (no final realpath).
    const configuredEntry = resolveCommandEntry(selected);
    expect(configuredEntry).toBe(selected);
    const installAtSpawn = resolveInstallIdentity(configuredEntry)!;
    const snapshot = await materializeTraexSnapshot({
      releaseDir: a, executablePath: configuredEntry, snapshotsRoot: join(root, 'snapshots'),
    });
    const launch = resolveInstallIdentity(snapshot.traexPath)!;
    const ds = {
      localProcessAttestation: {
        cliInstallEntry: configuredEntry,
        cliInstallAtSpawn: installAtSpawn,
        cliLaunchTargetIdentity: launch,
        cliExe: launch,
      },
    } as any;
    unlinkSync(selected);
    symlinkSync(join(b, 'traex'), selected);
    expect(resolveCommandReal(selected)).toBe(realpathSync(join(b, 'traex')));
    expect(observeTraexInstall(ds, 'traex').state).toBe('stale');
  });

  it('uses the cache domain the effective child actually receives after envUnset', async () => {
    const inheritedHome = join(root, 'bot-home');
    const nativeHome = join(root, 'native-home');
    const finalEnv = buildSessionChildEnv({ HOME: nativeHome, TRAE_HOME: inheritedHome }, undefined, ['TRAE_HOME']);
    expect(finalEnv.TRAE_HOME).toBeUndefined();
    // TRAE falls back to $HOME/.trae after TRAE_HOME was explicitly removed.
    const actualHome = join(finalEnv.HOME!, '.trae');
    // The production composition the worker feeds to the gate.
    const gateHome = resolveTraexChildHome({
      baseEnv: { HOME: nativeHome, TRAE_HOME: inheritedHome },
      envUnset: ['TRAE_HOME'],
    });
    expect(gateHome).toBe(actualHome);
    await liveRuntime(actualHome, 'A');
    const b = release('B');
    const next = await acquireTraexRuntimeLease({
      traeHome: gateHome,
      releaseDir: b,
      executablePath: join(b, 'traex'),
      snapshotsRoot: join(root, 'snapshots'),
      workerPid: process.pid,
      daemonPid: process.pid,
    });
    expect(next.kind).toBe('blocked');
  });
});

describe('independent PR2 r3 admission-to-exec identity', () => {
  it('does not label an A snapshot as current when the configured entry changes before attestation', async () => {
    const a = release('A');
    const b = release('B');
    const selected = join(root, 'selected');
    symlinkSync(join(a, 'traex'), selected);
    const entry = resolveCommandEntry(selected);
    const result = await acquireTraexRuntimeLease({
      traeHome: join(root, 'home'), entryPath: entry,
      releaseDir: a, snapshotsRoot: join(root, 'snapshots'),
      workerPid: process.pid, daemonPid: process.pid,
    });
    if (result.kind !== 'granted') throw new Error('expected A lease');
    expect(result.lease.snapshot.comboKey).toBe(actualKey(a));
    // The source observation is captured in the SAME materialisation pass as
    // the frozen content; production attests this value, not a later stat of
    // the mutable entry.
    const sourceAtSpawn = result.lease.snapshot.sourceInstallIdentity;
    expect(sourceAtSpawn).toBeTruthy();
    // Upgrade lands after the lease freezes A, before attestation.
    unlinkSync(selected);
    symlinkSync(join(b, 'traex'), selected);
    const frozen = resolveInstallIdentity(result.lease.snapshot.traexPath)!;
    const ds = { localProcessAttestation: {
      cliInstallEntry: entry,
      cliInstallAtSpawn: sourceAtSpawn,
      cliLaunchTarget: result.lease.snapshot.traexPath,
      cliLaunchTargetIdentity: frozen,
      cliLaunchComboKey: result.lease.snapshot.comboKey,
      cliExe: frozen,
    }} as any;
    // Running A must never be relabelled as the now-current B install.
    expect(observeTraexInstall(ds, 'traex').state).toBe('stale');
  });
});

describe('independent PR2 r4 late worker defer', () => {
  it('does not settle a finite run before the worker can report its start gate wait', async () => {
    task(); // real authority/store initialization
    const t = scheduler.addTask({id:'rvpr2002',name:'finite handoff',schedule:'every 30m',prompt:'exact prompt',workingDir:root,chatId:'oc_A',chatIds:['oc_A'],larkAppId:APP,repeat:{times:1,completed:0}});
    let runId = '';
    const turnId = `schedule:${t.id}:late`;
    scheduler.setExecuteCallback(async (current, context) => {
      runId = context.runId;
      expect(scheduler.markDeferredTargetDispatching(current.id, runId, 'oc_A', turnId, APP)).toBe(true);
      // The fork returned and the target is recorded as dispatched, but the
      // worker has not accepted the exact turn yet.
      scheduler.parkDeferredRun(current.id, context, {
        runId, detail: 'worker accepted the fork, not the turn',
        targets: { oc_A: 'dispatched' }, targetTurnIds: { oc_A: turnId },
      });
      // Mirrors daemon: executeScheduledTask returned after fork, worker has
      // not yet finished spawnCli / consulted the physical-cache gate.
      return 'executed';
    });
    expect(scheduler.runNow(t.id).ok).toBe(true);
    await flush();
    const corrected = scheduler.noteWorkerRuntimeDeferred(t.id, runId, 'oc_A', turnId, APP);
    const current = scheduler.getRuntimeTask(t.id, APP)!;
    expect({corrected, status:current.lastStatus, completed:current.repeat?.completed, enabled:current.enabled, waiting:current.deferredRun?.targets.oc_A})
      .toEqual({corrected:true, status:'deferred', completed:0, enabled:true, waiting:'held'});
  });

  it('does not redispatch a target whose first worker still holds the exact turn', async () => {
    const t = task();
    const turnA = `schedule:${t.id}:held-a`;
    const turnB = `schedule:${t.id}:held-b`;
    let attempts = 0;
    let sendsToA = 0;
    let runId = '';
    scheduler.setExecuteCallback(async (current, context) => {
      runId = context.runId;
      if (++attempts === 1) {
        sendsToA++;
        // A worker exists and owns A's input while awaiting its start gate.
        // B never got a worker. This is the daemon's persisted partial result.
        scheduler.parkDeferredRun(current.id, context, {runId, detail:'B blocked', targets:{oc_A:'dispatched',oc_B:'waiting'}, targetTurnIds:{oc_A:turnA,oc_B:turnB}});
      } else {
        const parked = scheduler.getRuntimeTask(current.id, APP)!.deferredRun!;
        if (parked.targets.oc_A === 'waiting') sendsToA++;
        scheduler.parkDeferredRun(current.id, context, {runId, detail:'still waiting', targets:parked.targets,targetTurnIds:parked.targetTurnIds});
      }
      return 'deferred';
    });
    scheduler.runNow(t.id);
    await flush();
    expect(scheduler.noteWorkerRuntimeDeferred(t.id,runId,'oc_A',turnA,APP)).toBe(true);
    scheduler.runNow(t.id);
    await flush();
    expect(sendsToA).toBe(1);
  });
});

describe('independent PR2 r5 admission facts', () => {
  it('never publishes successful completion while the forked worker has not crossed its gate', async () => {
    task();
    const t = scheduler.addTask({id:'rvpr2002',name:'finite',schedule:'every 30m',prompt:'original prompt',workingDir:root,chatId:'oc_A',chatIds:['oc_A'],larkAppId:APP,repeat:{times:1,completed:0}});
    let runId = '';
    const turnId = `schedule:${t.id}:late`;
    scheduler.setExecuteCallback(async (current, context) => {
      runId = context.runId;
      scheduler.markDeferredTargetDispatching(current.id,runId,'oc_A',turnId,APP);
      scheduler.parkDeferredRun(current.id, context, {
        runId, detail: 'fork returned, turn not accepted yet',
        targets: { oc_A: 'dispatched' }, targetTurnIds: { oc_A: turnId },
      });
      return 'executed'; // daemon currently returns immediately after fork
    });
    scheduler.runNow(t.id);
    await flush();
    const visibleBeforeLateMessage = scheduler.getRuntimeTask(t.id,APP)!;
    expect(visibleBeforeLateMessage.lastStatus).not.toBe('ok');
    expect(visibleBeforeLateMessage.repeat?.completed).toBe(0);
    expect(visibleBeforeLateMessage.enabled).toBe(true);
  });

  it('recovers every worker-held representation as ambiguous after restart', async () => {
    const t = task();
    let runId = '';
    const turnId = `schedule:${t.id}:late`;
    scheduler.setExecuteCallback(async (current,context) => {
      runId = context.runId;
      scheduler.parkDeferredRun(current.id, context, {
        runId, detail: 'both targets dispatched, none accepted yet',
        targets: { oc_A: 'dispatched', oc_B: 'dispatched' },
        targetTurnIds: { oc_A: turnId, oc_B: `schedule:${current.id}:other` },
      });
      return 'executed';
    });
    scheduler.runNow(t.id);
    await flush();
    expect(scheduler.noteWorkerRuntimeDeferred(t.id,runId,'oc_A',turnId,APP)).toBe(true);
    // This is the settled-run path's waiting + heldTargets representation.
    expect(scheduler.getRuntimeTask(t.id,APP)!.deferredRun?.heldTargets?.oc_A).toBe(turnId);
    scheduler.recoverDeferredRunOnStartup(t.id,APP);
    expect(scheduler.getRuntimeTask(t.id,APP)!.deferredRun?.targets.oc_A).toBe('ambiguous');
  });
});
