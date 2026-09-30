import { randomUUID } from 'node:crypto';
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
  REMOTE_RUNNER_CAPABILITIES,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  encodeRemoteRunnerCommand,
  normalizeRemoteRunnerBackendState,
  parseRemoteRunnerEventLine,
  remoteRunnerCommand,
  type RemoteRunnerBackendState,
  type RemoteRunnerCapability,
  type RemoteRunnerCommand,
  type RemoteRunnerEvent,
} from './remote-runner-protocol.js';

export interface RemoteRunnerBackendConfig {
  /** Optional fail-closed provider identity pin. */
  expectedProvider?: string;
  /** Capabilities required before start/resume. Defaults to the complete v1 set. */
  requiredCapabilities?: readonly RemoteRunnerCapability[];
  handshakeTimeoutMs?: number;
  operationTimeoutMs?: number;
}

type PendingRequest = {
  accept: (event: RemoteRunnerEvent) => boolean;
  resolve: (event: RemoteRunnerEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || value! < 100 || value! > 300_000) return fallback;
  return value!;
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
  private state: RemoteRunnerBackendState | undefined;
  private activeTurnId: string | null = null;
  private ready = false;
  private killed = false;
  private closing = false;
  private closePrepared = false;
  private shutdownDetaching = false;
  private exitEmitted = false;
  private startupPromise: Promise<void> | null = null;
  private turnSettled: Promise<void> = Promise.resolve();
  private settleTurn: (() => void) | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private taskDoneCb: (() => void) | null = null;
  private turnFinalCb: ((text: string, turnId?: string) => void) | null = null;
  private turnFailureCb: ((failure: BackendTurnFailure) => void) | null = null;
  private readyCb: (() => void) | null = null;
  private stateCb: ((state: RemoteRunnerBackendState) => void) | null = null;
  private accessUrlCb: ((url: string) => void) | null = null;

  constructor(
    private readonly config: RemoteRunnerBackendConfig,
    private readonly sessionId: string,
    initialState?: RemoteRunnerBackendState,
  ) {
    this.requiredCapabilities = config.requiredCapabilities ?? REMOTE_RUNNER_CAPABILITIES;
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

  write(_data: string): boolean {
    // Structured remote turns must never be degraded into terminal bytes.
    return false;
  }

  async submitTurn(input: BackendTurnInput): Promise<BackendTurnSubmission> {
    try {
      if (!this.startupPromise) throw new Error('remote runner has not spawned');
      await this.startupPromise;
    } catch (error) {
      return { submitted: false, failureReason: error instanceof Error ? error.message : String(error) };
    }
    if (!this.child || this.killed || this.closing || this.shutdownDetaching || !this.ready) {
      return { submitted: false, failureReason: 'remote runner is not accepting turns' };
    }
    if (this.activeTurnId) {
      return { submitted: false, failureReason: `remote runner turn ${this.activeTurnId} is still active` };
    }
    this.activeTurnId = input.turnId;
    this.turnSettled = new Promise<void>(resolve => { this.settleTurn = resolve; });
    try {
      await this.send(remoteRunnerCommand('turn', {
        requestId: this.requestId('turn'),
        turnId: input.turnId,
        content: input.content,
        ...(input.trustedCaller ? { trustedCaller: input.trustedCaller } : {}),
      }));
      return { submitted: true };
    } catch (error) {
      this.finishActiveTurn();
      return { submitted: false, failureReason: error instanceof Error ? error.message : String(error) };
    }
  }

  resize(_cols: number, _rows: number): void {}

  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }
  onTaskDone(cb: () => void): void { this.taskDoneCb = cb; }
  onTurnFinal(cb: (text: string, turnId?: string) => void): void { this.turnFinalCb = cb; }
  onTurnFailure(cb: (failure: BackendTurnFailure) => void): void { this.turnFailureCb = cb; }
  onReady(cb: () => void): void {
    this.readyCb = cb;
    if (this.ready) queueMicrotask(cb);
  }
  onBackendState(cb: (state: RemoteRunnerBackendState) => void): void {
    this.stateCb = cb;
    if (this.state) queueMicrotask(() => cb(this.state!));
  }
  onAccessUrl(cb: (url: string) => void): void { this.accessUrlCb = cb; }

  captureCurrentScreen(): string { return this.outputBuffer; }
  getChildPid(): number | null { return this.child?.pid ?? null; }
  getBackendState(): RemoteRunnerBackendState | undefined { return this.state; }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.ready = false;
    this.child?.kill('SIGTERM');
  }

  async destroySession(): Promise<SessionDestroyResult> {
    if (this.closePrepared) return { ok: true, ...(this.state?.agentThreadId ? { taskId: this.state.agentThreadId } : {}) };
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
      return { ok: true, ...(this.state?.agentThreadId ? { taskId: this.state.agentThreadId } : {}) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        recovery: 'uncertain',
        admission: 'fenced',
        ...(this.state?.agentThreadId ? { taskId: this.state.agentThreadId } : {}),
      };
    }
  }

  async abortDestroySession(): Promise<SessionAbortDestroyResult> {
    if (this.closePrepared || !this.child) {
      return { admissionRestored: false, reason: 'remote runner close outcome is not reversible' };
    }
    this.closing = false;
    return { admissionRestored: this.ready };
  }

  commitDestroySession(): void { this.kill(); }

  async prepareShutdownDetach(): Promise<SessionShutdownDetachResult> {
    this.shutdownDetaching = true;
    try {
      if (!this.startupPromise) throw new Error('remote runner has not spawned');
      await this.startupPromise;
      await this.withTimeout(this.turnSettled, this.operationTimeoutMs, 'active turn did not settle before detach');
      const event = await this.request(
        remoteRunnerCommand('detach', { requestId: this.requestId('detach') }),
        candidate => candidate.type === 'status' && candidate.status === 'detached',
        this.operationTimeoutMs,
      );
      if (event.type !== 'status' || event.status !== 'detached') throw new Error('provider did not confirm detach');
      if (event.state) this.applyState(event.state);
      return { ok: true, taskId: this.state?.agentThreadId ?? null };
    } catch (error) {
      return {
        ok: false,
        taskId: this.state?.agentThreadId ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  abortShutdownDetach(): SessionShutdownDetachResult {
    if (!this.child || this.killed) {
      return { ok: false, taskId: this.state?.agentThreadId ?? null, error: 'provider process is unavailable' };
    }
    this.shutdownDetaching = false;
    return { ok: true, taskId: this.state?.agentThreadId ?? null };
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
        })
      : remoteRunnerCommand('start', {
          requestId,
          sessionId: this.sessionId,
          cwd: opts.cwd,
        });
    const ready = await this.request(
      command,
      event => event.type === 'ready',
      this.handshakeTimeoutMs,
    );
    if (ready.type !== 'ready') throw new Error('remote runner did not become ready');
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
    if (event.type === 'progress') {
      if (!this.acceptActiveTurn(event.turnId)) return;
      this.outputBuffer = `${this.outputBuffer}${event.content}`.slice(-MAX_REMOTE_RUNNER_LINE_BYTES);
      this.dataCb?.(event.content);
      return;
    }
    if (event.type === 'final') {
      if (!this.acceptActiveTurn(event.turnId)) return;
      if (event.state && !this.applyState(event.state)) return;
      this.turnFinalCb?.(event.content, event.turnId);
      this.finishActiveTurn();
      this.taskDoneCb?.();
      return;
    }
    if (event.type === 'failure' && event.turnId) {
      if (!this.acceptActiveTurn(event.turnId)) return;
      this.emitTurnFailure({
        turnId: event.turnId,
        code: event.code,
        message: event.message,
        status: event.status,
        retryable: event.retryable,
      });
      return;
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
    if (event.type === 'failure') pending.reject(new Error(`${event.code}: ${event.message}`));
    else pending.resolve(event);
  }

  private acceptActiveTurn(turnId: string): boolean {
    if (this.activeTurnId === turnId) return true;
    this.failProtocol(`remote runner event turn ${turnId} does not match active turn`);
    return false;
  }

  private emitTurnFailure(failure: BackendTurnFailure): void {
    this.turnFailureCb?.(failure);
    this.finishActiveTurn();
    this.taskDoneCb?.();
  }

  private finishActiveTurn(): void {
    this.activeTurnId = null;
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
          && this.state.remoteSessionId && state.remoteSessionId
          && this.state.remoteSessionId !== state.remoteSessionId) {
        this.failProtocol('remote runner changed remote session without advancing generation');
        return false;
      }
    }
    this.state = state;
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
      this.pendingRequests.set(command.requestId, { accept, resolve, reject, timer });
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
