import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { readSecureHostFileSync } from '../platform/secure-host-file.js';
import { isLoopback } from './daemon-internal-auth.js';
import type { RoleInjectMode } from '../core/role-resolver.js';
import { cliModelSupportsReasoningEffort, isCodexReasoningEffort } from '../services/codex-reasoning-effort.js';

export const COMPANION_API_VERSION = 'botmux.companion.v1';
export const COMPANION_BODY_LIMIT = 64 * 1024;
export const COMPANION_MODEL_MAX_LENGTH = 200;
export const COMPANION_OPERATION_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;
const WRITE_RESULT_TTL_MS = 10 * 60_000;
const WRITE_RESULT_MAX = 1_000;
const COMPANION_ROUTES: Readonly<Record<string, 'health' | 'role-read' | 'role-write' | 'runtime-read' | 'runtime-write'>> = Object.freeze({
  'GET /__companion/v1/health': 'health',
  'GET /__companion/v1/role': 'role-read',
  'PUT /__companion/v1/role': 'role-write',
  'GET /__companion/v1/runtime': 'runtime-read',
  'PUT /__companion/v1/runtime': 'runtime-write',
});

export type CompanionProvider = 'codex' | 'traecli';
export interface CompanionRole { role: string; injectMode: RoleInjectMode; revision: null }
export interface CompanionRuntime { provider: CompanionProvider; model?: string; reasoning?: string }

export interface CompanionOperations {
  readRole(): CompanionRole | Promise<CompanionRole>;
  writeRole(value: { role: string; injectMode: RoleInjectMode }): CompanionRole | Promise<CompanionRole>;
  readRuntime(): CompanionRuntime | Promise<CompanionRuntime>;
  writeRuntime(value: CompanionRuntime): CompanionRuntime | Promise<CompanionRuntime>;
}

export interface CompanionApiConfig {
  secret: string;
  operations: CompanionOperations;
  now?: () => number;
}

export function loadCompanionSecret(path: string): string {
  try {
    if (!isAbsolute(path)) throw new Error();
    const leaf = lstatSync(path);
    if (leaf.isSymbolicLink() || !leaf.isFile() || realpathSync(path) !== path) throw new Error();
    const secret = readSecureHostFileSync(path, 1024)?.trim();
    if (!secret) throw new Error();
    return secret;
  } catch {
    // Stable error only: never include the credential path or file metadata.
    throw new Error('companion_secret_invalid');
  }
}

export function companionSignature(secret: string, input: {
  timestamp: string; nonce: string; method: string; pathname: string; bodyRaw: string;
}): string {
  const bodyHash = createHash('sha256').update(input.bodyRaw).digest('hex');
  return createHmac('sha256', secret).update([
    input.timestamp, input.nonce, input.method.toUpperCase(), input.pathname, bodyHash,
  ].join('\n')).digest('base64url');
}

export const isCompanionLoopback = isLoopback;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > COMPANION_BODY_LIMIT) return null;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

