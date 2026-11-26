import { constants, closeSync, mkdtempSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BYTEDCLI_EXEC_SCHEMA, BYTEDCLI_EXEC_LIMITS, BYTEDCLI_EXEC_ERROR_CODES, decodeBytedcliBase64,
  type BytedcliExecResponse, type BytedcliExecErrorCode, type BytedcliEffectiveIdentity } from '../cli/bytedcli-exec-protocol.js';
import { parseBytedcliOperation, assertBytedcliAuditedRelease, type BytedcliOperation } from './bytedcli-operation-policy.js';
import { ensureBytedcliPrivateDirectory, type BytedcliAuditRecord, type BytedcliAuditSink } from './bytedcli-broker-audit.js';
import { bytedcliSafeFingerprint, type BytedcliAuthorityRecheck, type BytedcliVerifiedActor,
  type BytedcliCredentialLease, type BytedcliLeaseResolver } from './bytedcli-broker-credentials.js';
import { BytedcliBrokerError, bytedcliMinimalEnv, runBoundedBytedcliChild,
  type BytedcliChildRunner, type BytedcliTrustedCli } from './bytedcli-broker-process.js';
import { maskCredentialShapes } from './stuck-page-catalog.js';

/** Constructed only by host peer/admission/turn/delegation resolution. */
export interface BytedcliFrozenAuthority {
  readonly daemonBootId: string; readonly botAppId: string; readonly sessionId: string;
  readonly turnId: string; readonly identityTurnId?: string; readonly workerGeneration: number;
  readonly dispatchAttempt: number; readonly policyFingerprint: string;
  readonly actor?: BytedcliVerifiedActor; readonly recheck: BytedcliAuthorityRecheck;
}
export interface BytedcliExecutionRequest {
  readonly requestId: string; readonly operation: BytedcliOperation;
  readonly authority: BytedcliFrozenAuthority; readonly signal?: AbortSignal;
}
export interface BytedcliExecutorDependencies {
  readonly privateRoot: string; readonly trustedCli: (signal: AbortSignal) => Promise<BytedcliTrustedCli>;
  readonly leases: BytedcliLeaseResolver; readonly audit: BytedcliAuditSink;
  readonly networkEnv?: Readonly<NodeJS.ProcessEnv>; readonly run?: BytedcliChildRunner;
}
export function redactBytedcliOutput(buffer: Buffer, activeSecrets: readonly string[]): Buffer {
  let text = buffer.toString('utf8');
  for (const secret of activeSecrets) {
    if (!secret) continue;
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
      text = text.split(value).join('[REDACTED]');
    }
  }
  text = maskCredentialShapes(text)
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:"|\b)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|jwt|authorization|cookie|client[_-]?secret|secret[_-]?access[_-]?key|device[_-]?code|authorize[_-]?url)(?:"\s*:|\s*[:=])\s*)(?:"(?:\\.|[^"\\])*"|[^\s,;}]+)/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]');
  return Buffer.from(text, 'utf8');
}
const GLOBAL_OUTPUT_LIMIT = 128 * 1024 * 1024;
interface Waiter { request: BytedcliExecutionRequest; resolve: (release: () => void) => void; reject: (error: Error) => void; cleanup: () => void }
interface Entry { digest: string; tuple: string; sessionId: string; promise: Promise<BytedcliExecResponse>; settled: boolean;
  outputBytes: number; revalidate?: BytedcliCredentialLease['stillCurrent']; controller?: AbortController;
  identity?: BytedcliEffectiveIdentity; dispatched?: boolean }
