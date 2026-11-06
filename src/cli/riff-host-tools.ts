import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { writeAndFlush } from './stdout-flush.js';
import {
  RIFF_HOST_BINDING_ENV, RIFF_HOST_MAX_BYTES, riffHostFileArguments,
  type RiffHostBinding, type RiffHostRequest, type RiffHostResult,
} from '../services/riff-host-tools.js';
import { RIFF_HOST_UNREACHABLE_HINT } from '../services/riff-host-hint.js';
import { RIFF_UPLOAD_PREFIX } from '../services/riff-upload-placeholder.js';
import { defaultStatFile, parseSendInvocation, validateClientSendInvocation } from './send-invocation.js';

function bindingPath(env: NodeJS.ProcessEnv): string {
  if (!env.BOTMUX_SESSION_ID) throw new Error('riff_host_session_missing');
  return env[RIFF_HOST_BINDING_ENV] ?? join(resolveBotmuxDataDir({ env }), 'riff-host-bindings',
    `${createHash('sha256').update(env.BOTMUX_SESSION_ID).digest('hex')}.json`);
}

export function installRiffHostBinding(encoded: string, env = process.env): void {
  const b = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as RiffHostBinding;
  const url = new URL(b.url);
  if (b.sessionId !== env.BOTMUX_SESSION_ID || !b.turnId || !/^[A-Za-z0-9_-]{43}$/.test(b.token)
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('riff_host_binding_invalid');
  const path = bindingPath(env);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(b), { mode: 0o600 });
}

/** Return stdin at most once. The top-level send preflight may already have
 *  read it; passing that cached value keeps the Riff path from consuming the
 *  same pipe twice while still allowing a standalone Riff call to read it. */
export function makeRiffStdinReader(
  cached: string | undefined,
  readStdin: () => Promise<string>,
): () => Promise<string> {
  return async () => cached !== undefined ? cached : readStdin();
}

export class RiffSendPreflightError extends Error {}

export async function prepareRiffHostRequest(argv: string[], readStdin: () => Promise<string>): Promise<RiffHostRequest> {
  const args = [...argv];
  if (args[0] === 'ask' && args[1]?.startsWith('--')) args.splice(1, 0, 'buttons');
  const sendInvocation = args[0] === 'send' ? parseSendInvocation(args.slice(1)) : undefined;
  if (sendInvocation) {
    if (sendInvocation.rawDoubleDashToken) {
      throw new RiffSendPreflightError("botmux send: '--' 分隔符尚未支持；正文以 -- 开头请用 --content-file 或 heredoc。");
    }
    if (!sendInvocation.freeHelpRequested) {
      const validated = validateClientSendInvocation(sendInvocation, { cwd: process.cwd(), statFile: defaultStatFile });
      if (!validated.ok) throw new RiffSendPreflightError(validated.message);
    }
  }
  const paths = riffHostFileArguments(args);
  const files: NonNullable<RiffHostRequest['files']> = [];
  let total = 0;
  let stdinValue: string | undefined;
  const stdin = async () => stdinValue ??= await readStdin();
  for (const i of paths) {
    const path = args[i]!;
    const fromStdin = args[i - 1] === '--content-file' && path === '-';
    let bytes: Buffer;
    if (fromStdin) bytes = Buffer.from(await stdin());
    else {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('riff_host_upload_too_large');
      bytes = readFileSync(path);
    }
    if (bytes.length > 24 * 1024 * 1024) throw new Error('riff_host_upload_too_large');
    total += bytes.length;
    if (total * 4 / 3 > RIFF_HOST_MAX_BYTES - 1024 * 1024) throw new Error('riff_host_upload_too_large');
    // Keep only an inert filename; paths and unicode names never select host files.
    const name = basename(path).replace(/[^\w. -]/g, '_').slice(-160) || `upload${extname(path)}`;
    args[i] = `${RIFF_UPLOAD_PREFIX}${files.length}`;
    files.push({ name, dataBase64: bytes.toString('base64') });
  }
  // cmdSend reads stdin only when neither a positional body nor a card/content
  // file was supplied. An empty pipe must not swallow a positional message.
  let body: string | undefined;
  if (sendInvocation?.bodySource === 'stdin' && !sendInvocation.freeHelpRequested) {
    body = await stdin();
  }
  const request = { operationId: randomUUID(), argv: args, stdin: body, ...(files.length ? { files } : {}) };
  if (Buffer.byteLength(JSON.stringify(request)) > RIFF_HOST_MAX_BYTES) throw new Error('riff_host_request_too_large');
  return request;
}

