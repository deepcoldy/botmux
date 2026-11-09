/**
 * A re-attaching worker whose daemon confirms its runtime reservation late:
 * after a fleet restart the daemon, busy restoring every session, answered the
 * last re-attaches 16 s after they asked. The worker has to attach the live
 * pane — or, with its tmux backing gone, launch the CLI again — and type the
 * message that reached it while it waited, instead of leaving it queued behind
 * an init that never finishes.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude; the test
 * plays the daemon's side of the session contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

afterEach(cleanUpClaudeHarnesses);

const ANSWER_LAG_MS = 16_500;

const send = (g: Generation, msg: DaemonToWorker) => g.child.send(msg);

/** The daemon grants every start, ANSWER_LAG_MS after the worker asked. */
function answerStartsLate(g: Generation): void {
  g.child.on('message', (raw: WorkerToDaemon) => {
    if (raw.type === 'runtime_binding_aborted' && g.child.connected) send(g, { type: 'runtime_binding_aborted_ack', bindingId: raw.bindingId });
    if (raw.type !== 'runtime_binding_started') return;
    const answer = setTimeout(() => {
      if (g.child.connected) send(g, { type: 'runtime_contract_reserved', bindingId: raw.bindingId, runtime: { runtimeId: `runtime-${raw.bindingId}`, epoch: 1 }, mayStart: true });
    }, ANSWER_LAG_MS);
    answer.unref();
  });
}

async function answeredGeneration(h: Harness): Promise<Generation> {
  const g = h.startWorker();
  await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
  send(g, { type: 'message', content: 'first question', turnId: 'om_first' });
  await g.waitFor(() => g.finals().some(text => text.includes('reply: first question')), 'the first answer');
  return g;
}

/** The daemon's re-attach after its restart, under the session contract. */
async function lateConfirmedReattach(h: Harness): Promise<Generation> {
  const next = h.startWorker({
    resume: true,
    sessionContract: { version: 2, session: { appId: 'app_test', sessionId: h.sessionId }, worker: { workerId: 'reattach-worker', generation: 2 } },
  });
  answerStartsLate(next);
  await next.waitFor(() => next.messages.some(m => m.type === 'runtime_binding_started'), 'the start to ask for its runtime reservation');
  const askedAt = Date.now();
  send(next, { type: 'message', content: 'asked while it waited', turnId: 'om_waiting', sessionCommand: { version: 2 } });
  await next.waitFor(() => next.logs.join('').includes('Queued message behind async init materialization'), 'the message to queue behind init');
  await next.waitFor(
    () => next.finals().some(text => text.includes('reply: asked while it waited')),
    'the answer to the message that arrived while the start waited',
    ANSWER_LAG_MS + 45_000,
  );
  expect(Date.now() - askedAt).toBeGreaterThan(ANSWER_LAG_MS);
  expect(next.messages.map(m => m.type), next.logs.join('')).not.toContain('runtime_binding_aborted');
  return next;
}

describe.skipIf(!runnable)('a re-attach whose runtime reservation the daemon confirms late', () => {
  it('attaches the live pane and answers the message that arrived while it waited', async () => {
    const h = setup({ turnMs: 500 });
    const g = await answeredGeneration(h);
    await g.kill();
    await lateConfirmedReattach(h);
    expect(h.launches()).toHaveLength(1);
  }, 150_000);

  it('with the tmux backing gone, launches the CLI again and answers the message that arrived while it waited', async () => {
    const h = setup({ turnMs: 500 });
    const g = await answeredGeneration(h);
    await g.kill();
    h.killCli();
    await lateConfirmedReattach(h);
    expect(h.launches()).toHaveLength(2);
    expect(h.launches()[1]!.args).toContain('--resume');
  }, 150_000);
});
