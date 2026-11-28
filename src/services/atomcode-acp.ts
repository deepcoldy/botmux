import { spawnOwnedModelProcess } from './constrained-invocation/native-process.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';

type Json = Record<string, any>;

export const ATOMCODE_FINAL_MAX_BYTES = 8_000_000;
// Per-line NDJSON cap measured on the WIRE bytes of one JSON-RPC message. The
// decoded-content cap above counts raw UTF-8 text, but a wire line also carries
// the JSON-RPC envelope and string escaping. The worst expansion is a control
// character (U+0000–U+001F): one UTF-8 byte of text serializes to a six-byte
// `\u0000` escape, so derive the line cap from the content cap at that
// ratio plus envelope slack. This guarantees any reply within the decoded cap
// passes the frame reader regardless of escaping, while the frame cap stays a
// backstop against a runaway single line; the decoded cap still bounds retained content.
const MAX_JSON_STRING_ESCAPE_RATIO = 6;
const MAX_FRAME_BYTES = ATOMCODE_FINAL_MAX_BYTES * MAX_JSON_STRING_ESCAPE_RATIO + 4096;
const REQUEST_TIMEOUT_MS = 30_000;
// Slightly above AtomCode's own 5s stop_and_wait bound so graceful session/close
// is not truncated before the runtime commits state and drops its .lease lock.
const CLOSE_REQUEST_TIMEOUT_MS = 6_000;
// Brief cooperative window after `session/cancel` so AtomCode can drop its
// `setsid()` bash tool children before we SIGTERM the ACP process group.
const CANCEL_GRACE_TIMEOUT_MS = 1_500;
const GRACEFUL_EXIT_TIMEOUT_MS = 1_500;
const DEFAULT_ATOMCODE_IDLE_RELEASE_MS = 120_000;

export type AtomcodeUserInputHandler = (
  method: 'elicitation/create' | 'session/request_permission',
  params: Json,
  signal: AbortSignal,
) => Promise<unknown>;

export interface AtomcodeAcpTurnOptions {
  content: string;
  onUpdate?: (update: Json) => void;
  onUserInput: AtomcodeUserInputHandler;
  onInteractionPending?: (waiting: boolean) => void;
}

export interface AtomcodeAcpSessionOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeSessionId?: string;
  model?: string;
  effort?: string;
  permission: 'full' | 'smart';
  /** Release an idle ACP child and its session lease after this many ms.
   *  Defaults to 120_000ms; 0 closes after every turn. */
  idleTimeoutMs?: number;
  onSession?: (sessionId: string) => void;
}

export interface AtomcodeAcpResult {
  sessionId: string;
  content: string;
}

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Parse an optional --idle-timeout-ms value: 0 disables reuse, positive ints
 *  set the idle lease-release window in ms. */
export function parseAtomcodeIdleTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ATOMCODE_IDLE_RELEASE_MS;
  if (!/^\d+$/.test(raw)) throw new Error('invalid_atomcode_idle_timeout');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new Error('invalid_atomcode_idle_timeout');
  }
  return parsed;
}

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

interface PendingRpc {
  method: string;
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Per-turn state allocated fresh on every `prompt()` call so message buffers,
 *  in-flight human interactions, and cancellation signals never leak across
 *  consecutive turns sharing one persistent ACP connection. */
interface ActiveTurnState {
  turnLifetime: AbortController;
  inputSignal: AbortSignal;
  aborted: boolean;
  closed: boolean;
  interactionPending: boolean;
  content: string;
  contentBytes: number;
  messageId?: string;
  nextMessage: boolean;
  incoming: Set<number | string>;
  onUpdate?: (update: Json) => void;
  onUserInput: AtomcodeUserInputHandler;
  onInteractionPending?: (waiting: boolean) => void;
}

interface OpenConnectionOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeSessionId?: string;
  model?: string;
  effort?: string;
  permission: 'full' | 'smart';
  onSession?: (sessionId: string) => void;
  onDisconnected?: () => void;
}

