import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import { failedTurnCaller } from '../src/core/failed-turn-recovery.js';
import { cancelDeploymentContinuation, claimDeploymentContinuation, deploymentContinuationCandidate, recordDeploymentContinuation } from '../src/services/deployment-continuation.js';
import type { DaemonSession } from '../src/core/types.js';

// Execute the daemon's real receipt callback: importing daemon.ts would start
// the fleet. Only unrelated notification/lease effects are replaced; routing,
// caller selection, the checkpoint gate and SQLite persistence remain real.
const source = ts.createSourceFile('daemon.ts', readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function callback(scope: Record<string, unknown>) {
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'onNativeInputConsumed') method = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!method) throw new Error('daemon receipt callback missing');
  const active = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'setActiveInteractiveTurn');
  if (!active) throw new Error('active turn admission missing');
  const code = ts.transpileModule(`${active.getText(source)}\nconst hooks = { ${method.getText(source)} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('scope', `with (scope) { ${code}; return hooks.onNativeInputConsumed; }`)(scope);
}

let directory: string, oldDirectory: string, ds: DaemonSession;
const caller = { senderType: 'user' as const, requestUserOpenId: 'ou_sender', requestLarkAppId: 'app_test' };
const nativeId = 'native-original';
const receive = callback({ recordDeploymentContinuation, failedTurnCaller, sessionStore: store,
  logger: { warn: vi.fn(), error: (message: string) => { throw new Error(message); } },
  trustedSessionController: () => undefined, ensureAutomaticTaskContinuationLease: () => {},
  confirmNativeGroupContextInput: () => {},
});
function receipt(turnId: string) {
  receive(ds, { type: 'native_input_consumed', ordinaryInteractive: true, turnId,
    proofKind: 'codex_history_match', nativeSessionId: nativeId }, { workerGeneration: 1 });
}
function admit(turnId: string, scope: 'thread' | 'chat' = 'thread', root?: string) {
  ds.scope = scope;
  beginReplyTargetTurn(ds, root, turnId, undefined, {
    senderOpenId: caller.requestUserOpenId,
    participants: [{ openId: caller.requestUserOpenId, isBot: false }],
  });
  ds.activeInteractiveTurn = { turnId, caller };
  store.updateSession(ds.session);
}
function reload() {
  store.init('app_test');
  return store.getOwnedSession(ds.session.sessionId)!;
}
function manualInput(failPersistence: boolean) {
  const pool = ts.createSourceFile('worker-pool.ts', readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = pool.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sendWorkerSessionInput');
  if (!declaration) throw new Error('manual input entry missing');
  const code = ts.transpileModule(declaration.getText(pool).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const scope = {
    cancelDeploymentContinuation,
    sessionStore: failPersistence ? { updateDeploymentContinuation: () => { throw new Error('disk unavailable'); } } : store,
    getBot: () => ({ config: { cliId: 'codex' } }), sessionCliId: () => 'codex',
    cancelOrdinaryRecoveryForUserInput: () => {},
    withTurnCaller: (_session: unknown, message: unknown) => message, bufferTransferInput: () => false,
    afterWorkerIpcBootstrap: (_worker: unknown, effect: () => void) => { effect(); return true; },
  };
  return new Function('scope', `with (scope) { ${code}; return sendWorkerSessionInput; }`)(scope);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'daemon-deployment-'));
  oldDirectory = config.session.dataDir; config.session.dataDir = directory;
  store.init('app_test');
  const session = store.createSession('oc_chat', 'om_root', 'task', 'group', 'thread');
  Object.assign(session, { larkAppId: 'app_test', backendType: 'tmux', cliId: 'codex', cliSessionId: nativeId, workerGeneration: 1 });
  store.updateSession(session);
  ds = { session, scope: 'thread', larkAppId: 'app_test', chatId: 'oc_chat', initConfig: { codexRpcInput: false } } as DaemonSession;
});
afterEach(() => { config.session.dataDir = oldDirectory; rmSync(directory, { recursive: true, force: true }); });

it.each(['thread', 'chat'] as const)('arms a %s first turn without a reply root and survives reload', scope => {
  admit('om_first', scope);
  expect(ds.currentReplyTarget).toBeUndefined();
  receipt('om_first');
  expect(deploymentContinuationCandidate(reload())).toMatchObject({ turnId: 'om_first', caller, state: 'running' });
});

it('re-arms a cold recovered turn twice, preserving its original caller', () => {
  admit('om_first'); receipt('om_first');
  for (let generation = 0; generation < 2; generation++) {
    ds.session = reload();
    const claimed = claimDeploymentContinuation(ds.session, deploymentContinuationCandidate(ds.session)!,
      previous => store.updateDeploymentContinuation(ds.session, previous))!;
    ds.activeInteractiveTurn = undefined;
    ds.currentReplyTarget = { rootMessageId: 'om_root', turnId: claimed.turnId, updatedAt: new Date().toISOString() };
    receipt('om_first');
    expect(deploymentContinuationCandidate(reload())).toMatchObject({ turnId: 'om_first', caller, state: 'running' });
    expect(ds.activeInteractiveTurn).toMatchObject({ turnId: 'om_first', caller: { ...caller, source: 'failed_turn_recovery' } });
  }
});

it('arms the next thread turn even when the restored reply target still names the old turn', () => {
  ds.currentReplyTarget = { rootMessageId: 'om_root', turnId: 'om_old', updatedAt: new Date().toISOString() };
  admit('om_next');
  expect(ds.currentReplyTarget.turnId).toBe('om_old');
  receipt('om_next');
  expect(deploymentContinuationCandidate(reload())?.turnId).toBe('om_next');
});

it('rejects a late old receipt after a newer turn was accepted', () => {
  admit('om_old', 'chat', 'om_root'); admit('om_next', 'chat', 'om_root');
  receipt('om_old');
  expect(reload().deploymentContinuation).toBeUndefined();
});

it('rejects a routed but unaccepted turn while another turn is still active', () => {
  admit('om_active', 'chat', 'om_root');
  beginReplyTargetTurn(ds, 'om_root', 'om_rejected', undefined, {
    senderOpenId: caller.requestUserOpenId, participants: [{ openId: caller.requestUserOpenId, isBot: false }],
  });
  store.updateSession(ds.session);
  receipt('om_rejected');
  expect(reload().deploymentContinuation).toBeUndefined();
});

it.each([
  { type: 'raw_input', content: '/clear' },
  { type: 'term_action', key: 'ctrlc' },
  { type: 'inject_command', command: '/new' },
])('$type cancels the active checkpoint despite a stale reply target before IPC', message => {
  ds.currentReplyTarget = { rootMessageId: 'om_root', turnId: 'om_old', updatedAt: new Date().toISOString() };
  admit('om_new'); receipt('om_new');
  const send = vi.fn(() => {
    expect(reload().deploymentContinuation).toEqual({ state: 'cancelled', turnId: 'om_new' });
  });
  ds.worker = { killed: false, send } as any;
  expect(manualInput(false)(ds, message)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  receipt('om_new');
  expect(deploymentContinuationCandidate(reload())).toBeUndefined();
});

it('does not deliver manual input when checkpoint cancellation cannot persist', () => {
  admit('om_new'); receipt('om_new');
  const send = vi.fn(); ds.worker = { killed: false, send } as any;
  expect(() => manualInput(true)(ds, { type: 'raw_input', content: '/clear' })).toThrow('disk unavailable');
  expect(send).not.toHaveBeenCalled();
  expect(deploymentContinuationCandidate(reload())?.turnId).toBe('om_new');
});

it.each([
  { type: 'raw_input', content: '/clear' },
  { type: 'term_action', key: 'ctrlc' },
  { type: 'inject_command', command: '/new' },
])('$type before the first receipt prevents a delayed receipt from re-arming', message => {
  admit('om_first');
  ds.worker = { killed: false, send: vi.fn() } as any;
  expect(manualInput(false)(ds, message)).toBe(true);
  expect(reload().deploymentContinuation).toEqual({ state: 'cancelled', turnId: 'om_first' });
  receipt('om_first');
  expect(deploymentContinuationCandidate(reload())).toBeUndefined();
});
