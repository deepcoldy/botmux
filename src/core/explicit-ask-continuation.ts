import type { TriggerRequest } from '../services/trigger-types.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  /** Daemon-observed origin, never supplied as authority by the caller. */
  origin?: { turnId: string; dispatchAttempt?: number; workerGeneration?: number };
}

/** Consumed receipts only answer late reconnects of the same invocation. */
const CONSUMED_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => [key, orderedJson(field)]),
  );
  return value;
}

function sameExplicitInvocation(left: CreateAskInput, right: CreateAskInput): boolean {
  const { replyCardTarget: leftTarget, backendSurvivesRestart: leftBackend, ...leftIdentity } = left;
  const { replyCardTarget: rightTarget, backendSurvivesRestart: rightBackend, ...rightIdentity } = right;
  return JSON.stringify(orderedJson(leftIdentity)) === JSON.stringify(orderedJson(rightIdentity));
}

export async function waitForExplicitAskResult(
  body: Record<string, unknown> & { timeoutMs: number },
  post: (body: Record<string, unknown>) => Promise<AskResult>,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AskResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const reconnectDeadline = body.timeoutMs === 0 ? null : now() + body.timeoutMs + 60_000;
  while (true) {
    try { return await post(body); }
    catch (error) {
      if (!(error as { retryable?: boolean }).retryable
        || (reconnectDeadline !== null && now() >= reconnectDeadline)) throw error;
      await sleep(1000);
    }
  }
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
  shouldInvalidate?: (receipt: ExplicitAskReceipt) => boolean;
  invalidate?: (input: CreateAskInput, reason: string) => void;
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
  /** presentation 只影响首次发卡位置和点名；重连保持原始回执与冻结卡片授权。 */
  function wait(input: CreateAskInput & { requestId: string }, origin?: ExplicitAskReceipt['origin'],
    presentation?: Pick<CreateAskInput, 'cardRootMessageId' | 'mentionedOpenId'>): Promise<AskResult> {
    const key = keyFor(input);
    const original = read(key);
    if (original && !sameExplicitInvocation(original.input, input)) {
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
    if (!original) write(key, { version: 1, input, ...(origin ? { origin } : {}) });
    const frozenInput = original?.input ?? input;
    const promise = deps.register(original ? frozenInput : { ...frozenInput, ...presentation }).then(result => {
      const receipt = read(key)!;
      write(key, { ...receipt, result, settledAt: now() });
      deps.releaseHandoff?.(frozenInput);
      return result;
    }).finally(() => running.delete(key));
    running.set(key, promise);
    return promise;
  }
  function acknowledge(input: CreateAskInput & { requestId: string }, canAcknowledge?: (receipt: ExplicitAskReceipt) => boolean): AskResult | undefined {
    const key = keyFor(input);
    const receipt = read(key);
    if (!receipt?.result || !sameExplicitInvocation(receipt.input, input)) return undefined;
    // A stdout flush can succeed even after its tool caller ended. A stale
    // origin is not consumption; leave the receipt for same-session recovery.
    if (!canAcknowledge || canAcknowledge(receipt)) write(key, { ...receipt, acknowledged: true });
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
            || keyFor(receipt.input) !== key) continue;
          if (receipt.acknowledged || receipt.delivered) {
            if (now() - receipt.settledAt! >= CONSUMED_RECEIPT_RETENTION_MS) rmSync(pathFor(key), { force: true });
            continue;
          }
          if (!receipt.result) {
            if (receipt.input.timeoutMs === 0 && deps.shouldInvalidate?.(receipt) && deps.invalidate) {
              deps.invalidate(receipt.input, 'explicit Ask session closed or binding changed');
              void wait(receipt.input).catch(deps.onError);
              continue;
            }
            // Restore only existing, still-bound sessions. Never create a session
            // or revive a closed business task to recover an interaction.
            if (deps.canResume(receipt) && !running.has(key)) {
              void wait(receipt.input).catch(deps.onError);
            }
            continue;
          }
          // Allow the normal HTTP caller to emit stdout and acknowledge first.
          if (now() - receipt.settledAt! < 5000 || !deps.canResume(receipt)) continue;
          // Generic recovery creates a fresh turn without a document-comment
          // binding. Keep the receipt for the original caller to reconnect;
          // never continue a document task in an unbound turn.
          if (receipt.input.deliveryTarget || receipt.input.chatId.startsWith('doc:')) continue;
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

/** Whether the live session still owns an explicit Ask's routing binding. The
 * Ask is bound with root=null in a chat-scope session, whose record stores its
 * chat id as rootMessageId; comparing that raw field would treat every
 * chat-scope Ask as rebound. Recovery and no-deadline invalidation share this. */
export function explicitAskSessionBound(
  ask: Pick<CreateAskInput, 'larkAppId' | 'chatId' | 'rootMessageId'>,
  session: { larkAppId: string; chatId: string; session: { scope?: 'thread' | 'chat'; rootMessageId: string } } | undefined,
): boolean {
  return !!session && session.larkAppId === ask.larkAppId && session.chatId === ask.chatId
    && (session.session.scope === 'chat' ? null : session.session.rootMessageId) === ask.rootMessageId;
}

/** The daemon must compare against its live worker authority, not CLI stdout. */
export function explicitAskOriginIsLive(receipt: ExplicitAskReceipt, session: {
  workerAlive: boolean;
  workerGeneration?: number;
  turnId?: string;
  dispatchAttempt?: number;
  terminal?: boolean;
} | undefined): boolean {
  // Preserve the behaviour of receipts written before origin tracking existed.
  if (!receipt.origin) return true;
  return !!session && session.workerAlive
    && session.workerGeneration === receipt.origin.workerGeneration
    && session.turnId === receipt.origin.turnId
    && session.dispatchAttempt === receipt.origin.dispatchAttempt
    && !session.terminal;
}

/** Shared production builder: group-only chat permission must never leak into
 * private sessions. Recovery is a quiet append, never a new task or a steer. */
export function explicitAskRecoveryRequest(receipt: ExplicitAskReceipt, key: string, chatType?: 'group' | 'p2p'): TriggerRequest {
  if (receipt.input.deliveryTarget || receipt.input.chatId.startsWith('doc:')) {
    throw new Error('Document ask automatic recovery requires a bound document turn; reconnect to the original ask');
  }
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
