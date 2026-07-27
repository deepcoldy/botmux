import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { CodexRpcEngine } from '../codex-rpc-engine.js';
import type { CliId } from '../adapters/cli/types.js';
import type { FastModeApplyResult } from '../types.js';
import {
  cancelFastModeResult,
  waitForFastModeResult,
} from './fast-mode-handshake.js';

export type FastModeAction = 'toggle' | 'on' | 'off' | 'status' | 'invalid';

/** Parse the public `/fast` surface once so daemon routing and the command
 * handler cannot disagree about which invocations may create a Session. */
export function parseFastModeAction(content: string): FastModeAction {
  const match = content.trim().match(/^\/fast(?:\s+(.*))?$/i);
  if (!match) return 'invalid';
  const action = (match[1] ?? '').trim().toLowerCase();
  if (!action) return 'toggle';
  if (action === 'on' || action === 'off' || action === 'status') return action;
  return 'invalid';
}

/** Static capability gate. Model-level support is deliberately separate and
 * comes from app-server model/list. */
export function fastModeSessionSupported(input: {
  cliId: CliId;
  wrapperCli?: string;
  adopted?: boolean;
}): boolean {
  if (input.cliId !== 'codex' || input.adopted) return false;
  return input.wrapperCli?.trim().split(/\s+/)[0] !== 'aiden';
}

/** Query the same Codex app-server catalog used by the executor. This is used
 * before a cold `/fast on` creates a Session and as a migration fallback for
 * old Fast sessions that did not persist a concrete tier id. */
export async function probeCodexFastServiceTier(input: {
  cliBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  log?: (message: string) => void;
}): Promise<FastModeApplyResult> {
  const engine = new CodexRpcEngine({
    cliBin: input.cliBin,
    cwd: input.cwd,
    env: input.env,
    model: input.model,
    log: input.log,
  });
  try {
    await engine.start();
    const resolved = await engine.resolveFastServiceTier(input.model);
    if (!resolved) return { ok: false, reason: 'unsupported_model' };
    return {
      ok: true,
      enabled: true,
      serviceTier: resolved.serviceTier,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'apply_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    engine.stop();
  }
}

/** Send a typed state-change request and wait for the executor ACK. Merely
 * handing bytes to child_process.send is not success. */
export async function requestWorkerFastModeChange(
  worker: ChildProcess,
  enabled: boolean,
  timeoutMs = 120_000,
): Promise<FastModeApplyResult> {
  if (worker.killed || worker.connected === false) {
    return { ok: false, reason: 'not_ready' };
  }
  const requestId = randomUUID();
  const result = waitForFastModeResult(requestId, timeoutMs);
  try {
    worker.send(
      { type: 'set_fast_mode', requestId, enabled },
      error => {
        if (error) cancelFastModeResult(requestId);
      },
    );
  } catch {
    cancelFastModeResult(requestId);
  }
  return result;
}