function errorCode(error: unknown): BytedcliExecErrorCode {
  const code = (error as { code?: unknown })?.code;
  return (BYTEDCLI_EXEC_ERROR_CODES as readonly unknown[]).includes(code) ? code as BytedcliExecErrorCode : 'internal_error';
}
function rejectResponse(request: BytedcliExecutionRequest, code: BytedcliExecErrorCode,
  identity: BytedcliEffectiveIdentity = { kind: 'none' }, unknownWrite = false): BytedcliExecResponse {
  return Object.freeze({ schema: BYTEDCLI_EXEC_SCHEMA, requestId: request.requestId, operationId: request.operation.id,
    effectiveIdentity: identity, outcome: unknownWrite ? 'write_outcome_unknown' : 'rejected',
    stdoutBase64: '', stderrBase64: '', exitCode: 77, errorCode: unknownWrite ? 'write_outcome_unknown' : code });
}
function tupleOf(authority: BytedcliFrozenAuthority): string {
  return JSON.stringify([authority.daemonBootId, authority.botAppId, authority.sessionId, authority.workerGeneration,
    authority.dispatchAttempt, authority.turnId, authority.identityTurnId ?? authority.turnId,
    authority.policyFingerprint, authority.actor ?? null]);
}
function snapshotOperation(operation: BytedcliOperation): BytedcliOperation {
  // Reparse even host descriptors: input bytes and canonical argv must remain
  // bound to one audited schema. Only host-selected lower limits are retained.
  const inputs = operation.stagedInputs.length ? {
    ...(operation.argv.includes('-') ? { stdinBase64: operation.stagedInputs[0]!.dataBase64 } : {
      files: operation.stagedInputs.map(input => ({ id: input.id, dataBase64: input.dataBase64 })) }),
  } : undefined;
  const parsed = parseBytedcliOperation(operation.argv, inputs);
  if (parsed.id !== operation.id || parsed.effect !== operation.effect || parsed.region !== operation.region
    || parsed.cliVersion !== operation.cliVersion || parsed.catalogVersion !== operation.catalogVersion
    || JSON.stringify(parsed.argv) !== JSON.stringify(operation.argv)
    || JSON.stringify(parsed.stagedInputs) !== JSON.stringify(operation.stagedInputs)) throw new BytedcliBrokerError('unsupported_operation');
  if (!Number.isSafeInteger(operation.timeoutMs) || operation.timeoutMs < 1 || operation.timeoutMs > BYTEDCLI_EXEC_LIMITS.maxTimeoutMs
    || !Number.isSafeInteger(operation.outputLimitBytes) || operation.outputLimitBytes < 1 || operation.outputLimitBytes > parsed.outputLimitBytes
    || !Number.isSafeInteger(operation.inputLimitBytes) || operation.inputLimitBytes < 0 || operation.inputLimitBytes > parsed.inputLimitBytes) {
    throw new BytedcliBrokerError('invalid_request');
  }
  return Object.freeze({ ...parsed, timeoutMs: operation.timeoutMs, outputLimitBytes: operation.outputLimitBytes, inputLimitBytes: operation.inputLimitBytes });
}

/** One instance per daemon. Quotas include lease waits; cached responses count
 * toward the global output budget. Settled stale tuples are retired only after
 * a new host-authorized turn proves they cannot be replayed. */
