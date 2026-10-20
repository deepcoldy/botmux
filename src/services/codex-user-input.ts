import { randomUUID } from 'node:crypto';
import type { AskResult, AskQuestion } from '../core/ask-types.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { loopbackFetch } from '../core/loopback-fetch.js';
import { readManagedOriginCapability } from '../core/managed-origin-capability.js';
import { findOnlineDaemon, resolveDaemonIpcPort } from '../utils/daemon-discovery.js';

export type CodexUserInputAnswer = { answers: Record<string, { answers: string[] }> };
export interface CodexUserInputContext {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId?: string | null;
  /** Botmux reply identity, not the app-server's native turn id. */
  originTurnId?: string;
  originDispatchAttempt?: number;
  env?: NodeJS.ProcessEnv;
}

/** Preserve the native batch and question ids. Unsupported questions must fail
 * the whole request, rather than silently dropping a question or answering it. */
export function parseCodexUserInputQuestions(params: unknown): Array<{ id: string; question: AskQuestion }> {
  const raw = params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>).questions : undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('requestUserInput has no questions');
  const ids = new Set<string>();
  return raw.map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`requestUserInput question ${index + 1} is malformed`);
    }
    const q = value as Record<string, unknown>;
    if (q.isSecret === true) throw new Error('requestUserInput secret questions cannot be sent to a chat card');
    const id = typeof q.id === 'string' && q.id ? q.id : `q${index}`;
    if (ids.has(id)) throw new Error('requestUserInput has duplicate question ids');
    ids.add(id);
    const prompt = typeof q.question === 'string' && q.question.trim() ? q.question
      : typeof q.header === 'string' && q.header.trim() ? q.header : `Question ${index + 1}`;
    if (q.options == null) {
      if (q.multiSelect === true) throw new Error('requestUserInput text questions cannot be multi-select');
      return { id, question: { prompt, inputMode: 'text' as const, multiSelect: false, options: [] } };
    }
    if (!Array.isArray(q.options) || q.options.length < 2) {
      throw new Error(`requestUserInput question ${index + 1} has fewer than two options`);
    }
    const labels = new Set<string>();
    const details: string[] = [];
    const options = q.options.map((option: unknown) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('requestUserInput has a malformed option');
      const o = option as Record<string, unknown>;
      if (typeof o.label !== 'string' || !o.label.trim()) throw new Error('requestUserInput has an invalid option label');
      if (labels.has(o.label)) throw new Error('requestUserInput has duplicate option labels');
      labels.add(o.label);
      if (typeof o.description === 'string' && o.description.trim()) details.push(`${o.label}: ${o.description}`);
      return { key: o.label, label: o.label };
    });
    // AskOption has no description field. Include native descriptions in the
    // question text so users see the tradeoffs before choosing a label.
    return { id, question: { prompt: [prompt, ...details].join('\n\n'), multiSelect: q.multiSelect === true, options } };
  });
}

export function codexUserInputAnswer(
  questions: ReturnType<typeof parseCodexUserInputQuestions>,
  result: AskResult,
): CodexUserInputAnswer {
  if (result.kind === 'invalidated' && result.failureCode === 'card_delivery_failed') {
    throw new Error(`Confirmation card could not be delivered: ${result.reason}`);
  }
  if (result.kind !== 'answered') {
    throw new Error(`ask not answered (${result.kind}${result.kind === 'invalidated' ? `: ${result.reason}` : ''})`);
  }
  if (!Array.isArray(result.answers) || result.answers.length !== questions.length) {
    throw new Error('ask returned an incomplete answer batch');
  }
  const comment = result.comment?.trim() ?? '';
  return { answers: Object.fromEntries(questions.map((entry, index) => {
    const selected = result.answers[index];
    if (!Array.isArray(selected) || selected.some(value => !entry.question.options.some(o => o.key === value))
      || new Set(selected).size !== selected.length || (!entry.question.multiSelect && selected.length > 1)) {
      throw new Error(`ask returned invalid answers for question ${index + 1}`);
    }
    const values = selected.length ? [...selected] : comment ? [comment] : [];
    if (!values.length && !entry.question.multiSelect) {
      throw new Error(`ask returned no answer for question ${index + 1}`);
    }
    return [entry.id, { answers: values }];
  })) };
}

