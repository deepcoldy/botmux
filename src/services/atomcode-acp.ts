import { spawnOwnedModelProcess } from './constrained-invocation/native-process.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';

type Json = Record<string, any>;

export const ATOMCODE_FINAL_MAX_BYTES = 8_000_000;
const MAX_FRAME_BYTES = 8_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_REQUEST_TIMEOUT_MS = 3_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 1_500;

export interface AtomcodeAcpOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  content: string;
  nativeSessionId?: string;
  model?: string;
  effort?: string;
  permission: 'full' | 'smart';
  onSession?: (sessionId: string) => void;
  onUpdate?: (update: Json) => void;
  onUserInput: (
    method: 'elicitation/create' | 'session/request_permission',
    params: Json,
    signal: AbortSignal,
  ) => Promise<unknown>;
  onInteractionPending?: (waiting: boolean) => void;
}

export interface AtomcodeAcpResult {
  sessionId: string;
  content: string;
}

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Split NDJSON lines by byte delimiter so multi-byte UTF-8 characters can span reads. */
export function createAtomcodeFrameReader(onLine: (line: string) => void | boolean) {
  let frameBytes = 0;
  let fragments: Buffer[] = [];
  return (chunk: Buffer): void => {
    for (let start = 0; start < chunk.length;) {
      const end = chunk.indexOf(0x0a, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      frameBytes += part.length;
      if (frameBytes > MAX_FRAME_BYTES) throw new Error('atomcode_acp_frame_limit');
      if (part.length) fragments.push(part);
      if (end < 0) return;
      const line = Buffer.concat(fragments, frameBytes).toString('utf8');
      fragments = [];
      frameBytes = 0;
      start = end + 1;
      if (line.trim() && onLine(line) === false) return;
    }
  };
}

/** Wire client for AtomCode's ACP v1 NDJSON stdio server. One owned process per
 *  Botmux turn; session/resume continues persisted native sessions, and clean
 *  session/close + stdin EOF releases the native session lease before exit. */
export async function runAtomcodeAcp(
  opts: AtomcodeAcpOptions,
  signal: AbortSignal,
): Promise<AtomcodeAcpResult> {
  signal.throwIfAborted();
  const env = { ...opts.env };
  applySessionOwnerEnv(env, opts.env.BOTMUX_OWNER_OPEN_ID);
  // Global flags precede `acp`; --model is intentionally applied via session/set_config_option
  // below so logical model IDs switch both owning account and wire model.
  const cliArgs = [
    '--no-telemetry',
    ...(opts.permission === 'full' ? ['--dangerously-skip-permissions'] : []),
    'acp',
  ];
  const child = spawnOwnedModelProcess(opts.executable, cliArgs, { cwd: opts.cwd, env });
  const lifetime = new AbortController();
  const inputSignal = AbortSignal.any([signal, lifetime.signal]);
  let sessionId: string | undefined;
  let prompting = false;
  let success = false;
  let closing = false;
  let failure: Error | undefined;
  let nextId = 1;
  let content = '';
  let contentBytes = 0;
  let messageId: string | undefined;
  let nextMessage = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      method: string;
      resolve: (value: Json) => void;
      reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  const incoming = new Set<number | string>();
  let childExited = false;
  const exited = new Promise<void>(resolve => {
    child.once('close', () => {
      childExited = true;
      resolve();
    });
  });
  const kill = (sig: NodeJS.Signals) => {
    if (!child.pid || childExited) return;
    try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
  };
  const rejectPending = (error: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
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
    if (failure || closing || inputSignal.aborted) {
      throw failure ?? new Error('atomcode_acp_closed');
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (
    method: string,
    params: Json,
    timeoutMs: number | false = REQUEST_TIMEOUT_MS,
  ): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = timeoutMs === false
        ? undefined
        : setTimeout(() => fail(new Error(`atomcode ACP ${method} 超时`)), timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        fail(error instanceof Error ? error : new Error('atomcode_acp_write_failed'));
      }
    });

  const handle = (message: unknown) => {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      throw new Error('atomcode_acp_protocol_invalid');
    }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if ((typeof message.id !== 'string' && typeof message.id !== 'number') || incoming.has(message.id)) {
          throw new Error('atomcode_acp_request_invalid');
        }
        const id = message.id;
        const params = message.params;
        if (!prompting || !sessionId || !isObject(params) || params.sessionId !== sessionId) {
          throw new Error('atomcode_acp_question_session_mismatch');
        }
        if (message.method !== 'elicitation/create' && message.method !== 'session/request_permission') {
          write({ id, error: { code: -32601, message: 'Client method not supported' } });
          return;
        }
        if (incoming.size >= 8) throw new Error('atomcode_acp_too_many_questions');
        incoming.add(id);
        if (incoming.size === 1) opts.onInteractionPending?.(true);
        const method = message.method;
        void Promise.resolve()
          .then(() => opts.onUserInput(method, params, inputSignal))
          .then(result => {
            if (inputSignal.aborted || failure || closing || !prompting) return;
            write({ id, result });
          }, error => {
            fail(error instanceof Error ? error : new Error('atomcode_acp_user_input_failed'));
          })
          .finally(() => {
            incoming.delete(id);
            if (!incoming.size) opts.onInteractionPending?.(false);
          })
          .catch(error => fail(error instanceof Error ? error : new Error('atomcode_acp_user_input_failed')));
        return;
      }
      if (message.method !== 'session/update') return;
      const params = message.params;
      if (!isObject(params) || params.sessionId !== sessionId || !isObject(params.update)) {
        if (!prompting) return;
        throw new Error('atomcode_acp_update_session_mismatch');
      }
      if (!prompting) return;
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') {
          throw new Error('atomcode_acp_message_invalid');
        }
        const id = typeof update.messageId === 'string' ? update.messageId : undefined;
        // AtomCode advances messageId after each LLM round/Usage; reset so pre-tool prose stays out of the final reply.
        if ((id && id !== messageId) || (!id && nextMessage)) {
          content = '';
          contentBytes = 0;
        }
        messageId = id;
        nextMessage = false;
        contentBytes += Buffer.byteLength(update.content.text);
        if (contentBytes > ATOMCODE_FINAL_MAX_BYTES) throw new Error('atomcode_acp_content_limit');
        content += update.content.text;
      } else if (update.sessionUpdate === 'tool_call') {
        nextMessage = true;
      }
      opts.onUpdate?.(update);
      return;
    }
    if (typeof message.id !== 'number' || !pending.has(message.id)) {
      throw new Error('atomcode_acp_response_unknown');
    }
    const entry = pending.get(message.id)!;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (isObject(message.error)) {
      const detail = typeof message.error.data === 'string' && message.error.data
        ? `${message.error.message ?? 'request failed'}: ${message.error.data}`
        : typeof message.error.message === 'string'
          ? message.error.message
          : 'request failed';
      entry.reject(new Error(`atomcode ACP: ${detail}`));
    } else if (isObject(message.result)) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error('atomcode_acp_result_invalid'));
    }
  };

  const readFrames = createAtomcodeFrameReader(line => {
    handle(JSON.parse(line));
    return !failure && !closing;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure || closing) return;
    try {
      readFrames(chunk);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('atomcode_acp_protocol_invalid'));
    }
  });
  // Drain stderr without retaining it so verbose tool diagnostics cannot exhaust memory or block the pipe.
  child.stderr.resume();
  child.stdin.on('error', () => fail(new Error('atomcode_acp_transport_closed')));
  child.on('error', () => fail(new Error('atomcode_acp_spawn_failed')));
  child.once('close', () => {
    if (!closing) fail(new Error('atomcode_acp_process_exited'));
  });

  const abort = () => {
    if (sessionId && prompting && !failure && !closing) {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`);
      } catch { /* process teardown follows */ }
    }
    fail(new Error('atomcode_acp_aborted'));
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    if (signal.aborted) abort();
    const init = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'botmux', version: '1' },
      clientCapabilities: { elicitation: { form: {} } },
    });
    if (init.protocolVersion !== 1) throw new Error('atomcode_acp_version_unsupported');

    let control: Json;
    if (opts.nativeSessionId) {
      sessionId = opts.nativeSessionId;
      const canResume = isObject(init.agentCapabilities?.sessionCapabilities?.resume);
      const canLoad = init.agentCapabilities?.loadSession === true;
      if (!canResume && !canLoad) throw new Error('atomcode_acp_resume_unsupported');
      const method = canResume ? 'session/resume' : 'session/load';
      control = await request(method, { sessionId, cwd: opts.cwd, mcpServers: [] });
      if (control.sessionId !== undefined && control.sessionId !== sessionId) {
        throw new Error('atomcode_acp_resume_mismatch');
      }
    } else {
      control = await request('session/new', { cwd: opts.cwd, mcpServers: [] });
      if (typeof control.sessionId !== 'string' || !control.sessionId) {
        throw new Error('atomcode_acp_session_invalid');
      }
      sessionId = control.sessionId;
    }
    opts.onSession?.(sessionId!);

    const configure = async (configId: string, value: string) => {
      const option = Array.isArray(control.configOptions)
        ? control.configOptions.find((entry: Json) => entry.id === configId)
        : undefined;
      if (!option || !Array.isArray(option.options) || !option.options.some((entry: Json) => entry.value === value)) {
        throw new Error(`atomcode ACP 不支持配置 ${configId}=${value}`);
      }
      if (option.currentValue !== value) {
        control = await request('session/set_config_option', { sessionId, configId, value });
      }
    };

    const desiredMode = opts.permission === 'full' ? 'bypass' : 'build';
    await configure('mode', desiredMode);
    if (opts.model?.trim()) {
      await configure('model', opts.model.trim());
    }
    if (opts.effort?.trim()) {
      await configure('reasoning_effort', opts.effort.trim());
    }

    prompting = true;
    const result = await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: opts.content }] },
      false,
    );
    if (incoming.size || failure || inputSignal.aborted) {
      throw failure ?? new Error('atomcode_acp_question_incomplete');
    }
    if (result.stopReason !== 'end_turn') {
      throw new Error(`atomcode ACP 执行未完成：${result.stopReason ?? 'unknown'}`);
    }
    prompting = false;
    success = true;
    // Close the live session before EOF so AtomCode releases the native session
    // lease immediately before the next turn's session/resume.
    if (isObject(init.agentCapabilities?.sessionCapabilities?.close)) {
      await request('session/close', { sessionId }, CLOSE_REQUEST_TIMEOUT_MS).catch(() => {});
    }
    return { sessionId: sessionId!, content };
  } finally {
    signal.removeEventListener('abort', abort);
    closing = true;
    lifetime.abort();
    rejectPending(new Error('atomcode_acp_closed'));
    if (success) {
      // Allow shutdown_sessions() to commit state and drop the disk lease before SIGTERM.
      try { child.stdin.end(); } catch { /* ignore */ }
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>(resolve => {
          graceTimer = setTimeout(resolve, GRACEFUL_EXIT_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(graceTimer);
    }
    if (!childExited) {
      kill('SIGTERM');
      hardKill ??= setTimeout(() => kill('SIGKILL'), 1000);
    }
    await exited;
    clearTimeout(hardKill);
  }
}
