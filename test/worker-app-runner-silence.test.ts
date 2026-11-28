import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { resolveCodexAppFinalTurnIdentity } from '../src/adapters/cli/codex-app-turn.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';
import { bridgePostText, BRIDGE_NOTHING_TO_SEND_SENTINEL, BRIDGE_NO_REPLY_SENTINEL_LEGACY } from '../src/services/bridge-fallback-gate.js';
import { runnerFinalOutcome, appRunnerSilenceDisposition } from '../src/services/runner-final-outcome.js';
import { isNativeGatewayCoreProcess } from '../src/core/runtime-mode.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';

/**
 * The terminal the worker emits for an app-runner final (worker.ts
 * handleTrustedCodexAppMarker, shared by every non-Codex-App runner): only a
 * native gateway core marks a bare sentinel final as positive silence, which
 * is what lets its async result settle. A Feishu daemon and a bare core-only
 * service emit the terminal exactly as before (no disposition).
 */
afterEach(() => vi.unstubAllEnvs());

type Kind = 'feishu daemon' | 'bare core-only' | 'native gateway core';
function enter(kind: Kind): void {
  vi.stubEnv('BOTMUX_CORE_ONLY', kind === 'feishu daemon' ? '' : '1');
  vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', kind === 'native gateway core' ? '1' : '');
}

async function terminalFor(cliId: string, payload: Record<string, unknown>) {
  const send = vi.fn();
  const emitTurnTerminal = vi.fn();
  const final = loadWorkerFunction<(kind: string, payload: Record<string, unknown>) => Promise<boolean>>('handleTrustedCodexAppMarker', {
    lastInitConfig: { cliId }, isCodexAppCliId, normalizeFinalUsage, resolveCodexAppFinalTurnIdentity, bridgePostText,
    runnerFinalOutcome, appRunnerSilenceDisposition, isNativeGatewayCoreProcess,
    currentBotmuxTurnId: 'om_current', currentBotmuxDispatchAttempt: 2,
    send, emitTurnTerminal, log: vi.fn(), cliName: () => cliId, inflightInputs: new InflightInputTracker(),
  });
  await final('final', { ...payload, turnId: 'om_current' });
  expect(emitTurnTerminal).toHaveBeenCalledTimes(1);
  const [turnId, status, , , disposition] = emitTurnTerminal.mock.calls[0];
  return { turnId, status, disposition };
}

const RUNNERS = ['minimax', 'dsh', 'mira', 'mir'];
const SENTINELS = [BRIDGE_NOTHING_TO_SEND_SENTINEL, BRIDGE_NO_REPLY_SENTINEL_LEGACY];

describe('app-runner terminal disposition per process kind', () => {
  it.each(RUNNERS)('%s: a bare sentinel final is positive silence only in a native gateway core', async (cli) => {
    for (const kind of ['feishu daemon', 'bare core-only', 'native gateway core'] as const) {
      enter(kind);
      for (const content of SENTINELS) {
        const t = await terminalFor(cli, { content });
        expect({ kind, content, status: t.status, disposition: t.disposition }).toEqual({
          kind, content, status: 'completed', disposition: kind === 'native gateway core' ? 'nothing_to_send' : undefined,
        });
      }
    }
  });

  it.each(RUNNERS)('%s: no other final is silence, in any process', async (cli) => {
    for (const kind of ['feishu daemon', 'bare core-only', 'native gateway core'] as const) {
      enter(kind);
      for (const content of ['', ' \n ', `answer\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}`, 'answer']) {
        expect((await terminalFor(cli, { content })).disposition, `${kind} ${JSON.stringify(content)}`).toBeUndefined();
      }
    }
  });

  it('a failed or cancelled sentinel final is not silence, even in a native gateway core', async () => {
    enter('native gateway core');
    for (const errorCode of ['cancelled', 'execution_failed']) {
      const t = await terminalFor('minimax', { content: BRIDGE_NOTHING_TO_SEND_SENTINEL, errorCode });
      expect(t.status).not.toBe('completed');
      expect(t.disposition).toBeUndefined();
    }
  });
});
