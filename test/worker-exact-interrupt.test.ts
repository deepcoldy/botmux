import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';

// Execute the actual worker handler with a controlled backend. Importing the
// whole worker would start its IPC/runtime; a copy of the handler would miss
// regressions in the ACK ordering we need to exercise here.
const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function handleExactTurnInterrupt(');
const end = source.indexOf('/** Key name → ANSI escape sequence', start);
if (start < 0 || end < start) throw new Error('Exact interrupt handler not found');
const handler = transpileModule(source.slice(start, end), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;

function harness(delivered = true) {
  const inflightInputs = new InflightInputTracker();
  inflightInputs.onWrite({ content: 'cancelled task', turnId: 'stop' });
  inflightInputs.onWrite({ content: 'next task', turnId: 'next' });
  const pendingMessages = [{ content: 'cancelled task', turnId: 'stop' }, { content: 'next task', turnId: 'next' }];
  const send = vi.fn();
  const control = vi.fn(async () => delivered);
  const context = createContext({
    currentBotmuxTurnId: 'stop', backend: {}, lastInitConfig: { cliId: 'codex' }, effectiveBackendType: 'pty',
    inflightInputs, pendingMessages, send, log: vi.fn(), tuiPromptBlocking: true,
    flushPending: vi.fn(), scheduleOneShotAfterAction: vi.fn(),
    runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
    sendCriticalControlKey: async (_key: string, action: () => unknown) => action(),
    sendTermActionOnce: control,
  });
  runInContext(handler, context);
  const interrupt = () => runInContext("handleExactTurnInterrupt('request', 'stop')", context) as Promise<void>;
  const replay = () => { inflightInputs.onCliExit(); return inflightInputs.takeCarryOver().map(item => item.turnId); };
  return { context, pendingMessages, send, control, interrupt, replay, inflightInputs };
}

describe('worker exact interrupt acknowledgement and crash replay', () => {
  it.each([false, true])('retires only the cancelled turn before ACK (already exited=%s)', async exited => {
    const h = harness();
    if (exited) h.inflightInputs.onCliExit();
    h.send.mockImplementation(message => {
      expect(message).toMatchObject({ type: 'turn_interrupt_result', delivered: true, turnId: 'stop' });
      expect(h.pendingMessages.map(item => item.turnId)).toEqual(['next']);
      expect(h.replay()).toEqual(['next']);
    });
    await h.interrupt();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.context.flushPending).toHaveBeenCalledOnce();
  });

  it('keeps both inputs when the backend did not accept the interrupt', async () => {
    const h = harness(false);
    await h.interrupt();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ delivered: false, reason: 'delivery_failed' }));
    expect(h.replay()).toEqual(['stop', 'next']);
    expect(h.pendingMessages.map(item => item.turnId)).toEqual(['stop', 'next']);
    expect(h.context.flushPending).not.toHaveBeenCalled();
  });

  it('does not retire a successor when completion arrives after the turn changed', async () => {
    const h = harness();
    h.control.mockImplementation(async () => { h.context.currentBotmuxTurnId = 'next'; return true; });
    await h.interrupt();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ delivered: false, reason: 'stale_turn' }));
    expect(h.replay()).toEqual(['stop', 'next']);
    expect(h.pendingMessages.map(item => item.turnId)).toEqual(['stop', 'next']);
  });

  it('repeated interrupts leave unrelated pending and replay inputs intact', async () => {
    const h = harness();
    await h.interrupt();
    await h.interrupt();
    expect(h.replay()).toEqual(['next']);
    expect(h.pendingMessages.map(item => item.turnId)).toEqual(['next']);
  });
});