/** The part of an HTTP answer the client needs. Deliberately not a WHATWG
 * Response: a gateway may answer with a status that Response refuses to
 * construct (Node rejects any body on 204), and every answer must surface as a
 * reportable HTTP failure instead of crashing the CLI. */
export interface RiffHostHttpResponse { status: number; text(): Promise<string> }

// A host capability is sent directly to its deployment-owned endpoint. Bun's
// global fetch snapshots proxy variables at startup and can hand private IPv6
// addresses (and their credentials) to the sandbox's HTTP egress proxy.
async function riffHostDirectFetch(url: string, init: RequestInit): Promise<RiffHostHttpResponse> {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('riff_host_endpoint_invalid');
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = typeof init.body === 'string' ? init.body : undefined;
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
      method: init.method, headers, signal: init.signal ?? undefined,
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RIFF_HOST_MAX_BYTES) { res.destroy(new Error('riff_host_response_too_large')); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, text: async () => new TextDecoder().decode(bytes) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const EXCERPT_CHARS = 120;
// C0/C1 controls plus invisible/bidi format characters: an excerpt must not
// rewrite the terminal or reorder the text a human reads.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** One printable line from an unexpected response body: the capability token
 * is masked before anything else, markup of an HTML error page is dropped,
 * control characters are removed and the result is truncated. */
function riffHostResponseExcerpt(text: string, token: string): string {
  // Mask on the whole body first so a later cut can never expose a token part.
  let value = (token ? text.split(token).join('***') : text).slice(0, 8192);
  if (/^\s*</.test(value)) value = value.replace(/<[^>]*>/g, ' ');
  value = value.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(value);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : value;
}

/** Error text for an answer that is not a usable worker reply. A JSON error
 * from the botmux worker keeps its own code; anything else (HTML/plain-text
 * gateway pages, empty bodies, 502/503/504, foreign JSON) did not come from
 * the worker and also names the configuration to check. */
function riffHostResponseError(status: number, text: string, token: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  const workerError = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
  const success = status >= 200 && status < 300;
  // The worker answers with JSON {error} and never with a gateway status.
  if (!success && typeof workerError === 'string' && ![502, 503, 504].includes(status)) {
    return `riff_host_http_${status}: ${riffHostResponseExcerpt(workerError, token) || '<empty error>'}`;
  }
  const detail = riffHostResponseExcerpt(text, token) || '<empty body>';
  return `${success ? `riff_host_response_invalid (HTTP ${status})` : `riff_host_http_${status}`}: ${detail} — ${RIFF_HOST_UNREACHABLE_HINT}`;
}

/** A short, non-secret cause for a failed request: an error code or timeout,
 * never the error message (it can contain the private endpoint address). */
function riffHostTransportCause(error: unknown): string | undefined {
  const e = error as { code?: unknown; message?: unknown; cause?: { name?: unknown } } | undefined;
  if (e?.cause?.name === 'TimeoutError' || (e as { name?: unknown } | undefined)?.name === 'TimeoutError') return 'timeout';
  if (typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code)) return e.code;
  if (typeof e?.message === 'string' && /^riff_host_[a-z_]{1,60}$/.test(e.message)) return e.message;
  return undefined;
}

