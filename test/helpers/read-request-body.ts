import type { IncomingMessage } from 'node:http';

/**
 * Read a loopback mock server's request body without assuming it is JSON.
 *
 * WHY this exists: several tests bind an ephemeral loopback port
 * (`listen(0, '127.0.0.1')`) and then parse every request body with a bare
 * `JSON.parse`. On a machine that runs a port scanner — the corp host runs
 * `/etc/sysop/mongoosev3-agent/plugin/scanner/scanner`, which issues
 * `GET /` with an EMPTY body against every listening loopback port — the mock
 * receives that probe, `JSON.parse('')` throws `SyntaxError: Unexpected end of
 * JSON input` inside the async handler, and Vitest reports it as an *unhandled*
 * rejection. Depending on timing that flips the whole run's exit code (observed
 * ~50% on this host) while the assertions themselves still pass, so CI and local
 * runs disagree at random. The probe is not a bug in the mock's contract: a real
 * HTTP server must tolerate an empty body, so the fixture should too.
 *
 * Callers that need the parsed value still get it; callers that want to ignore
 * non-JSON probes (a bare `GET /` health check) can pass `{ ignoreNonJson: true }`
 * and receive the sentinel `undefined` instead of a throw.
 */
export type RequestBodyRead =
  | { kind: 'json'; raw: string; value: unknown }
  | { kind: 'empty'; raw: ''; value: undefined }
  | { kind: 'other'; raw: string; value: undefined };

/** Read the raw body text, tolerating a stream that is already ended. */
export async function readRequestBodyText(req: IncomingMessage): Promise<string> {
  // `for await` on an already-ended stream yields nothing, but guard against
  // incoming-message variants whose async iterator was consumed elsewhere.
  if ((req as { readableEnded?: boolean }).readableEnded) return '';
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/**
 * Read and classify a mock server's body. Never throws on an empty or malformed
 * body — a loopback scanner probe must not crash the fixture.
 */
export async function readRequestBody(req: IncomingMessage): Promise<RequestBodyRead> {
  const raw = await readRequestBodyText(req);
  if (raw.length === 0) return { kind: 'empty', raw: '', value: undefined };
  try {
    return { kind: 'json', raw, value: JSON.parse(raw) };
  } catch {
    return { kind: 'other', raw, value: undefined };
  }
}

/**
 * Convenience for the common `requests.push({ …, body: JSON.parse(body) })`
 * shape: returns the parsed JSON, or `undefined` for a probe we should ignore.
 * Pass `{ strict: true }` to keep the old throwing behaviour for bodies that are
 * non-empty but malformed (a genuine test bug rather than a scanner probe).
 */
export async function readRequestBodyJson<T = unknown>(
  req: IncomingMessage,
  options: { strict?: boolean } = {},
): Promise<T | undefined> {
  const read = await readRequestBody(req);
  if (read.kind === 'json') return read.value as T;
  if (read.kind === 'empty') return undefined;
  if (options.strict) throw new SyntaxError(`non-JSON request body: ${read.raw.slice(0, 200)}`);
  return undefined;
}