async function bounded<T>(operation: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), COMPANION_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createCompanionApi(config: CompanionApiConfig) {
  const now = config.now ?? Date.now;
  const nonces = new Map<string, number>();
  const writes = new Map<string, { expiresAt: number; promise: Promise<{ status: number; value: unknown }> }>();

  return async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith('/__companion/')) return false;
    if (!isCompanionLoopback(req.socket?.remoteAddress)) { json(res, 403, { ok: false, error: 'forbidden' }); return true; }
    const operation = COMPANION_ROUTES[`${req.method ?? 'GET'} ${pathname}`];
    if (!operation) { json(res, 404, { ok: false, error: 'unknown_endpoint' }); return true; }

    const raw = await body(req);
    if (raw === null) { json(res, 413, { ok: false, error: 'body_too_large' }); return true; }
    const timestamp = typeof req.headers['x-botmux-companion-timestamp'] === 'string' ? req.headers['x-botmux-companion-timestamp'] : '';
    const nonce = typeof req.headers['x-botmux-companion-nonce'] === 'string' ? req.headers['x-botmux-companion-nonce'] : '';
    const signature = typeof req.headers['x-botmux-companion-signature'] === 'string' ? req.headers['x-botmux-companion-signature'] : '';
    const timestampMs = Number(timestamp);
    if (!timestamp || !nonce || !signature || !Number.isSafeInteger(timestampMs) || Math.abs(now() - timestampMs) > CLOCK_SKEW_MS) {
      json(res, 401, { ok: false, error: 'unauthorized' }); return true;
    }
    for (const [key, expiry] of nonces) if (expiry <= now()) nonces.delete(key);
    if (nonces.has(nonce)) { json(res, 409, { ok: false, error: 'replayed' }); return true; }
    const expected = companionSignature(config.secret, { timestamp, nonce, method: req.method ?? 'GET', pathname, bodyRaw: raw });
    const got = Buffer.from(signature, 'base64url');
    const want = Buffer.from(expected, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      json(res, 401, { ok: false, error: 'unauthorized' }); return true;
    }
    nonces.set(nonce, now() + NONCE_TTL_MS);

    if (operation === 'health') {
      json(res, 200, { ok: true, version: COMPANION_API_VERSION, capabilities: ['role.read', 'role.write', 'runtime.read', 'runtime.write'] });
      return true;
    }
    try {
      if (operation === 'role-read') { json(res, 200, { ok: true, value: await bounded(config.operations.readRole) }); return true; }
      if (operation === 'runtime-read') { json(res, 200, { ok: true, value: await bounded(config.operations.readRuntime) }); return true; }
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'operation_failed' });
      return true;
    }

    const parsed = parseObject(raw);
    if (!parsed || !validRequestId(parsed.requestId)) { json(res, 400, { ok: false, error: 'invalid_body' }); return true; }

    let execute: () => Promise<unknown>;
    if (operation === 'role-write') {
      if (!exactKeys(parsed, ['requestId', 'role', 'injectMode']) || typeof parsed.role !== 'string'
        || Buffer.byteLength(parsed.role, 'utf8') > 32 * 1024
        || (parsed.injectMode !== 'every' && parsed.injectMode !== 'once')) {
        json(res, 400, { ok: false, error: 'invalid_body' }); return true;
      }
      const role = parsed.role;
      const injectMode = parsed.injectMode;
      execute = () => bounded(() => config.operations.writeRole({ role, injectMode }));
    } else {
      if (!exactKeys(parsed, ['requestId', 'provider', 'model', 'reasoning'])
        || (parsed.provider !== 'codex' && parsed.provider !== 'traecli')) {
        json(res, 400, { ok: false, error: 'invalid_body' }); return true;
      }
      const provider: CompanionProvider = parsed.provider;
      const model = parsed.model === undefined ? undefined : typeof parsed.model === 'string' ? parsed.model.trim() : null;
      const cliId = provider === 'codex' ? 'codex' : 'traex';
      if (model === null || (model && model.length > COMPANION_MODEL_MAX_LENGTH)
        || (parsed.reasoning !== undefined && (!isCodexReasoningEffort(parsed.reasoning)
          || !cliModelSupportsReasoningEffort(cliId, model || undefined, parsed.reasoning)))) {
        json(res, 400, { ok: false, error: 'invalid_body' }); return true;
      }
      const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;
      execute = () => bounded(() => config.operations.writeRuntime({
        provider,
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
      }));
    }

    const idempotencyKey = `${operation}:${parsed.requestId}`;
    const currentTime = now();
    for (const [key, entry] of writes) if (entry.expiresAt <= currentTime) writes.delete(key);
    let entry = writes.get(idempotencyKey);
    if (!entry) {
      const pending = execute().then(
        value => ({ status: 200, value: { ok: true, requestId: parsed.requestId, value } }),
        error => ({ status: 500, value: { ok: false, error: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'operation_failed' } }),
      );
      // Store before awaiting: concurrent retries share the same side effect.
      entry = { expiresAt: currentTime + WRITE_RESULT_TTL_MS, promise: pending };
      writes.set(idempotencyKey, entry);
      while (writes.size > WRITE_RESULT_MAX) {
        const oldest = writes.keys().next().value;
        if (!oldest) break;
        writes.delete(oldest);
      }
      pending.then(result => {
        // Failed results are never durable idempotency records: callers may
        // retry after a transient backend failure or timeout.
        if (result.status !== 200 && writes.get(idempotencyKey)?.promise === pending) writes.delete(idempotencyKey);
      }).catch(() => { /* result promise already normalizes operation errors */ });
    }
    const result = await entry.promise;
    json(res, result.status, result.value);
    return true;
  };
}