/** Race a wait against caller abort without cancelling the underlying promise,
 *  so an in-flight teardown still finishes releasing its OS `.lease` lock. */
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('atomcode_acp_aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('atomcode_acp_aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Single owned `atomcode acp` subprocess holding one initialized, configured
 *  ACP session. Reusable across consecutive turns while healthy; torn down
 *  cleanly via `session/close` + stdin EOF on idle release or forcefully reaped
 *  as a process group on any abort or protocol failure. */
class AtomcodeAcpConnection {
  private readonly child: ReturnType<typeof spawnOwnedModelProcess>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<number, PendingRpc>();
  private readonly exited: Promise<void>;
  private readonly onDisconnected?: () => void;

  private sessionId = '';
  private canClose = false;
  private nextId = 1;
  private childExited = false;
  // Separate close intent from wire shutdown: closingRequested blocks new turn
  // reuse immediately while wireClosed stays false until session/close receives its reply.
  private closingRequested = false;
  private wireClosed = false;
  private failure?: Error;
  private hardKill?: ReturnType<typeof setTimeout>;
  private cancelGraceWait?: () => void;
  private activeTurn?: ActiveTurnState;
  private closedPromise?: Promise<void>;

  private constructor(opts: OpenConnectionOptions) {
    const env = { ...opts.env };
    applySessionOwnerEnv(env, opts.env.BOTMUX_OWNER_OPEN_ID);
    // Global flags precede `acp`; --model is intentionally applied via session/set_config_option
    // below so logical model IDs switch both owning account and wire model.
    const cliArgs = [
      '--no-telemetry',
      ...(opts.permission === 'full' ? ['--dangerously-skip-permissions'] : []),
      'acp',
    ];
    this.child = spawnOwnedModelProcess(opts.executable, cliArgs, { cwd: opts.cwd, env });
    this.onDisconnected = opts.onDisconnected;
    this.exited = new Promise<void>(resolve => {
      this.child.once('close', () => {
        this.childExited = true;
        resolve();
      });
    });

    const readFrames = createAtomcodeFrameReader(line => {
      this.handleMessage(JSON.parse(line));
      return !this.failure && !this.wireClosed;
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failure || this.wireClosed) return;
      try {
        readFrames(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('atomcode_acp_protocol_invalid'));
      }
    });
    // Drain stderr without retaining it so verbose tool diagnostics cannot exhaust memory or block the pipe.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('atomcode_acp_transport_closed')));
    this.child.on('error', () => this.fail(new Error('atomcode_acp_spawn_failed')));
    // While idle, detach immediately on 'exit' rather than waiting for stdio 'close'
    // (which can lag a tick or stall if a grandchild still holds a pipe open).
    this.child.once('exit', () => {
      if (!this.activeTurn && !this.wireClosed) this.fail(new Error('atomcode_acp_process_exited'));
    });
    this.child.once('close', () => {
      if (!this.wireClosed) this.fail(new Error('atomcode_acp_process_exited'));
    });
  }

  /** Spawn an owned `atomcode acp` process, complete the v1 handshake, bind
   *  or resume the native session, and apply mode/model/effort config options.
   *  Detaches the caller's abort listener once open so Turn 1's signal never
   *  stays pinned to a long-lived connection; any failure reaps the child. */
  static async open(
    opts: OpenConnectionOptions,
    signal: AbortSignal,
  ): Promise<AtomcodeAcpConnection> {
    signal.throwIfAborted();
    const conn = new AtomcodeAcpConnection(opts);
    const onOpenAbort = () => conn.fail(new Error('atomcode_acp_aborted'));
    signal.addEventListener('abort', onOpenAbort, { once: true });
    try {
      if (signal.aborted) onOpenAbort();
      const init = await conn.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'botmux', version: '1' },
        clientCapabilities: { elicitation: { form: {} } },
      });
      if (init.protocolVersion !== 1) throw new Error('atomcode_acp_version_unsupported');
      conn.canClose = isObject(init.agentCapabilities?.sessionCapabilities?.close);

      let control: Json;
      if (opts.nativeSessionId) {
        conn.sessionId = opts.nativeSessionId;
        const canResume = isObject(init.agentCapabilities?.sessionCapabilities?.resume);
        const canLoad = init.agentCapabilities?.loadSession === true;
        if (!canResume && !canLoad) throw new Error('atomcode_acp_resume_unsupported');
        const method = canResume ? 'session/resume' : 'session/load';
        control = await conn.request(method, {
          sessionId: conn.sessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
        if (control.sessionId !== undefined && control.sessionId !== conn.sessionId) {
          throw new Error('atomcode_acp_resume_mismatch');
        }
      } else {
        control = await conn.request('session/new', { cwd: opts.cwd, mcpServers: [] });
        if (typeof control.sessionId !== 'string' || !control.sessionId) {
          throw new Error('atomcode_acp_session_invalid');
        }
        conn.sessionId = control.sessionId;
      }
      opts.onSession?.(conn.sessionId);

      const configure = async (configId: string, value: string) => {
        const option = Array.isArray(control.configOptions)
          ? control.configOptions.find((entry: Json) => entry.id === configId)
          : undefined;
        if (!option || !Array.isArray(option.options) || !option.options.some((entry: Json) => entry.value === value)) {
          throw new Error(`atomcode ACP 不支持配置 ${configId}=${value}`);
        }
        if (option.currentValue !== value) {
          control = await conn.request('session/set_config_option', {
            sessionId: conn.sessionId,
            configId,
            value,
          });
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
      return conn;
    } catch (error) {
      await conn.close(false);
      throw error;
    } finally {
      signal.removeEventListener('abort', onOpenAbort);
    }
  }

  isReusable(): boolean {
    return !this.failure
      && !this.closingRequested
      && !this.wireClosed
      && !this.childExited
      && !this.activeTurn
      && this.child.exitCode === null
      && this.child.signalCode === null
      && !this.child.stdin.destroyed
      && !this.child.stdin.writableEnded;
  }

  /** Execute a single `session/prompt` turn on this live connection. Leaves
   *  the connection warm on `end_turn`; any error, abort, or non-`end_turn`
   *  stop reason tears down the entire process group so neither wire framing
   *  nor child tool processes can poison subsequent turns. */
  async prompt(turn: AtomcodeAcpTurnOptions, signal: AbortSignal): Promise<AtomcodeAcpResult> {
    signal.throwIfAborted();
    if (!this.isReusable()) {
      throw this.failure ?? new Error('atomcode_acp_closed');
    }

    const turnLifetime = new AbortController();
    const inputSignal = AbortSignal.any([signal, turnLifetime.signal, this.lifetime.signal]);
    const state: ActiveTurnState = {
      turnLifetime,
      inputSignal,
      aborted: false,
      closed: false,
      interactionPending: false,
      content: '',
      contentBytes: 0,
      messageId: undefined,
      nextMessage: false,
      incoming: new Set<number | string>(),
      onUpdate: turn.onUpdate,
      onUserInput: turn.onUserInput,
      onInteractionPending: turn.onInteractionPending,
    };
    this.activeTurn = state;

    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const onTurnAbort = () => {
      if (state.aborted) return;
      state.aborted = true;
      turnLifetime.abort(new Error('atomcode_acp_aborted'));
      if (this.sessionId && this.activeTurn === state && !this.failure && !this.wireClosed) {
        try {
          this.child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId: this.sessionId },
          })}\n`);
          // Allow AtomCode to process `session/cancel` and drop `setsid()` bash
          // children before escalating to SIGTERM on the ACP process group.
          cancelTimer = setTimeout(() => this.fail(new Error('atomcode_acp_aborted')), CANCEL_GRACE_TIMEOUT_MS);
          cancelTimer.unref?.();
          return;
        } catch { /* fall through to immediate teardown */ }
      }
      this.fail(new Error('atomcode_acp_aborted'));
    };
    signal.addEventListener('abort', onTurnAbort, { once: true });

    let succeeded = false;
    try {
      if (signal.aborted) onTurnAbort();
      const result = await this.request(
        'session/prompt',
        { sessionId: this.sessionId, prompt: [{ type: 'text', text: turn.content }] },
        false,
      );
      if (state.aborted || signal.aborted) {
        throw new Error('atomcode_acp_aborted');
      }
      if (state.incoming.size || this.failure || state.inputSignal.aborted) {
        throw this.failure ?? new Error('atomcode_acp_question_incomplete');
      }
      if (result.stopReason !== 'end_turn') {
        throw new Error(`atomcode ACP 执行未完成：${result.stopReason ?? 'unknown'}`);
      }
      succeeded = true;
      return { sessionId: this.sessionId, content: state.content };
    } finally {
      clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onTurnAbort);
      // Mark the turn closed and flush interaction-pending synchronously so a
      // late-settling onUserInput from this turn cannot flip the next turn's budget state.
      state.closed = true;
      state.incoming.clear();
      if (state.interactionPending) {
        state.interactionPending = false;
        state.onInteractionPending?.(false);
      }
      if (this.activeTurn === state) this.activeTurn = undefined;
      if (!succeeded) {
        turnLifetime.abort(new Error('atomcode_acp_closed'));
        await this.close(false);
      }
    }
  }

  /** Idempotently tear down this connection. When `graceful` is true and no
   *  turn is active, sends `session/close` + stdin EOF to let AtomCode commit
   *  state and drop its `.lease` cleanly; a subsequent `close(false)` escalates
   *  any in-flight graceful close or post-EOF wait immediately. */
  close(graceful: boolean): Promise<void> {
    this.closingRequested = true;
    // Never wait on idle session/close while a prompt or human-input round-trip is active;
    // cancel immediately so blocked onUserInput handlers unblock without stalling.
    const effectiveGraceful = graceful && !this.activeTurn;
    if (!effectiveGraceful) {
      if (this.activeTurn && this.sessionId && !this.failure && !this.wireClosed) {
        try {
          this.child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId: this.sessionId },
          })}\n`);
        } catch { /* process teardown follows */ }
      }
      // Escalate an in-flight graceful close or post-EOF grace wait immediately.
      this.cancelGraceWait?.();
      if (!this.wireClosed) {
        this.fail(new Error('atomcode_acp_closed'));
      } else if (!this.childExited) {
        this.kill('SIGTERM');
        this.hardKill ??= setTimeout(() => this.kill('SIGKILL'), 1000);
      }
    }
    if (this.closedPromise) return this.closedPromise;
    this.closedPromise = this.performClose(effectiveGraceful);
    return this.closedPromise;
  }

  private async performClose(graceful: boolean): Promise<void> {
    try {
      // Close the live session before EOF so AtomCode releases the native session
      // lease immediately before any subsequent local resume or reconnect.
      if (graceful && !this.failure && !this.childExited && this.canClose && this.sessionId && !this.activeTurn) {
        await this.request('session/close', { sessionId: this.sessionId }, CLOSE_REQUEST_TIMEOUT_MS)
          .catch(() => {});
      }
      const allowGracefulExit = graceful && !this.failure;
      this.wireClosed = true;
      this.lifetime.abort();
      this.rejectPending(new Error('atomcode_acp_closed'));
      if (allowGracefulExit && !this.childExited) {
        // Allow shutdown_sessions() to commit state and drop the disk lease before SIGTERM.
        try { this.child.stdin.end(); } catch { /* ignore */ }
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.exited,
          new Promise<void>(resolve => {
            this.cancelGraceWait = resolve;
            graceTimer = setTimeout(resolve, GRACEFUL_EXIT_TIMEOUT_MS);
          }),
        ]);
        this.cancelGraceWait = undefined;
        clearTimeout(graceTimer);
      }
      if (!this.childExited) {
        this.kill('SIGTERM');
        this.hardKill ??= setTimeout(() => this.kill('SIGKILL'), 1000);
      }
      await this.exited;
      // The group leader can exit while a tool descendant ignores SIGTERM;
      // reap any remaining process-group members before returning.
      this.killGroup('SIGKILL');
    } finally {
      this.wireClosed = true;
      this.cancelGraceWait = undefined;
      clearTimeout(this.hardKill);
      this.hardKill = undefined;
    }
  }

  private killGroup(sig: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, sig); } catch { /* group already gone */ }
  }

  private kill(sig: NodeJS.Signals): void {
    if (!this.child.pid || this.childExited) return;
    try { process.kill(-this.child.pid, sig); } catch { this.child.kill(sig); }
  }

  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error): void {
    if (this.wireClosed) return;
    const first = !this.failure;
    this.failure ??= error;
    this.lifetime.abort(error);
    this.rejectPending(this.failure);
    if (!this.childExited) {
      this.kill('SIGTERM');
      this.hardKill ??= setTimeout(() => this.kill('SIGKILL'), 1000);
    }
    if (first) this.onDisconnected?.();
  }

  private write(message: Json): void {
    if (this.failure || this.wireClosed || this.lifetime.signal.aborted) {
      throw this.failure ?? new Error('atomcode_acp_closed');
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private request(
    method: string,
    params: Json,
    timeoutMs: number | false = REQUEST_TIMEOUT_MS,
  ): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs === false
        ? undefined
        : setTimeout(() => this.fail(new Error(`atomcode ACP ${method} 超时`)), timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('atomcode_acp_write_failed'));
      }
    });
  }

  private handleMessage(message: unknown): void {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      throw new Error('atomcode_acp_protocol_invalid');
    }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        // Server-initiated requests (permissions/forms) are only valid during an active
        // turn; unsolicited requests while idle fail closed and tear down the connection.
        const turn = this.activeTurn;
        if (!turn || turn.closed) {
          throw new Error('atomcode_acp_question_session_mismatch');
        }
        if ((typeof message.id !== 'string' && typeof message.id !== 'number') || turn.incoming.has(message.id)) {
          throw new Error('atomcode_acp_request_invalid');
        }
        const id = message.id;
        const params = message.params;
        if (!this.sessionId || !isObject(params) || params.sessionId !== this.sessionId) {
          throw new Error('atomcode_acp_question_session_mismatch');
        }
        if (message.method !== 'elicitation/create' && message.method !== 'session/request_permission') {
          this.write({ id, error: { code: -32601, message: 'Client method not supported' } });
          return;
        }
        if (turn.incoming.size >= 8) throw new Error('atomcode_acp_too_many_questions');
        turn.incoming.add(id);
        if (turn.incoming.size === 1) {
          turn.interactionPending = true;
          turn.onInteractionPending?.(true);
        }
        const method = message.method;
        void Promise.resolve()
          .then(() => turn.onUserInput(method, params, turn.inputSignal))
          .then(result => {
            if (turn.closed || turn.inputSignal.aborted || this.failure || this.wireClosed || this.activeTurn !== turn) return;
            this.write({ id, result });
          }, error => {
            if (turn.closed || turn.aborted) return;
            this.fail(error instanceof Error ? error : new Error('atomcode_acp_user_input_failed'));
          })
          .finally(() => {
            if (turn.closed) return;
            turn.incoming.delete(id);
            if (!turn.incoming.size && turn.interactionPending) {
              turn.interactionPending = false;
              turn.onInteractionPending?.(false);
            }
          })
          .catch(error => {
            if (!turn.closed && !turn.aborted) {
              this.fail(error instanceof Error ? error : new Error('atomcode_acp_user_input_failed'));
            }
          });
        return;
      }
      if (message.method !== 'session/update') return;
      const turn = this.activeTurn;
      const params = message.params;
      if (!isObject(params) || params.sessionId !== this.sessionId || !isObject(params.update)) {
        // Ignore pre-prompt replay or trailing updates while idle; reject session mismatches mid-turn.
        if (!turn) return;
        throw new Error('atomcode_acp_update_session_mismatch');
      }
      if (!turn || turn.closed) return;
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') {
          throw new Error('atomcode_acp_message_invalid');
        }
        const id = typeof update.messageId === 'string' ? update.messageId : undefined;
        // AtomCode advances messageId after each LLM round/Usage; reset so pre-tool prose stays out of the final reply.
        if ((id && id !== turn.messageId) || (!id && turn.nextMessage)) {
          turn.content = '';
          turn.contentBytes = 0;
        }
        turn.messageId = id;
        turn.nextMessage = false;
        turn.contentBytes += Buffer.byteLength(update.content.text);
        if (turn.contentBytes > ATOMCODE_FINAL_MAX_BYTES) throw new Error('atomcode_acp_content_limit');
        turn.content += update.content.text;
      } else if (update.sessionUpdate === 'tool_call') {
        turn.nextMessage = true;
      }
      turn.onUpdate?.(update);
      return;
    }
    if (typeof message.id !== 'number' || !this.pending.has(message.id)) {
      throw new Error('atomcode_acp_response_unknown');
    }
    const entry = this.pending.get(message.id)!;
    this.pending.delete(message.id);
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
  }
}