export class BytedcliExecutor {
  private running = 0; private writes = 0; private outputBytes = 0;
  private admissions = 0; private duplicateWaiters = 0;
  private closed = false;
  private readonly sessions = new Map<string, { reads: number; writes: number }>();
  private readonly waiters: Waiter[] = []; private readonly entries = new Map<string, Entry>();
  constructor(private readonly deps: BytedcliExecutorDependencies) {}
  async execute(raw: BytedcliExecutionRequest): Promise<BytedcliExecResponse> {
    if (this.admissions >= 80) return rejectResponse(raw, 'busy');
    this.admissions++;
    const started = Date.now();
    let request = raw;
    try {
      const operation = snapshotOperation(raw.operation);
      const authority = Object.freeze({ ...raw.authority, ...(raw.authority.actor ? { actor: Object.freeze({ ...raw.authority.actor }) } : {}) });
      request = Object.freeze({ ...raw, operation, authority });
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.requestId)) throw new BytedcliBrokerError('invalid_request');
      if (operation.effect !== 'read' && operation.effect !== 'write') throw new BytedcliBrokerError('unsupported_operation');
      if (operation.effect === 'write' && (!authority.actor || !authority.actor.verifiedEmail)) throw new BytedcliBrokerError('actor_required');
      const deadline = started + operation.timeoutMs;
      await this.beforeDeadline(this.check(request), deadline, request.signal);
      const tuple = tupleOf(authority); const key = JSON.stringify([tuple, request.requestId]);
      for (const [oldKey, old] of this.entries) {
        if (old.settled && old.sessionId === authority.sessionId && old.tuple !== tuple) {
          this.outputBytes -= old.outputBytes; this.entries.delete(oldKey);
        }
      }
      const digest = bytedcliSafeFingerprint([operation.argv, operation.stagedInputs.map(input => input.dataBase64),
        operation.timeoutMs, operation.outputLimitBytes, operation.inputLimitBytes]);
      const prior = this.entries.get(key);
      if (prior) {
        if (prior.digest !== digest) return rejectResponse(request, 'invalid_request');
        return await this.replay(request, prior, deadline);
      }
      if (this.entries.size >= 4096) throw new BytedcliBrokerError('busy');
      const entry: Entry = { digest, tuple, sessionId: authority.sessionId, promise: Promise.resolve(rejectResponse(request, 'internal_error')),
        settled: false, outputBytes: 0 };
      this.entries.set(key, entry);
      entry.promise = this.executeOnce(request, digest, entry, deadline).finally(() => { entry.settled = true; });
      return await entry.promise;
    } catch (error) { return rejectResponse(request, errorCode(error)); }
    finally { this.admissions--; }
  }
  private async check(request: BytedcliExecutionRequest): Promise<void> {
    if (this.closed) throw new BytedcliBrokerError('executor_unavailable');
    if (request.signal?.aborted) throw new BytedcliBrokerError('cancelled');
    const code = await request.authority.recheck(); if (code) throw new BytedcliBrokerError(code);
    if (this.closed) throw new BytedcliBrokerError('executor_unavailable');
    if (request.signal?.aborted) throw new BytedcliBrokerError('cancelled');
  }
  /** Called by host session teardown, after admission has stopped new calls. */
  async retireSession(sessionId: string): Promise<void> {
    const retired = [...this.entries].filter(([, entry]) => entry.sessionId === sessionId);
    for (const [, entry] of retired) entry.controller?.abort();
    await Promise.all(retired.map(([, entry]) => entry.promise));
    for (const [key, entry] of retired) {
      if (this.entries.get(key) === entry) { this.outputBytes -= entry.outputBytes; this.entries.delete(key); }
    }
  }
  /** Daemon-owned lifecycle: cancel/reap requests and discard retained output. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...new Set([...this.entries.values()].map(entry => entry.sessionId))].map(id => this.retireSession(id)));
  }
  private abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new BytedcliBrokerError('cancelled'));
    return new Promise((resolveResult, reject) => {
      const abort = () => reject(new BytedcliBrokerError('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolveResult, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private beforeDeadline<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new BytedcliBrokerError('timeout')), Math.max(0, deadline - Date.now()));
      this.abortable(promise, signal).then(resolveResult, reject).finally(() => clearTimeout(timer));
    });
  }
  private async replay(request: BytedcliExecutionRequest, entry: Entry, deadline: number): Promise<BytedcliExecResponse> {
    if (this.waiters.length + this.duplicateWaiters >= 64) return rejectResponse(request, 'busy');
    this.duplicateWaiters++; let counted = true; let release: (() => void) | undefined; let timedOut = false;
    const controller = new AbortController(); const abort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    request.signal?.addEventListener('abort', abort, { once: true }); if (request.signal?.aborted) abort();
    const active = { ...request, signal: controller.signal };
    try {
      const result = await this.abortable(entry.promise, controller.signal);
      this.duplicateWaiters--; counted = false;
      // Result source verification can itself touch the provider. Give it the
      // same quota/deadline as a fresh request, without re-dispatching business.
      release = await this.acquire(active); await this.abortable(this.check(active), controller.signal);
      if (entry.revalidate) {
        const current = await this.abortable(entry.revalidate(controller.signal), controller.signal);
        if (current) throw new BytedcliBrokerError(current);
      }
      await this.abortable(this.check(active), controller.signal);
      return result;
    } catch (error) {
      return rejectResponse(request, timedOut ? 'timeout' : errorCode(error), entry.identity ?? { kind: 'none' },
        !!entry.dispatched && request.operation.effect === 'write');
    } finally {
      if (counted) this.duplicateWaiters--; release?.(); clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
    }
  }
  private fits(request: BytedcliExecutionRequest): boolean {
    const session = this.sessions.get(request.authority.sessionId) ?? { reads: 0, writes: 0 };
    return this.running < 16 && (request.operation.effect === 'write'
      ? this.writes < 4 && session.writes < 1 : session.reads < 4);
  }
  private reserve(request: BytedcliExecutionRequest): () => void {
    const id = request.authority.sessionId; const session = this.sessions.get(id) ?? { reads: 0, writes: 0 };
    const write = request.operation.effect === 'write'; this.running++; if (write) { this.writes++; session.writes++; } else session.reads++;
    this.sessions.set(id, session); let released = false;
    return () => {
      if (released) return; released = true; this.running--; if (write) { this.writes--; session.writes--; } else session.reads--;
      if (!session.reads && !session.writes) this.sessions.delete(id);
      for (let index = 0; index < this.waiters.length;) {
        const waiter = this.waiters[index]!;
        if (this.fits(waiter.request)) { this.waiters.splice(index, 1); waiter.cleanup(); waiter.resolve(this.reserve(waiter.request)); }
        else index++;
      }
    };
  }
  private async acquire(request: BytedcliExecutionRequest): Promise<() => void> {
    if (request.signal?.aborted) throw new BytedcliBrokerError('cancelled');
    if (this.fits(request)) return this.reserve(request);
    if (this.waiters.length >= 64) throw new BytedcliBrokerError('busy');
    return new Promise((resolveRelease, reject) => {
      const fail = (code: BytedcliExecErrorCode) => {
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        waiter.cleanup(); reject(new BytedcliBrokerError(code));
      };
      const abort = () => fail('cancelled'); const timer = setTimeout(() => fail('busy'), 5000);
      const waiter: Waiter = { request, resolve: resolveRelease, reject, cleanup: () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); } };
      this.waiters.push(waiter); request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
    });
  }
  private async executeOnce(request: BytedcliExecutionRequest, digest: string, entry: Entry, deadline: number): Promise<BytedcliExecResponse> {
    const controller = new AbortController(); let timeout = false; let dispatched = false;
    entry.controller = controller;
    const abort = () => controller.abort(); request.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    const active = Object.freeze({ ...request, signal: controller.signal });
    let release: (() => void) | undefined; let root: string | undefined; let lease: BytedcliCredentialLease | undefined;
    let identity: BytedcliEffectiveIdentity = { kind: 'none' }; let auditBase: Omit<BytedcliAuditRecord, 'phase'> | undefined;
    let heldOutput = 0; const started = Date.now();
    const bounded = <T>(promise: Promise<T>) => this.abortable(promise, controller.signal);
    try {
      if (request.signal?.aborted) controller.abort();
      release = await this.acquire(active); await bounded(this.check(active));
      const leaseRequest = { region: request.operation.region, actor: request.authority.actor, recheck: request.authority.recheck,
        signal: controller.signal, sessionId: request.authority.sessionId, botAppId: request.authority.botAppId,
        identityTurnId: request.authority.identityTurnId ?? request.authority.turnId };
      lease = await bounded(request.operation.effect === 'read' ? this.deps.leases.machine(leaseRequest) : this.deps.leases.actor(leaseRequest));
      entry.revalidate = lease.stillCurrent;
      const kind = request.operation.effect === 'read' ? 'machine' : 'actor';
      if (lease.kind !== kind || !/^sha256:[A-Za-z0-9_-]+$/.test(lease.accountFingerprint)) throw new BytedcliBrokerError('actor_identity_unverified');
      identity = Object.freeze({ kind, accountFingerprint: lease.accountFingerprint });
      entry.identity = identity;
      if (lease.region !== request.operation.region || !lease.jwt || lease.expiresAt <= Date.now()) throw new BytedcliBrokerError('region_auth_required');
      await bounded(this.check(active));
      const cli = await bounded(this.deps.trustedCli(controller.signal)); assertBytedcliAuditedRelease(cli.version);
      ensureBytedcliPrivateDirectory(this.deps.privateRoot); root = mkdtempSync(join(this.deps.privateRoot, 'request-'));
      const home = join(root, 'home'); const cwd = join(root, 'cwd'); mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
      const stage = (name: string, bytes: Buffer) => {
        const path = join(root!, name); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes); } finally { closeSync(fd); } return path;
      };
      const argv = [...request.operation.argv]; let inputBytes = 0;
      for (let index = 0; index < request.operation.stagedInputs.length; index++) {
        const input = request.operation.stagedInputs[index]!;
        const bytes = decodeBytedcliBase64(input.dataBase64, request.operation.inputLimitBytes - inputBytes); inputBytes += bytes.length;
        argv[input.argvIndex] = stage(`input-${index}`, bytes);
      }
      const jwtPath = stage('request.jwt', Buffer.from(lease.jwt)); argv.unshift('--bytecloud-user-jwt-file', jwtPath);
      const authority = request.authority;
      auditBase = { daemonBootId: authority.daemonBootId, botAppId: authority.botAppId, sessionId: authority.sessionId,
        turnId: authority.turnId, workerGeneration: authority.workerGeneration, dispatchAttempt: authority.dispatchAttempt,
        identityTurnId: request.authority.identityTurnId ?? request.authority.turnId,
        policyFingerprint: bytedcliSafeFingerprint(request.authority.policyFingerprint), requestId: request.requestId,
        operationId: request.operation.id, catalogVersion: request.operation.catalogVersion, effect: request.operation.effect as 'read' | 'write',
        accountFingerprint: lease.accountFingerprint, source: lease.source, resources: request.operation.resources,
        inputDigest: digest, timestamp: new Date().toISOString() };
      if (request.operation.effect === 'write') {
        try { await bounded(this.deps.audit.append({ ...auditBase, phase: 'intent' })); }
        catch { throw new BytedcliBrokerError('audit_unavailable'); }
      }
      await bounded(this.check(active)); const leaseCode = await bounded(lease.stillCurrent()); if (leaseCode) throw new BytedcliBrokerError(leaseCode);
      await bounded(this.check(active)); if (!cli.stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
      const runner = this.deps.run ?? runBoundedBytedcliChild;
      // An injected runner is a trusted host boundary; conservatively assume
      // dispatch on entry. The default runner reports the actual spawn event.
      if (this.deps.run) { dispatched = true; entry.dispatched = true; }
      const childWork = runner({ executable: cli.executable, argv: [...(cli.prefixArgs ?? []), ...argv], cwd,
        env: bytedcliMinimalEnv(home, cwd, cli.path, this.deps.networkEnv), signal: controller.signal,
        timeoutMs: Math.max(1, request.operation.timeoutMs - (Date.now() - started)), outputLimitBytes: request.operation.outputLimitBytes,
        onDispatch: () => { dispatched = true; entry.dispatched = true; }, reserveOutput: bytes => {
          if (this.outputBytes + bytes > GLOBAL_OUTPUT_LIMIT) return false;
          this.outputBytes += bytes; heldOutput += bytes; return true;
        } });
      let result;
      try { result = await bounded(childWork); }
      catch (error) { if (!this.deps.run) await childWork.catch(() => undefined); throw error; }
      if (request.operation.effect === 'write' && result.exitCode !== 0) throw new BytedcliBrokerError('upstream_failed');
      if (result.stdout.length + result.stderr.length > request.operation.outputLimitBytes) throw new BytedcliBrokerError('output_limit');
      if (heldOutput === 0) { // injected runners still obey the global budget
        heldOutput = result.stdout.length + result.stderr.length;
        if (this.outputBytes + heldOutput > GLOBAL_OUTPUT_LIMIT) { heldOutput = 0; throw new BytedcliBrokerError('output_limit'); }
        this.outputBytes += heldOutput;
      }
      await bounded(this.check(active)); const current = await bounded(lease.stillCurrent()); if (current) throw new BytedcliBrokerError(current);
      if (!cli.stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
      const stdout = redactBytedcliOutput(result.stdout, [lease.jwt]); const stderr = redactBytedcliOutput(result.stderr, [lease.jwt]);
      if (stdout.length + stderr.length > request.operation.outputLimitBytes) throw new BytedcliBrokerError('output_limit');
      const response: BytedcliExecResponse = Object.freeze({ schema: BYTEDCLI_EXEC_SCHEMA, requestId: request.requestId,
        operationId: request.operation.id, effectiveIdentity: identity, outcome: result.exitCode === 0 ? 'completed' : 'failed',
        stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'), exitCode: Math.max(0, Math.min(255, result.exitCode)),
        ...(result.exitCode !== 0 ? { errorCode: 'upstream_failed' as const } : {}) });
      try { await bounded(this.deps.audit.append({ ...auditBase, phase: 'result', outcome: response.outcome,
        durationMs: Date.now() - started, exitCode: response.exitCode, ...(response.errorCode ? { errorCode: response.errorCode } : {}) })); }
      catch { throw new BytedcliBrokerError('audit_unavailable'); }
      await bounded(this.check(active)); const finalCode = await bounded(lease.stillCurrent()); if (finalCode) throw new BytedcliBrokerError(finalCode);
      const cachedBytes = Buffer.byteLength(response.stdoutBase64) + Buffer.byteLength(response.stderrBase64);
      if (this.outputBytes - heldOutput + cachedBytes > GLOBAL_OUTPUT_LIMIT) throw new BytedcliBrokerError('output_limit');
      this.outputBytes += cachedBytes - heldOutput; heldOutput = 0; entry.outputBytes = cachedBytes;
      return response;
    } catch (error) {
      const code = timeout ? 'timeout' : errorCode(error);
      const unknown = dispatched && request.operation.effect === 'write';
      const response = rejectResponse(request, code, identity, unknown);
      if (auditBase) {
        try { await bounded(this.deps.audit.append({ ...auditBase, phase: 'result', outcome: response.outcome,
          errorCode: response.errorCode, durationMs: Date.now() - started, exitCode: 77 })); } catch { /* persisted intent remains authoritative */ }
      }
      return response;
    } finally {
      controller.abort(); clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
      this.outputBytes -= heldOutput;
      if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* private root remains inaccessible to Agent */ } }
      release?.();
    }
  }
}
