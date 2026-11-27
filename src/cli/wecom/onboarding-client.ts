import { loopbackFetch, type LoopbackFetchInit } from '../../core/loopback-fetch.js';
import type { DashboardResult } from '../dashboard-endpoint.js';
import type { WecomOnboardingSnapshot } from '../../im/wecom/contract/dashboard-dto.js';

export interface WecomSetupClient {
  list(): Promise<WecomOnboardingSnapshot[]>;
  start(input: Record<string, unknown>): Promise<WecomOnboardingSnapshot>;
  get(id: string): Promise<WecomOnboardingSnapshot>;
  action(id: string, action: 'retry' | 'refresh' | 'cancel'): Promise<WecomOnboardingSnapshot>;
}
const JOB_ID = /^wecom-[a-f0-9-]{36}$/;
const STATUSES = new Set(['starting', 'waiting_for_scan', 'verifying', 'needs_pairing', 'starting_bot', 'completed', 'failed', 'cancelled']);
const failure = () => new Error('本机 Dashboard 请求失败或授权已失效；重新运行 setup 续办，勿重复创建机器人。');

/**
 * The Dashboard answered a start request with `400 { error: 'wecom_…' }`: it
 * refused the job and said why. Carries that code only — nothing else of the
 * response and nothing of the request (which may hold a Secret). Which codes
 * prove that no job was created is the caller's call (cli/wecom/setup-wizard.ts).
 */
export class WecomSetupRejectedError extends Error {
  constructor(readonly code: string) {
    super(`本机 Dashboard 拒绝了创建请求（${code}）`);
    this.name = 'WecomSetupRejectedError';
  }
}
const REJECTION_CODE = /^wecom_[a-z_]+$/;
function snapshot(value: unknown): WecomOnboardingSnapshot {
  const job = value as WecomOnboardingSnapshot | undefined;
  if (!job || !JOB_ID.test(job.id) || job.platform !== 'wecom' || !STATUSES.has(job.status)) throw failure();
  return job;
}

/** Uses the same local owner cookie and page-minted CSRF as the browser. URLs
 * in the HMAC response may point at a LAN/remote frontend; only their token is
 * consumed. The destination comes exclusively from the successful HMAC dial. */
export async function createWecomSetupClient(result: DashboardResult, port: number, options: {
  fetch?: (url: string, init?: LoopbackFetchInit) => Promise<Response>;
  timeoutMs?: number;
} = {}): Promise<WecomSetupClient> {
  if (!result.ok || !Number.isInteger(port) || port < 1 || port > 65535) throw failure();
  let token: string | null;
  try {
    token = new URL(result.localUrl ?? result.url).searchParams.get('t');
  } catch {
    throw failure();
  }
  if (!token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw failure();
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `botmux_dashboard_token=${token}`;
  let csrf = '';
  const transport = options.fetch ?? loopbackFetch;
  // `readRejection`: a 400 JSON answer is read for its `wecom_…` code (start only).
  const request = async (path: string, body?: Record<string, unknown>, html = false, readRejection = false): Promise<string> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejected: string | undefined;
    try {
      const response = await transport(`${origin}${path}`, {
        method: body ? 'POST' : 'GET', signal: abort.signal,
        headers: { cookie, ...(body ? { origin, 'x-botmux-csrf': csrf, 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // loopbackFetch uses node:http and never follows redirects or proxies.
      const rejection = readRejection && response.status === 400;
      if ((!response.ok && !rejection) || !response.body || !response.headers.get('content-type')?.includes(html ? 'text/html' : 'application/json')) {
        throw failure();
      }
      const max = html ? 512 * 1024 : 2 * 1024 * 1024;
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw failure();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > max || abort.signal.aborted) throw failure();
        chunks.push(part.value);
      }
      if (abort.signal.aborted) throw failure();
      const text = Buffer.concat(chunks).toString('utf8');
      if (rejection) {
        const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
        if (typeof error === 'string' && REJECTION_CODE.test(error)) rejected = error;
        throw failure();
      }
      return text;
    } catch {
      throw rejected ? new WecomSetupRejectedError(rejected) : failure();
    } finally {
      clearTimeout(timer);
      void reader?.cancel().catch(() => {});
    }
  };
  const page = await request('/', undefined, true);
  const tickets = [...page.matchAll(/<meta name="botmux-csrf" content="([A-Za-z0-9_-]{16,256})">/g)];
  if (tickets.length !== 1) throw failure();
  csrf = tickets[0][1];
  const json = async (path: string, body?: Record<string, unknown>, readRejection = false) => {
    try {
      return JSON.parse(await request(path, body, false, readRejection));
    } catch (error) {
      throw error instanceof WecomSetupRejectedError ? error : failure();
    }
  };
  const jobPath = (id: string) => {
    if (!JOB_ID.test(id)) {
      throw failure();
    }
    return `/api/bot-onboarding/${id}`;
  };
  return {
    async list() {
      const result = await json('/api/bot-onboarding/wecom-jobs');
      if (!Array.isArray(result.jobs)) throw failure();
      return result.jobs.map(snapshot);
    },
    // Scan-to-create unless the caller explicitly asks for manual credentials
    // (`mode: 'manual'` with botId / secret — the same job the browser's manual
    // form starts). The secret travels only in this one request body; a failure
    // is reported with the fixed message above, or — for a `400 { error: 'wecom_…' }`
    // refusal — as WecomSetupRejectedError carrying that code alone; never with a body.
    async start(input) {
      return snapshot((await json('/api/bot-onboarding/start', {
        ...input,
        platform: 'wecom',
        mode: input.mode === 'manual' ? 'manual' : 'qr',
      }, true)).job);
    },
    async get(id) {
      return snapshot((await json(jobPath(id))).job);
    },
    async action(id, action) {
      return snapshot((await json(`${jobPath(id)}/${action}`, {})).job);
    },
  };
}