/** Session-scoped persistent ACP manager. Keeps one `atomcode acp` process warm
 *  across consecutive turns (avoiding per-turn cold spawn/resume/MCP setup and
 *  preserving in-session permission grants and background `/compact`), while
 *  releasing the process and its `.lease` lock after an idle window so local
 *  `atomcode resume` stays unblocked. */
export class AtomcodeAcpSession {
  private readonly idleTimeoutMs: number;
  private readonly lifecycle = new AbortController();
  private readonly closingConnections = new Set<AtomcodeAcpConnection>();
  private nativeSessionId?: string;
  private connection?: AtomcodeAcpConnection;
  private openingPromise?: Promise<void>;
  private teardownPromise?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private disposed = false;

  constructor(private readonly opts: AtomcodeAcpSessionOptions) {
    this.nativeSessionId = opts.nativeSessionId;
    const rawIdle = opts.idleTimeoutMs ?? DEFAULT_ATOMCODE_IDLE_RELEASE_MS;
    if (!Number.isSafeInteger(rawIdle) || rawIdle < 0 || rawIdle > 2_147_483_647) {
      throw new Error('invalid_atomcode_idle_timeout');
    }
    this.idleTimeoutMs = rawIdle;
  }

  /** Run one turn on the warm connection, or open/resume a new one after any
   *  in-flight teardown finishes releasing its `.lease`. On success, arms the
   *  idle release timer (or closes immediately when `idleTimeoutMs === 0`); on
   *  any failure, force-tears down the connection while keeping `sessionId`. */
  async runTurn(turn: AtomcodeAcpTurnOptions, signal: AbortSignal): Promise<AtomcodeAcpResult> {
    if (this.disposed) throw new Error('atomcode_acp_closed');
    if (this.busy) throw new Error('atomcode_acp_busy');
    signal.throwIfAborted();
    this.busy = true;
    this.clearIdleTimer();

    const turnSignal = AbortSignal.any([signal, this.lifecycle.signal]);
    let conn: AtomcodeAcpConnection | undefined;
    let armIdle = false;
    try {
      // Wait for any in-flight teardown (such as an idle lease release) so the
      // retiring child drops its OS .lease lock before session/resume starts.
      if (this.teardownPromise) {
        await awaitWithAbort(this.teardownPromise, turnSignal);
      }
      turnSignal.throwIfAborted();
      if (this.disposed) throw new Error('atomcode_acp_closed');

      const existing = this.connection;
      if (existing && existing.isReusable()) {
        conn = existing;
      } else {
        if (existing) {
          await awaitWithAbort(this.detachAndClose(existing, false), turnSignal);
        }
        turnSignal.throwIfAborted();
        if (this.disposed) throw new Error('atomcode_acp_closed');

        // Track in-flight open() so close() aborts and awaits it; re-check disposed
        // afterwards so a session closed mid-handshake never dispatches session/prompt.
        let opened: AtomcodeAcpConnection | undefined;
        let finishOpen!: () => void;
        const opening = new Promise<void>(resolve => { finishOpen = resolve; });
        this.openingPromise = opening;
        try {
          opened = await AtomcodeAcpConnection.open({
            executable: this.opts.executable,
            cwd: this.opts.cwd,
            env: this.opts.env,
            nativeSessionId: this.nativeSessionId,
            model: this.opts.model,
            effort: this.opts.effort,
            permission: this.opts.permission,
            onSession: sessionId => {
              this.nativeSessionId = sessionId;
              this.opts.onSession?.(sessionId);
            },
            onDisconnected: () => {
              if (opened && this.connection === opened) {
                // Track background exit cleanup so the next turn awaits lease release.
                void this.detachAndClose(opened, false);
              }
            },
          }, turnSignal);
          if (this.disposed) {
            await this.detachAndClose(opened, false);
            throw new Error('atomcode_acp_closed');
          }
          conn = opened;
          this.connection = opened;
        } finally {
          if (this.openingPromise === opening) this.openingPromise = undefined;
          finishOpen();
        }
      }

      const result = await conn.prompt(turn, turnSignal);
      if (this.idleTimeoutMs === 0 || this.disposed) {
        const closingConn = conn;
        const escalate = () => { void closingConn.close(false); };
        turnSignal.addEventListener('abort', escalate, { once: true });
        try {
          await this.detachAndClose(closingConn, !turnSignal.aborted);
        } finally {
          turnSignal.removeEventListener('abort', escalate);
        }
      } else {
        armIdle = true;
      }
      return result;
    } catch (error) {
      if (conn) {
        await this.detachAndClose(conn, false);
      }
      throw error;
    } finally {
      // Clear busy before arming the idle timer so armIdleTimer() observes the idle state.
      this.busy = false;
      if (armIdle) this.armIdleTimer();
    }
  }

