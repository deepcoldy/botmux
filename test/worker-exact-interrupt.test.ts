import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { TraexAutoModelController } from '../src/services/traex-auto-model.js';

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

function harness(delivered = true, interruptKey?: 'ctrlc' | 'esc') {
  const inflightInputs = new InflightInputTracker();
  inflightInputs.onWrite({ content: 'cancelled task', turnId: 'stop' });
  inflightInputs.onWrite({ content: 'next task', turnId: 'next' });
  const pendingMessages = [{ content: 'cancelled task', turnId: 'stop' }, { content: 'next task', turnId: 'next' }];
  const send = vi.fn();
  const control = vi.fn(async () => delivered);
  const controlKey = vi.fn(async (_key: string, action: () => unknown) => action());
  const context = createContext({
    currentBotmuxTurnId: 'stop', backend: {}, lastInitConfig: { cliId: 'codex' }, effectiveBackendType: 'pty', isCodexAppCliId,
    codexCliEffortOperation: undefined, cliLifetimeNonce: 1,
    traexAutoModelController: null,
    cliAdapter: interruptKey ? { interruptKey } : undefined,
    inflightInputs, pendingMessages, send, log: vi.fn(), tuiPromptBlocking: true,
    flushPending: vi.fn(), scheduleOneShotAfterAction: vi.fn(),
    runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
    sendCriticalControlKey: controlKey,
    sendTermActionOnce: control,
  });
  runInContext(handler, context);
  const interrupt = () => runInContext("handleExactTurnInterrupt('request', 'stop')", context) as Promise<void>;
  const replay = () => { inflightInputs.onCliExit(); return inflightInputs.takeCarryOver().map(item => item.turnId); };
  return { context, pendingMessages, send, control, controlKey, interrupt, replay, inflightInputs };
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

  it('sends the adapter-selected interrupt key (ZCode uses Escape, not Ctrl+C)', async () => {
    // A single Ctrl+C quits ZCode outright, even mid-turn, so its adapter sets
    // interruptKey: 'esc'. The handler must honour that instead of hardcoding
    // ctrlc — otherwise the card's Stop button kills the session.
    const h = harness(true, 'esc');
    await h.interrupt();
    // `expect.anything()`, not `expect.any(Function)`: the second argument is a
    // callback created inside the vm realm, and Bun's instanceof check rejects
    // cross-realm functions (vitest happens to accept them).
    expect(h.controlKey).toHaveBeenCalledWith('esc', expect.anything());
    expect(h.control).toHaveBeenCalledWith(expect.anything(), 'esc');
  });

  it('defaults to Ctrl+C for adapters that do not override the key', async () => {
    const h = harness();
    await h.interrupt();
    expect(h.controlKey).toHaveBeenCalledWith('ctrlc', expect.anything());
    expect(h.control).toHaveBeenCalledWith(expect.anything(), 'ctrlc');
  });

  it('repeated interrupts leave unrelated pending and replay inputs intact', async () => {
    const h = harness();
    await h.interrupt();
    await h.interrupt();
    expect(h.replay()).toEqual(['next']);
    expect(h.pendingMessages.map(item => item.turnId)).toEqual(['next']);
  });

  it.each([true, false])('settles Auto model selection only when interruption is delivered (%s)', async delivered => {
    const h = harness(delivered);
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'] });
    controller.beginTurn('stop');
    h.context.traexAutoModelController = controller;
    await h.interrupt();
    expect(controller.currentTurnId()).toBe(delivered ? undefined : 'stop');
    expect(h.pendingMessages.map(item => item.turnId)).toEqual(delivered ? ['next'] : ['stop', 'next']);
  });
});
