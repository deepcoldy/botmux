/** Official wecom-cli QR protocol. Credentials and the polling code stay server-side.
 * https://github.com/WecomTeam/wecom-cli/blob/main/crates/wecom-cli/src/auth/qrcode.rs
 */
const ORIGIN = 'https://work.weixin.qq.com';
const SOURCE = 'wecom_cli_external';
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const QR_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

export interface WecomQrCredentials { botId: string; secret: string }
export interface WecomQrAuthorization {
  readonly authUrl: string;
  readonly expiresAt: number;
  waitForCredentials(options?: { signal?: AbortSignal }): Promise<WecomQrCredentials>;
  cancel(): void;
}
export interface WecomQrOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  platform?: NodeJS.Platform;
}
function failure(code: string): Error { return new Error(`wecom_qr_${code}`); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function token(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : failure('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function request(url: URL, options: WecomQrOptions, signal: AbortSignal): Promise<Record<string, unknown>> {
  const timeout = new AbortController();
  const abort = () => timeout.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => timeout.abort(failure('request_timeout')), REQUEST_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    return await abortable((async () => {
      const response = await (options.fetch ?? globalThis.fetch)(url, { signal: timeout.signal, redirect: 'error', credentials: 'omit' });
      if (timeout.signal.aborted) { void response.body?.cancel().catch(() => {}); throw timeout.signal.reason; }
      if (!response.ok || !response.body) throw failure('request_failed');
      const size = response.headers.get('content-length');
      if (size && (!/^\d+$/.test(size) || Number(size) > MAX_RESPONSE_BYTES)) throw failure('response_too_large');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const next = await abortable(reader.read(), timeout.signal);
        if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw failure('response_too_large');
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const parsed = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (!parsed || (parsed.errcode !== undefined && parsed.errcode !== 0)) throw failure('invalid_response');
      return parsed;
    })(), timeout.signal);
  } catch (error) {
    if (timeout.signal.aborted) throw timeout.signal.reason instanceof Error ? timeout.signal.reason : failure('cancelled');
    // Never propagate upstream error messages, URLs, body fragments, or credential values.
    if (error instanceof Error && /^wecom_qr_[a-z_]+$/.test(error.message)) throw error;
    throw failure('request_failed');
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    void reader?.cancel().catch(() => {});
  }
}
function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, POLL_INTERVAL_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function createWecomQrAuthorization(options: WecomQrOptions = {}): Promise<WecomQrAuthorization> {
  const controller = new AbortController();
  const cancel = () => controller.abort(failure('cancelled'));
  const parentAbort = () => cancel();
  options.signal?.addEventListener('abort', parentAbort, { once: true });
  if (options.signal?.aborted) cancel();
  const now = options.now ?? Date.now, expiresAt = now() + QR_TIMEOUT_MS;
  let scode = '', waiting = false;
  const dispose = () => { scode = ''; options.signal?.removeEventListener('abort', parentAbort); };
  try {
    const url = new URL('/ai/qc/generate', ORIGIN);
    const platform = options.platform ?? process.platform;
    url.searchParams.set('source', SOURCE);
    url.searchParams.set('plat', platform === 'darwin' ? '1' : platform === 'win32' ? '2' : platform === 'linux' ? '3' : '0');
    const response = await request(url, options, controller.signal);
    if (controller.signal.aborted) throw failure('cancelled');
    const data = record(response.data);
    if (!data || !token(data.scode) || !token(data.auth_url, 8192)) throw failure('invalid_response');
    let auth: URL;
    try { auth = new URL(data.auth_url); } catch { throw failure('invalid_response'); }
    if (auth.origin !== ORIGIN || auth.username || auth.password) throw failure('invalid_response');
    scode = data.scode;
    return {
      authUrl: auth.href, expiresAt,
      cancel() { cancel(); dispose(); },
      async waitForCredentials(waitOptions = {}) {
        if (waiting) throw failure('already_waiting');
        waiting = true;
        const abort = () => cancel();
        waitOptions.signal?.addEventListener('abort', abort, { once: true });
        if (waitOptions.signal?.aborted) cancel();
        const timer = setTimeout(() => controller.abort(failure('expired')), Math.max(0, expiresAt - now()));
        try {
          while (true) {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (now() >= expiresAt) throw failure('expired');
            const query = new URL('/ai/qc/query_result', ORIGIN); query.searchParams.set('scode', scode);
            const queried = await request(query, options, controller.signal);
            if (controller.signal.aborted) throw controller.signal.reason;
            if (now() >= expiresAt) throw failure('expired');
            const state = record(queried.data);
            if (!state || !token(state.status, 128)) throw failure('invalid_response');
            if (state.status === 'success') {
              const bot = record(state.bot_info);
              if (!bot || !token(bot.botid) || !token(bot.secret)) throw failure('invalid_response');
              return { botId: bot.botid, secret: bot.secret };
            }
            await delay(controller.signal);
          }
        } finally {
          clearTimeout(timer); waitOptions.signal?.removeEventListener('abort', abort); dispose();
        }
      },
    };
  } catch (error) { dispose(); throw error; }
}
