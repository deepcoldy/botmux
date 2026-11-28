/**
 * Validate a configured `coreUrl`: it must name a dedicated core-only service at
 * `http://127.0.0.1:<port>` with no credentials, path, query or fragment.
 * Returns the normalized origin.
 *
 * The single copy of this check: configuration parsing (config.ts) and the
 * gateway's `WecomHttpCore` constructor (gateway/core-client.ts) both call it.
 * It lives in the config layer so parsing a configuration does not import the
 * gateway runtime.
 */
export function validateWecomCoreUrl(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all: refused like any other unusable coreUrl below.
  }
  if (!parsed || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('coreUrl 必须是独立 core-only 服务的 http://127.0.0.1:<port>');
  }
  return parsed.origin;
}
