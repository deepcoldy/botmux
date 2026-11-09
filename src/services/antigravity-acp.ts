/** ACP transport for one Antigravity turn, retaining the exact native session across turns. */
import { StringDecoder } from 'node:string_decoder';
import { spawnOwnedModelProcess } from './constrained-invocation/native-process.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';

type JsonObject = Record<string, unknown>;

/** Runtime and immutable input passed to the native ACP process. */
export interface AntigravityAcpOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  content: string;
  nativeSessionId?: string;
  model?: string;
  effort?: string;
  logFile?: string;
  onSession: (id: string) => void;
  onText?: (text: string) => void;
  onTool?: (title: string) => void;
}

/** Accept only JSON objects at the protocol boundary. */
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Send a complete prompt over NDJSON; stop and reap only this owned process on failure or cancellation. */
export async function runAntigravityAcp(opts: AntigravityAcpOptions, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const env = { ...opts.env };
  applySessionOwnerEnv(env, opts.env.BOTMUX_OWNER_OPEN_ID);
  const child = spawnOwnedModelProcess(opts.executable, [
    'acp', '--stdio', '--dangerously-skip-permissions',
    ...(opts.logFile ? ['--log-file', opts.logFile] : []),
  ], { cwd: opts.cwd, env });
  const decoder = new StringDecoder('utf8');
  const pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  let sequence = 0;
  let buffer = '';
  let sessionId: string | undefined;
  let prompting = false;
  let closing = false;
  let failure: Error | undefined;
  let content = '';
  let contentBytes = 0;
  let toolSinceText = false;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));

  /** Reject every in-flight RPC exactly once without exposing provider stderr. */
  const fail = (error: Error): void => {
    failure ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
  };
  /** Write one protocol frame; stdout and stderr remain separate from terminal control. */
  const write = (message: JsonObject): void => {
    if (failure || closing || signal.aborted) throw failure ?? new Error('Antigravity ACP cancelled');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  /** Control operations have a deadline; prompt completion is cancelled by the caller. */
  const rpc = (method: string, params: JsonObject, timed = true): Promise<JsonObject> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = timed ? setTimeout(() => fail(new Error(`Antigravity ACP ${method} timed out`)), 30_000) : undefined;
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); }
      catch (error) { fail(error instanceof Error ? error : new Error('Antigravity ACP write failed')); }
    });
  };
  /** Validate session ownership before forwarding any native progress. */
  const receive = (message: unknown): void => {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Antigravity ACP invalid protocol');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        write({ id: message.id, error: { code: -32601, message: 'Client method unsupported' } });
        throw new Error(`Antigravity ACP requested unsupported client method: ${message.method}`);
      }
      if (message.method !== 'session/update' || !prompting) return;
      const params = message.params;
      if (!object(params) || params.sessionId !== sessionId || !object(params.update)) {
        throw new Error('Antigravity ACP session mismatch');
      }
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (!object(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') {
          throw new Error('Antigravity ACP invalid message');
        }
        if (toolSinceText) { content = ''; contentBytes = 0; }
        toolSinceText = false;
        content += update.content.text;
        contentBytes += Buffer.byteLength(update.content.text, 'utf8');
        if (contentBytes > 2 * 1024 * 1024) throw new Error('Antigravity ACP response exceeds limit');
        opts.onText?.(update.content.text);
      } else if (update.sessionUpdate === 'tool_call') {
        toolSinceText = true;
        opts.onTool?.(typeof update.title === 'string' ? update.title : 'tool');
      }
      return;
    }
    if (typeof message.id !== 'number') throw new Error('Antigravity ACP invalid response id');
    const request = pending.get(message.id);
    if (!request) throw new Error('Antigravity ACP unknown response id');
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (object(message.error)) request.reject(new Error(`Antigravity ACP request failed (${String(message.error.code)})`));
    else if (object(message.result)) request.resolve(message.result);
    else request.reject(new Error('Antigravity ACP invalid response'));
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (closing || failure) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > 4 * 1024 * 1024) { fail(new Error('Antigravity ACP frame exceeds limit')); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0 && !failure) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); }
      catch (error) { fail(error instanceof Error ? error : new Error('Antigravity ACP invalid JSON')); }
    }
  });
  child.stderr.resume();
  child.stdin.on('error', () => fail(new Error('Antigravity ACP input closed')));
  child.once('error', () => fail(new Error('Antigravity ACP spawn failed')));
  child.once('close', () => { if (!closing) fail(new Error('Antigravity ACP process exited')); });
  /** Cancellation is never retried as a new prompt. */
  const abort = (): void => {
    if (sessionId && prompting && !closing) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`);
    }
    fail(new Error('Antigravity ACP cancelled'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const initialized = await rpc('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'botmux', version: '1' },
    });
    if (initialized.protocolVersion !== 1) throw new Error('Antigravity ACP protocol version unsupported');
    if (opts.nativeSessionId && (!object(initialized.agentCapabilities) || initialized.agentCapabilities.loadSession !== true)) {
      throw new Error('Antigravity ACP exact session restore unsupported');
    }
    const control = await rpc(opts.nativeSessionId ? 'session/load' : 'session/new', {
      cwd: opts.cwd, mcpServers: [], ...(opts.nativeSessionId ? { sessionId: opts.nativeSessionId } : {}),
    });
    sessionId = opts.nativeSessionId ?? (typeof control.sessionId === 'string' ? control.sessionId : undefined);
    if (!sessionId || (control.sessionId !== undefined && control.sessionId !== sessionId)) {
      throw new Error('Antigravity ACP native session identity invalid');
    }
    opts.onSession(sessionId);
    // agy's CLI aliases include an effort suffix; ACP exposes those exact IDs
    // through models, while configOptions.model contains only base models.
    let modelApplied = false;
    if (opts.model && object(control.models) && Array.isArray(control.models.availableModels)
      && control.models.availableModels.some(model => object(model) && model.modelId === opts.model)) {
      await rpc('session/set_model', { sessionId, modelId: opts.model });
      modelApplied = true;
    }
    for (const [category, selected] of [['model', opts.model], ['thought_level', opts.effort]] as const) {
      if (!selected || (category === 'model' && modelApplied)) continue;
      const configs = Array.isArray(control.configOptions) ? control.configOptions.filter(object) : [];
      const config = configs.find(option => option.category === category || option.id === category);
      if (!config || typeof config.id !== 'string' || !Array.isArray(config.options)
        || !config.options.some(option => object(option) && option.value === selected)) {
        throw new Error(`Antigravity ACP configuration unavailable: ${category}`);
      }
      await rpc('session/set_config_option', { sessionId, configId: config.id, value: selected });
    }
    prompting = true;
    const result = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.content }] }, false);
    if (result.stopReason !== 'end_turn') throw new Error(`Antigravity ACP turn stopped: ${String(result.stopReason)}`);
    return content;
  } finally {
    closing = true;
    signal.removeEventListener('abort', abort);
    fail(new Error('Antigravity ACP closed'));
    child.stdin.end();
    /** Reap only the process group created by spawnOwnedModelProcess. */
    const kill = (kind: NodeJS.Signals): void => { if (child.pid) { try { process.kill(-child.pid, kind); } catch { /* Already exited. */ } } };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1_000);
    try { await closed; } finally {
      // The group leader can exit while a tool descendant ignores SIGTERM.
      // Its close event cannot retire cleanup of the rest of the owned group.
      kill('SIGKILL');
      clearTimeout(timer);
    }
  }
}
