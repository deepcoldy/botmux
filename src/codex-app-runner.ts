#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createConnection, type Socket } from 'node:net';
import type { KeyObject } from 'node:crypto';
import type { CodexAppTurnInput } from './types.js';
import {
  buildCodexAppTurnStartParams,
  isCleanInputCapabilityError,
  isCodexAppTurnInput,
  parseCodexVersion,
  supportsClientUserMessageId,
  type CodexVersion,
} from './adapters/cli/codex-app-turn.js';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import {
  CODEX_APP_CONTROL_BOOTSTRAP_ENV,
  CODEX_APP_CONTROL_FINAL_CHUNK_BYTES,
  CODEX_APP_CONTROL_FINAL_MAX_BYTES,
  CodexAppControlEndpointTracker,
  CodexAppControlLineDecoder,
  CodexAppControlRunnerHandshake,
  armCodexAppControlHandshakeTimeout,
  armCodexAppControlStartupTimeout,
  consumeCodexAppControlBootstrap,
  encodeCodexAppControlAuth,
  encodeCodexAppSignedControlMarker,
  parseCodexAppControlWireRecord,
  takeCodexAppControlLocatorEndpoint,
} from './utils/codex-app-control.js';
import {
  TurnTokenUsageAccumulator,
  parseTokenUsagePair,
} from './services/codex-app-token-usage.js';

type JsonObject = Record<string, any>;

interface Args {
  sessionId: string;
  codexBin: string;
  cwd: string;
  controlGeneration: string;
  controlPrivateKey: KeyObject;
  controlSocketPath?: string;
  controlLocatorPath?: string;
  threadId?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
  model?: string;
  reasoningEffort?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
}

interface ActiveTurn {
  /** Codex app-server's native turn id. This is used only to correlate
   * notifications from the server; botmux routing uses the stable client
   * message id carried alongside the queued input. */
  nativeTurnId?: string;
  /** Immutable Botmux/Lark identity sent through app-server. Mismatched native
   * completions may be adopted only when their full items contain this exact
   * client id. */
  clientUserMessageId?: string;
  epoch: number;
  reconciliation?: Promise<void>;
  identityConflictReported: boolean;
  completed: boolean;
  requestKind: 'start' | 'steer';
  requestAccepted: boolean;
  pendingCompletions: JsonObject[];
  pendingNotifications: JsonObject[];
  serverStarted: boolean;
  startedAtMs: number;
  lastActivityMarkerAtMs: number;
  finalText: string;
  allAgentText: string;
  itemText: Map<string, string>;
  done: Promise<void>;
  resolveDone: () => void;
  // ─── Blocking 1 ordered-steer driver (codex decision A/B/C) ──────────────
  // These extend the single-turn model into "one native turn carries an ordered
  // accepted group". They are optional/defaulted so the existing single-input
  // start / Goal-continuation paths behave exactly as before until the driver
  // wires pre-final Lark steer. See drive()/canSteer().
  /** Lifecycle phase of the active native turn. */
  phase?: 'starting' | 'open' | 'closing' | 'fenced';
  /** How the canonical native id was proven (guards premature steer/bind).
   * exact_started / exact_completed are the two exact-client proofs; they are
   * first-proof-wins (a later exact proof with a DIFFERENT id fences). */
  identityProof?: 'exact_started' | 'exact_completed' | 'start_response' | 'goal_snapshot';
  /** Root + only matching-steer-accepted members, in strict inbound order.
   * The last member's reply id owns the real final; earlier members expand to
   * `steer_superseded` finals at native completion. */
  accepted?: Dispatch[];
  /** Proven canonical native turn id (distinct from the transient nativeTurnId
   * hint until an exact `turn/started` or start-response binds it). */
  canonicalNativeTurnId?: string;
  /** A start-response is outstanding. SEPARATE from steerInFlight: per codex, a
   * start-response may overlap with a steer once an exact `turn/started` proved
   * the canonical id. */
  startResponsePending?: boolean;
  /** New steer admission is closed (completion seen or a definite rejection). */
  steeringClosed?: boolean;
  /** The authoritative terminal `turn/completed` payload, once observed for the
   * proven canonical id. */
  terminalCompletion?: JsonObject;
  /** The single in-flight steer RPC (at most one), and the id it targets. */
  steerInFlight?: { dispatch: Dispatch; expectedTurnId: string };
  /** The canonical native `turn/completed` has been observed. Distinct from
   * `completed` (which means the logical group has settled + done resolved): a
   * completion seen while a steer RPC is still in flight is buffered here as a
   * barrier and only settles the group after the steer response resolves. */
  completionSeen?: boolean;
}

/** One admitted input tracked inside an ActiveTurn's ordered accepted group. */
interface Dispatch {
  input: QueuedInput;
  replyTurnId?: string;
  /** The client id actually sent to app-server (legacy inputs may omit it). */
  clientUserMessageId?: string;
  receivedAtMs: number;
}

interface QueuedInput {
  content: string;
  codexAppInput?: CodexAppTurnInput;
  /** Immutable botmux/Lark turn identity for reply routing. Sourced from the
   * runner input's top-level `replyTurnId`, falling back to the structured
   * sidecar's `clientUserMessageId`. Threaded onto the app-server request's
   * clientUserMessageId (when structured is supported) and onto the final
   * marker as both PR's `turnId` and master's `replyTurnId`. */
  replyTurnId?: string;
  /** Explicit positive (from the daemon admission gate, decision A): this
   * plain-human-interactive input may `turn/steer` into an already-active Codex
   * App turn. Missing/false ⇒ forced serial (starts its own turn only when the
   * runner is idle). Never inferred here — copied verbatim from the decoded
   * control line's `codexAppSteerable`. */
  codexAppSteerable?: true;
  /** Wall-clock at which the runner dequeued this control line. Used as the real
   * final's startedAtMs for a multi-member steered group so an early
   * botmux-send marker cannot suppress the true answer. */
  receivedAtMs?: number;
}

const output = new RunnerControlWriter();
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RECONCILIATION_TIMEOUT_MS = 5_000;
const RECONCILIATION_PAGE_LIMIT = 3;
const RECONCILIATION_PAGE_SIZE = 50;

class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly data: unknown,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'AppServerRpcError';
  }
}

class AppServerRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method}: timed out after ${timeoutMs}ms; request acceptance is unknown`);
    this.name = 'AppServerRequestTimeoutError';
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function parseArgs(argv: string[]): Args {
  const controlBootstrapPath = process.env[CODEX_APP_CONTROL_BOOTSTRAP_ENV];
  // app-server and every model-launched tool inherit process.env. Remove even
  // the non-secret bootstrap path before either can start; private key material
  // was never present in env/argv/layout.
  delete process.env[CODEX_APP_CONTROL_BOOTSTRAP_ENV];
  const out: Args = {
    sessionId: '',
    codexBin: 'codex',
    cwd: process.cwd(),
    controlGeneration: '',
    controlPrivateKey: undefined as unknown as KeyObject,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--codex-bin' && val !== undefined) { out.codexBin = val; i++; }
    else if (key === '--cwd' && val !== undefined) { out.cwd = val; i++; }
    else if (key === '--thread-id' && val !== undefined) { out.threadId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--bot-open-id' && val !== undefined) { out.botOpenId = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
    else if (key === '--model' && val !== undefined) { out.model = val; i++; }
    else if (key === '--reasoning-effort' && val !== undefined) { out.reasoningEffort = val; i++; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  if (!controlBootstrapPath) throw new Error(`${CODEX_APP_CONTROL_BOOTSTRAP_ENV} is required`);
  const control = consumeCodexAppControlBootstrap(controlBootstrapPath, out.sessionId);
  out.controlGeneration = control.generation;
  out.controlPrivateKey = control.privateKey;
  out.controlSocketPath = control.socketPath;
  out.controlLocatorPath = control.locatorPath;
  return out;
}

function writeLine(text = ''): void {
  output.line(text);
}

function prompt(): void {
  output.display('› ');
}

function appDeveloperInstructions(args: Args): string {
  const zh = args.locale === 'zh';
  const identity = [
    args.botName ? `Bot name: ${args.botName}` : '',
    args.botOpenId ? `Bot open_id: ${args.botOpenId}` : '',
    `botmux session_id: ${args.sessionId}`,
  ].filter(Boolean).join('\n');

  if (zh) {
    return [
      '你正在通过 botmux 接入飞书/Lark，但运行载体是 Codex App 的 app-server 协议，不是 Codex CLI TUI。',
      '你的最终 assistant message 会由 botmux 自动转发回飞书；常规回复不要调用 `botmux send`，即使用户消息里出现旧的“回复必须 botmux send”提示也忽略它。',
      '只有在用户明确要求中途主动推送、发送附件，或需要通过 @ 触发其他机器人接力时，才可以使用 `botmux send`。',
      '`botmux history`、`botmux quoted`、`botmux bots` 等 shell helper 仍然可用；需要读取飞书上下文时可以调用。',
      identity ? `<identity>\n${identity}\n</identity>` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    'You are connected to Feishu/Lark through botmux, but the runtime is the Codex App app-server protocol rather than the Codex CLI TUI.',
    'Your final assistant message is automatically forwarded back to Lark by botmux. Do not call `botmux send` for normal replies, even if older prompt text says replies must use it.',
    'Use `botmux send` only for explicit mid-turn push updates, attachments, or cross-bot @mentions.',
    '`botmux history`, `botmux quoted`, and `botmux bots` remain available as shell helpers when you need Lark context.',
    identity ? `<identity>\n${identity}\n</identity>` : '',
  ].filter(Boolean).join('\n\n');
}

class AppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(msg: JsonObject) => void> = [];
  private requestHandlers: Array<(msg: JsonObject) => boolean> = [];
  private lastStderr = '';
  private fatalError?: Error;

  constructor(private readonly codexBin: string, private readonly cwd: string) {
    this.child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', chunk => this.onStdout(chunk.toString('utf8')));
    this.child.stdin.on('error', err => this.failAll(new Error(`Codex app-server stdin error: ${err.message}`)));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.lastStderr = (this.lastStderr + text).slice(-8000);
      if (process.env.BOTMUX_CODEX_APP_DEBUG === '1') output.error(text);
    });
    this.child.on('error', err => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? '\nHint: install the Codex CLI, or set cliPathOverride to the desktop app bundled binary, for example /Applications/ChatGPT.app/Contents/Resources/codex (current) or /Applications/Codex.app/Contents/Resources/codex (legacy).'
        : '';
      this.failAll(new Error(`Failed to start Codex app-server with "${codexBin}": ${err.message}${hint}`));
    });
    this.child.on('exit', (code, signal) => {
      const err = this.fatalError ?? new Error(`Codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`);
      this.failAll(err);
    });
  }

  onNotification(handler: (msg: JsonObject) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: JsonObject) => boolean): void {
    this.requestHandlers.push(handler);
  }

  async initialize(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'botmux-codex-app', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    }, { timeoutMs });
    this.notify('initialized');
  }

  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs;
      const pending: PendingRequest = { resolve, reject, method };
      if (timeoutMs !== undefined) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          reject(new AppServerRequestTimeoutError(method, Math.max(0, timeoutMs)));
          return;
        }
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new AppServerRequestTimeoutError(method, timeoutMs));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(asError(err));
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonObject = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  close(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }

  private write(msg: JsonObject): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(err: Error): void {
    this.fatalError = this.fatalError ?? err;
    const fatal = this.fatalError;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(fatal);
    }
    this.pending.clear();
  }

  /**
   * Message ordering must not depend on pipe chunk boundaries. Dispatching
   * line N+1 synchronously after line N starves the microtask continuations
   * line N scheduled: a response resolving `await request(...)` runs its
   * awaiting caller (which records protocol state, e.g. "steer accepted,
   * group grew") only AFTER the whole synchronous loop — so a notification
   * coalesced into the same chunk behind its own request's response was
   * processed against stale state and the turn stalled forever. The kernel
   * coalesces adjacent writes whenever this reader is scheduled late (routine
   * on loaded CI runners, possible anywhere), so yield a MICROtask between
   * lines: already-queued continuations run before the next dispatch, while
   * anything the runner deliberately defers past the current burst (e.g.
   * macrotask-deferred publications) still sees the burst as one unit.
   */
  private stdoutDraining = false;

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    if (this.stdoutDraining) return;
    this.stdoutDraining = true;
    const step = (): void => {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) {
        this.stdoutDraining = false;
        return;
      }
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line) {
        let msg: JsonObject | undefined;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = undefined;
        }
        if (msg) this.dispatch(msg);
      }
      queueMicrotask(step);
    };
    step();
  }

  private dispatch(msg: JsonObject): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new AppServerRpcError(
          pending.method,
          typeof msg.error.code === 'number' ? msg.error.code : undefined,
          msg.error.data,
          typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error),
        ));
      }
      else pending.resolve(msg.result);
      return;
    }

    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      for (const handler of this.requestHandlers) {
        if (handler(msg)) return;
      }
      this.respond(msg.id, { decision: 'decline' });
      return;
    }

    if (typeof msg.method === 'string') {
      for (const handler of this.notificationHandlers) handler(msg);
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err: any) {
  output.error(`${err?.message ?? err}\n`);
  process.exit(2);
}

let controlSeq = 0;
let controlAckedSeq = 0;
let controlSentThrough = 0;
const controlQueue: Array<{ seq: number; kind: string; payload: JsonObject }> = [];
let controlFatal = false;
let controlSocket: Socket | undefined;
let controlChallenge: string | undefined;
let controlAccepted = false;
let controlAcceptanceCount = 0;
let controlReconnectTimer: NodeJS.Timeout | undefined;
let resolveControlReady!: () => void;
const controlReady = new Promise<void>(resolve => { resolveControlReady = resolve; });
const CONTROL_QUEUE_MAX_RECORDS = 2_048;
const controlEndpoints = new CodexAppControlEndpointTracker();

function scheduleControlReconnect(): void {
  if (controlFatal || controlReconnectTimer) return;
  controlReconnectTimer = setTimeout(() => {
    controlReconnectTimer = undefined;
    connectControlSocket();
  }, 250);
}

function flushControlQueue(): void {
  const socket = controlSocket;
  const challenge = controlChallenge;
  if (controlFatal || !socket || socket.destroyed || !controlAccepted || !challenge) return;
  try {
    for (const marker of controlQueue) {
      if (marker.seq <= controlSentThrough) continue;
      socket.write(`${encodeCodexAppSignedControlMarker(
        args.controlPrivateKey,
        args.sessionId,
        args.controlGeneration,
        challenge,
        marker.seq,
        marker.kind,
        marker.payload,
      )}\n`);
      controlSentThrough = marker.seq;
    }
  } catch (err: any) {
    controlFatal = true;
    console.error(`Codex App control channel failed closed: ${err?.message ?? err}`);
    process.exit(2);
  }
}

function nextControlEndpoint(): { endpoint: string; epoch?: string } | undefined {
  if (args.controlSocketPath) return { endpoint: args.controlSocketPath };
  if (!args.controlLocatorPath) return undefined;
  return takeCodexAppControlLocatorEndpoint({
    locatorPath: args.controlLocatorPath,
    sessionId: args.sessionId,
    tracker: controlEndpoints,
  });
}

function connectControlSocket(): void {
  if (controlFatal || (controlSocket && !controlSocket.destroyed)) return;
  const target = nextControlEndpoint();
  if (!target) {
    scheduleControlReconnect();
    return;
  }
  // A never-accepted locator endpoint may retry with the existing 250ms
  // reconnect backoff; the protected 256-bit locator epoch is still required
  // before acceptance. Once accepted, its endpoint is permanently burned and
  // only a newly published locator can be used.
  const socket = createConnection(target.endpoint);
  const handshakeTimer = armCodexAppControlHandshakeTimeout(() => {
    socket.destroy(new Error('Codex App control endpoint handshake timed out'));
  });
  handshakeTimer.unref?.();
  const decoder = new CodexAppControlLineDecoder();
  const handshake = new CodexAppControlRunnerHandshake(
    args.sessionId,
    args.controlGeneration,
    target.epoch,
  );
  controlSocket = socket;
  controlChallenge = undefined;
  controlAccepted = false;
  controlSentThrough = controlAckedSeq;
  socket.setNoDelay(true);
  socket.on('data', chunk => {
    const decoded = decoder.push(chunk);
    if (decoded.droppedMalformed) {
      socket.destroy(new Error('oversized Codex App control response'));
      return;
    }
    for (const line of decoded.lines) {
      if (controlSocket !== socket) {
        socket.destroy(new Error('unexpected Codex App control response'));
        return;
      }
      const action = handshake.handle(parseCodexAppControlWireRecord(line), controlSentThrough);
      if (action.type === 'authenticate') {
        controlChallenge = action.challenge;
        socket.write(`${encodeCodexAppControlAuth(
          args.controlPrivateKey,
          args.sessionId,
          args.controlGeneration,
          action.challenge,
        )}\n`);
      } else if (action.type === 'accepted') {
        // `accepted` is intentionally unsigned. Its authority is the protected
        // locator's independent epoch plus the already-bound random endpoint.
        // Ed25519 still authenticates every runner marker to the worker.
        controlAccepted = true;
        clearTimeout(handshakeTimer);
        if (args.controlLocatorPath) controlEndpoints.noteAccepted(target.endpoint);
        controlAcceptanceCount++;
        resolveControlReady();
        // The first acceptance happens before app-server initialization; it is
        // not a ready boundary. Re-authentication can publish the live state
        // only after initialization has completed.
        if (controlAcceptanceCount > 1 && runnerReady) emitRunnerState();
        flushControlQueue();
      } else if (action.type === 'ack' && controlAccepted) {
        if (action.seq > controlAckedSeq) controlAckedSeq = action.seq;
        while (controlQueue[0] && controlQueue[0].seq <= controlAckedSeq) controlQueue.shift();
      } else {
        socket.destroy(new Error('out-of-order Codex App control response'));
        return;
      }
    }
  });
  socket.on('error', () => { /* close schedules a retry */ });
  socket.on('close', () => {
    clearTimeout(handshakeTimer);
    if (controlSocket === socket) {
      controlSocket = undefined;
      controlChallenge = undefined;
      controlAccepted = false;
    }
    scheduleControlReconnect();
  });
}

function emitMarker(kind: string, payload: JsonObject): void {
  if (controlQueue.length >= CONTROL_QUEUE_MAX_RECORDS) {
    controlFatal = true;
    console.error('Codex App control queue exceeded its fail-closed bound');
    process.exit(2);
    return;
  }
  controlQueue.push({ seq: ++controlSeq, kind, payload });
  flushControlQueue();
}

function emitFinalMarker(
  payload: JsonObject,
  opts: { disposition?: 'steer_superseded'; drainUsage?: boolean } = {},
): void {
  // Usage draining is caller-controlled so an N-final expansion of one native
  // completion does not let the FIRST (superseded) transaction steal the usage:
  // only the LAST real final drains the accumulator. Default (no opts) drains,
  // preserving every existing single-final caller. A `steer_superseded`
  // transaction never carries usage and never drains.
  const superseded = opts.disposition === 'steer_superseded';
  const drainUsage = superseded ? false : (opts.drainUsage ?? true);
  // Attach this turn's token usage (if the accumulator saw coherent totals) and
  // drain its accumulator. Keyed by the codex native turn id; omitted when no
  // usage was observed / a protocol anomaly was detected — never zeros.
  const usageKey = typeof payload.nativeTurnId === 'string' && payload.nativeTurnId.length > 0
    ? payload.nativeTurnId
    : undefined;
  const acc = usageKey && drainUsage ? usageAccumulators.get(usageKey) : undefined;
  const usage = acc?.result() ?? undefined;
  if (acc?.warning && !usage) {
    // Surface a protocol anomaly rather than silently omitting usage — a
    // regression/negative-baseline should be visible in the runner log.
    writeLine(`[codex-app] token usage dropped for turn ${usageKey ?? '?'}: ${acc.warning}`);
  }
  if (usageKey && drainUsage) usageAccumulators.delete(usageKey);

  // Dual-name the turn identity so both protocol vocabularies ride the same
  // signed final transaction:
  //   - PR #597: `turnId` (botmux/Lark id) + `nativeTurnId` (codex app-server id)
  //     — consumed by the worker's serial dispatch FIFO (settleFinal).
  //   - master:  `replyTurnId` (botmux/Lark id) + `appTurnId` (codex id) — the
  //     names the runner-protocol normalizer + steer-ack correlation expect.
  // `appTurnId` is always present: a turn that never bound a native id (e.g. a
  // turn/start rejection) gets a synthetic codex-app-error id, matching master's
  // controller failure-id contract so the worker can still key the completion.
  const replyTurnId = typeof payload.turnId === 'string' && payload.turnId.length > 0
    ? payload.turnId
    : undefined;
  const appTurnId = usageKey ?? `codex-app-error-${Date.now()}-${++finalFailureSequence}`;

  const original = Buffer.from(String(payload.content ?? ''), 'utf8');
  const truncated = original.length > CODEX_APP_CONTROL_FINAL_MAX_BYTES;
  const content = truncated
    ? Buffer.concat([
        original.subarray(0, CODEX_APP_CONTROL_FINAL_MAX_BYTES - 64),
        Buffer.from('\n\n[botmux: final output truncated at control limit]', 'utf8'),
      ])
    : original;
  const id = `${String(payload.turnId ?? 'turn')}:${String(payload.completedAtMs ?? Date.now())}`;
  const total = Math.ceil(content.length / CODEX_APP_CONTROL_FINAL_CHUNK_BYTES);
  const { content: _content, ...metadata } = payload;
  emitMarker('final-start', {
    id,
    total,
    truncated,
    ...metadata,
    appTurnId,
    ...(replyTurnId ? { replyTurnId } : {}),
    ...(usage ? { usage } : {}),
    ...(superseded ? { disposition: 'steer_superseded' } : {}),
  });
  for (let index = 0; index < total; index++) {
    const start = index * CODEX_APP_CONTROL_FINAL_CHUNK_BYTES;
    emitMarker('final-chunk', {
      id,
      index,
      data: content.subarray(start, start + CODEX_APP_CONTROL_FINAL_CHUNK_BYTES).toString('base64'),
    });
  }
  emitMarker('final-end', { id, total });
}

connectControlSocket();

let client!: AppServerClient;
let threadId = args.threadId;
let threadReady = false;
let activeTurn: ActiveTurn | null = null;
let activeTurnEpoch = 0;
/** App-server may start a Goal continuation without a Botmux input. Keep that
 * native lifecycle separate from `activeTurn`; otherwise the next Lark input
 * is incorrectly sent with turn/start and its completion can be discarded as
 * belonging to an "unexpected" native turn. */
let nativeActiveTurnId: string | undefined;
const queue: QueuedInput[] = [];
let inputBuffer = '';
let processing = false;
/** At most one pre-final Lark `turn/steer` admission runs at a time (checkpoint:
 * startResponsePending ≠ steerInFlight — this guards ONLY the steer RPC). */
let steerAdmitting = false;
/** An unknown turn/start|turn/steer outcome fenced the generation. Stops all
 * dequeue / steer / final / idle-state emission until the process is torn down
 * (the worker's authenticated `fatal` lifecycle fails the control generation). */
let generationFenced = false;
let runnerReady = false;
let cleanInputUnsupported = false;
let codexVersionChecked = false;
let codexVersion: CodexVersion | undefined;
let cleanVersionWarningShown = false;

/** Per-turn token accumulators keyed by codex native turn id. Fed by
 *  thread/tokenUsage/updated notifications; drained (and deleted) when the
 *  matching turn's final marker is emitted. Bounded by turn lifetime — a turn
 *  that never finalizes leaves at most one stale entry, cleared on next final. */
const usageAccumulators = new Map<string, TurnTokenUsageAccumulator>();
/** Only one turn is active at a time; a small cap bounds leakage from turns
 *  that never emit a final marker. */
const MAX_USAGE_ACCUMULATORS = 8;
/** Monotonic counter for synthetic appTurnId values on finals that never bound a
 *  codex native turn id (e.g. turn/start rejections). Mirrors master's controller
 *  failure-id contract (`codex-app-error-<now>-<seq>`). */
let finalFailureSequence = 0;

/** Get (or create, with bounded pruning) the usage accumulator for a turn. */
function getOrCreateUsageAccumulator(turnId: string): TurnTokenUsageAccumulator {
  let acc = usageAccumulators.get(turnId);
  if (!acc) {
    // Bounded pruning: a turn that never emits a final marker (crash/interrupt)
    // would otherwise leak its accumulator. Evict the oldest insertion at the cap.
    if (usageAccumulators.size >= MAX_USAGE_ACCUMULATORS) {
      const oldest = usageAccumulators.keys().next().value;
      if (oldest !== undefined) usageAccumulators.delete(oldest);
    }
    acc = new TurnTokenUsageAccumulator();
    usageAccumulators.set(turnId, acc);
  }
  return acc;
}

function emitRunnerState(
  busy = processing || queue.length > 0 || nativeActiveTurnId !== undefined,
  tracksTurn = activeTurn !== null,
): void {
  emitMarker('state', {
    busy,
    atMs: Date.now(),
    // Input is accepted only after the runner has initialized and emitted this
    // signed state. The worker uses this field as a runtime type-ahead gate;
    // authentication alone never releases a prompt.
    acceptingInput: runnerReady,
    ...(busy && !tracksTurn ? { tracksTurn: false } : {}),
  });
}

function detectedCodexVersion(): CodexVersion | undefined {
  if (codexVersionChecked) return codexVersion;
  codexVersionChecked = true;
  try {
    const result = spawnSync(args.codexBin, ['--version'], {
      cwd: args.cwd,
      env: process.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    codexVersion = parseCodexVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch {
    codexVersion = undefined;
  }
  return codexVersion;
}

function makeTurn(clientUserMessageId: string | undefined, requestKind: 'start' | 'steer'): ActiveTurn {
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  return {
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    epoch: ++activeTurnEpoch,
    identityConflictReported: false,
    completed: false,
    requestKind,
    requestAccepted: false,
    pendingCompletions: [],
    pendingNotifications: [],
    startedAtMs: Date.now(),
    lastActivityMarkerAtMs: 0,
    serverStarted: false,
    finalText: '',
    allAgentText: '',
    itemText: new Map(),
    phase: 'starting',
    done,
    resolveDone,
  };
}

const TURN_ACTIVITY_MARKER_MIN_INTERVAL_MS = 5_000;

/**
 * Expose app-server lifecycle activity to the parent worker without polluting
 * the visible terminal. Progress markers are throttled because token-delta
 * notifications can arrive many times per second; submitted/completed edges
 * are always emitted.
 */
function emitTurnActivity(turn: ActiveTurn, phase: 'submitted' | 'progress' | 'completed', force = false): void {
  const atMs = Date.now();
  if (!force && atMs - turn.lastActivityMarkerAtMs < TURN_ACTIVITY_MARKER_MIN_INTERVAL_MS) return;
  turn.lastActivityMarkerAtMs = atMs;
  emitMarker('activity', {
    phase,
    atMs,
    ...(turn.nativeTurnId ? { turnId: turn.nativeTurnId } : {}),
  });
}

function handleServerRequest(msg: JsonObject): boolean {
  const method = msg.method;
  if (method === 'item/commandExecution/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/fileChange/requestApproval') {
    client.respond(msg.id, { decision: 'acceptForSession' });
    return true;
  }
  if (method === 'item/permissions/requestApproval') {
    client.respond(msg.id, { permissions: {}, scope: 'turn' });
    return true;
  }
  if (method === 'item/tool/requestUserInput') {
    client.respond(msg.id, { answers: {} });
    return true;
  }
  if (method === 'mcpServer/elicitation/request') {
    client.respond(msg.id, { action: 'cancel', content: null, _meta: null });
    return true;
  }
  if (method === 'item/tool/call') {
    client.respond(msg.id, { contentItems: [], success: false });
    return true;
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    client.respond(msg.id, { decision: 'approved_for_session' });
    return true;
  }
  return false;
}

function exactClientItemIndexes(turn: JsonObject, clientUserMessageId: string): number[] {
  if (turn?.itemsView !== 'full' || !Array.isArray(turn?.items)) return [];
  const indexes: number[] = [];
  for (let index = 0; index < turn.items.length; index++) {
    const item = turn.items[index];
    if (item?.type === 'userMessage' && item.clientId === clientUserMessageId) indexes.push(index);
  }
  return indexes;
}

function isTerminalNativeTurn(turn: JsonObject): boolean {
  return turn?.status === undefined
    || turn.status === 'completed'
    || turn.status === 'failed'
    || turn.status === 'interrupted';
}

/** Rebuild only from content causally after the exact user item. Never reuse
 * streamed text from a different native turn during identity reconciliation. */
function rebuildReconciledFinal(turn: JsonObject, userItemIndex: number): string {
  const following = Array.isArray(turn.items) ? turn.items.slice(userItemIndex + 1) : [];
  const finalAnswers = following.filter(
    (item: JsonObject) => item?.type === 'agentMessage' && item.phase === 'final_answer',
  );
  if (finalAnswers.length > 0) return String(finalAnswers.at(-1)?.text ?? '');
  if (turn?.error?.message) return `Codex App turn failed: ${String(turn.error.message)}`;
  return '';
}

function completeActiveTurnFromNative(turn: ActiveTurn, nativeTurn: JsonObject, exactIndex?: number): void {
  if (activeTurn !== turn || turn.completed || !isTerminalNativeTurn(nativeTurn)) return;
  if (exactIndex !== undefined) {
    turn.finalText = rebuildReconciledFinal(nativeTurn, exactIndex);
    turn.allAgentText = '';
  } else if (nativeTurn?.error?.message && !turn.finalText) {
    turn.finalText = `Codex App turn failed: ${String(nativeTurn.error.message)}`;
  }
  if (typeof nativeTurn?.id === 'string') {
    turn.nativeTurnId = nativeTurn.id;
    if (nativeActiveTurnId === nativeTurn.id) nativeActiveTurnId = undefined;
  }
  turn.completed = true;
  emitTurnActivity(turn, 'completed', true);
  turn.resolveDone();
}

function reportIdentityConflict(turn: ActiveTurn, observedNativeTurnId?: string, reason = 'no exact client id match'): void {
  if (activeTurn !== turn || turn.identityConflictReported) return;
  turn.identityConflictReported = true;
  const stableTurnId = turn.clientUserMessageId;
  const message = `Codex App native turn identity conflict (${reason}); refusing to attribute a completion without an exact clientUserMessageId match`;
  writeLine(`[codex-app] ${message}`);
  emitMarker('diagnostic', {
    code: 'native_turn_identity_conflict',
    message,
    ...(stableTurnId ? { turnId: stableTurnId } : {}),
    ...(turn.nativeTurnId ? { expectedNativeTurnId: turn.nativeTurnId } : {}),
    ...(observedNativeTurnId ? { observedNativeTurnId } : {}),
    atMs: Date.now(),
  });
  // Attribution failed closed, but the logical Botmux turn must still settle.
  // Leaving turn.done unresolved permanently poisons the runner FIFO and keeps
  // the session "busy" forever. Emit one explicit error final under the stable
  // client turn id; never reuse untrusted native text.
  turn.finalText = `Codex App turn failed: ${message}`;
  turn.allAgentText = '';
  if (turn.nativeTurnId && nativeActiveTurnId === turn.nativeTurnId) {
    nativeActiveTurnId = undefined;
  }
  turn.completed = true;
  emitTurnActivity(turn, 'completed', true);
  turn.resolveDone();
}

async function reconcileCompletedTurn(turn: ActiveTurn, observedNativeTurnId?: string): Promise<void> {
  if (turn.reconciliation || turn.completed) return turn.reconciliation;
  const clientUserMessageId = turn.clientUserMessageId;
  if (!clientUserMessageId || !threadId) {
    reportIdentityConflict(turn, observedNativeTurnId, 'legacy input has no clientUserMessageId');
    return;
  }
  const epoch = turn.epoch;
  const deadlineAtMs = Date.now() + RECONCILIATION_TIMEOUT_MS;
  turn.reconciliation = (async () => {
    const matches: Array<{ turn: JsonObject; itemIndex: number }> = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < RECONCILIATION_PAGE_LIMIT; page++) {
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) break;
      const result = await client.request('thread/turns/list', {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: RECONCILIATION_PAGE_SIZE,
        sortDirection: 'desc',
        itemsView: 'full',
      }, { timeoutMs: remaining });
      for (const candidate of Array.isArray(result?.data) ? result.data : []) {
        if (!isTerminalNativeTurn(candidate)) continue;
        const indexes = exactClientItemIndexes(candidate, clientUserMessageId);
        if (indexes.length === 1) matches.push({ turn: candidate, itemIndex: indexes[0] });
        else if (indexes.length > 1) {
          reportIdentityConflict(turn, observedNativeTurnId, 'client id appears more than once in one turn');
          return;
        }
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
      if (!cursor) break;
    }
    if (activeTurn !== turn || turn.epoch !== epoch || turn.completed) return;
    if (matches.length === 1) {
      completeActiveTurnFromNative(turn, matches[0].turn, matches[0].itemIndex);
      return;
    }
    reportIdentityConflict(
      turn,
      observedNativeTurnId,
      matches.length === 0 ? 'bounded history lookup found no match' : 'bounded history lookup found multiple matches',
    );
  })().catch(err => {
    if (activeTurn === turn && !turn.completed) {
      reportIdentityConflict(turn, observedNativeTurnId, `bounded history lookup failed: ${asError(err).message}`);
    }
  });
  await turn.reconciliation;
}

function handleNotification(msg: JsonObject, replayedAfterResponse = false): void {
  const params = msg.params ?? {};
  if (params.threadId !== threadId) return;
  const notificationTurnId = params.turnId ?? params.turn?.id;

  // Per-turn token usage rides on thread/tokenUsage/updated (NOT turn/completed).
  // Feed the accumulator for the matching native turn id; it is drained onto the
  // final marker under the same id when the turn's final transaction is emitted.
  if (msg.method === 'thread/tokenUsage/updated') {
    const usageTurnId = typeof notificationTurnId === 'string' && notificationTurnId.length > 0
      ? notificationTurnId
      : undefined;
    if (usageTurnId) {
      const usage = (params.tokenUsage ?? {}) as JsonObject;
      const parsed = parseTokenUsagePair(usage.total, usage.last);
      const acc = getOrCreateUsageAccumulator(usageTurnId);
      if (parsed) {
        acc.update(parsed.total, parsed.last);
      } else {
        // Malformed usage for a KNOWN turn: poison it (sticky). Silently skipping
        // would let a later valid notification rebuild a fresh baseline and report
        // only the last completion — a plausible-looking undercount. This also
        // covers asymmetric cacheWrite presence (total has it, last omits it or
        // vice-versa), where a 0-default would misattribute cache-create tokens.
        acc.poison('malformed tokenUsage notification');
      }
    } else {
      // No turnId to attribute usage to — can't fold it into any turn. Surface a
      // protocol warning rather than dropping it entirely silently.
      writeLine('[codex-app] tokenUsage notification without turnId (ignored)');
    }
    return;
  }

  if (msg.method === 'turn/started') {
    const startedId = typeof notificationTurnId === 'string' ? notificationTurnId : undefined;
    if (startedId && (!replayedAfterResponse
        || nativeActiveTurnId === undefined
        || nativeActiveTurnId === startedId)) nativeActiveTurnId = startedId;
    const turn = activeTurn;
    if (turn && startedId) {
      const exact = turn.clientUserMessageId
        ? exactClientItemIndexes(params.turn, turn.clientUserMessageId)
        : [];
      // B1/R4-B2: an exact-client `turn/started` proves the canonical native id
      // even before the turn/start response returns. First-proof-wins: bind only
      // if canonical is unset OR already this id; a different already-proven
      // canonical fences (contradiction). Same id opens the group + kicks.
      if (exact.length === 1) {
        if (!proveCanonicalExact(turn, startedId, 'exact_started')) return;
        if (!turn.nativeTurnId) turn.nativeTurnId = startedId;
        if (turn.phase === undefined || turn.phase === 'starting') turn.phase = 'open';
      }
      if (turn.nativeTurnId === startedId) {
        turn.serverStarted = true;
        emitTurnActivity(turn, 'progress', true);
        // Kick only when the canonical id is proven exact (not a bare id echo)
        // so a follow-up steers into the proven turn during a pending response.
        if ((turn.identityProof === 'exact_started' || turn.identityProof === 'exact_completed')
            && !turn.completed) void tryAdmitSteer();
        return;
      }
      // app-server is allowed to publish turn/started before replying to
      // turn/start. Without the response we do not yet know whether this is
      // our native turn, but dropping it also loses the first (and sometimes
      // only) progress edge. Replay it after the RPC binds nativeTurnId.
      if (!turn.requestAccepted && turn.requestKind === 'start') {
        const alreadyBufferedStart = turn.pendingNotifications.some(
          notification => notification.method === 'turn/started'
            && (notification.params?.turnId ?? notification.params?.turn?.id) === startedId,
        );
        if (!alreadyBufferedStart) turn.pendingNotifications.push(msg);
        return;
      }
    }
    // A Goal continuation is native work, not a Botmux turn. Keep the worker
    // busy while explicitly advertising that the initialized runner can accept
    // a Lark follow-up through turn/steer.
    if (runnerReady) emitRunnerState(true, false);
    return;
  }

  if (msg.method === 'turn/completed') {
    const nativeTurn = params.turn ?? {};
    const completedId = typeof notificationTurnId === 'string' ? notificationTurnId : undefined;
    if (completedId && nativeActiveTurnId === completedId) nativeActiveTurnId = undefined;
    const turn = activeTurn;
    if (!turn) {
      // An autonomous Goal turn finished with no tracked Botmux turn. If a
      // false-flag head was parked behind it (B3 gate), nativeActiveTurnId is
      // now cleared (line above) so re-kick the drain to start it as its own
      // turn — otherwise it would sleep forever. drainQueue no-ops when idle.
      if (runnerReady) emitRunnerState();
      if (queue.length > 0 && nativeActiveTurnId === undefined) void drainQueue();
      return;
    }
    // Group mode (R3): a steerable root that actually began ordered-steer work
    // routes EVERY completion through group-aware settlement — never the
    // single-turn completeActiveTurnFromNative / single-root reconcile, which
    // finalizeAcceptedGroup would then wrongly expand into N finals from a turn
    // that does not contain the whole group.
    if (inGroupMode(turn)) {
      turn.completionSeen = true;
      turn.steeringClosed = true;
      // A steer RPC racing this completion, or a still-pending root start
      // response, is a barrier: buffer and let that continuation settle the group
      // once it appends its member / binds canonical. (canonical-only barrier.)
      const isCanonical = turn.canonicalNativeTurnId !== undefined
        && completedId === turn.canonicalNativeTurnId;
      if (isCanonical) {
        turn.terminalCompletion = nativeTurn;
        if (turn.steerInFlight || turn.startResponsePending) {
          emitLifecycle({ kind: 'completion_race', appTurnId: completedId, category: 'steer_in_flight' });
          return;
        }
        settleSteeredCompletion(turn, nativeTurn);
        return;
      }
      // A NON-canonical completion cannot itself close the group. If a steer is
      // still racing / the start response is pending, wait for that continuation
      // (it may prove the canonical id). Otherwise scan bounded history for the
      // one terminal turn that contains the full ordered group; fail closed
      // (identity error, no foreign text) on 0 / multiple / partial matches.
      if (turn.steerInFlight || turn.startResponsePending) {
        emitLifecycle({ kind: 'completion_race', appTurnId: completedId ?? '', category: 'steer_in_flight' });
        return;
      }
      void reconcileSteeredGroupFromHistory(turn, completedId);
      return;
    }
    if (turn.nativeTurnId && completedId === turn.nativeTurnId) {
      const exact = turn.clientUserMessageId
        ? exactClientItemIndexes(nativeTurn, turn.clientUserMessageId)
        : [];
      // R3-B2: an exact-client completion arriving BEFORE the start response is
      // upgraded to canonical identity proof — atomically bind the canonical id,
      // set an independent proof, and require a late start response to match it.
      // Until that atomic upgrade, the completion is only a candidate (buffered);
      // it must never single-turn-settle here in a way a late response could then
      // silently overwrite. Only a steerable root can upgrade (Goal steer / plain
      // legacy keep the original single-turn behavior below).
      if (exact.length === 1
          && !turn.requestAccepted
          && turn.startResponsePending
          && turn.accepted?.[0]?.input.codexAppSteerable === true
          && typeof completedId === 'string') {
        // R4-B2 first-proof-wins: a prior exact proof for a DIFFERENT id fences;
        // same id is idempotent. Never overwrite an already-proven canonical.
        if (!proveCanonicalExact(turn, completedId, 'exact_completed')) return;
        turn.completionSeen = true;
        turn.steeringClosed = true;
        turn.terminalCompletion = nativeTurn;
        emitLifecycle({ kind: 'completion_race', appTurnId: completedId, category: 'steer_in_flight' });
        return;
      }
      if (exact.length === 1) {
        completeActiveTurnFromNative(turn, nativeTurn, exact[0]);
        return;
      }
      if (!turn.requestAccepted) {
        turn.pendingCompletions.push(nativeTurn);
        return;
      }
      if (turn.requestKind === 'steer') {
        void reconcileCompletedTurn(turn, completedId);
        return;
      }
      completeActiveTurnFromNative(turn, nativeTurn);
      return;
    }
    const exact = turn.clientUserMessageId
      ? exactClientItemIndexes(nativeTurn, turn.clientUserMessageId)
      : [];
    // R3-B2: an exact-client full-items completion arriving BEFORE the start
    // response binds nativeTurnId is upgraded to canonical identity proof for a
    // steerable root (atomic: bind canonical id + independent proof + buffer as
    // candidate + require the late response to match). It must NOT single-turn
    // settle here — a late response with a different id would otherwise be unable
    // to correct an already-settled wrong attribution. The response path fences
    // on id mismatch and settles the buffered candidate on match.
    if (exact.length === 1
        && !turn.requestAccepted
        && turn.startResponsePending
        && turn.accepted?.[0]?.input.codexAppSteerable === true
        && typeof completedId === 'string') {
      // R4-B2 first-proof-wins: a prior exact proof for a DIFFERENT id fences;
      // same id is idempotent. Never overwrite an already-proven canonical.
      if (!proveCanonicalExact(turn, completedId, 'exact_completed')) return;
      turn.completionSeen = true;
      turn.steeringClosed = true;
      turn.terminalCompletion = nativeTurn;
      emitLifecycle({ kind: 'completion_race', appTurnId: completedId, category: 'steer_in_flight' });
      return;
    }
    if (exact.length === 1) {
      completeActiveTurnFromNative(turn, nativeTurn, exact[0]);
      return;
    }
    if (!turn.requestAccepted) {
      turn.pendingCompletions.push(nativeTurn);
      return;
    }
    void reconcileCompletedTurn(turn, completedId);
    return;
  }

  const turn = activeTurn;
  if (!turn) return;
  if (!turn.requestAccepted) {
    // turn/start notifications may beat their response. Buffer only that
    // request's candidate native events and replay after the response chooses
    // the authoritative id. For turn/steer, pre-response events can be old
    // autonomous output and are deliberately never promoted into the final.
    if (turn.requestKind === 'start' && typeof notificationTurnId === 'string') {
      turn.pendingNotifications.push(msg);
    }
    return;
  }
  if (turn.nativeTurnId && notificationTurnId && notificationTurnId !== turn.nativeTurnId) return;

  // Every notification for the active app-server turn is evidence of forward
  // progress, including reasoning/status events that do not render text.
  emitTurnActivity(turn, 'progress');

  if (msg.method === 'item/started') {
    const item = params.item;
    if (item?.type === 'commandExecution') {
      writeLine(`\n$ ${item.command}`);
    } else if (item?.type === 'fileChange') {
      writeLine('\n[files changed]');
    }
    return;
  }

  if (msg.method === 'item/agentMessage/delta') {
    const delta = String(params.delta ?? '');
    const itemId = String(params.itemId ?? '');
    turn.itemText.set(itemId, (turn.itemText.get(itemId) ?? '') + delta);
    turn.allAgentText += delta;
    output.display(delta);
    return;
  }

  if (msg.method === 'item/commandExecution/outputDelta' || msg.method === 'item/fileChange/outputDelta') {
    output.display(String(params.delta ?? ''));
    return;
  }

  if (msg.method === 'item/completed') {
    const item = params.item;
    if (item?.type === 'agentMessage') {
      if (item.phase === 'final_answer') turn.finalText = String(item.text ?? '');
      else if (!turn.itemText.has(item.id) && item.text) {
        turn.allAgentText += String(item.text);
      }
    }
    return;
  }
}

function startupRequestTimeout(deadlineAtMs: number | undefined, method: string): number {
  if (deadlineAtMs === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) throw new AppServerRequestTimeoutError(method, 0);
  return remaining;
}

function isExplicitMissingThread(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  return /(thread|rollout|conversation).*(not found|does not exist|missing|unknown)|not found.*(thread|rollout|conversation)/i
    .test(error.message);
}

function isExplicitExpectedTurnInactive(error: unknown): boolean {
  return error instanceof AppServerRpcError
    && /(expected|active).*(turn).*(not active|no longer active|mismatch|does not match)|(turn).*(not active|no longer active).*(expected)/i
      .test(error.message);
}

/**
 * Whether an RPC error definitively proves the operation was NOT accepted — safe
 * to treat as a clean rejection (no fence, no in-doubt final). Mirrors the
 * controller's isDefiniteSteerRejection (nit): JSON-RPC parse/method/params
 * errors (-32600/-32601/-32602) prove non-acceptance, plus the app-server's
 * explicit "not steerable / expected turn" rejection phrases. Anything else
 * (transport, timeout, generic -32000, protocol anomaly) is an UNKNOWN outcome
 * that must fence rather than guess a disposition.
 */
function isDefiniteRpcRejection(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  if (error.code === -32600 || error.code === -32601 || error.code === -32602) return true;
  let dataText = '';
  try { dataText = JSON.stringify(error.data ?? '').toLowerCase(); } catch { /* untrusted data */ }
  const detail = `${error.message} ${dataText}`.toLowerCase();
  return detail.includes('no active turn to steer')
    || detail.includes('activeturnnotsteerable')
    || detail.includes('active turn not steerable')
    || detail.includes('expectedturnid')
    || detail.includes('expected turn id')
    || detail.includes('cannot steer a review turn')
    || detail.includes('cannot steer a compact turn')
    || detail.includes('input must not be empty')
    || isExplicitExpectedTurnInactive(error);
}

async function ensureThread(startupDeadlineAtMs?: number): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        // Intentionally NO model / model_reasoning_effort here: on resume the
        // app-server restores the thread's persisted {model, provider, effort}
        // triple, and sending any single override would short-circuit that
        // restoration (drifting model/provider to the current default). Per-turn
        // overrides are applied on the fresh thread/start below only. Mirrors the
        // RPC engine's resume contract (see codex-rpc-engine.resumeThread).
        config: { shell_environment_policy: { inherit: 'all' } },
        developerInstructions: appDeveloperInstructions(args),
        excludeTurns: true,
        // Keep Codex App's rich history in sync with turns created by this
        // external runner so the desktop UI can render follow-up messages.
        persistExtendedHistory: true,
      }, { timeoutMs: startupRequestTimeout(startupDeadlineAtMs, 'thread/resume') });
      const resumedThreadId = String(resumed.thread.id);
      threadId = resumedThreadId;
      threadReady = true;
      emitMarker('thread', { threadId: resumedThreadId });
      return resumedThreadId;
    } catch (err: any) {
      // A transport error or timeout is an ambiguous acceptance boundary. It
      // must never fork history by silently creating a fresh thread. Only an
      // explicit app-server "missing thread" rejection permits fallback.
      if (!isExplicitMissingThread(err)) throw err;
      writeLine(`[codex-app] resume failed, starting a fresh thread: ${err?.message ?? err}`);
      threadId = undefined;
      threadReady = false;
    }
  }

  const started = await client.request('thread/start', {
    cwd: args.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: {
      shell_environment_policy: { inherit: 'all' },
      // Per-turn reasoning effort → codex config key (ThreadStartParams accepts an
      // arbitrary config map). Codex 0.145 accepts low/medium/high/xhigh and echoes
      // xhigh back verbatim, so pass it through unchanged (no downgrade).
      ...(args.reasoningEffort ? { model_reasoning_effort: args.reasoningEffort } : {}),
    },
    // Per-turn model override → ThreadStartParams top-level model. Only set on a
    // fresh thread/start, so a fold-in (existing thread) keeps its frozen model —
    // matching the API's fresh-spawn-only override semantics.
    ...(args.model && args.model.trim() ? { model: args.model.trim() } : {}),
    serviceName: 'botmux',
    developerInstructions: appDeveloperInstructions(args),
    ephemeral: false,
    experimentalRawEvents: false,
    // Keep Codex App's rich history in sync with turns created by this
    // external runner so the desktop UI can render follow-up messages.
    persistExtendedHistory: true,
  }, { timeoutMs: startupRequestTimeout(startupDeadlineAtMs, 'thread/start') });
  const startedThreadId = String(started.thread.id);
  threadId = startedThreadId;
  threadReady = true;
  emitMarker('thread', { threadId: startedThreadId });
  void client.request('thread/name/set', {
      threadId: startedThreadId,
      name: `botmux ${args.sessionId.slice(0, 8)}`,
    }, { timeoutMs: 2_000 }).catch(() => { /* naming is cosmetic */ });
  return startedThreadId;
}

/** Emit a signed lifecycle marker (steer_attempt / steer_accepted / completion_race
 *  / unknown_outcome / fatal ...). The worker relays steer_accepted back to the
 *  daemon as a "收到,引导成功" edge and treats fatal as a control-generation kill. */
function emitLifecycle(event: JsonObject): void {
  emitMarker('lifecycle', { atMs: Date.now(), ...event });
}

/**
 * Fence the runner generation on an UNKNOWN turn/start|turn/steer outcome
 * (transport / rpc / protocol — never a definite rejection). This is a
 * control-plane action, not a log line: it emits a signed unknown_outcome + a
 * signed fatal so the worker calls failCodexAppControlGeneration, and it stops
 * every subsequent dequeue / steer / final / idle emission. It NEVER emits a
 * failure final — guessing a final would advance the worker FIFO past a turn
 * whose true disposition is unknown.
 */
function fenceUnknown(
  operation: 'turn/start' | 'turn/steer',
  category: 'transport' | 'rpc' | 'protocol',
  turn: ActiveTurn | null,
): void {
  if (generationFenced) return;
  generationFenced = true;
  if (turn) turn.phase = 'fenced';
  emitLifecycle({ kind: 'unknown_outcome', operation, category });
  emitLifecycle({ kind: 'fatal', operation, category });
  writeLine(`[codex-app] fenced generation on unknown ${operation} outcome (${category})`);
}

/**
 * First-proof-wins canonical binding for an exact-client proof (R4-B2). The
 * FIRST exact `turn/started` or exact `turn/completed` to prove the canonical
 * native id wins; any LATER exact proof carrying a DIFFERENT id is a protocol
 * anomaly (the app-server contradicted itself) → fence. The same id is
 * idempotent. Returns true if the caller may proceed (proof accepted / already
 * bound to same id), false if it fenced (caller must stop).
 */
function proveCanonicalExact(
  turn: ActiveTurn,
  id: string,
  proof: 'exact_started' | 'exact_completed',
): boolean {
  if (turn.canonicalNativeTurnId === undefined) {
    turn.canonicalNativeTurnId = id;
    turn.identityProof = proof;
    return true;
  }
  if (turn.canonicalNativeTurnId === id) return true; // idempotent, same proof id
  // A different exact id after canonical was already proven: contradiction.
  fenceUnknown('turn/start', 'protocol', turn);
  if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
  return false;
}

/**
 * Whether this turn is in "group mode": a steerable root that has actually begun
 * ordered-steer work (grew past its root, has a steer RPC in flight, or already
 * closed steering with an accepted member). In group mode EVERY completion and
 * failure path must be group-aware — a single-turn settle (completeActiveTurnFromNative
 * / single-root reconcile) followed by finalizeAcceptedGroup's N-final expansion
 * would mis-map a foreign/partial turn's content onto the last follower. A bare
 * steerable root that never steered is NOT in group mode (stays single-turn).
 */
function inGroupMode(turn: ActiveTurn): boolean {
  return turn.accepted?.[0]?.input.codexAppSteerable === true
    && (turn.steerInFlight !== undefined || (turn.accepted?.length ?? 0) > 1);
}

/**
 * Whether the runner may steer `head` into the active native turn right now.
 * Mirrors codex's canSteer contract (Blocking 1): the group must be open, its
 * canonical native id proven, no steer in flight, and BOTH the root and the
 * follow-up head explicitly authorized by the daemon admission gate. A Goal
 * root additionally requires its own matching steer to have been accepted.
 */
function canSteer(turn: ActiveTurn, head: QueuedInput): boolean {
  return !generationFenced
    && !turn.completed
    && turn.phase !== 'fenced'
    && turn.phase !== 'closing'
    && !turn.steeringClosed
    && !turn.steerInFlight
    && !steerAdmitting
    && turn.canonicalNativeTurnId !== undefined
    && turn.accepted !== undefined
    && turn.accepted.length > 0
    && turn.accepted[0].input.codexAppSteerable === true
    && head.codexAppSteerable === true;
}

/**
 * Verify a candidate terminal turn contains the full ordered steered-group
 * subsequence: EVERY member that actually sent a clientUserMessageId appears
 * exactly once, and those user-item indexes are strictly increasing in accepted
 * order. Returns the LAST member's item index on success (to rebuild the real
 * answer from it), or a reason string on failure. When no member sent a
 * clientId, or the turn has no full items, returns { lastIndex: -1 } (caller
 * trusts streamed text — matches the single-turn contract).
 */
function verifyGroupSubsequence(
  turn: ActiveTurn,
  nativeTurn: JsonObject,
): { lastIndex: number } | { reason: string } {
  const sentIdMembers = (turn.accepted ?? []).filter(m => m.clientUserMessageId);
  if (nativeTurn?.itemsView !== 'full' || sentIdMembers.length === 0) return { lastIndex: -1 };
  let previousIndex = -1;
  for (const member of sentIdMembers) {
    const indexes = exactClientItemIndexes(nativeTurn, member.clientUserMessageId!);
    if (indexes.length !== 1 || indexes[0] <= previousIndex) {
      return {
        reason: indexes.length === 0
          ? 'steered group member missing from terminal turn items'
          : indexes.length > 1
            ? 'steered group member appears more than once in terminal turn'
            : 'steered group members are out of order in terminal turn',
      };
    }
    previousIndex = indexes[0];
  }
  return { lastIndex: previousIndex };
}

/**
 * Settle a steered group against a terminal turn already proven to be its
 * canonical completion (completedId === canonicalNativeTurnId). Resolves
 * `turn.done` exactly once; runTurn then expands the group into N finals.
 *
 * B5 group-aware identity defense: EVERY member that sent a clientUserMessageId
 * must appear exactly once in strictly-increasing order (verifyGroupSubsequence);
 * the real answer is rebuilt from the LAST member's user item so a prior
 * member's agent text is never mistaken for the final reply. Any violation fails
 * closed via reportIdentityConflict — the settled final then carries an explicit
 * identity error, never foreign model text.
 */
function settleSteeredCompletion(turn: ActiveTurn, nativeTurn: JsonObject): void {
  if (activeTurn !== turn || turn.completed) return;
  const verdict = verifyGroupSubsequence(turn, nativeTurn);
  if ('reason' in verdict) {
    reportIdentityConflict(
      turn,
      typeof nativeTurn?.id === 'string' ? nativeTurn.id : undefined,
      verdict.reason,
    );
    return;
  }
  if (verdict.lastIndex >= 0) {
    // Rebuild the real answer from the LAST accepted member's user item.
    turn.finalText = rebuildReconciledFinal(nativeTurn, verdict.lastIndex);
    turn.allAgentText = '';
  }
  turn.terminalCompletion = nativeTurn;
  if (typeof nativeTurn?.id === 'string' && nativeActiveTurnId === nativeTurn.id) {
    nativeActiveTurnId = undefined;
  }
  turn.completed = true;
  turn.phase = 'closing';
  emitTurnActivity(turn, 'completed', true);
  turn.resolveDone();
}

/**
 * Group-aware bounded-history reconcile (codex R3 boundary): a group-mode turn
 * received a completion whose native id is NOT its canonical id. A non-canonical
 * completion cannot itself close the group — instead scan bounded history for the
 * ONE terminal turn that contains the full ordered group subsequence. Only a
 * unique complete match settles (rebuilding the real answer from its last
 * member). Zero / multiple / partial (root-only) matches fail closed with an
 * explicit identity error that carries NO foreign model text — never expand a
 * follower final from a turn that does not contain the whole group.
 */
async function reconcileSteeredGroupFromHistory(
  turn: ActiveTurn,
  observedNativeTurnId?: string,
): Promise<void> {
  if (turn.reconciliation || turn.completed) return turn.reconciliation;
  if (!threadId) {
    reportIdentityConflict(turn, observedNativeTurnId, 'steered group reconcile has no thread');
    return;
  }
  const epoch = turn.epoch;
  const deadlineAtMs = Date.now() + RECONCILIATION_TIMEOUT_MS;
  turn.reconciliation = (async () => {
    const matches: Array<{ turn: JsonObject; lastIndex: number }> = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < RECONCILIATION_PAGE_LIMIT; page++) {
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) break;
      const result = await client.request('thread/turns/list', {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: RECONCILIATION_PAGE_SIZE,
        sortDirection: 'desc',
        itemsView: 'full',
      }, { timeoutMs: remaining });
      for (const candidate of Array.isArray(result?.data) ? result.data : []) {
        if (!isTerminalNativeTurn(candidate)) continue;
        const verdict = verifyGroupSubsequence(turn, candidate);
        // Only a turn containing the FULL ordered group counts. A root-only turn
        // yields a 'reason' (later members missing) and is skipped, never matched.
        if ('lastIndex' in verdict && verdict.lastIndex >= 0) {
          matches.push({ turn: candidate, lastIndex: verdict.lastIndex });
        }
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
      if (!cursor) break;
    }
    if (activeTurn !== turn || turn.epoch !== epoch || turn.completed) return;
    if (matches.length === 1) {
      const { turn: matched, lastIndex } = matches[0];
      turn.finalText = rebuildReconciledFinal(matched, lastIndex);
      turn.allAgentText = '';
      turn.terminalCompletion = matched;
      // R4-B3: the matched turn is now the authoritative native identity for this
      // group — the final marker, native id, and usage drain must all key off
      // matched.id, not the stale pre-history canonical. Compare-and-clear the OLD
      // canonical from the global native-busy slot ONLY if it is still the head
      // there; if a newer autonomous Goal C has since claimed nativeActiveTurnId,
      // leave C untouched (never clear/overwrite a newer lifecycle).
      if (typeof matched?.id === 'string') {
        const priorCanonical = turn.canonicalNativeTurnId;
        if (priorCanonical !== undefined && nativeActiveTurnId === priorCanonical) {
          nativeActiveTurnId = undefined;
        }
        turn.nativeTurnId = matched.id;
        turn.canonicalNativeTurnId = matched.id;
        if (nativeActiveTurnId === matched.id) nativeActiveTurnId = undefined;
      }
      turn.completed = true;
      turn.phase = 'closing';
      emitTurnActivity(turn, 'completed', true);
      turn.resolveDone();
      return;
    }
    reportIdentityConflict(
      turn,
      observedNativeTurnId,
      matches.length === 0
        ? 'steered group: no terminal turn contains the full ordered group'
        : 'steered group: multiple terminal turns match the full group',
    );
  })().catch(err => {
    if (activeTurn === turn && !turn.completed) {
      reportIdentityConflict(turn, observedNativeTurnId, `steered group history lookup failed: ${asError(err).message}`);
    }
  });
  await turn.reconciliation;
}


/**
 * Opportunistically admit the queue head as a pre-final `turn/steer` into the
 * active steerable group (Blocking 1). Kicked from enqueueLine, from runTurn
 * once the root's canonical id is proven, and re-kicked after each success to
 * chain successive follow-ups. At most one steer RPC runs at a time
 * (steerAdmitting + steerInFlight). The queue head is shifted ONLY after the
 * steer is accepted; a definite rejection closes steering; an unknown outcome
 * fences the generation (never falls back to a fresh start that would reorder).
 */
async function tryAdmitSteer(): Promise<void> {
  const turn = activeTurn;
  if (!turn) return;
  const head = queue[0];
  if (!head || !canSteer(turn, head)) return;
  steerAdmitting = true;
  const expectedTurnId = turn.canonicalNativeTurnId!;
  const replyTurnId = head.replyTurnId;
  const version = head.codexAppInput ? detectedCodexVersion() : undefined;
  const requestClientId = head.codexAppInput
    && !cleanInputUnsupported
    && supportsClientUserMessageId(version)
    && replyTurnId
    ? replyTurnId
    : head.codexAppInput?.clientUserMessageId;
  const dispatch: Dispatch = {
    input: head,
    ...(replyTurnId ? { replyTurnId } : {}),
    ...(requestClientId ? { clientUserMessageId: requestClientId } : {}),
    receivedAtMs: head.receivedAtMs ?? Date.now(),
  };
  turn.steerInFlight = { dispatch, expectedTurnId };
  const built = buildCodexAppTurnStartParams({
    threadId: threadId!,
    cwd: args.cwd,
    legacyContent: head.content,
    codexAppInput: head.codexAppInput,
    codexVersion: version,
    structuredDisabled: cleanInputUnsupported,
  });
  if (built.structured && requestClientId) built.params.clientUserMessageId = requestClientId;
  // steer_attempt/steer_accepted share appTurnId (the canonical native id) so the
  // worker can correlate them; replyTurnId selects the follow-up's reply routing.
  emitLifecycle({
    kind: 'steer_attempt',
    appTurnId: expectedTurnId,
    ...(replyTurnId ? { replyTurnId } : {}),
  });
  let result: any;
  try {
    const { input, clientUserMessageId, additionalContext } = built.params;
    result = await client.request('turn/steer', {
      threadId: threadId!,
      input,
      expectedTurnId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    });
  } catch (err) {
    turn.steerInFlight = undefined;
    steerAdmitting = false;
    if (isDefiniteRpcRejection(err)) {
      // Definite rejection (nit: full controller rejection vocabulary, incl.
      // -32600/-32601/-32602 and the explicit "not steerable / expected turn"
      // phrases): the head did NOT land. Do not shift/append. Close steering;
      // once this native turn completes the head starts its own turn.
      turn.steeringClosed = true;
      emitLifecycle({ kind: 'steer_rejected_fallback', appTurnId: expectedTurnId, category: 'definite_rejection' });
      if (turn.completionSeen && turn.terminalCompletion) settleSteeredCompletion(turn, turn.terminalCompletion);
      return;
    }
    // Unknown outcome (transport/timeout/generic rpc/protocol): fence — never
    // guess a final for a turn whose acceptance is in doubt.
    const category = err instanceof AppServerRpcError ? 'rpc' : 'transport';
    fenceUnknown('turn/steer', category, turn);
    if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
    return;
  }
  // Only `result.turnId === expectedTurnId` proves acceptance into this group.
  if (result?.turnId !== expectedTurnId) {
    turn.steerInFlight = undefined;
    steerAdmitting = false;
    fenceUnknown('turn/steer', 'protocol', turn);
    if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
    return;
  }
  // The accepted steer must correspond to the exact queue head we sent (nit): a
  // divergence means an out-of-band mutation reordered the FIFO under us, so the
  // append below would attribute this acceptance to the wrong input. Fence
  // rather than silently append a mismatched member.
  if (queue[0] !== head) {
    turn.steerInFlight = undefined;
    steerAdmitting = false;
    fenceUnknown('turn/steer', 'protocol', turn);
    if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
    return;
  }
  queue.shift();
  turn.accepted!.push(dispatch);
  turn.steerInFlight = undefined;
  steerAdmitting = false;
  emitLifecycle({
    kind: 'steer_accepted',
    appTurnId: expectedTurnId,
    ...(replyTurnId ? { replyTurnId } : {}),
  });
  // A completion may have arrived while this steer was in flight (barrier): settle
  // now that the group is final. Otherwise chain the next queued follow-up.
  if (turn.completionSeen && turn.terminalCompletion) {
    settleSteeredCompletion(turn, turn.terminalCompletion);
    return;
  }
  void tryAdmitSteer();
}

/**
 * Emit the final transaction(s) for a completed native turn, expanding the
 * ordered `accepted` group into N signed finals (Blocking 1, decision A/B/C).
 *
 * - N === 1 (every existing path: single start, Goal-steer root, legacy): emits
 *   exactly one final, byte-identical to the pre-driver single-final contract.
 * - N > 1 (a plain-Lark root that absorbed pre-final `turn/steer` follow-ups):
 *   the FIRST N−1 members get an empty `steer_superseded` final (no content, no
 *   usage, not delivered — only advances the worker FIFO); the LAST member owns
 *   the real model answer + usage. The real final's startedAtMs is the last
 *   accepted dispatch's receivedAtMs so an early botmux-send marker from before
 *   the follow-up arrived cannot suppress the true answer.
 *
 * A fenced turn (unknown outcome) emits ZERO finals — the signed fatal lifecycle
 * already tore the generation down; guessing a final would advance the FIFO.
 */
function finalizeAcceptedGroup(turn: ActiveTurn): void {
  if (turn.phase === 'fenced') return;
  const group = turn.accepted && turn.accepted.length > 0
    ? turn.accepted
    : [{ input: { content: '' }, receivedAtMs: turn.startedAtMs } as Dispatch];
  const finalText = (turn.finalText || turn.allAgentText).trim();
  const completedAtMs = Date.now();
  const lastIndex = group.length - 1;
  for (let index = 0; index < group.length; index++) {
    const dispatch = group[index];
    const isReal = index === lastIndex;
    const replyTurnId = dispatch.replyTurnId;
    emitFinalMarker({
      ...(replyTurnId ? { turnId: replyTurnId } : {}),
      ...(turn.nativeTurnId ? { nativeTurnId: turn.nativeTurnId } : {}),
      content: isReal ? finalText : '',
      // The real answer's clock starts at the LAST accepted dispatch so a
      // botmux-send marker emitted before the follow-up landed cannot race
      // ahead and suppress it. A single-member group keeps the turn's own
      // startedAtMs (byte-identical to the pre-driver contract).
      startedAtMs: isReal
        ? (group.length > 1 ? dispatch.receivedAtMs : turn.startedAtMs)
        : turn.startedAtMs,
      completedAtMs,
    }, isReal ? {} : { disposition: 'steer_superseded' });
  }
}

async function runTurn(message: QueuedInput): Promise<void> {
  const tid = await ensureThread();
  // The botmux/Lark reply identity is the top-level replyTurnId (which already
  // fell back to the sidecar clientUserMessageId at decode time). This is the id
  // exposed on the final marker for reply routing; the app-server's native turn
  // id is tracked separately as nativeTurnId.
  const replyTurnId = message.replyTurnId;
  const version = message.codexAppInput ? detectedCodexVersion() : undefined;
  // When structured input is supported, thread the reply id through as the
  // request's clientUserMessageId so app-server echoes it as item.clientId
  // (used for exact native-turn attribution). Mirrors master's prepareControllerInput.
  const requestClientId = message.codexAppInput
    && !cleanInputUnsupported
    && supportsClientUserMessageId(version)
    && replyTurnId
    ? replyTurnId
    : message.codexAppInput?.clientUserMessageId;
  let expectedSteerTurnId = nativeActiveTurnId;
  const turn = makeTurn(requestClientId, expectedSteerTurnId ? 'steer' : 'start');
  // The root dispatch is accepted[0]. Follow-up Lark inputs that win a pre-final
  // turn/steer are appended by the steer-admission path; at native completion
  // finalizeAcceptedGroup expands the group into N signed finals.
  turn.accepted = [{
    input: message,
    ...(replyTurnId ? { replyTurnId } : {}),
    ...(requestClientId ? { clientUserMessageId: requestClientId } : {}),
    receivedAtMs: message.receivedAtMs ?? turn.startedAtMs,
  }];
  if (expectedSteerTurnId) {
    turn.nativeTurnId = expectedSteerTurnId;
    turn.serverStarted = true;
  } else {
    // B1: a plain start request is outstanding. startResponsePending is SEPARATE
    // from steerInFlight — an exact `turn/started` can prove the canonical id and
    // open pre-final steering while this start response is still pending, and a
    // late start response must still bind/verify the same canonical id.
    turn.startResponsePending = true;
  }
  activeTurn = turn;
  // This edge proves the runner decoded and dequeued Botmux's control line,
  // even if app-server stalls before acknowledging turn/start.
  emitTurnActivity(turn, 'submitted', true);
  let built = buildCodexAppTurnStartParams({
    threadId: tid,
    cwd: args.cwd,
    legacyContent: message.content,
    codexAppInput: message.codexAppInput,
    codexVersion: version,
    structuredDisabled: cleanInputUnsupported,
  });
  // Override the built clientUserMessageId with the reply id when the sidecar
  // omitted one (e.g. a top-level replyTurnId with no clientUserMessageId).
  if (built.structured && requestClientId) {
    built.params.clientUserMessageId = requestClientId;
  }
  if (message.codexAppInput && !built.structured && !cleanInputUnsupported && !cleanVersionWarningShown) {
    cleanVersionWarningShown = true;
    const found = version ? `${version.major}.${version.minor}.${version.patch}` : 'unknown';
    writeLine(`[codex-app] clean input requires codex >= 0.135.0 (found ${found}); using legacy prompt`);
  }
  for (const path of built.skippedImages) {
    writeLine(`[codex-app] skipped unreadable local image: ${path}`);
  }
  writeLine();
  writeLine('[user]');
  writeLine(built.structured && message.codexAppInput ? message.codexAppInput.text : message.content);
  writeLine();

  const requestBuiltTurn = (candidate: typeof built): Promise<any> => {
    if (!expectedSteerTurnId) return client.request('turn/start', candidate.params);
    const { threadId, input, clientUserMessageId, additionalContext } = candidate.params;
    return client.request('turn/steer', {
      threadId,
      input,
      expectedTurnId: expectedSteerTurnId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    });
  };

  let result: any;
  let capabilityRetried = false;
  let inactiveSteerFallback = false;
  for (;;) {
    try {
      result = await requestBuiltTurn(built);
      break;
    } catch (err) {
      if (expectedSteerTurnId
          && !inactiveSteerFallback
          && nativeActiveTurnId === undefined
          && isExplicitExpectedTurnInactive(err)) {
        // turn/steer was explicitly rejected before acceptance and the signed
        // native completion already proved the captured Goal turn is gone.
        // Starting the same client-id input is safe; timeout/transport/generic
        // errors never enter this branch.
        inactiveSteerFallback = true;
        expectedSteerTurnId = undefined;
        turn.requestKind = 'start';
        turn.nativeTurnId = undefined;
        turn.serverStarted = false;
        turn.pendingCompletions.length = 0;
        turn.pendingNotifications.length = 0;
        turn.finalText = '';
        turn.allAgentText = '';
        turn.itemText.clear();
        writeLine('[codex-app] captured native turn completed before steer acceptance; starting the same client-id input as a new turn');
        continue;
      }
      if (capabilityRetried
          || !built.structured
          || (!expectedSteerTurnId && turn.serverStarted)
          || !isCleanInputCapabilityError(err)) {
        // Nit: the fenced RPC's operation reflects what we actually sent — a Goal
        // root steers (expectedSteerTurnId set), a plain root starts — so the
        // signed unknown_outcome/fatal diagnostic is accurate.
        const fenceOperation: 'turn/start' | 'turn/steer' = expectedSteerTurnId ? 'turn/steer' : 'turn/start';
        // R3-B1 fail-closed on positive evidence: once ANY evidence exists that
        // this native turn may have started or grown — an exact `turn/started`
        // proof, a server-started edge, or an already-accepted follow-up (group
        // grew past its root) — a start-RPC failure of ANY kind (even an explicit
        // RPC error) must FENCE, never synthesize a failure final. Synthesizing a
        // single root failure would (a) misreport an actually-started turn and
        // (b) if a follow-up was already steer-accepted and shifted, settle only
        // the root and strand the follow-up in the worker FIFO (poison). The
        // durable recovery contract has no authoritative response record proving
        // this generation can safely continue, so we tear it down.
        const positiveEvidence = turn.serverStarted
          || turn.identityProof !== undefined
          || turn.canonicalNativeTurnId !== undefined
          || (turn.accepted?.length ?? 0) > 1;
        if (positiveEvidence) {
          fenceUnknown(fenceOperation, err instanceof AppServerRpcError ? 'rpc' : 'transport', turn);
          if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
          return;
        }
        // No positive evidence yet. A non-RPC failure (timeout / transport drop)
        // leaves acceptance genuinely UNKNOWN → fence. An explicit server error
        // response (any AppServerRpcError, e.g. -32000 "model overloaded")
        // definitively proves the turn did NOT run → stays on the
        // throw→failure-final path (a clean, safely-attributed failure).
        if (!(err instanceof AppServerRpcError)) {
          fenceUnknown(fenceOperation, 'transport', turn);
          if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
          return;
        }
        throw err;
      }
      // The app-server explicitly rejected the experimental field before a turn
      // started. Disable structured input for this runner lifetime and retry the
      // preserved legacy prompt exactly once.
      capabilityRetried = true;
      cleanInputUnsupported = true;
      writeLine('[codex-app] clean input unsupported by app-server; retrying this turn with the legacy prompt');
      built = buildCodexAppTurnStartParams({
        threadId: tid,
        cwd: args.cwd,
        legacyContent: message.content,
        codexAppInput: message.codexAppInput,
        codexVersion: version,
        structuredDisabled: true,
      });
    }
  }
  const responseNativeId = result.turn?.id ?? result.turnId ?? turn.nativeTurnId;
  // B1/R4-B2 late start response: if an exact proof (turn/started OR completed)
  // already bound a canonical id, the start response MUST match it — a divergent
  // id is a protocol anomaly whose true turn is unknown → fence, never bind a
  // second id. Otherwise the start response is what proves canonical.
  if ((turn.identityProof === 'exact_started' || turn.identityProof === 'exact_completed')
      && turn.canonicalNativeTurnId
      && responseNativeId
      && responseNativeId !== turn.canonicalNativeTurnId) {
    turn.startResponsePending = false;
    fenceUnknown('turn/start', 'protocol', turn);
    if (!turn.completed) { turn.completed = true; turn.resolveDone(); }
    return;
  }
  turn.nativeTurnId = responseNativeId;
  turn.requestAccepted = true;
  turn.startResponsePending = false;
  // The root request is accepted → its native id is now canonical for the group,
  // so pre-final follow-up steers may bind against it (canSteer). A plain start
  // is proven by its start-response; a Goal-continuation root is proven by the
  // accepted matching steer (identityProof left as the Goal snapshot). An exact
  // `turn/started` may already have upgraded identityProof to 'exact_started'.
  if (!turn.completed && turn.nativeTurnId) {
    turn.canonicalNativeTurnId = turn.nativeTurnId;
    if (!turn.identityProof) {
      turn.identityProof = turn.requestKind === 'steer' ? 'goal_snapshot' : 'start_response';
    }
    if (turn.phase === undefined || turn.phase === 'starting') turn.phase = 'open';
  }
  // A response may arrive after its turn completed or after a Goal
  // continuation B already started. Never resurrect the completed lifecycle,
  // and never let late response A overwrite the newer global lifecycle. If A
  // is still pending and no newer turn exists, temporarily restoring A is safe
  // because the buffered A completion below clears it immediately.
  if (!turn.completed
      && turn.nativeTurnId
      && (nativeActiveTurnId === undefined || nativeActiveTurnId === turn.nativeTurnId)) {
    nativeActiveTurnId = turn.nativeTurnId;
  }
  // B4: replay buffered notifications/completions BEFORE any steer kick. A
  // completion buffered during the RPC (completion-before-response) must set
  // completionSeen / close steering here so the kick below sees a closed group
  // and refuses — otherwise we would steer into an already-completed turn.
  // B1+B4 / R3-B2: if a completion was buffered as a barrier while this start
  // response was pending — either a grown steered group (completion_race), or a
  // single steerable root whose exact-completion was upgraded to canonical proof
  // before the response — settle it now that the response resolved and matched
  // the canonical id. settleSteeredCompletion verifies the ordered group
  // subsequence (1-member is a valid group) and fails closed on any mismatch, so
  // a foreign/partial buffered completion can never expand a wrong final.
  // R4-B2 defense-in-depth: the buffered terminal's id MUST equal the proven
  // canonical id before we settle from it — a first-proof-wins violation upstream
  // would otherwise let terminal A's content ship under a different native id.
  const bufferedTerminalMatchesCanonical = turn.terminalCompletion !== undefined
    && (typeof turn.terminalCompletion.id !== 'string'
      || turn.terminalCompletion.id === turn.canonicalNativeTurnId);
  const settleBufferedCanonical = !turn.completed
    && turn.completionSeen
    && turn.terminalCompletion
    && !turn.steerInFlight
    && bufferedTerminalMatchesCanonical
    && turn.accepted?.[0]?.input.codexAppSteerable === true
    && ((turn.accepted?.length ?? 0) > 1
      || turn.identityProof === 'exact_started'
      || turn.identityProof === 'exact_completed');
  if (settleBufferedCanonical) {
    settleSteeredCompletion(turn, turn.terminalCompletion!);
  }
  const pendingNotifications = turn.pendingNotifications.splice(0);
  for (const notification of pendingNotifications) {
    const notificationTurnId = notification.params?.turnId ?? notification.params?.turn?.id;
    if (notificationTurnId === turn.nativeTurnId) handleNotification(notification, true);
  }
  const pendingCompletions = turn.pendingCompletions.splice(0);
  if (pendingCompletions.length > 0 && !turn.completed) {
    const attributionClientId = turn.clientUserMessageId;
    const exactMatches = attributionClientId
      ? pendingCompletions.flatMap(completion => {
          const indexes = exactClientItemIndexes(completion, attributionClientId);
          return indexes.length === 1 ? [{ completion, itemIndex: indexes[0] }] : [];
        })
      : [];
    const nativeMatches = pendingCompletions.filter(
      completion => completion?.id === turn.nativeTurnId,
    );
    if (exactMatches.length === 1) {
      completeActiveTurnFromNative(turn, exactMatches[0].completion, exactMatches[0].itemIndex);
    } else if (exactMatches.length > 1 || nativeMatches.length > 1) {
      reportIdentityConflict(turn, turn.nativeTurnId, 'multiple pre-response completions matched one request');
    } else if (turn.requestKind === 'steer' && nativeMatches.length === 1) {
      void reconcileCompletedTurn(turn, turn.nativeTurnId);
    } else if (turn.requestKind === 'start' && nativeMatches.length === 1) {
      completeActiveTurnFromNative(turn, nativeMatches[0]);
    }
  }
  // B4: only NOW, after buffered completions were replayed, admit a follow-up.
  // A follow-up that arrived during the RPC (before canonical was proven) steers
  // here; if the group already closed (completion-before-response), canSteer
  // refuses and it stays serial. Never kick before the replay above.
  if (!turn.completed) void tryAdmitSteer();
  await turn.done;

  // Expand the ordered accepted group into N signed finals (N===1 for every
  // pre-driver path — single start, Goal-steer root, legacy — byte-identical to
  // the old single-final contract). clientUserMessageId is the daemon-frozen
  // botmux/Lark turn identity; the app-server generates a different native id
  // for the same logical turn, exposing which as `turnId` would break daemon
  // wait maps / VC suppression / reply routing. When no structured sidecar
  // exists, turnId is omitted so the worker resolves it from its own FIFO head.
  finalizeAcceptedGroup(turn);
  writeLine();
  activeTurn = null;
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      // A fenced generation must not consume any more input: an unknown
      // turn/start|turn/steer outcome left a head whose disposition is unknown,
      // and starting the next queued input would submit against a poisoned FIFO.
      // The signed fatal already tore the generation down; stop draining.
      if (generationFenced) break;
      // Goal gate (B3): while an autonomous Goal continuation is native-busy,
      // only a daemon-authorized steerable head may enter it (as a Goal-steer
      // root). A missing/false-flag head must stay serial — leave it in the
      // queue and wait for the Goal to complete, at which point turn/completed's
      // no-active-turn branch re-kicks drainQueue so the head starts its own
      // turn. Without this a special-sink / non-interactive input would be
      // silently merged into the Goal turn and its output mis-delivered.
      if (nativeActiveTurnId !== undefined && queue[0].codexAppSteerable !== true) {
        break;
      }
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err: any) {
        // A fenced generation already emitted the signed unknown_outcome+fatal;
        // never synthesize a failure final on top (it would advance the worker
        // FIFO past a turn whose true disposition is unknown).
        if (generationFenced) { activeTurn = null; break; }
        const message = `Codex App runner error: ${err?.message ?? err}`;
        const completedAtMs = Date.now();
        const replyTurnId = next.replyTurnId;
        const nativeTurnId = activeTurn?.nativeTurnId;
        writeLine(message);
        emitFinalMarker({
          ...(replyTurnId ? { turnId: replyTurnId } : {}),
          ...(nativeTurnId ? { nativeTurnId } : {}),
          content: message,
          startedAtMs: activeTurn?.startedAtMs ?? completedAtMs,
          completedAtMs,
        });
        activeTurn = null;
      }
      // Do not publish a transient idle boundary between inputs already queued
      // in the serial runner. Once the queue is truly empty, append signed
      // busy:false only AFTER completed + every final fragment. The worker can
      // therefore become ready even if the terminal prompt is lost, while its
      // IPC order remains final_output before prompt_ready.
      //
      // A queue that is non-empty only because its head is a false-flag input
      // parked behind an active Goal (the B3 gate above) is NOT drainable now:
      // treat it like an empty queue so the runner still advertises native-busy
      // and never wedges without an idle/ready edge.
      const parkedBehindGoal = queue.length > 0
        && nativeActiveTurnId !== undefined
        && queue[0].codexAppSteerable !== true;
      if (queue.length === 0 || parkedBehindGoal) {
        const nativeBusy = nativeActiveTurnId !== undefined;
        emitRunnerState(nativeBusy, !nativeBusy);
        if (!nativeBusy) prompt();
      }
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('::botmux-codex-app:')) {
    const encoded = trimmed.slice('::botmux-codex-app:'.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        const codexAppInput = isCodexAppTurnInput(decoded.codexAppInput)
          ? decoded.codexAppInput
          : undefined;
        if (decoded.codexAppInput !== undefined && !codexAppInput) {
          writeLine('[codex-app] ignored invalid structured input sidecar');
        }
        // Reply routing identity: prefer the top-level replyTurnId, else fall
        // back to the structured sidecar's clientUserMessageId (mirrors the
        // shared decodeCodexAppRunnerInput contract).
        const replyTurnId = typeof decoded.replyTurnId === 'string' && decoded.replyTurnId.length > 0
          ? decoded.replyTurnId
          : codexAppInput?.clientUserMessageId;
        // Explicit positive only: the daemon admission gate (decision A) sets
        // `true` solely for a plain-human-interactive turn. Any other value is
        // treated as absent → forced serial, never a silent steer authorization.
        const codexAppSteerable = decoded.codexAppSteerable === true;
        queue.push({
          content: decoded.content,
          codexAppInput,
          ...(replyTurnId ? { replyTurnId } : {}),
          ...(codexAppSteerable ? { codexAppSteerable: true } : {}),
          receivedAtMs: Date.now(),
        });
        // If a steerable group is active, opportunistically steer this head into
        // it (pre-final). Otherwise fall through to the serial drain, which
        // starts it as its own turn once the runner is idle. drainQueue's
        // `await runTurn(root)` keeps the root active until its group settles, so
        // a head consumed by tryAdmitSteer is never double-processed by drain.
        void tryAdmitSteer();
        void drainQueue();
      }
    } catch (err: any) {
      writeLine(`[codex-app] bad botmux input: ${err?.message ?? err}`);
    }
    return;
  }
  queue.push({ content: line });
  void drainQueue();
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    if (ch === '\u0003') {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (ch === '\u007f' || ch === '\b') {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  const testTimeout = process.env.NODE_ENV === 'test'
    ? Number(process.env.BOTMUX_TEST_CODEX_APP_STARTUP_TIMEOUT_MS)
    : Number.NaN;
  const startupTimeoutMs = Number.isFinite(testTimeout) && testTimeout > 0
    ? testTimeout
    : 90_000;
  const startupDeadlineAtMs = Date.now() + startupTimeoutMs;
  const authTimeout = armCodexAppControlStartupTimeout(() => {
    console.error('Codex App startup timed out before the first signed runner state');
    process.exit(2);
  }, startupTimeoutMs);
  await controlReady;
  client = new AppServerClient(args.codexBin, args.cwd);
  client.onRequest(handleServerRequest);
  client.onNotification(handleNotification);
  await client.initialize(startupRequestTimeout(startupDeadlineAtMs, 'initialize'));
  await ensureThread(startupDeadlineAtMs);
  writeLine('Codex App connected.');
  runnerReady = true;
  // Initial readiness is signed too; never rely on terminal rendering as the
  // only path that releases the worker's first-prompt gate.
  emitRunnerState(false);
  // Authentication is deliberately insufficient. Keep the absolute startup
  // timer armed through initialize + resume/start and the first signed state.
  clearTimeout(authTimeout);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => {
  if (controlReconnectTimer) clearTimeout(controlReconnectTimer);
  controlSocket?.destroy();
  client?.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (controlReconnectTimer) clearTimeout(controlReconnectTimer);
  controlSocket?.destroy();
  client?.close();
  process.exit(130);
});

main().catch(err => {
  if (!runnerReady && err instanceof AppServerRequestTimeoutError) {
    output.error('Codex App startup timed out before the first signed runner state\n');
    process.exit(2);
  }
  output.error(`${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
});
