import { createHash, randomUUID } from 'node:crypto';
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import type {
  BackendTurnFailure,
  BackendTurnInput,
  BackendTurnSubmission,
  SessionAbortDestroyResult,
  SessionBackend,
  SessionDestroyResult,
  SessionShutdownDetachResult,
  SpawnOpts,
} from './types.js';
import {
  MAX_REMOTE_RUNNER_LINE_BYTES,
  REMOTE_RUNNER_BASE_CAPABILITIES,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  encodeRemoteRunnerCommand,
  normalizeRemoteRunnerBackendState,
  normalizeRemoteRunnerUsageReport,
  parseRemoteRunnerEventLine,
  remoteRunnerCommand,
  type RemoteRunnerBackendState,
  type RemoteRunnerCapability,
  type RemoteRunnerCommand,
  type RemoteRunnerEvent,
  type RemoteRunnerOutboundMessage,
  type RemoteRunnerOutboundMessageResult,
  type RemoteRunnerUsageReport,
} from './remote-runner-protocol.js';
import type { RemoteRunnerConfig } from './remote-runner-config.js';

type PendingRequest = {
  command: RemoteRunnerCommand;
  accept: (event: RemoteRunnerEvent) => boolean;
  resolve: (event: RemoteRunnerEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type OutboundOperation = {
  fingerprint: string;
  result: Promise<RemoteRunnerOutboundMessageResult>;
};

const MAX_OUTBOUND_MESSAGES_PER_TURN = 10;

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || value! < 100 || value! > 300_000) return fallback;
  return value!;
}

/**
 * Convert text newlines to the PTY contract expected by xterm without
 * disturbing standalone carriage returns used for in-place progress redraws.
 * `previousEndsWithCr` covers a CRLF pair split across two progress events.
 */
function normalizeIncrementalTerminalNewlines(
  value: string,
  previousEndsWithCr: boolean,
): string {
  const normalized = value.replace(/\r?\n/g, '\r\n');
  return previousEndsWithCr && value.startsWith('\n')
    ? normalized.slice(1)
    : normalized;
}

/**
 * Provider-neutral, JSONL-speaking remote execution backend.
 *
 * The child is a control-plane provider, not the model CLI itself. It owns the
 * remote compute/session APIs and must implement the public protocol. BotMux
 * owns trusted turn attribution, lifecycle fencing, persistence callbacks and
 * user-visible rendering; provider stdout is never treated as an implicit
 * terminal stream.
 */
