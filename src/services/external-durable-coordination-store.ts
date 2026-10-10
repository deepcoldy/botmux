import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AcquireSessionLeaseInput,
  BeginOutboxAttemptInput,
  BeginOutboxAttemptResult,
  ClaimInboxInput,
  CompleteOutboxAttemptInput,
  DurableCoordinationStore,
  DurableInboxEvent,
  DurableInsertResult,
  DurableJson,
  DurableOutboxRecord,
  DurableSessionRecord,
  EnqueueOutboxInput,
  InboxClaim,
  InboxClaimMutationResult,
  LeaseMutationResult,
  MarkOutboxAmbiguousInput,
  OutboxMutationResult,
  OutboxReservation,
  RenewInboxClaimInput,
  RenewSessionLeaseInput,
  ReserveOutboxInput,
  RetryInboxClaimInput,
  RetryOutboxAttemptInput,
  SessionLease,
  SessionLeaseAcquisition,
  WriteSessionInput,
  WriteSessionResult,
} from './durable-coordination.js';
import {
  MAX_DURABLE_COORDINATION_PROVIDER_LINE_BYTES,
  parseDurableCoordinationProviderResponse,
  providerCallRequest,
  providerHelloRequest,
  validateDurableCoordinationProviderResult,
  type DurableCoordinationProviderMethod,
  type DurableCoordinationProviderRequest,
  type DurableCoordinationProviderResponse,
} from './durable-coordination-provider-protocol.js';

export interface ExternalDurableCoordinationStoreConfig {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

type Pending = {
  expected: 'hello' | 'result';
  resolve: (response: DurableCoordinationProviderResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) {
    throw new Error('durable coordination provider timeout must be an integer between 100 and 300000');
  }
  return value;
}

function jsonInput(value: unknown): DurableJson {
  return JSON.parse(JSON.stringify(value ?? null)) as DurableJson;
}

export class ExternalDurableCoordinationProviderError extends Error {
  override readonly name = 'ExternalDurableCoordinationProviderError';

  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Provider-neutral JSONL bridge for a durable coordination implementation.
 *
 * The child is trusted runtime code selected by the operator. BotMux never
 * interprets provider stderr and never launches through a shell; credentials
 * stay in inherited environment/file references owned by the provider.
 */
export class ExternalDurableCoordinationStore implements DurableCoordinationStore {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private stdoutBuffer = '';
  private closing = false;
  private closed = false;
  private failure: Error | undefined;
  private providerName: string | undefined;

