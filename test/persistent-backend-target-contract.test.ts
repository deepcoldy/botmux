/**
 * A worker publishes the pane/agent it selected (`persistent_backend_target`)
 * BEFORE it spawns the CLI, so the daemon's session row knows the exact
 * resource even if the daemon dies between "agent created" and "runtime bound".
 * With session contracts on, that message travels through the same scoped-event
 * admission as every other worker event; it must still reach the daemon's
 * handler, otherwise a restarted daemon only knows `bmx-*` and cannot re-attach.
 *
 * Real worker start path (spawnCli + sessionEventMetadata) against the real
 * daemon handler, controller and contract store; the CLI launch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { sameWorker } from '../src/services/session-contract.js';
import type { DaemonSession } from '../src/core/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

const target = { backendType: 'herdr', sessionName: 'default', agentName: 'botmux-abcd1234' } as const;

/** A fresh worker's first CLI start, wired to the daemon's real handler. The
 *  stubbed launch does what the real one does around the spawn: publish the
 *  selected target, then (after the process exists) its runtime identity. */
async function firstStart(withFirstPrompt: boolean) {
  const data = mkdtempSync(join(tmpdir(), 'persistent-target-')); directories.push(data); fixtureConfig.dataDir = data;
  const store = new SessionContractStore(data, 'cli_target_test'); handles.push(store);
  const ref = { appId: 'cli_target_test', sessionId: 'session-1' };
  const ds = { larkAppId: ref.appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: ref.appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store); const worker = controller.bindWorker(1).worker;
  const pending: Promise<void>[] = [];
  const env: any = { workerSessionEventScope: new WorkerSessionEventScope(ref, worker), pendingRuntimeReservations: new Map(),
    activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
    CliSpawnSupersededError: class extends Error {}, log: vi.fn() };
  const delivered: any[] = [];
  let landedBeforeRuntimeBound = false;
  env.spawnCliBody = vi.fn(async () => {
    env.send({ type: 'persistent_backend_target', target });
    // The window the pre-spawn stamp exists for: agent created, runtime not yet bound.
    await new Promise(resolve => setTimeout(resolve, 0));
    landedBeforeRuntimeBound = delivered.some(message => message.type === 'persistent_backend_target');
  });
  env.publishRuntimeContract = vi.fn(async (binding: any) => {
    binding.identity = { backend: 'herdr', physicalId: 'pane-1', proof: 'opaque' };
    env.send({ type: 'runtime_binding', bindingId: binding.bindingId, identity: binding.identity });
  });
  const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
  const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
  const child = { send: vi.fn((message: any) => { void receive(message); }) };
  ds.worker = child as any;
  const hostScope: any = { sessionController: controller, contractWorker: worker, ds, worker: child, sameWorker,
    logger: { warn: vi.fn(), debug: vi.fn() }, t: ref.sessionId, handleLegacyWorkerMessage: vi.fn(async (message: any) => { delivered.push(message); }) };
  const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
  const sent: any[] = [];
  env.send = (message: any) => { const scoped = metadata(message); sent.push(scoped); pending.push(host(scoped)); };
  const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
  if (!withFirstPrompt) await spawn({ prompt: '', resume: true });
  else {
    // A new topic's first message is admitted as an execution before the CLI exists.
    const execution = controller.admitInput('turn-1');
    await spawn({ prompt: 'hello', resume: false, turnId: 'turn-1', sessionCommand: { version: 2, execution } });
  }
  await Promise.all(pending);
  return { delivered, sent, store, ref, landedBeforeRuntimeBound };
}

describe.each([
  ['a worker started without input', false],
  ['a new topic whose first message is already admitted', true],
])('persistent_backend_target published before the CLI spawn of %s', (_name, withFirstPrompt) => {
  it('reaches the daemon handler instead of being rejected', async () => {
    const { delivered, sent } = await firstStart(withFirstPrompt);
    // capture_identity is force-published inside the reserved runtime before
    // spawnCliBody, so it lands between the reservation grant and the
    // pre-spawn backend target stamp.
    expect(sent.map(message => message.type)).toEqual(['runtime_binding_started', 'capture_identity', 'persistent_backend_target', 'runtime_binding']);
    expect(delivered.filter(message => message.type === 'persistent_backend_target').map(message => message.target)).toEqual([target]);
  });

  it('lands before the runtime is bound, not parked until the binding settles', async () => {
    const { landedBeforeRuntimeBound } = await firstStart(withFirstPrompt);
    expect(landedBeforeRuntimeBound).toBe(true);
  });
});
