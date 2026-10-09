import type { TriggerRequest } from '../services/trigger-types.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { askKeyFor } from './ask-persist-store.js';
import type { AskResult, CreateAskInput } from './ask-types.js';

export interface ExplicitAskReceipt {
  version: 1;
  input: CreateAskInput & { requestId: string };
  result?: AskResult;
  settledAt?: number;
  acknowledged?: boolean;
  delivered?: boolean;
}

/** Explicit asks have a daemon-owned claimant, independent of the waiting CLI.
 * Keep terminal receipts until acknowledged or durably dispatched to the SAME
 * session. A stable turn key makes a lost dispatch response safe to retry. */
export function createExplicitAskContinuation(deps: {
  dir: string;
  appId: string;
  register: (input: CreateAskInput) => Promise<AskResult>;
  canResume: (receipt: ExplicitAskReceipt) => boolean;
  dispatch: (receipt: ExplicitAskReceipt, key: string) => Promise<boolean>;
  onError: (error: unknown) => void;
  releaseHandoff?: (input: CreateAskInput) => void;
  hasHandoff?: (input: CreateAskInput) => boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const running = new Map<string, Promise<AskResult>>();
  let sweeping = false;
  const keyFor = (input: CreateAskInput) => createHash('sha256')
    .update(askKeyFor(input.larkAppId, input.sessionId, 'host_explicit', input.requestId!)).digest('hex');
  const pathFor = (key: string) => join(deps.dir, `${key}.json`);
  const read = (key: string): ExplicitAskReceipt | undefined => {
    try { return JSON.parse(readFileSync(pathFor(key), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  };
  const write = (key: string, receipt: ExplicitAskReceipt) => {
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(pathFor(key), JSON.stringify(receipt), { mode: 0o600, durable: true });
  };
  function wait(input: CreateAskInput & { requestId: string }): Promise<AskResult> {
    const key = keyFor(input);
    const original = read(key);
    if (original && JSON.stringify(original.input) !== JSON.stringify(input)) {
      return Promise.reject(new Error('explicit ask invocation identity conflict'));
    }
    if (original?.result) return Promise.resolve(original.result);
    const joined = running.get(key);
    if (joined) return joined;
    if (original && deps.hasHandoff && !deps.hasHandoff(input)) {
      const result: AskResult = { kind: 'invalidated', reason: 'durable Ask handoff missing; do not reuse an old confirmation', selected: null, by: null, comment: null, timedOut: false };
      write(key, { ...original, result, settledAt: now() });
      return Promise.resolve(result);
    }
    if (!original) write(key, { version: 1, input });
    const promise = deps.register(input).then(result => {
      const receipt = read(key)!;
      write(key, { ...receipt, result, settledAt: now() });
      deps.releaseHandoff?.(input);
      return result;
    }).finally(() => running.delete(key));
    running.set(key, promise);
    return promise;
  }
  function acknowledge(input: CreateAskInput & { requestId: string }): AskResult | undefined {
    const key = keyFor(input);
    const receipt = read(key);
    if (!receipt?.result || JSON.stringify(receipt.input) !== JSON.stringify(input)) return undefined;
    write(key, { ...receipt, acknowledged: true });
    return receipt.result;
  }
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      let files: string[];
      try { files = readdirSync(deps.dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        try {
          const key = file.slice(0, -5);
          const receipt = read(key)!;
          if (receipt.version !== 1 || receipt.input.larkAppId !== deps.appId
            || keyFor(receipt.input) !== key || receipt.acknowledged || receipt.delivered) continue;
          if (!receipt.result) {
            // Restore only existing, still-bound sessions. Never create a session
            // or revive a closed business task to recover an interaction.
            if (deps.canResume(receipt) && !running.has(key)) {
              void wait(receipt.input).catch(deps.onError);
            }
            continue;
          }
          // Allow the normal HTTP caller to emit stdout and acknowledge first.
          if (now() - receipt.settledAt! < 5000 || !deps.canResume(receipt)) continue;
          if (await deps.dispatch(receipt, `ask-${key}`)) {
            // Re-read: a normal claimant may have acknowledged during dispatch.
            write(key, { ...read(key)!, delivered: true });
          }
        } catch (error) { deps.onError(error); }
      }
    } catch (error) { deps.onError(error); }
    finally { sweeping = false; }
  }
  return { wait, acknowledge, sweep };
}

/** Shared production builder: group-only chat permission must never leak into
 * private sessions. Recovery is a quiet append, never a new task or a steer. */
export function explicitAskRecoveryRequest(receipt: ExplicitAskReceipt, key: string, chatType?: 'group' | 'p2p'): TriggerRequest {
  return {
    source: { type: 'ui', connectorId: 'ask-continuation', requestId: key },
    target: { kind: 'turn', sessionId: receipt.input.sessionId },
    envelope: { format: 'json', sourceName: 'Ask result recovery', trusted: false,
      payload: { requestId: receipt.input.requestId, questions: receipt.input.questions, result: receipt.result } },
    instruction: 'Recover the result of this existing Ask in the original task and session. Read current task state and verify the question, scope and solution revision before consuming this decision. Do not ask it again, create a new task, or replay completed development, tests or deployment. A timeout or invalidation is not approval. Record the existing decision and continue only already-authorized pending work; if scope no longer matches, retain the evidence and report the conflict.',
    options: { asyncReturnSessionId: true, turnIdempotencyKey: key,
      allowChatMessages: chatType === 'group', suppressFinalOutput: true },
  };
}
