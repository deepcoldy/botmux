/** Execute the production terminal/ACK functions; only IPC and authority storage are controlled. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['emitTurnTerminal', 'releaseCommittedTurn', 'acceptSerialTerminalCommit'].map(name => {
  const declaration = parsed.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  return ts.transpileModule(declaration.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}).join('\n');

function harness(serial: boolean) {
  const events: string[] = [];
  const claimed = new Set<string>();
  const key = JSON.stringify(['turn-a', 2]);
  let active: { turnId: string; dispatchAttempt: number } | undefined = { turnId: 'turn-a', dispatchAttempt: 2 };
  const state: Record<string, any> = {
    sessionId: 'session', cliSpawnGeneration: 1, submitFailureChains: new Map(),
    serialTurnKey: (id: string, attempt: number) => JSON.stringify([id, attempt ?? null]),
    isSerialOwnedTurn: () => serial, codexRpcEngine: undefined, serialRpcRelease: new Map(),
    cancelSubmitFailureChainForTerminal: () => {},
    emittedTurnTerminals: { claim: (_: string, id: string, attempt: number) => {
      const k = JSON.stringify([id, attempt]); if (claimed.has(k)) return false; claimed.add(k); return true;
    } },
    turnExecutionClock: { settle: () => undefined, forget: () => {} },
    thinkingTurn: undefined, activeTurnAuthority: { snapshot: () => active },
    sandboxRelayCapability: { token: 'original' },
    completeManagedTurnOriginRevocation: () => { events.push('revoke'); state.sandboxRelayCapability = null; },
    serialDispatchIds: new Map(serial ? [[key, 'dispatch-a']] : []), serialPendingTerminals: new Map(),
    send: (message: any) => {
      events.push(message.type);
      if (serial) state.serialPendingTerminals.set(state.serialTurnKey(message.turnId, message.dispatchAttempt), message);
    },
    publishSerialSettlement: () => events.push('await-commit'),
    releaseActiveTurnAuthority: (_: string, exact: any) => {
      if (active?.turnId === exact.turnId && active?.dispatchAttempt === exact.dispatchAttempt) {
        active = undefined; events.push('release-admission');
      }
    },
    currentBotmuxTurnId: 'turn-a', currentBotmuxDispatchAttempt: 2, durableTurnInFlight: true,
    terminalReleasesDurableTurn: (a: any, b: any) => a.turnId === b.turnId && a.dispatchAttempt === b.dispatchAttempt,
    inflightInputs: { onTurnComplete: () => events.push('complete-input') },
    remoteRunnerRecoveredTurnInFlight: false, queueMicrotask: (fn: () => void) => fn(),
    flushPending: () => events.push('wake'), codexAppPendingDaemonAcks: new Map(),
    serialSettlementNotified: new Set(), serialFinalOutputs: new Map(), codexAppRecoveredDispatches: [],
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('state', `with (state) { ${functions}; return { emitTurnTerminal, acceptSerialTerminalCommit }; }`)(state);
  return { state, events, api, active: () => active,
    replace: () => { active = { turnId: 'turn-b', dispatchAttempt: 3 }; },
    commit: (dispatchId = 'dispatch-a') => api.acceptSerialTerminalCommit({ sessionId: 'session', turnId: 'turn-a', dispatchAttempt: 2, dispatchId }),
  };
}

it('revokes ordinary outbound authority before terminal publication and wakes its successor', () => {
  const h = harness(false); h.api.emitTurnTerminal('turn-a', 'completed', undefined, 2);
  expect(h.events).toEqual(['revoke', 'turn_terminal', 'release-admission', 'complete-input', 'wake']);
  expect(h.active()).toBeUndefined();
});

it('revokes serial outbound authority while retaining admission until the exact persistence receipt', () => {
  const h = harness(true); h.api.emitTurnTerminal('turn-a', 'completed', undefined, 2);
  expect(h.events).toEqual(['revoke', 'turn_terminal', 'await-commit']);
  expect(h.state.sandboxRelayCapability).toBeNull();
  expect(h.active()?.turnId).toBe('turn-a');
  expect(h.state.durableTurnInFlight).toBe(true);
  h.commit('wrong-dispatch'); expect(h.active()?.turnId).toBe('turn-a');
  h.commit(); expect(h.active()).toBeUndefined();
  expect(h.events.slice(-3)).toEqual(['release-admission', 'complete-input', 'wake']);
  const count = h.events.length; h.commit(); expect(h.events).toHaveLength(count);
});

it.each([false, true])('a late predecessor terminal cannot revoke successor authority (serial: %s)', serial => {
  const h = harness(serial); h.replace(); h.api.emitTurnTerminal('turn-a', 'completed', undefined, 2);
  expect(h.events).not.toContain('revoke'); expect(h.active()?.turnId).toBe('turn-b');
  expect(h.state.sandboxRelayCapability).toEqual({ token: 'original' });
});

it('duplicate terminal retries only the original serial observation without revoking or releasing again', () => {
  const h = harness(true); h.api.emitTurnTerminal('turn-a', 'completed', undefined, 2);
  h.api.emitTurnTerminal('turn-a', 'completed', undefined, 2);
  expect(h.events).toEqual(['revoke', 'turn_terminal', 'await-commit', 'await-commit']);
  expect(h.active()?.turnId).toBe('turn-a');
});
