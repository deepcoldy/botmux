import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';

const appId = 'cli_screen_origin';
const sessionId = 'session-screen-origin';
const directories: string[] = [];
const stores: SessionContractStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A host and worker that agree on one bound runtime, the way a worker that
 *  attached to an existing CLI pane ends up after its first binding. */
function boundWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'screen-origin-'));
  directories.push(dir);
  const store = new SessionContractStore(dir, appId);
  stores.push(store);
  const controller = new SessionController({
    larkAppId: appId, chatId: 'oc_chat',
    session: { sessionId, larkAppId: appId, chatId: 'oc_chat', status: 'active' },
  } as any, store);
  const worker = controller.bindWorker(1).worker;
  const scope = new WorkerSessionEventScope({ appId, sessionId }, worker);
  const binding = scope.beginRuntime(undefined, 'pane-1');
  const runtime = controller.reserveBinding(binding.bindingId, worker);
  controller.bindRuntime(binding.bindingId, worker, { backend: 'tmux', physicalId: '222:cliStart', proof: 'process_start' });
  scope.assign(binding.bindingId, runtime);
  const screenFrame = (turnId?: string) => ({
    type: 'screen_update', status: 'working', content: 'running', ...(turnId ? { turnId } : {}),
    // The worker strips execution authority from every screen frame.
    sessionContract: (() => {
      const context = scope.envelope(scope.screenObservationOrigin(turnId));
      delete context.scope.execution;
      return context;
    })(),
  }) as any;
  /** The worker typed `turnId` into the CLI under its binding. */
  const submit = (turnId: string) => scope.run(binding, () => scope.recordSubmission(turnId));
  return { controller, worker, scope, binding, runtime, screenFrame, submit };
}

describe('screen observation origin of a sampler started before any runtime binding', () => {
  it('attributes a frame naming a submitted turn to the binding it was submitted under', () => {
    const w = boundWorld();
    w.submit('om_adopt_turn');

    // The sampler timer was created while handling init: no binding in its context.
    expect(w.scope.screenObservationOrigin('om_adopt_turn')).toEqual({ bindingId: w.binding.bindingId, runtime: w.runtime });
    expect(w.controller.ingest(w.screenFrame('om_adopt_turn'), w.worker)).toMatchObject({ kind: 'current' });
  });

  it('lets that frame prove its running turn through the host store', () => {
    const w = boundWorld();
    const execution = w.controller.admitInput('om_adopt_turn');
    // The worker typed the turn into the pane and reported it started under its binding.
    w.submit('om_adopt_turn');
    const started = w.scope.run(w.binding, () => w.scope.envelope(), execution);
    expect(w.controller.ingest({ type: 'turn_execution_started', turnId: 'om_adopt_turn', startedAtMs: Date.now(),
      sessionContract: { ...started, scope: { runtime: w.runtime, execution } } } as any, w.worker)).toMatchObject({ kind: 'current' });

    const admission = w.controller.ingest(w.screenFrame('om_adopt_turn'), w.worker);

    expect(admission).toMatchObject({ kind: 'current' });
    if (admission.kind !== 'current') throw new Error('expected a current admission');
    expect(admission.context.scope.execution).toEqual(execution);
  });

  it('leaves a turnless frame unattributed, so a restored pane is not reported busy on a guess', () => {
    const w = boundWorld();

    expect(w.scope.screenObservationOrigin()).toBeUndefined();
    expect(w.controller.ingest(w.screenFrame(), w.worker)).toMatchObject({ kind: 'reject', reason: 'runtime_scope_missing' });
  });

  it('does not attribute a turn this worker never submitted', () => {
    const w = boundWorld();
    w.submit('om_adopt_turn');

    expect(w.scope.screenObservationOrigin('om_someone_else')).toBeUndefined();
  });

  it('keeps a frame for a turn submitted to a replaced process on that stale binding', () => {
    const w = boundWorld();
    w.submit('om_adopt_turn');
    const replacement = w.scope.beginRuntime(undefined, 'pane-2');

    expect(w.scope.currentBinding()).toBe(replacement);
    expect(w.scope.screenObservationOrigin('om_adopt_turn')).toEqual({ bindingId: w.binding.bindingId, runtime: w.runtime });
  });

  it('advances a frame for a turn submitted before an in-process rebind to the live binding', () => {
    const w = boundWorld();
    w.submit('om_adopt_turn');
    const rebind = w.scope.beginRuntime(undefined, 'pane-1');

    expect(w.scope.screenObservationOrigin('om_adopt_turn')).toEqual({ bindingId: rebind.bindingId });
  });

  it('keeps a bound callback on its own binding as before', () => {
    const w = boundWorld();
    const replacement = w.scope.beginRuntime(undefined, 'pane-2');

    const fromOldProcess = w.scope.run(w.binding, () => w.scope.screenObservationOrigin());

    expect(w.scope.currentBinding()).toBe(replacement);
    expect(fromOldProcess).toEqual({ bindingId: w.binding.bindingId, runtime: w.runtime });
  });
});