  private constructor(config: ExternalDurableCoordinationStoreConfig) {
    if (!config.command.trim()) throw new Error('durable coordination provider command is required');
    this.handshakeTimeoutMs = boundedTimeout(config.handshakeTimeoutMs, 10_000);
    this.requestTimeoutMs = boundedTimeout(config.requestTimeoutMs, 10_000);
    this.child = spawn(config.command, [...(config.args ?? [])], {
      ...(config.cwd ? { cwd: config.cwd } : {}),
      env: config.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consumeStdout(String(chunk)));
    // Provider stderr may contain deployment-specific details. Drain it so the
    // pipe cannot block, but never copy it into BotMux logs or protocol errors.
    this.child.stderr.on('data', () => {});
    this.child.on('error', error => this.fail(new Error(`durable coordination provider process error: ${error.message}`)));
    this.child.on('exit', (code, signal) => {
      if (this.closing || this.closed) return;
      this.fail(new Error(`durable coordination provider exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  }

  static async connect(config: ExternalDurableCoordinationStoreConfig): Promise<ExternalDurableCoordinationStore> {
    const store = new ExternalDurableCoordinationStore(config);
    try {
      const response = await store.request(providerHelloRequest(store.requestId('hello')), 'hello', store.handshakeTimeoutMs);
      if (response.type !== 'hello') throw new Error('durable coordination provider did not complete hello');
      store.providerName = response.provider;
      return store;
    } catch (error) {
      store.terminate();
      throw error;
    }
  }

  get provider(): string | undefined {
    return this.providerName;
  }

  private requestId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }

  private consumeStdout(chunk: string): void {
    if (this.closed || this.failure) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_DURABLE_COORDINATION_PROVIDER_LINE_BYTES) {
      this.fail(new Error('durable coordination provider stdout buffer exceeded the protocol limit'));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trimEnd();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response: DurableCoordinationProviderResponse;
      try {
        response = parseDurableCoordinationProviderResponse(line);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const pending = this.pending.get(response.requestId);
      if (!pending) {
        this.fail(new Error('durable coordination provider returned an unknown request id'));
        return;
      }
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.type === 'error') {
        pending.reject(new ExternalDurableCoordinationProviderError(
          response.code,
          response.message,
          response.retryable,
        ));
        continue;
      }
      if (response.type !== pending.expected) {
        pending.reject(new Error(`durable coordination provider returned ${response.type}, expected ${pending.expected}`));
        continue;
      }
      pending.resolve(response);
    }
  }

  private request(
    request: DurableCoordinationProviderRequest,
    expected: Pending['expected'],
    timeoutMs: number,
    allowClosing = false,
  ): Promise<DurableCoordinationProviderResponse> {
    if (this.closed || (this.closing && !allowClosing)) {
      return Promise.reject(new Error('durable coordination provider is closed'));
    }
    if (this.failure) return Promise.reject(this.failure);
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_DURABLE_COORDINATION_PROVIDER_LINE_BYTES) {
      return Promise.reject(new Error('durable coordination provider request exceeds the protocol limit'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        const error = new Error(`durable coordination provider request timed out: ${request.type}`);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, { expected, resolve, reject, timer });
      this.child.stdin.write(encoded, 'utf8', error => {
        if (!error) return;
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        clearTimeout(pending.timer);
        pending.reject(new Error(`durable coordination provider write failed: ${error.message}`));
      });
    });
  }

  private async call(method: DurableCoordinationProviderMethod, input: unknown): Promise<DurableJson> {
    const response = await this.request(
      providerCallRequest(this.requestId(method), method, jsonInput(input)),
      'result',
      this.requestTimeoutMs,
    );
    if (response.type !== 'result') throw new Error('durable coordination provider returned no result');
    return validateDurableCoordinationProviderResult(method, response.result);
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill('SIGTERM');
  }

  terminate(): void {
    if (this.closed) return;
    this.closing = true;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('durable coordination provider was terminated'));
    }
    this.pending.clear();
    this.child.kill('SIGTERM');
  }

  async acquireSessionLease(input: AcquireSessionLeaseInput): Promise<SessionLeaseAcquisition> {
    return await this.call('acquireSessionLease', input) as unknown as SessionLeaseAcquisition;
  }

  async renewSessionLease(input: RenewSessionLeaseInput): Promise<LeaseMutationResult> {
    return await this.call('renewSessionLease', input) as unknown as LeaseMutationResult;
  }

  async releaseSessionLease(lease: SessionLease): Promise<LeaseMutationResult> {
    return await this.call('releaseSessionLease', lease) as unknown as LeaseMutationResult;
  }

  async readSession(sessionKey: string): Promise<DurableSessionRecord | undefined> {
    const result = await this.call('readSession', sessionKey);
    return result === null ? undefined : result as unknown as DurableSessionRecord;
  }

  async writeSession(input: WriteSessionInput): Promise<WriteSessionResult> {
    return await this.call('writeSession', input) as unknown as WriteSessionResult;
  }

  async enqueueInbox(event: DurableInboxEvent): Promise<DurableInsertResult> {
    return await this.call('enqueueInbox', event) as unknown as DurableInsertResult;
  }

  async claimNextInbox(input: ClaimInboxInput): Promise<InboxClaim | undefined> {
    const result = await this.call('claimNextInbox', input);
    return result === null ? undefined : result as unknown as InboxClaim;
  }

  async renewInboxClaim(input: RenewInboxClaimInput): Promise<InboxClaimMutationResult> {
    return await this.call('renewInboxClaim', input) as unknown as InboxClaimMutationResult;
  }

  async completeInboxClaim(claim: InboxClaim): Promise<InboxClaimMutationResult> {
    return await this.call('completeInboxClaim', claim) as unknown as InboxClaimMutationResult;
  }

  async retryInboxClaim(input: RetryInboxClaimInput): Promise<InboxClaimMutationResult> {
    return await this.call('retryInboxClaim', input) as unknown as InboxClaimMutationResult;
  }

  async enqueueOutbox(input: EnqueueOutboxInput): Promise<DurableInsertResult | { kind: 'stale_lease' }> {
    return await this.call('enqueueOutbox', input) as unknown as DurableInsertResult | { kind: 'stale_lease' };
  }

  async reserveNextOutbox(input: ReserveOutboxInput): Promise<OutboxReservation | undefined> {
    const result = await this.call('reserveNextOutbox', input);
    return result === null ? undefined : result as unknown as OutboxReservation;
  }

  async beginOutboxAttempt(input: BeginOutboxAttemptInput): Promise<BeginOutboxAttemptResult> {
    return await this.call('beginOutboxAttempt', input) as unknown as BeginOutboxAttemptResult;
  }

  async completeOutboxAttempt(input: CompleteOutboxAttemptInput): Promise<OutboxMutationResult> {
    return await this.call('completeOutboxAttempt', input) as unknown as OutboxMutationResult;
  }

  async retryOutboxAttempt(input: RetryOutboxAttemptInput): Promise<OutboxMutationResult> {
    return await this.call('retryOutboxAttempt', input) as unknown as OutboxMutationResult;
  }

  async markOutboxAmbiguous(input: MarkOutboxAmbiguousInput): Promise<OutboxMutationResult> {
    return await this.call('markOutboxAmbiguous', input) as unknown as OutboxMutationResult;
  }

  async readOutbox(messageId: string): Promise<DurableOutboxRecord | undefined> {
    const result = await this.call('readOutbox', messageId);
    return result === null ? undefined : result as unknown as DurableOutboxRecord;
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      if (!this.failure) {
        const response = await this.request(
          providerCallRequest(this.requestId('close'), 'close', null),
          'result',
          this.requestTimeoutMs,
          true,
        );
        if (response.type !== 'result' || response.result !== null) {
          throw new Error('durable coordination provider close result is invalid');
        }
      }
    } finally {
      this.closed = true;
      this.child.stdin.end();
      this.child.kill('SIGTERM');
    }
  }
}
