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
}

interface QueuedInput {
  content: string;
  codexAppInput?: CodexAppTurnInput;
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
        ? '\nHint: install the Codex CLI, or set cliPathOverride to the Codex App bundled binary, for example /Applications/Codex.app/Contents/Resources/codex.'
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

  private onStdout(data: string): void {
    this.stdoutBuffer += data;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonObject;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
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

function emitFinalMarker(payload: JsonObject): void {
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
  emitMarker('final-start', { id, total, truncated, ...metadata });
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
let runnerReady = false;
let cleanInputUnsupported = false;
let codexVersionChecked = false;
let codexVersion: CodexVersion | undefined;
let cleanVersionWarningShown = false;

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
      if (!turn.nativeTurnId && exact.length === 1) turn.nativeTurnId = startedId;
      if (turn.nativeTurnId === startedId) {
        turn.serverStarted = true;
        emitTurnActivity(turn, 'progress', true);
        return;
      }
      // app-server is allowed to publish turn/started before replying to
      // turn/start. Without the response we do not yet know whether this is
      // our native turn, but dropping it also loses the first (and sometimes
      // only) progress edge. Replay it after the RPC binds nativeTurnId.
      if (!turn.requestAccepted && turn.requestKind === 'start') {
        const alreadyBufferedStart = turn.pendingNotifications.some(
          notification => notification.method === 'turn/started',
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
      if (runnerReady) emitRunnerState();
      return;
    }
    if (turn.nativeTurnId && completedId === turn.nativeTurnId) {
      const exact = turn.clientUserMessageId
        ? exactClientItemIndexes(nativeTurn, turn.clientUserMessageId)
        : [];
      if (exact.length === 1) {
        completeActiveTurnFromNative(turn, nativeTurn, exact[0]);
        return;
      }
      // A captured Goal turn can finish while turn/steer is still in flight.
      // Until the RPC succeeds, native-id equality proves only that the old
      // autonomous work completed; it does not prove this Lark input landed.
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

async function ensureThread(startupDeadlineAtMs?: number): Promise<string> {
  if (threadReady && threadId) return threadId;

  if (threadId) {
    try {
      const resumed = await client.request('thread/resume', {
        threadId,
        cwd: args.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
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
    config: { shell_environment_policy: { inherit: 'all' } },
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

async function runTurn(message: QueuedInput): Promise<void> {
  const tid = await ensureThread();
  const stableTurnId = message.codexAppInput?.clientUserMessageId;
  let expectedSteerTurnId = nativeActiveTurnId;
  const turn = makeTurn(stableTurnId, expectedSteerTurnId ? 'steer' : 'start');
  if (expectedSteerTurnId) {
    turn.nativeTurnId = expectedSteerTurnId;
    turn.serverStarted = true;
  }
  activeTurn = turn;
  // This edge proves the runner decoded and dequeued Botmux's control line,
  // even if app-server stalls before acknowledging turn/start.
  emitTurnActivity(turn, 'submitted', true);
  const version = message.codexAppInput ? detectedCodexVersion() : undefined;
  let built = buildCodexAppTurnStartParams({
    threadId: tid,
    cwd: args.cwd,
    legacyContent: message.content,
    codexAppInput: message.codexAppInput,
    codexVersion: version,
    structuredDisabled: cleanInputUnsupported,
  });
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
          || !isCleanInputCapabilityError(err)) throw err;
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
  turn.nativeTurnId = result.turn?.id ?? result.turnId ?? turn.nativeTurnId;
  turn.requestAccepted = true;
  // A response may arrive after its turn completed and a Goal continuation B
  // already started. Never let late response A overwrite the newer global
  // native lifecycle. If no newer turn exists, temporarily restoring A is safe
  // because the buffered A completion below clears it immediately.
  if (turn.nativeTurnId
      && (nativeActiveTurnId === undefined || nativeActiveTurnId === turn.nativeTurnId)) {
    nativeActiveTurnId = turn.nativeTurnId;
  }
  const pendingNotifications = turn.pendingNotifications.splice(0);
  for (const notification of pendingNotifications) {
    const notificationTurnId = notification.params?.turnId ?? notification.params?.turn?.id;
    if (notificationTurnId === turn.nativeTurnId) handleNotification(notification, true);
  }
  const pendingCompletions = turn.pendingCompletions.splice(0);
  if (pendingCompletions.length > 0 && !turn.completed) {
    const exactMatches = stableTurnId
      ? pendingCompletions.flatMap(completion => {
          const indexes = exactClientItemIndexes(completion, stableTurnId);
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
  await turn.done;

  const finalText = (turn.finalText || turn.allAgentText).trim();
  const completedAtMs = Date.now();
  // Every dequeued runner input gets one complete final transaction, including
  // an empty model answer. Without that zero-chunk boundary the worker cannot
  // advance its attribution FIFO safely before the next queued turn finishes.
  // clientUserMessageId is the daemon-frozen botmux/Lark turn identity. The
  // app-server generates a different id for the same logical turn; exposing
  // that native id as `turnId` breaks daemon wait maps, VC suppression and
  // reply routing. When no structured sidecar exists, omit turnId so the
  // worker resolves it from its own FIFO head.
  emitFinalMarker({
    ...(stableTurnId ? { turnId: stableTurnId } : {}),
    ...(turn.nativeTurnId ? { nativeTurnId: turn.nativeTurnId } : {}),
    content: finalText,
    startedAtMs: turn.startedAtMs,
    completedAtMs,
  });
  writeLine();
  activeTurn = null;
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err: any) {
        const message = `Codex App runner error: ${err?.message ?? err}`;
        const completedAtMs = Date.now();
        const stableTurnId = next.codexAppInput?.clientUserMessageId;
        const nativeTurnId = activeTurn?.nativeTurnId;
        writeLine(message);
        emitFinalMarker({
          ...(stableTurnId ? { turnId: stableTurnId } : {}),
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
      if (queue.length === 0) {
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
        queue.push({ content: decoded.content, codexAppInput });
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
