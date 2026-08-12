import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { FeedbackEventEnvelope, FrozenWebhookDestination } from './feedback-outbox.js';
import type { SkillFeedbackStore } from './skill-feedback-store.js';

export interface AddressRecord { address: string; family: 4 | 6 }
type Lookup = (hostname: string) => Promise<AddressRecord[]>;

function parseV4(value: string): number[] | undefined {
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : undefined;
}
function v4Blocked(value: string): boolean {
  const p = parseV4(value); if (!p) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}
function addressBlocked(address: string): boolean {
  let normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) return v4Blocked(normalized);
  if (isIP(normalized) !== 6) return true;
  // Canonicalize every valid IPv6 spelling before classifying it. DNS can
  // return expanded forms that are loopback/unspecified but evade textual
  // ::/::1 checks. WHATWG URL normalization operates on parsed address words.
  try {
    normalized = new URL(`https://[${normalized}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  const mapped = normalized.match(/^(?:0*:){5}ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16), lo = Number.parseInt(mappedHex[2], 16);
    return v4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:');
}

export async function validateWebhookDestination(url: string, options: { lookup?: Lookup; allowPrivateNetworks?: boolean } = {}): Promise<{ url: URL; hostname: string; addresses: AddressRecord[] }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('webhook_destination_invalid'); }
  if (parsed.protocol !== 'https:') throw new Error('webhook_destination_https_required');
  if (parsed.username || parsed.password) throw new Error('webhook_destination_credentials_forbidden');
  if (parsed.hash) throw new Error('webhook_destination_fragment_forbidden');
  if (!parsed.hostname) throw new Error('webhook_destination_hostname_required');
  const literal = isIP(parsed.hostname.replace(/^\[|\]$/g, ''));
  const addresses = literal
    ? [{ address: parsed.hostname.replace(/^\[|\]$/g, ''), family: literal as 4 | 6 }]
    : await (options.lookup ?? (async host => (await dnsLookup(host, { all: true, verbatim: true })) as AddressRecord[]))(parsed.hostname);
  if (addresses.length === 0) throw new Error('webhook_destination_dns_empty');
  if (!options.allowPrivateNetworks && addresses.some(record => addressBlocked(record.address))) throw new Error('webhook_destination_address_blocked');
  return { url: parsed, hostname: parsed.hostname, addresses };
}

export class FeedbackWebhookSecretStore {
  private readonly path: string;
  constructor(dataDir: string) { mkdirSync(dataDir, { recursive: true }); this.path = join(dataDir, 'feedback-webhook-secrets.json'); }
  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    const value = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('feedback_webhook_secret_store_invalid');
    return value;
  }
  put(destinationId: string, secret: string): string {
    if (!secret) throw new Error('feedback_webhook_secret_empty');
    const ref = `feedback-webhook:${createHash('sha256').update(destinationId).digest('hex')}`;
    const all = this.read(); all[ref] = secret;
    atomicWriteFileSync(this.path, JSON.stringify(all), { mode: 0o600, durable: true, followTargetSymlink: false });
    return ref;
  }
  get(ref: string): string | undefined { return this.read()[ref]; }
  clear(ref: string): boolean { const all = this.read(); if (!(ref in all)) return false; delete all[ref]; atomicWriteFileSync(this.path, JSON.stringify(all), { mode: 0o600, durable: true, followTargetSymlink: false }); return true; }
}

export function classifyWebhookResponse(status: number): 'delivered' | 'retry' | 'failed' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}

export function computeRetryDelay(input: { attempts: number; retryAfter?: string; now?: number; random?: () => number; baseDelayMs?: number; maxDelayMs?: number }): number {
  const cap = input.maxDelayMs ?? 300_000;
  if (input.retryAfter) {
    const seconds = Number(input.retryAfter);
    const absolute = Date.parse(input.retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(absolute) ? Math.max(0, absolute - (input.now ?? Date.now())) : 0;
    if (delay > 0) return Math.min(delay, cap);
  }
  const ceiling = Math.min((input.baseDelayMs ?? 1000) * 2 ** Math.max(0, input.attempts - 1), cap);
  return Math.floor(ceiling * (input.random ?? Math.random)());
}

export interface WebhookRequestInput {
  url: URL; headers: Record<string, string>; body: string; timeoutMs: number; redirect: 'error'; pinnedAddress: string; signal?: AbortSignal;
}
async function nativeRequest(input: WebhookRequestInput): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(input.url, {
      method: 'POST', headers: input.headers, timeout: input.timeoutMs, signal: input.signal,
      lookup: (_hostname, _options, callback) => callback(null, input.pinnedAddress, isIP(input.pinnedAddress) as 4 | 6),
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { if (size < 16_384) { const b = Buffer.from(chunk); chunks.push(b.subarray(0, 16_384 - size)); size += b.length; } });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] ?? '' : String(v ?? '')])), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('webhook_timeout')));
    req.on('error', reject); req.end(input.body);
  });
}

export async function dispatchWebhookAttempt(input: {
  destination: FrozenWebhookDestination; event: FeedbackEventEnvelope; secret: string;
  now?: () => number; lookup?: Lookup; request?: (input: WebhookRequestInput) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  allowPrivateNetworks?: boolean; signal?: AbortSignal;
}): Promise<{ kind: 'delivered' | 'retry' | 'failed'; status?: number; retryAfter?: string; error?: string }> {
  const target = await validateWebhookDestination(input.destination.url, { lookup: input.lookup, allowPrivateNetworks: input.allowPrivateNetworks });
  const body = JSON.stringify(input.event);
  if (Buffer.byteLength(body) > 256 * 1024) return { kind: 'failed', error: 'webhook_body_too_large' };
  const timestamp = String((input.now ?? Date.now)());
  const signature = createHmac('sha256', input.secret).update(`v1.${timestamp}.${body}`).digest('hex');
  try {
    const response = await (input.request ?? nativeRequest)({
      url: target.url, body, timeoutMs: Math.min(Math.max(input.destination.timeoutMs, 100), 30_000), redirect: 'error',
      pinnedAddress: target.addresses[0].address, signal: input.signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'User-Agent': 'botmux-feedback-webhook/1', 'X-Botmux-Event-Id': input.event.eventId, 'X-Botmux-Event-Type': input.event.type, 'X-Botmux-Timestamp': timestamp, 'X-Botmux-Signature': `v1=${signature}` },
    });
    return { kind: classifyWebhookResponse(response.status), status: response.status, ...(response.headers['retry-after'] ? { retryAfter: response.headers['retry-after'] } : {}) };
  } catch (error) { return { kind: 'retry', error: String((error as Error)?.message ?? error).slice(0, 500) }; }
}

export function startFeedbackWebhookDispatcher(options: {
  store: SkillFeedbackStore; readSecret: (ref: string) => string | undefined;
  dispatch?: typeof dispatchWebhookAttempt; intervalMs?: number; staleClaimMs?: number; batchSize?: number; shutdownMs?: number;
  allowPrivateNetworks?: boolean; onError?: (error: unknown) => void;
}): { ready: Promise<void>; stop: () => Promise<void> } {
  let stopped = false, timer: NodeJS.Timeout | undefined, running: Promise<void> | undefined;
  const controller = new AbortController();
  const dispatch = options.dispatch ?? dispatchWebhookAttempt;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = (async () => {
      const now = Date.now(), claimToken = randomUUID();
      const rows = options.store.claimFeedbackOutbox({ now, limit: options.batchSize ?? 10, claimToken });
      await Promise.all(rows.map(async row => {
        try {
          const secret = options.readSecret(row.destination.secretRef);
          if (!secret) { options.store.rescheduleFeedbackOutbox(row.outboxId, claimToken, { now, nextAttemptAt: now, error: 'webhook_secret_missing', permanent: true }); return; }
          const result = await dispatch({ destination: row.destination, event: row.event, secret, allowPrivateNetworks: options.allowPrivateNetworks, signal: controller.signal });
          if (result.kind === 'delivered') { options.store.settleFeedbackOutboxDelivered(row.outboxId, claimToken, result.status ?? 200, new Date().toISOString()); return; }
          const delay = result.kind === 'retry' ? computeRetryDelay({ attempts: row.attempts, retryAfter: result.retryAfter }) : 0;
          options.store.rescheduleFeedbackOutbox(row.outboxId, claimToken, { now, nextAttemptAt: now + delay, error: result.error ?? `webhook_http_${result.status ?? 0}`, httpStatus: result.status, permanent: result.kind === 'failed' });
        } catch (error) {
          options.onError?.(error);
          const delay = computeRetryDelay({ attempts: row.attempts });
          options.store.rescheduleFeedbackOutbox(row.outboxId, claimToken, { now, nextAttemptAt: now + delay, error: String((error as Error)?.message ?? error).slice(0, 500), permanent: false });
        }
      }));
    })().finally(() => { running = undefined; });
    await running;
  };
  const installInterval = (): void => {
    if (stopped || timer) return;
    timer = setInterval(() => {
      try { options.store.resetExpiredFeedbackOutboxClaims(Date.now(), options.staleClaimMs ?? 60_000); }
      catch (error) { options.onError?.(error); }
      void tick().catch(error => options.onError?.(error));
    }, options.intervalMs ?? 5_000);
    timer.unref?.();
  };
  const ready = (async () => {
    // The recurring poll MUST be armed regardless of the bootstrap tick's fate:
    // a transient SQLite BUSY during the first reset/tick previously threw
    // before setInterval ran, leaving the outbox permanently unpolled (queued
    // webhooks never delivered until process restart). Report the bootstrap
    // failure but let the self-healing interval take over.
    try {
      options.store.resetExpiredFeedbackOutboxClaims(Date.now(), options.staleClaimMs ?? 60_000);
      await tick();
    } catch (error) {
      options.onError?.(error);
    } finally {
      installInterval();
    }
  })();
  return { ready, stop: async () => {
    stopped = true; if (timer) clearInterval(timer); controller.abort();
    const pending = running; if (pending) await Promise.race([pending, new Promise<void>(resolve => setTimeout(resolve, options.shutdownMs ?? 5_000))]);
  } };
}