  /** Permanently dispose this session: aborts any in-flight `open()` or active
   *  turn, escalates in-flight idle closes when `graceful` is false, and awaits
   *  full process exit so the native `.lease` is released before resolving. */
  async close(graceful = true): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    this.lifecycle.abort(new Error('atomcode_acp_closed'));
    if (this.openingPromise) {
      await this.openingPromise.catch(() => {});
    }
    const conn = this.connection;
    if (conn) {
      await this.detachAndClose(conn, graceful);
    }
    if (!graceful) {
      for (const closing of this.closingConnections) {
        void closing.close(false);
      }
    }
    if (this.teardownPromise) {
      await this.teardownPromise.catch(() => {});
    }
  }

  private detachAndClose(conn: AtomcodeAcpConnection, graceful: boolean): Promise<void> {
    if (this.connection === conn) {
      this.connection = undefined;
    }
    this.clearIdleTimer();
    // Retain closing references so close(false) can escalate an in-flight idle
    // session/close immediately; chain teardowns so the next turn awaits full OS .lease release.
    this.closingConnections.add(conn);
    const p = conn.close(graceful)
      .catch(() => {})
      .finally(() => { this.closingConnections.delete(conn); });
    const prev = this.teardownPromise;
    const chained = prev ? prev.catch(() => {}).then(() => p) : p;
    this.teardownPromise = chained;
    void chained.finally(() => {
      if (this.teardownPromise === chained) this.teardownPromise = undefined;
    });
    return chained;
  }

  /** Schedule graceful release of an idle ACP child so its `.lease` does not
   *  block standalone `atomcode resume`. Unref'd so the timer itself cannot
   *  pin process exit if no child or stdin stream remains alive. */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || this.busy || !this.connection || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.busy || !this.connection) return;
      void this.detachAndClose(this.connection, true);
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
