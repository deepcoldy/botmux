import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { spawnOwnedModelProcess } from './constrained-invocation/native-process.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';
import { readMinimaxUsage } from './minimax-usage.js';
import { minimaxDataDir } from './minimax-paths.js';
import type { McodeExecOptions, McodeExecResult } from './mcode-exec.js';
import { minimaxQuestionnaireCursor, pendingMinimaxQuestionnaires, readMinimaxContinuation } from './minimax-acp-continuation.js';
import { setTimeout as delay } from 'node:timers/promises';

type Json = Record<string, any>;
export interface MinimaxAcpOptions extends Omit<McodeExecOptions, 'onEvent'> {
  onSession?: (sessionId: string) => void;
  onUpdate?: (update: Json) => void;
  onUserInput: (method: 'elicitation/create' | 'session/request_permission', params: Json, signal: AbortSignal) => Promise<unknown>;
  onInteractionPending?: (waiting: boolean) => void;
}

const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** Wire client for mcode's ACP v1 NDJSON surface, with no new SDK dependency.
 * One owned process per Botmux turn; exact native session/resume preserves the
 * existing runner's queue and restart semantics. Model-only invocations keep
 * their separate exec surface. No fallback from a failed human question. */
export async function runMinimaxAcp(opts: MinimaxAcpOptions, signal: AbortSignal): Promise<McodeExecResult> {
  signal.throwIfAborted();
  const env = { ...opts.env };
  applySessionOwnerEnv(env, opts.env.BOTMUX_OWNER_OPEN_ID);
  const child = spawnOwnedModelProcess(opts.executable, ['acp'], { cwd: opts.cwd, env });
  const lifetime = new AbortController();
  const inputSignal = AbortSignal.any([signal, lifetime.signal]);
  let sessionId: string | undefined;
  let prompting = false;
  let nativeRuntime = false;
  let success = false;
  let closing = false;
  let failure: Error | undefined;
  let nextId = 1;
  let bytes = 0;
  let buffer = '';
  let content = '';
  let messageId: string | undefined;
  let nextMessage = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder('utf8');
  const pending = new Map<number, { method: string; resolve: (value: Json) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  const incoming = new Set<number | string>();
  const nativeQuestions = new Set<string>();
  let questionnaireCursor: number | undefined;
  const dbPath = join(minimaxDataDir(env), 'v2', 'sqlite', 'runtime-state.sqlite');
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const kill = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
  };
  const rejectPending = (error: Error) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  const fail = (error: Error) => {
    if (closing) return;
    failure ??= error;
    lifetime.abort(error);
    rejectPending(failure);
    kill('SIGTERM');
    hardKill ??= setTimeout(() => kill('SIGKILL'), 1000);
  };
  const write = (message: Json) => {
    if (failure || closing || inputSignal.aborted) throw failure ?? new Error('mcode_acp_closed');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (method: string, params: Json, timed = true): Promise<Json> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = timed ? setTimeout(() => fail(new Error(`mcode ACP ${method} 超时`)), 30_000) : undefined;
    pending.set(id, { method, resolve, reject, timer });
    try { write({ id, method, params }); } catch (error) { fail(error instanceof Error ? error : new Error('mcode_acp_write_failed')); }
  });
  const handle = (message: unknown) => {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error('mcode_acp_protocol_invalid');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if ((typeof message.id !== 'string' && typeof message.id !== 'number') || incoming.has(message.id)) throw new Error('mcode_acp_request_invalid');
        const id = message.id;
        const params = message.params;
        if (!prompting || !sessionId || !object(params) || params.sessionId !== sessionId) throw new Error('mcode_acp_question_session_mismatch');
        if (!['elicitation/create', 'session/request_permission'].includes(message.method)) {
          write({ id, error: { code: -32601, message: 'Client method not supported' } });
          return;
        }
        if (incoming.size >= 8) throw new Error('mcode_acp_too_many_questions');
        incoming.add(id);
        if (message.method === 'elicitation/create') {
          if (nativeRuntime && questionnaireCursor === undefined) throw new Error('mcode ACP 本轮问卷启动边界不可读');
          const questions = pendingMinimaxQuestionnaires(dbPath, sessionId, questionnaireCursor, nativeRuntime);
          if (nativeRuntime && !questions.length) throw new Error('mcode ACP 缺少本轮原生问卷记录');
          for (const requestId of questions) nativeQuestions.add(requestId);
          if (nativeQuestions.size > 32) throw new Error('mcode_acp_too_many_native_questions');
        }
        if (incoming.size === 1) opts.onInteractionPending?.(true);
        void Promise.resolve().then(() => opts.onUserInput(message.method, params, inputSignal)).then(result => {
          if (inputSignal.aborted || failure || closing || !prompting) return;
          write({ id, result });
        }, error => {
          // A failed/missing human answer must stop the turn. mcode may fall
          // back to a permission picker after an RPC error; never answer empty.
          fail(error instanceof Error ? error : new Error('mcode_acp_user_input_failed'));
        }).finally(() => {
          incoming.delete(id);
          if (!incoming.size) opts.onInteractionPending?.(false);
        }).catch(error => fail(error instanceof Error ? error : new Error('mcode_acp_user_input_failed')));
        return;
      }
      if (message.method !== 'session/update') return;
      const params = message.params;
      if (!object(params) || params.sessionId !== sessionId || !object(params.update)) {
        // session/load may replay history before its response. Ignore only
        // pre-prompt projections; an active foreign session is never accepted.
        if (!prompting) return;
        throw new Error('mcode_acp_update_session_mismatch');
      }
      if (!prompting) return;
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('mcode_acp_message_invalid');
        const id = typeof update.messageId === 'string' ? update.messageId : undefined;
        if ((id && id !== messageId) || (!id && nextMessage)) content = '';
        messageId = id; nextMessage = false;
        content += update.content.text;
      } else if (update.sessionUpdate === 'tool_call') nextMessage = true;
      // Thoughts/raw tool inputs are never copied into the public reply.
      opts.onUpdate?.(update);
      return;
    }
    if (typeof message.id !== 'number' || !pending.has(message.id)) throw new Error('mcode_acp_response_unknown');
    const p = pending.get(message.id)!;
    pending.delete(message.id); clearTimeout(p.timer);
    if (object(message.error)) p.reject(new Error(`mcode ACP: ${typeof message.error.message === 'string' ? message.error.message : 'request failed'}`));
    else if (object(message.result)) p.resolve(message.result);
    else p.reject(new Error('mcode_acp_result_invalid'));
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure || closing) return;
    bytes += chunk.length;
    if (bytes > 8_000_000) { fail(new Error('mcode_acp_output_limit')); return; }
    buffer += decoder.write(chunk);
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0 && !failure) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { handle(JSON.parse(line)); } catch (error) { fail(error instanceof Error ? error : new Error('mcode_acp_protocol_invalid')); }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8_000_000) fail(new Error('mcode_acp_output_limit')); });
  child.stdin.on('error', () => fail(new Error('mcode_acp_transport_closed')));
  child.on('error', () => fail(new Error('mcode_acp_spawn_failed')));
  child.once('close', () => { if (!closing) fail(new Error('mcode_acp_process_exited')); });
  const abort = () => {
    if (sessionId && prompting && !failure && !closing) {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`); } catch { /* process group below */ }
    }
    fail(new Error('mcode_acp_aborted'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    const init = await request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'botmux', version: '1' }, clientCapabilities: { elicitation: { form: {} } } });
    if (init.protocolVersion !== 1) throw new Error('mcode_acp_version_unsupported');
    nativeRuntime = init.agentInfo?.name === 'minimax-code';
    let control: Json;
    if (opts.nativeSessionId) {
      sessionId = opts.nativeSessionId;
      if (!init.agentCapabilities?.loadSession) throw new Error('mcode_acp_resume_unsupported');
      const method = object(init.agentCapabilities?.sessionCapabilities?.resume) ? 'session/resume' : 'session/load';
      control = await request(method, { sessionId, cwd: opts.cwd, mcpServers: [] });
      if (control.sessionId !== undefined && control.sessionId !== sessionId) throw new Error('mcode_acp_resume_mismatch');
    } else {
      control = await request('session/new', { cwd: opts.cwd, mcpServers: [] });
      if (typeof control.sessionId !== 'string' || !control.sessionId) throw new Error('mcode_acp_session_invalid');
      sessionId = control.sessionId;
    }
    opts.onSession?.(sessionId!);
    const configure = async (configId: string, value: string) => {
      const option = Array.isArray(control.configOptions) ? control.configOptions.find((o: Json) => o.id === configId) : undefined;
      if (!option || !Array.isArray(option.options) || !option.options.some((o: Json) => o.value === value)) throw new Error(`mcode ACP 不支持配置 ${configId}=${value}`);
      if (option.currentValue !== value) control = await request('session/set_config_option', { sessionId, configId, value });
    };
    await configure('permissionMode', opts.permission === 'full' ? 'bypassPermissions' : 'auto');
    if (opts.model) {
      const hash = opts.model.indexOf('#');
      const model = hash < 0 ? opts.model : opts.model.slice(0, hash);
      const variant = hash < 0 ? undefined : opts.model.slice(hash + 1);
      if (variant === '') throw new Error('mcode_acp_model_invalid');
      const slash = model.indexOf('/');
      if (slash < 1 || slash === model.length - 1) throw new Error('mcode_acp_model_invalid');
      const prefix = `m:${encodeURIComponent(model.slice(0, slash))}:${encodeURIComponent(model.slice(slash + 1))}:`;
      const option = control.configOptions?.find((o: Json) => o.id === 'model');
      const candidates = option?.options?.filter((o: Json) => typeof o.value === 'string' && o.value.startsWith(prefix));
      const selected = variant !== undefined
        ? candidates?.find((o: Json) => o.value === `${prefix}v:${encodeURIComponent(variant)}`)
        : candidates?.find((o: Json) => o.value === option.currentValue)
          ?? candidates?.find((o: Json) => o.value.endsWith(':thinking')) ?? candidates?.[0];
      if (!selected) throw new Error('mcode_acp_model_unavailable');
      await configure('model', selected.value);
    }
    if (opts.effort) await configure('thinkingEffort', opts.effort);
    const before = readMinimaxUsage(dbPath, sessionId!, true)?.tokens;
    questionnaireCursor = minimaxQuestionnaireCursor(dbPath, sessionId!);
    prompting = true;
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.content }] }, false);
    if (incoming.size || failure || inputSignal.aborted) throw failure ?? new Error('mcode_acp_question_incomplete');
    if (result.stopReason !== 'end_turn') throw new Error(`mcode ACP 执行未完成：${result.stopReason ?? 'unknown'}`);
    if (nativeQuestions.size) {
      for (;;) {
        inputSignal.throwIfAborted();
        const continuation = readMinimaxContinuation(dbPath, sessionId!, nativeQuestions, questionnaireCursor);
        if (continuation.state === 'completed' && !incoming.size) {
          if (content !== continuation.content) opts.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: continuation.content } });
          content = continuation.content;
          break;
        }
        await delay(100, undefined, { signal: inputSignal });
      }
    }
    prompting = false;
    const after = readMinimaxUsage(dbPath, sessionId!, true)?.tokens;
    const delta = after && (before || !opts.nativeSessionId) ? { inputTokens: after.inputTokens - (before?.inputTokens ?? 0),
      outputTokens: after.outputTokens - (before?.outputTokens ?? 0),
      cacheReadTokens: (after.cacheReadTokens ?? 0) - (before?.cacheReadTokens ?? 0),
      cacheCreateTokens: (after.cacheCreateTokens ?? 0) - (before?.cacheCreateTokens ?? 0) } : undefined;
    const usage = delta && Object.values(delta).every(n => Number.isSafeInteger(n) && n >= 0) ? delta : undefined;
    success = true;
    return { sessionId: sessionId!, content, ...(usage ? { usage } : {}) };
  } finally {
    signal.removeEventListener('abort', abort);
    closing = true;
    lifetime.abort();
    rejectPending(new Error('mcode_acp_closed'));
    // Closing this transport detaches ACP, not the persisted native session.
    // The owned process group also reaps tools and its owner-death guard.
    if (success) child.stdin.end();
    kill('SIGTERM');
    hardKill ??= setTimeout(() => kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(hardKill);
  }
}