/** Native App and RPC requests use the same existing daemon ask broker. The
 * authenticated daemon binds the real chat/thread and enforces answer access.
 * Aborting the long poll detaches its waiter and invalidates an abandoned card. */
export async function bridgeCodexUserInput(
  context: CodexUserInputContext,
  params: unknown,
  signal?: AbortSignal,
): Promise<CodexUserInputAnswer> {
  const questions = parseCodexUserInputQuestions(params);
  return codexUserInputAnswer(questions, await postCodexAsk(context, questions.map(q => q.question), signal));
}

/** Also used by nonblocking questions; the daemon owns answer admission. */
export async function postCodexAsk(
  context: CodexUserInputContext,
  questions: AskQuestion[],
  signal?: AbortSignal,
  asyncUserInput?: { threadId: string; itemId: string },
  asyncFailure?: 'limit' | 'invalid_questions',
): Promise<AskResult> {
  const env = context.env ?? process.env;
  if (env.BOTMUX_WORKFLOW === '1') {
    throw new Error('requestUserInput is unavailable inside workflow subagents; use workflow humanGate / decision nodes');
  }
  if (!context.sessionId || !context.larkAppId || !context.chatId) {
    throw new Error('requestUserInput requires a Botmux session with Lark transport');
  }
  signal?.throwIfAborted();
  const dataDir = resolveBotmuxDataDir({ env });
  const claim = readManagedOriginCapability(dataDir, context.sessionId,
    env.BOTMUX_SEND_RELAY, env.BOTMUX_ORIGIN_CHANNEL_ID);
  if (claim && context.originTurnId && claim.turnId !== context.originTurnId) {
    throw new Error('requestUserInput no longer belongs to the current Botmux turn');
  }
  if (!claim && (env.BOTMUX_SEND_RELAY || env.BOTMUX_ORIGIN_CHANNEL_ID)) {
    throw new Error('requestUserInput has no live session origin capability');
  }
  const port = resolveDaemonIpcPort(claim?.ipcPort ?? findOnlineDaemon(context.larkAppId, dataDir)?.ipcPort,
    env.BOTMUX_DAEMON_IPC_PORT);
  if (!port) throw new Error('requestUserInput daemon is offline');
  const timeoutMs = 3_600_000;
  const deadline = AbortSignal.timeout(timeoutMs + 5_000);
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    body: JSON.stringify({
      sessionId: context.sessionId, larkAppId: context.larkAppId, chatId: context.chatId,
      rootMessageId: context.rootMessageId?.startsWith('om_') ? context.rootMessageId : null,
      questions, timeoutMs,
      // A server request belongs to this process/turn. Do not reattach a card
      // from an older runner merely because its JSON-RPC id was reused.
      requestId: asyncUserInput?.itemId ?? randomUUID(),
      originKind: asyncUserInput ? 'native-user-input-async' : 'native-user-input',
      ...(asyncUserInput ? { asyncUserInput } : {}),
      ...(asyncFailure ? { asyncFailure } : {}),
      ...(claim ? { originCapability: claim.capability } : {}),
      ...((context.originTurnId ?? claim?.turnId) ? { originTurnId: context.originTurnId ?? claim?.turnId } : {}),
      ...((context.originDispatchAttempt ?? claim?.dispatchAttempt)
        ? { originDispatchAttempt: context.originDispatchAttempt ?? claim?.dispatchAttempt } : {}),
    }),
  } satisfies RequestInit;
  const response = claim
    ? await loopbackFetch(`http://127.0.0.1:${port}/api/asks`, init)
    : await fetchDaemonIpc(port, '/api/asks', init);
  if (!response.ok) {
    const text = await response.text();
    let failure: { error?: string; detail?: string } | undefined;
    try { failure = JSON.parse(text); } catch { /* Non-JSON daemon/proxy errors keep the HTTP fallback. */ }
    if (failure?.error === 'card_delivery_failed') {
      const detail = typeof failure.detail === 'string' ? failure.detail.slice(0, 200) : 'recipient unavailable';
      throw new Error(`Confirmation card could not be delivered: ${detail}`);
    }
    throw new Error(`ask broker HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const result = await response.json() as AskResult;
  signal?.throwIfAborted();
  return result;
}