export class RemoteRunnerBackend implements SessionBackend {
  private readonly requiredCapabilities: readonly RemoteRunnerCapability[];
  private readonly handshakeTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private outputBuffer = '';
  private stderrBytes = 0;
  private provider: string | null = null;
  private readonly providerCapabilities = new Set<string>();
  private state: RemoteRunnerBackendState | undefined;
  private terminalSnapshot = '';
  private terminalGeneration = -1;
  private terminalSequence = -1;
  private terminalCols: number | null = null;
  private terminalRows: number | null = null;
  private activeTurnId: string | null = null;
  private activeTurnAccepted = false;
  private ready = false;
  private killed = false;
  private closing = false;
  private closePrepared = false;
  private closeOutcomeUncertain = false;
  private shutdownDetaching = false;
  private shutdownDetachRemoteFencePossible = false;
  private activeTurnRequestId: string | null = null;
  private exitEmitted = false;
  private startupPromise: Promise<void> | null = null;
  private turnSettled: Promise<void> = Promise.resolve();
  private settleTurn: (() => void) | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly outboundOperations = new Map<string, OutboundOperation>();
  private outboundOperationCount = 0;
  private readonly outboundResultWrites = new Map<string, number>();
  private dataCb: ((data: string) => void) | null = null;
  private screenResyncCb: ((snapshot: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private taskDoneCb: (() => void) | null = null;
  private turnFinalCb: ((text: string, turnId?: string) => void) | null = null;
  private turnFailureCb: ((failure: BackendTurnFailure) => void) | null = null;
  private outboundMessageCb: ((message: RemoteRunnerOutboundMessage) => Promise<RemoteRunnerOutboundMessageResult>) | null = null;
  private readyCb: (() => void) | null = null;
  private stateCb: ((state: RemoteRunnerBackendState) => void) | null = null;
  private usageCb: ((usage: RemoteRunnerUsageReport) => void) | null = null;
  private accessUrlCb: ((url: string) => void) | null = null;

  constructor(
    private readonly config: RemoteRunnerConfig,
    private readonly sessionId: string,
    initialState?: RemoteRunnerBackendState,
  ) {
    this.requiredCapabilities = config.requiredCapabilities ?? REMOTE_RUNNER_BASE_CAPABILITIES;
    this.handshakeTimeoutMs = boundedTimeout(config.handshakeTimeoutMs, 15_000);
    this.operationTimeoutMs = boundedTimeout(config.operationTimeoutMs, 30_000);
    if (initialState) {
      const normalized = normalizeRemoteRunnerBackendState(initialState);
      if (!normalized) throw new Error('remote runner initial state is invalid');
      if (config.expectedProvider && normalized.provider !== config.expectedProvider) {
        throw new Error(`remote runner state provider ${normalized.provider} does not match ${config.expectedProvider}`);
      }
      this.state = normalized;
    }
  }

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    if (this.child) throw new Error('remote runner backend already spawned');
    if (this.killed) throw new Error('remote runner backend is closed');
    const child = spawnProcess(bin, args, {
      cwd: opts.cwd,
      env: { ...opts.env, ...(opts.injectEnv ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.stderrBytes = Math.min(
        MAX_REMOTE_RUNNER_LINE_BYTES,
        this.stderrBytes + Buffer.byteLength(chunk),
      );
    });
    child.stdout.on('data', chunk => this.consumeStdout(String(chunk)));
    child.on('error', error => this.failProtocol(`provider process error: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.ready = false;
      const expected = this.killed || this.closePrepared || this.shutdownDetaching;
      if (!expected && this.activeTurnId) {
        this.emitTurnFailure({
          turnId: this.activeTurnId,
          code: 'provider_exited',
          message: 'Remote runner provider exited before the turn reached a terminal state.',
          status: 'ambiguous',
          retryable: false,
        });
      }
      this.rejectPending(new Error('remote runner provider exited'));
      this.emitExit(code, signal);
    });
    this.startupPromise = this.initialize(opts);
    void this.startupPromise.catch(error => this.failProtocol(error.message));
  }

  write(data: string): boolean {
    if (!this.ready || !this.child || !this.providerCapabilities.has('terminal_input')) return false;
    if (!data || Buffer.byteLength(data, 'utf8') > MAX_REMOTE_RUNNER_LINE_BYTES) return false;
    const generation = this.state?.generation;
    if (generation === undefined) return false;
    const requestId = this.requestId('terminal-input');
    void this.request(
      remoteRunnerCommand('terminal_input', { requestId, generation, data }),
      event => event.type === 'status',
      this.operationTimeoutMs,
    ).catch(error => {
      logger.warn(`[remote-runner] terminal input was not acknowledged: ${error instanceof Error ? error.message : error}`);
    });
    return true;
  }

  async submitTurn(input: BackendTurnInput): Promise<BackendTurnSubmission> {
    try {
      if (!this.startupPromise) throw new Error('remote runner has not spawned');
      await this.startupPromise;
    } catch (error) {
      return {
        submitted: false,
        submissionDisposition: 'untouched',
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!this.child || this.killed || this.closing || this.shutdownDetaching || !this.ready) {
      return {
        submitted: false,
        submissionDisposition: 'untouched',
        failureReason: 'remote runner is not accepting turns',
      };
    }
    if (this.activeTurnId) {
      return {
        submitted: false,
        submissionDisposition: 'untouched',
        failureReason: `remote runner turn ${this.activeTurnId} is still active`,
      };
    }
    this.activeTurnId = input.turnId;
    this.activeTurnAccepted = false;
    this.outboundOperations.clear();
    this.outboundOperationCount = 0;
    this.outboundResultWrites.clear();
    this.turnSettled = new Promise<void>(resolve => { this.settleTurn = resolve; });
    const requestId = this.requestId('turn');
    this.activeTurnRequestId = requestId;
    try {
      const acknowledgement = await this.request(remoteRunnerCommand('turn', {
        requestId,
        turnId: input.turnId,
        content: input.content,
        ...(input.trustedCaller ? { trustedCaller: input.trustedCaller } : {}),
      }), event => event.type === 'status' && event.status === 'busy', this.operationTimeoutMs);
      if (acknowledgement.type === 'failure') {
        const failure: BackendTurnFailure = {
          turnId: acknowledgement.turnId ?? input.turnId,
          code: acknowledgement.code,
          message: acknowledgement.message,
          status: acknowledgement.status,
          retryable: acknowledgement.retryable,
        };
        // Let submitTurn resolve first so the worker records the accepted
        // delivery before the terminal callback closes the same logical turn.
        setImmediate(() => {
          if (!this.killed && this.activeTurnId === failure.turnId) {
            this.emitTurnFailure(failure);
          }
        });
      }
      return { submitted: true };
    } catch (error) {
      if (this.activeTurnRequestId === requestId) this.activeTurnRequestId = null;
      const reason = error instanceof Error ? error.message : String(error);
      // Once the command entered the provider pipe, a missing ACK cannot prove
      // that execution did not start. Retire this provider generation and emit
      // an exact ambiguous terminal before any successor can be admitted.
      this.failProtocol(`turn acknowledgement failed: ${reason}`);
      return {
        submitted: false,
        submissionDisposition: 'dirty_unknown',
        failureReason: reason,
      };
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.ready || !this.child || !this.providerCapabilities.has('terminal_resize')) return;
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1000
        || !Number.isSafeInteger(rows) || rows < 1 || rows > 1000) return;
    const generation = this.state?.generation;
    if (generation === undefined) return;
    const requestId = this.requestId('terminal-resize');
    void this.request(
      remoteRunnerCommand('terminal_resize', { requestId, generation, cols, rows }),
      event => event.type === 'status',
      this.operationTimeoutMs,
    ).catch(error => {
      logger.warn(`[remote-runner] terminal resize was not acknowledged: ${error instanceof Error ? error.message : error}`);
    });
  }

  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onScreenResync(cb: (snapshot: string) => void): void {
    this.screenResyncCb = cb;
    if (this.terminalSnapshot) {
      queueMicrotask(() => {
        if (this.screenResyncCb === cb) cb(this.terminalSnapshot);
      });
    }
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
  onTaskDone(cb: () => void): void { this.taskDoneCb = cb; }
  onTurnFinal(cb: (text: string, turnId?: string) => void): void { this.turnFinalCb = cb; }
  onTurnFailure(cb: (failure: BackendTurnFailure) => void): void { this.turnFailureCb = cb; }
  onOutboundMessage(
    cb: (message: RemoteRunnerOutboundMessage) => Promise<RemoteRunnerOutboundMessageResult>,
  ): void { this.outboundMessageCb = cb; }
  onReady(cb: () => void): void {
    this.readyCb = cb;
    if (this.ready) queueMicrotask(cb);
  }
  onBackendState(cb: (state: RemoteRunnerBackendState) => void): void {
    this.stateCb = cb;
    if (this.state) queueMicrotask(() => cb(this.state!));
  }
  onUsageSnapshot(cb: (usage: RemoteRunnerUsageReport) => void): void {
    this.usageCb = cb;
  }
  onAccessUrl(cb: (url: string) => void): void { this.accessUrlCb = cb; }

  captureCurrentScreen(): string { return this.terminalSnapshot || this.outputBuffer; }
  getPaneSize(): { cols: number; rows: number } | null {
    return this.terminalCols && this.terminalRows
      ? { cols: this.terminalCols, rows: this.terminalRows }
      : null;
  }
  getChildPid(): number | null { return this.child?.pid ?? null; }
  getBackendState(): RemoteRunnerBackendState | undefined { return this.state; }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.ready = false;
    this.child?.kill('SIGTERM');
  }

  async destroySession(): Promise<SessionDestroyResult> {
    if (this.closePrepared) return { ok: true };
    this.closing = true;
    try {
      if (!this.startupPromise) throw new Error('remote runner has not spawned');
      await this.startupPromise;
      const event = await this.request(
        remoteRunnerCommand('cancel', { requestId: this.requestId('cancel') }),
        candidate => candidate.type === 'status' && candidate.status === 'closed',
        this.operationTimeoutMs,
      );
      if (event.type !== 'status' || event.status !== 'closed') throw new Error('provider did not confirm close');
      if (event.state) this.applyState(event.state);
      this.closePrepared = true;
      return { ok: true };
    } catch (error) {
      this.closeOutcomeUncertain = true;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        recovery: 'uncertain',
        admission: 'fenced',
      };
    }
  }

  async abortDestroySession(): Promise<SessionAbortDestroyResult> {
    if (this.closePrepared || this.closeOutcomeUncertain || !this.child) {
      return { admissionRestored: false, reason: 'remote runner close outcome is not reversible' };
    }
    this.closing = false;
    return { admissionRestored: this.ready };
  }

  commitDestroySession(): void { this.kill(); }

  async prepareShutdownDetach(drainTimeoutMs?: number): Promise<SessionShutdownDetachResult> {
    this.shutdownDetaching = true;
    try {
      if (!this.startupPromise) throw new Error('remote runner has not spawned');
      await this.startupPromise;
      if (!this.providerCapabilities.has('detach')
          || !this.providerCapabilities.has('reattach')) {
        this.shutdownDetaching = false;
        return {
          ok: false,
          taskId: null,
          error: 'remote runner does not support transactional detach',
        };
      }
      await this.withTimeout(
        this.turnSettled,
        drainTimeoutMs ?? this.operationTimeoutMs,
        'active turn did not settle before detach',
      );
      // From this point a transport failure cannot prove whether the provider
      // installed its detach fence. abortShutdownDetach must positively
      // reattach before local admission can be restored.
      this.shutdownDetachRemoteFencePossible = true;
      const event = await this.request(
        remoteRunnerCommand('detach', { requestId: this.requestId('detach') }),
        candidate => candidate.type === 'status' && candidate.status === 'detached',
        this.operationTimeoutMs,
      );
      if (event.type !== 'status' || event.status !== 'detached') throw new Error('provider did not confirm detach');
      if (event.state) this.applyState(event.state);
      // The generic shutdown coordinator's taskId field is legacy Riff/Mojo
      // lineage.  Remote Runner lineage travels only through backendState, so
      // never alias agentThreadId into Session.riffParentTaskId.
      return { ok: true, taskId: null };
    } catch (error) {
      return {
        ok: false,
        taskId: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async abortShutdownDetach(): Promise<SessionShutdownDetachResult> {
    if (!this.child || this.killed) {
      return { ok: false, taskId: null, error: 'provider process is unavailable' };
    }
    if (!this.shutdownDetachRemoteFencePossible) {
      this.shutdownDetaching = false;
      return { ok: true, taskId: null };
    }
    try {
      const event = await this.request(
        remoteRunnerCommand('reattach', { requestId: this.requestId('reattach') }),
        candidate => candidate.type === 'status' && candidate.status === 'ready',
        this.operationTimeoutMs,
      );
      if (event.type !== 'status' || event.status !== 'ready') {
        throw new Error('provider did not confirm reattach');
      }
      if (event.state && !this.applyState(event.state)) {
        throw new Error('provider returned invalid state while reattaching');
      }
      this.shutdownDetachRemoteFencePossible = false;
      this.shutdownDetaching = false;
      return { ok: true, taskId: null };
    } catch (error) {
      return {
        ok: false,
        taskId: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  commitShutdownDetach(): void { this.kill(); }

  private async initialize(opts: SpawnOpts): Promise<void> {
    const helloId = this.requestId('hello');
    const hello = await this.request(
      remoteRunnerCommand('hello', {
        requestId: helloId,
        sessionId: this.sessionId,
        requiredCapabilities: [...this.requiredCapabilities],
      }),
      event => event.type === 'hello',
      this.handshakeTimeoutMs,
    );
    if (hello.type !== 'hello') throw new Error('remote runner hello response is invalid');
    if (this.config.expectedProvider && hello.provider !== this.config.expectedProvider) {
      throw new Error(`remote runner provider ${hello.provider} does not match ${this.config.expectedProvider}`);
    }
    const missing = this.requiredCapabilities.filter(capability => !hello.capabilities.includes(capability));
    if (missing.length > 0) throw new Error(`remote runner is missing required capabilities: ${missing.join(', ')}`);
    this.providerCapabilities.clear();
    for (const capability of hello.capabilities) this.providerCapabilities.add(capability);
    if (this.state && this.state.provider !== hello.provider) {
      throw new Error(`remote runner state provider ${this.state.provider} does not match handshake ${hello.provider}`);
    }
    this.provider = hello.provider;

    const requestId = this.requestId(this.state ? 'resume' : 'start');
    const command = this.state
      ? remoteRunnerCommand('resume', {
          requestId,
          sessionId: this.sessionId,
          cwd: opts.cwd,
          state: this.state,
          ...(opts.remoteResumeMode ? { resumeMode: opts.remoteResumeMode } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.modelBackendVariant ? { modelBackendVariant: opts.modelBackendVariant } : {}),
          ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        })
      : remoteRunnerCommand('start', {
          requestId,
          sessionId: this.sessionId,
          cwd: opts.cwd,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.modelBackendVariant ? { modelBackendVariant: opts.modelBackendVariant } : {}),
          ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        });
    const ready = await this.request(
      command,
      event => event.type === 'ready',
      this.handshakeTimeoutMs,
    );
    if (ready.type !== 'ready') throw new Error('remote runner did not become ready');
    if (opts.remoteResumeMode === 'rebuild'
        && this.state
        && ready.state.generation <= this.state.generation) {
      throw new Error('remote runner rebuild did not advance the backend generation');
    }
    if (!this.applyState(ready.state)) throw new Error('remote runner ready state is invalid');
    this.ready = true;
    this.readyCb?.();
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_REMOTE_RUNNER_LINE_BYTES) {
      this.failProtocol('remote runner emitted an oversized or unterminated event');
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const event = parseRemoteRunnerEventLine(line);
      if (!event) {
        this.failProtocol('remote runner emitted an invalid protocol event');
        return;
      }
      this.handleEvent(event);
    }
  }

  private handleEvent(event: RemoteRunnerEvent): void {
    if (event.type === 'lineage_changed') {
      this.applyState(event.state);
      return;
    }
    if (event.type === 'access_url') {
      this.accessUrlCb?.(event.url);
      return;
    }
    if (event.type === 'terminal_screen') {
      const currentGeneration = this.state?.generation;
      if (currentGeneration !== undefined && event.generation < currentGeneration) return;
      if (currentGeneration !== undefined && event.generation > currentGeneration) {
        this.failProtocol('remote runner terminal screen is ahead of durable state generation');
        return;
      }
      if (event.generation < this.terminalGeneration
          || (event.generation === this.terminalGeneration && event.sequence <= this.terminalSequence)) return;
      this.terminalGeneration = event.generation;
      this.terminalSequence = event.sequence;
      this.terminalCols = event.cols;
      this.terminalRows = event.rows;
      // `tmux capture-pane -p` returns LF-separated rows.  A PTY normally
      // delivers CRLF; feeding bare LF into xterm keeps the previous column and
      // renders a diagonal/stair-step screen.  Normalize complete snapshots at
      // this transport boundary so the existing local terminal renderer sees
      // the same newline contract for local and remote tmux.
      const snapshot = event.snapshot
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n$/, '')
        .replace(/\n/g, '\r\n');
      this.terminalSnapshot = snapshot;
      this.outputBuffer = snapshot;
      // terminal_screen is an authoritative full viewport, not another PTY
      // byte delta.  Appending successive screens to onData makes the worker's
      // replay buffer retain one stale TUI frame per poll; after a refresh,
      // scrolling then reveals a stack of duplicated full-screen UIs.  Route
      // it through the SessionBackend snapshot/rebase channel instead.  Plain
      // progress events remain incremental onData output.
      this.screenResyncCb?.(snapshot);
      return;
    }
    if (event.type === 'progress') {
      if (!this.acceptAcknowledgedTurn(event.turnId)) return;
      // Providers send structured progress text rather than PTY bytes and may
      // therefore use ordinary LF-separated lines. xterm treats LF as
      // line-feed only (the cursor keeps its current column), producing a
      // diagonal/stair-step display. Normalize at this provider-neutral
      // terminal boundary while preserving existing CRLF and bare CR redraws.
      const content = normalizeIncrementalTerminalNewlines(
        event.content,
        this.outputBuffer.endsWith('\r'),
      );
      this.outputBuffer = `${this.outputBuffer}${content}`.slice(-MAX_REMOTE_RUNNER_LINE_BYTES);
      this.dataCb?.(content);
      return;
    }
    if (event.type === 'outbound_message') {
      this.handleOutboundMessage(event);
      return;
    }
    if (event.type === 'final') {
      if (!this.acceptAcknowledgedTurn(event.turnId)) return;
      if ((this.outboundResultWrites.get(event.turnId) ?? 0) > 0) {
        this.failProtocol('remote runner emitted final before an outbound message result was returned');
        return;
      }
      if (event.state && !this.applyState(event.state)) return;
      if (event.usage) {
        const usage = normalizeRemoteRunnerUsageReport(event.usage);
        if (!usage || usage.generation !== this.state?.generation) {
          this.failProtocol('remote runner emitted usage for an invalid backend generation');
          return;
        }
        this.usageCb?.(usage);
      }
      this.turnFinalCb?.(event.content, event.turnId);
      this.finishActiveTurn();
      this.taskDoneCb?.();
      return;
    }
    if (event.type === 'failure') {
      // A provider may reject a turn before its status:busy ACK. Correlate that
      // definitive terminal through requestId (or the sole active turn request)
      // so submitTurn does not time out and misclassify it as dirty_unknown.
      const pendingTurnRequestId = event.requestId
        ?? (event.turnId ? this.activeTurnRequestId : null)
        ?? undefined;
      const pending = pendingTurnRequestId
        ? this.pendingRequests.get(pendingTurnRequestId)
        : undefined;
      if (pending?.command.type === 'turn') {
        const turnId = pending.command.turnId;
        if ((event.turnId && event.turnId !== turnId) || !this.acceptActiveTurn(turnId)) {
          this.failProtocol('remote runner emitted a failure with mismatched turn acknowledgement');
          return;
        }
        clearTimeout(pending.timer);
        this.pendingRequests.delete(pendingTurnRequestId!);
        this.activeTurnRequestId = null;
        pending.resolve(event);
        return;
      }
      if (event.turnId) {
        if (event.requestId && event.requestId !== this.activeTurnRequestId) {
          this.failProtocol('remote runner emitted a turn failure for an unrelated request');
          return;
        }
        if (!this.acceptAcknowledgedTurn(event.turnId)) return;
        this.emitTurnFailure({
          turnId: event.turnId,
          code: event.code,
          message: event.message,
          status: event.status,
          retryable: event.retryable,
        });
        return;
      }
    }

    const id = 'requestId' in event ? event.requestId : undefined;
    if (!id) {
      this.failProtocol(`remote runner emitted uncorrelated ${event.type} event`);
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (!pending || (event.type !== 'failure' && !pending.accept(event))) {
      this.failProtocol(`remote runner emitted unexpected ${event.type} response`);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
    if (pending.command.type === 'turn' && this.activeTurnRequestId === id
        && event.type === 'status' && event.status === 'busy') {
      this.activeTurnAccepted = true;
    }
    if (event.type === 'failure') pending.reject(new Error(`${event.code}: ${event.message}`));
    else pending.resolve(event);
  }

  private acceptActiveTurn(turnId: string): boolean {
    if (this.activeTurnId === turnId) return true;
    this.failProtocol(`remote runner event turn ${turnId} does not match active turn`);
    return false;
  }

  private acceptAcknowledgedTurn(turnId: string): boolean {
    if (!this.acceptActiveTurn(turnId)) return false;
    if (this.activeTurnAccepted) return true;
    this.failProtocol(`remote runner emitted a turn event before the busy acknowledgement`);
    return false;
  }

  private outboundFingerprint(message: RemoteRunnerOutboundMessage): string {
    return createHash('sha256').update(JSON.stringify([
      message.turnId,
      message.generation,
      message.content,
      message.responseKind,
      message.mention,
    ])).digest('hex');
  }

  private handleOutboundMessage(message: RemoteRunnerOutboundMessage): void {
    if (!this.providerCapabilities.has('outbound_message')) {
      this.failProtocol('remote runner emitted outbound_message without advertising the capability');
      return;
    }
    if (!this.acceptAcknowledgedTurn(message.turnId)) return;
    if (message.generation !== this.state?.generation) {
      this.failProtocol('remote runner outbound message belongs to another backend generation');
      return;
    }

    const fingerprint = this.outboundFingerprint(message);
    const existing = this.outboundOperations.get(message.operationId);
    let result: Promise<RemoteRunnerOutboundMessageResult>;
    if (existing) {
      result = existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({
            outcome: 'rejected',
            code: 'operation_id_conflict',
            message: 'The outbound operation id was reused with a different payload.',
          });
    } else if (this.outboundOperationCount >= MAX_OUTBOUND_MESSAGES_PER_TURN) {
      result = Promise.resolve({
        outcome: 'rejected',
        code: 'outbound_rate_limited',
        message: `A remote turn may emit at most ${MAX_OUTBOUND_MESSAGES_PER_TURN} outbound messages.`,
      });
    } else {
      this.outboundOperationCount++;
      const callback = this.outboundMessageCb;
      result = callback
        ? Promise.resolve().then(() => callback(message)).catch((error): RemoteRunnerOutboundMessageResult => ({
            outcome: 'unknown',
            code: 'outbound_delivery_unknown',
            message: (error instanceof Error ? error.message : String(error)).slice(0, 4096)
              || 'Outbound delivery failed with an unknown result.',
          }))
        : Promise.resolve({
            outcome: 'rejected',
            code: 'outbound_delivery_unavailable',
            message: 'The BotMux host did not install an outbound message handler.',
          });
      this.outboundOperations.set(message.operationId, { fingerprint, result });
    }

    this.outboundResultWrites.set(
      message.turnId,
      (this.outboundResultWrites.get(message.turnId) ?? 0) + 1,
    );
    void result.then(async (settled) => {
      if (this.activeTurnId !== message.turnId
          || this.state?.generation !== message.generation) return;
      await this.send(remoteRunnerCommand('outbound_message_result', {
        requestId: this.requestId('outbound-message-result'),
        operationId: message.operationId,
        turnId: message.turnId,
        generation: message.generation,
        result: settled,
      }));
    }).catch(error => {
      if (this.activeTurnId === message.turnId) {
        this.failProtocol(
          `remote runner outbound message result could not be returned: ${error instanceof Error ? error.message : error}`,
        );
      }
    }).finally(() => {
      const pending = this.outboundResultWrites.get(message.turnId);
      if (pending === undefined) return;
      if (pending <= 1) this.outboundResultWrites.delete(message.turnId);
      else this.outboundResultWrites.set(message.turnId, pending - 1);
    });
  }

  private emitTurnFailure(failure: BackendTurnFailure): void {
    this.turnFailureCb?.(failure);
    this.finishActiveTurn();
    this.taskDoneCb?.();
  }

  private finishActiveTurn(): void {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.activeTurnAccepted = false;
    this.activeTurnRequestId = null;
    this.outboundOperations.clear();
    this.outboundOperationCount = 0;
    if (turnId) this.outboundResultWrites.delete(turnId);
    const settle = this.settleTurn;
    this.settleTurn = null;
    settle?.();
  }

  private applyState(value: RemoteRunnerBackendState): boolean {
    const state = normalizeRemoteRunnerBackendState(value);
    if (!state || (this.provider && state.provider !== this.provider)) {
      this.failProtocol('remote runner emitted invalid or foreign backend state');
      return false;
    }
    if (this.state) {
      if (state.generation < this.state.generation) {
        this.failProtocol('remote runner backend state generation moved backwards');
        return false;
      }
      if (state.generation === this.state.generation
          && this.state.remoteSessionId
          && state.remoteSessionId !== this.state.remoteSessionId) {
        this.failProtocol('remote runner changed or cleared remote session without advancing generation');
        return false;
      }
    }
    const generationAdvanced = this.state !== undefined && state.generation > this.state.generation;
    this.state = state;
    if (generationAdvanced) {
      this.terminalSnapshot = '';
      this.terminalGeneration = state.generation;
      this.terminalSequence = -1;
      this.terminalCols = null;
      this.terminalRows = null;
    }
    this.stateCb?.(state);
    return true;
  }

  private requestId(prefix: string): string { return `${prefix}:${randomUUID()}`; }

  private request(
    command: RemoteRunnerCommand,
    accept: (event: RemoteRunnerEvent) => boolean,
    timeoutMs: number,
  ): Promise<RemoteRunnerEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(command.requestId);
        reject(new Error(`remote runner ${command.type} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(command.requestId, { command, accept, resolve, reject, timer });
      void this.send(command).catch(error => {
        const pending = this.pendingRequests.get(command.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(command.requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private send(command: RemoteRunnerCommand): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error('remote runner provider stdin is unavailable'));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(encodeRemoteRunnerCommand(command), error => error ? reject(error) : resolve());
    });
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private failProtocol(reason: string): void {
    if (this.killed) return;
    logger.error(`[remote-runner] ${reason}; stderr_bytes=${this.stderrBytes}`);
    if (this.activeTurnId) {
      this.emitTurnFailure({
        turnId: this.activeTurnId,
        code: 'remote_runner_protocol_error',
        message: reason,
        status: 'ambiguous',
        retryable: false,
      });
    }
    this.rejectPending(new Error(reason));
    this.ready = false;
    this.killed = true;
    this.child?.kill('SIGTERM');
  }

  private emitExit(code: number | null, signal: string | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.exitCb?.(code, signal);
  }
}