export async function callRiffHostTool(binding: RiffHostBinding, request: RiffHostRequest,
  fetchImpl: (url: string, init: RequestInit) => Promise<RiffHostHttpResponse> = riffHostDirectFetch): Promise<RiffHostResult> {
  const headers = { 'x-riff-host-token': binding.token, 'content-type': 'application/json' };
  const deadline = Date.now() + 62 * 60_000;
  let posted = false, transportFailures = 0;
  while (Date.now() < deadline) {
    // One POST only. A transport-ambiguous POST is reconciled by GET with the
    // same operation id; never fall back to direct Lark or create a fresh id.
    const init = !posted ? { method: 'POST', headers, body: JSON.stringify(request) } : { method: 'GET', headers };
    const url = posted ? `${binding.url}?operationId=${encodeURIComponent(request.operationId)}` : binding.url;
    posted = true;
    let response: RiffHostHttpResponse;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch (error) {
      if (++transportFailures >= 3) {
        const cause = riffHostTransportCause(error);
        throw new Error(`riff_host_transport_unknown${cause ? ` (${cause})` : ''}; do not repeat automatically — ${RIFF_HOST_UNREACHABLE_HINT}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500)); continue;
    }
    transportFailures = 0;
    // Read text first: a gateway page is not JSON, and its status is the
    // useful part of the failure (not a JSON parse error).
    const text = await response.text();
    let body: { state?: unknown; result?: RiffHostResult } | undefined;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (response.status >= 200 && response.status < 300 && body && typeof body === 'object') {
      if (body.state === 'completed' && body.result) return body.result;
      if (body.state === 'running') { await new Promise(resolve => setTimeout(resolve, 300)); continue; }
    }
    throw new Error(riffHostResponseError(response.status, text, binding.token));
  }
  throw new Error('riff_host_execution_unknown; do not repeat automatically');
}

export function restoreRiffHostAttachments(result: RiffHostResult): RiffHostResult {
  if (!result.attachments?.length) return result;
  const directory = mkdtempSync(join(tmpdir(), 'botmux-riff-quoted-'));
  const parsed = JSON.parse(result.stdout) as { attachments?: Array<{ path: string }> };
  for (const [index, item] of result.attachments.entries()) {
    const path = join(directory, `${index}-${basename(item.name)}`);
    writeFileSync(path, Buffer.from(item.dataBase64, 'base64'), { mode: 0o600 });
    for (const attachment of parsed.attachments ?? []) {
      if (attachment.path === item.placeholder) attachment.path = path;
    }
  }
  return { ...result, stdout: `${JSON.stringify(parsed, null, 2)}\n` };
}

/** Returns false for a local invocation. A configured remote command either
 * completes on the host or fails explicitly; it never edits sandbox-local state. */
export async function maybeRunRiffHostTool(argv: string[], readStdin: () => Promise<string>, env = process.env): Promise<boolean> {
  if (env.BOTMUX_HOST_RELAY_AUTHORIZED === '1' || !env.BOTMUX_SESSION_ID) return false;
  if (argv[0] === 'riff-host-bind') {
    if (argv.length !== 2) throw new Error('riff_host_binding_invalid');
    installRiffHostBinding(argv[1]!, env);
    return true;
  }
  const path = bindingPath(env);
  if (env.BOTMUX_RIFF_HOST_TOOLS !== '1') return false;
  if (['--version', '-v', '--help', '-h', 'help', 'capabilities', 'skill'].includes(argv[0] ?? '')
    || (argv[0] === 'send' && argv.includes('--dry-run'))) return false;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    // A missing binding means this turn's bootstrap did not finish; a bare
    // ENOENT sends the reader looking at the file system instead of that line.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('riff_host_binding_missing: run this turn\'s <botmux_host_tools> bootstrap command first and check its error output');
    }
    throw error;
  }
  const b = JSON.parse(raw) as RiffHostBinding;
  if (b.sessionId !== env.BOTMUX_SESSION_ID) throw new Error('riff_host_session_mismatch');
  let request: RiffHostRequest;
  try {
    request = await prepareRiffHostRequest(argv, readStdin);
  } catch (error) {
    if (error instanceof RiffSendPreflightError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
  const result = restoreRiffHostAttachments(await callRiffHostTool(b, request));
  await Promise.all([writeAndFlush(process.stdout, result.stdout), writeAndFlush(process.stderr, result.stderr)]);
  process.exitCode = result.exitCode;
  return true;
}
