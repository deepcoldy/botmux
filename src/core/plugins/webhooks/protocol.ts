import type { PluginWebhookRouteEntry, PluginWebhooksContribution } from '../types.js';
import { isValidPluginId } from '../ids.js';

export const PLUGIN_WEBHOOK_SCHEMA_VERSION = 1;
export const PLUGIN_WEBHOOK_TOKEN_ENV = 'BOTMUX_PLUGIN_WEBHOOK_TOKEN';
export const PLUGIN_RESERVED_HOST_CALLBACK_PREFIXES = ['/botmux'] as const;
export const PLUGIN_WEBHOOK_DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const PLUGIN_WEBHOOK_ROUTES_MAX = 32;
export const PLUGIN_WEBHOOK_PATH_MAX_LENGTH = 256;
export const PLUGIN_WEBHOOK_TIMEOUT_MS = 30_000;
export const PLUGIN_WEBHOOK_BODY_READ_TIMEOUT_MS = 15_000;
export const PLUGIN_WEBHOOK_BODY_IDLE_TIMEOUT_MS = 5_000;
export const PLUGIN_WEBHOOK_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const VISIBLE_ASCII_RE = /^[\x21-\x7e]*$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const ENCODED_SLASH_OR_BACKSLASH_RE = /%(?:2f|5c)/i;
const STRICT_NON_NEGATIVE_INT_RE = /^\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a strict HTTP path string for webhook declarations or incoming
 * subpaths. Enforces visible ASCII (preventing ERR_UNESCAPED_CHARACTERS and
 * control/whitespace injection), rejects `//`, `\`, `?`, `#`, malformed percent
 * encoding, encoded `/` or `\`, and any raw or decoded `.` / `..` segment.
 */
export function validateStrictPluginHttpPath(
  raw: unknown,
  options: {
    allowRoot?: boolean;
    allowTrailingSlash?: boolean;
    maxLength?: number;
    errorCode: string;
  },
): string {
  const maxLength = options.maxLength ?? PLUGIN_WEBHOOK_PATH_MAX_LENGTH;
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || raw.length > maxLength
    || raw !== raw.trim()
    || !raw.startsWith('/')
    || !VISIBLE_ASCII_RE.test(raw)
    || raw.includes('//')
    || raw.includes('\\')
    || raw.includes('?')
    || raw.includes('#')
  ) {
    throw new Error(options.errorCode);
  }
  if (raw === '/') {
    if (!options.allowRoot) throw new Error(options.errorCode);
    return raw;
  }
  if (!options.allowTrailingSlash && raw.endsWith('/')) {
    throw new Error(options.errorCode);
  }
  const trimmedTrailing = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = trimmedTrailing.slice(1).split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(options.errorCode);
    }
    if (ENCODED_SLASH_OR_BACKSLASH_RE.test(segment)) {
      throw new Error(options.errorCode);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(options.errorCode);
    }
    if (
      decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || CONTROL_CHAR_RE.test(decoded)
    ) {
      throw new Error(options.errorCode);
    }
  }
  return raw;
}

export function validateWebhookMaxBodyBytes(raw: unknown, errorCode: string): number | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== 'number'
    || !Number.isInteger(raw)
    || raw < 1
    || raw > PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES
  ) {
    throw new Error(errorCode);
  }
  return raw;
}

function readWebhookRouteEntry(raw: unknown): PluginWebhookRouteEntry {
  if (!isPlainObject(raw)) throw new Error('invalid_plugin_webhook_route');
  const path = validateStrictPluginHttpPath(raw.path, {
    allowRoot: false,
    allowTrailingSlash: false,
    errorCode: 'invalid_plugin_webhook_route_path',
  });
  let prefix: true | undefined;
  if (raw.prefix !== undefined) {
    if (typeof raw.prefix !== 'boolean') throw new Error('invalid_plugin_webhook_route_prefix');
    if (raw.prefix) prefix = true;
  }
  const endpoint = raw.endpoint === undefined
    ? undefined
    : validateStrictPluginHttpPath(raw.endpoint, {
        // Prefix routes may not mount onto `/` (which exposes the entire loopback
        // HTTP pathspace including internal host-attested callback routes).
        allowRoot: !prefix,
        allowTrailingSlash: false,
        errorCode: 'invalid_plugin_webhook_route_endpoint',
      });
  const maxBodyBytes = validateWebhookMaxBodyBytes(raw.maxBodyBytes, 'invalid_plugin_webhook_route_max_body_bytes');
  return {
    path,
    ...(prefix ? { prefix } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
  };
}

/**
 * Canonicalize a plugin callback path for case-insensitive, percent-decoded
 * prefix overlap comparison. Returns `null` on malformed encoding, backslash,
 * or `..` segments so callers fail closed.
 */
export function canonicalizePluginCallbackPath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || CONTROL_CHAR_RE.test(decoded)) return null;
  const parts = decoded.split('/');
  if (parts.some(part => part === '..')) return null;
  const collapsed = decoded.replace(/\/+/g, '/').toLowerCase();
  if (collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

export function pathMatchesBlockedPrefix(normalizedPath: string, normalizedPrefix: string): boolean {
  if (normalizedPrefix === '/') return true;
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export function collectReservedPluginCallbackEndpoints(contributions?: {
  cardActions?: { endpoint: string };
  commands?: { endpoint: string };
}): string[] {
  const endpoints: string[] = [...PLUGIN_RESERVED_HOST_CALLBACK_PREFIXES];
  if (contributions?.cardActions) endpoints.push(contributions.cardActions.endpoint);
  if (contributions?.commands) endpoints.push(contributions.commands.endpoint);
  return endpoints;
}

export function upstreamPathMatchesReservedEndpoint(
  upstreamPathname: string,
  reservedEndpoint: unknown,
): boolean {
  const normalizedUpstream = canonicalizePluginCallbackPath(upstreamPathname);
  const normalizedReserved = typeof reservedEndpoint === 'string'
    ? canonicalizePluginCallbackPath(reservedEndpoint)
    : null;
  if (normalizedUpstream === null || normalizedReserved === null) return true;
  return pathMatchesBlockedPrefix(normalizedUpstream, normalizedReserved);
}

export function webhookRouteOverlapsReservedEndpoint(
  route: PluginWebhookRouteEntry,
  reservedEndpoint: unknown,
): boolean {
  const base = canonicalizePluginCallbackPath(route.endpoint ?? route.path);
  const reserved = typeof reservedEndpoint === 'string'
    ? canonicalizePluginCallbackPath(reservedEndpoint)
    : null;
  if (base === null || reserved === null) return true;
  if (pathMatchesBlockedPrefix(base, reserved)) return true;
  if (route.prefix && pathMatchesBlockedPrefix(reserved, base)) return true;
  return false;
}

export function assertWebhookRoutesAvoidReservedEndpoints(
  contribution: PluginWebhooksContribution,
  reservedEndpoints: readonly unknown[],
): void {
  for (const route of contribution.routes) {
    for (const reserved of reservedEndpoints) {
      if (webhookRouteOverlapsReservedEndpoint(route, reserved)) {
        throw new Error(`plugin_webhook_route_reserved_endpoint:${route.path}`);
      }
    }
  }
}

/**
 * Parse and validate `dist/webhooks/index.json` (used both at install scan time
 * and as a defense-in-depth runtime re-validator when dispatching requests).
 */
export function parsePluginWebhooksContribution(raw: unknown): PluginWebhooksContribution {
  if (!isPlainObject(raw)) throw new Error('invalid_plugin_webhooks');
  if (raw.schemaVersion !== PLUGIN_WEBHOOK_SCHEMA_VERSION) {
    throw new Error('invalid_plugin_webhooks_schema');
  }
  const maxBodyBytes = validateWebhookMaxBodyBytes(raw.maxBodyBytes, 'invalid_plugin_webhooks_max_body_bytes');
  if (!Array.isArray(raw.routes) || raw.routes.length === 0) {
    throw new Error('plugin_webhooks_routes_required');
  }
  if (raw.routes.length > PLUGIN_WEBHOOK_ROUTES_MAX) {
    throw new Error('plugin_webhooks_routes_too_many');
  }
  const routes = raw.routes.map(readWebhookRouteEntry);
  const seenRaw = new Set<string>();
  const seenCanonical = new Set<string>();
  for (const route of routes) {
    const decodedCanonical = decodeURIComponent(route.path).toLowerCase();
    if (seenRaw.has(route.path) || seenCanonical.has(decodedCanonical)) {
      throw new Error(`duplicate_plugin_webhook_route:${route.path}`);
    }
    seenRaw.add(route.path);
    seenCanonical.add(decodedCanonical);
  }
  return {
    schemaVersion: 1,
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    routes,
  };
}

export interface MatchedPluginWebhookRoute {
  route: PluginWebhookRouteEntry;
  upstreamPathname: string;
  maxBodyBytes: number;
}

/**
 * Match an incoming webhook subpath (e.g. `/events` or `/hooks/repo/1`) against
 * a plugin's validated webhook contribution. Exact routes win first, followed
 * by the longest segment-boundary prefix match (`path` or `path/*`).
 */
export function matchPluginWebhookRoute(
  contribution: PluginWebhooksContribution,
  incomingSubpath: string,
): MatchedPluginWebhookRoute | null {
  let matched: PluginWebhookRouteEntry | undefined;
  for (const route of contribution.routes) {
    if (route.path === incomingSubpath) {
      matched = route;
      break;
    }
  }
  if (!matched) {
    for (const route of contribution.routes) {
      if (!route.prefix) continue;
      if (incomingSubpath.startsWith(`${route.path}/`)) {
        if (!matched || route.path.length > matched.path.length) {
          matched = route;
        }
      }
    }
  }
  if (!matched) return null;

  const suffix = incomingSubpath.slice(matched.path.length);
  const baseEndpoint = matched.endpoint;
  const upstreamPathname = baseEndpoint !== undefined
    ? `${baseEndpoint === '/' ? '' : baseEndpoint}${suffix}` || '/'
    : incomingSubpath || '/';

  const maxBodyBytes = Math.min(
    PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES,
    matched.maxBodyBytes ?? contribution.maxBodyBytes ?? PLUGIN_WEBHOOK_DEFAULT_MAX_BODY_BYTES,
  );
  return { route: matched, upstreamPathname, maxBodyBytes };
}

export interface ParsedRawRequestTarget {
  rawPath: string;
  rawSearch: string;
}

/**
 * Parse raw `req.url` BEFORE `new URL(...)` normalizes `..`, `.`, or `\`.
 * Validates origin-form, visible ASCII, and absence of `#` across path & query.
 */
export function parseRawOriginFormTarget(rawUrl: string | undefined): ParsedRawRequestTarget | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.startsWith('/\\')) return null;
  if (rawUrl.includes('#') || !VISIBLE_ASCII_RE.test(rawUrl)) return null;
  const queryIndex = rawUrl.indexOf('?');
  const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const rawSearch = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';
  return { rawPath, rawSearch };
}

function safeDecodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export type PluginProxyRawTargetKind = 'webhook' | 'service' | null;

function decodeLowerSegment(segment: string): string {
  return (safeDecodeSegment(segment) ?? segment).toLowerCase();
}

function classifyDecodedPluginProxySegments(segments: readonly string[]): PluginProxyRawTargetKind {
  if (segments[0] === 'webhook' && segments[1] === 'plugin') return 'webhook';
  if (segments[0] === 'api' && segments[1] === 'plugins' && segments.length >= 4 && segments[3] === 'service') {
    return 'service';
  }
  return null;
}

function walkPluginProxySegments(
  decodedSegments: readonly string[],
  collapseEmpty: boolean,
): PluginProxyRawTargetKind {
  const stack: string[] = [];
  for (const seg of decodedSegments) {
    if (seg === '.' || (collapseEmpty && seg === '')) continue;
    if (seg === '..') {
      stack.pop();
    } else {
      stack.push(seg);
    }
    const matched = classifyDecodedPluginProxySegments(stack);
    if (matched) return matched;
  }
  return null;
}

function classifyPathForPluginProxy(pathname: string): PluginProxyRawTargetKind {
  const decodedSegments = pathname.replace(/\\/g, '/').slice(1).split('/').map(decodeLowerSegment);
  return (
    classifyDecodedPluginProxySegments(decodedSegments)
    ?? walkPluginProxySegments(decodedSegments, true)
    ?? walkPluginProxySegments(decodedSegments, false)
  );
}

/**
 * Determine whether a raw HTTP request-target aims at `/webhook/plugin*` or
 * `/api/plugins/:id/service*` (even before URL normalization or when prefix
 * segments are percent-encoded like `/webhook/%70lugin/...`, cased, double-
 * slashed, dot-prefixed, or absolute-form).
 */
export function detectPluginProxyRawTargetKind(rawUrl: string | undefined): PluginProxyRawTargetKind {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
  let candidatePath = rawUrl;
  const hashIdx = candidatePath.indexOf('#');
  if (hashIdx >= 0) candidatePath = candidatePath.slice(0, hashIdx);
  const queryIdx = candidatePath.indexOf('?');
  if (queryIdx >= 0) candidatePath = candidatePath.slice(0, queryIdx);
  if (!candidatePath.startsWith('/') || candidatePath.startsWith('//') || candidatePath.startsWith('/\\')) {
    try {
      const parsed = new URL(rawUrl, 'http://botmux.invalid');
      candidatePath = parsed.pathname;
    } catch {
      return null;
    }
  }
  const preKind = classifyPathForPluginProxy(candidatePath);
  if (preKind) return preKind;
  try {
    const parsed = new URL(rawUrl, 'http://botmux.invalid');
    return classifyPathForPluginProxy(parsed.pathname);
  } catch {
    return null;
  }
}

export type ParsedWebhookRouteRequest =
  | { ok: true; pluginId: string; subpath: string; rawSearch: string }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Parse and strictly validate a raw request URL targeting `/webhook/plugin/:pluginId/*`.
 */
export function parseRawPluginWebhookRequest(rawUrl: string | undefined): ParsedWebhookRouteRequest {
  const target = parseRawOriginFormTarget(rawUrl);
  if (!target) return { ok: false, status: 400, error: 'invalid_webhook_path' };
  const { rawPath, rawSearch } = target;
  // Require exact unencoded `/webhook/plugin` prefix (block `/webhook/%70lugin/...`).
  if (rawPath === '/webhook/plugin' || rawPath === '/webhook/plugin/') {
    return { ok: false, status: 404, error: 'webhook_route_not_found' };
  }
  if (!rawPath.startsWith('/webhook/plugin/')) {
    return { ok: false, status: 400, error: 'invalid_webhook_path' };
  }
  try {
    validateStrictPluginHttpPath(rawPath, {
      allowRoot: false,
      allowTrailingSlash: true,
      maxLength: 2048,
      errorCode: 'invalid_webhook_path',
    });
  } catch {
    return { ok: false, status: 400, error: 'invalid_webhook_path' };
  }
  const rest = rawPath.slice('/webhook/plugin/'.length);
  const slashIdx = rest.indexOf('/');
  const rawPluginId = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  if (!rawPluginId || rawPluginId.includes('%') || !isValidPluginId(rawPluginId)) {
    return { ok: false, status: 404, error: 'plugin_not_found' };
  }
  if (slashIdx < 0) {
    return { ok: false, status: 404, error: 'webhook_route_not_found' };
  }
  const subpath = rest.slice(slashIdx);
  if (subpath === '/') {
    return { ok: false, status: 404, error: 'webhook_route_not_found' };
  }
  return { ok: true, pluginId: rawPluginId, subpath, rawSearch };
}

export type ParsedServiceProxyRequest =
  | { ok: true; pluginId: string; upstreamPath: string; rawSearch: string }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Legacy connector webhooks (`src/dashboard/webhook-routes.ts`) match at most
 * `/webhook/<connectorId>` or `/webhook/<connectorId>/<token>` — one or two
 * path segments — while a plugin webhook always requires three
 * (`/webhook/plugin/<pluginId>/<subpath>`). A persisted connector whose id is
 * the now-reserved literal `plugin` (in any letter case) therefore owns the
 * 1–2 segment shape: the plugin gateway must let such requests fall through
 * instead of answering 404/400, or the connector's existing webhook URLs stop
 * delivering on upgrade. The legacy router re-runs its own token/HMAC
 * verification, so falling through never bypasses authentication.
 *
 * The gate deliberately does NOT reuse the plugin strict-path validator: a
 * legacy custom secret may contain `/` or `\`, and `publicWebhookUrl` bakes
 * `encodeURIComponent(secret)` into the path, so the opaque token segment can
 * legitimately contain `%2F`/`%5C`. Safety instead comes from:
 *  - normalization invariance: `new URL(rawPath).pathname` must equal the raw
 *    path byte-for-byte, so raw backslashes, raw/encoded complete dot segments
 *    and double slashes (anything WHATWG URL rewrites onto another route) fail;
 *  - single-wire-segment shape (the encoded token cannot split mid-parse);
 *  - rejection of malformed percent encoding and control characters.
 * The legacy router uses the decoded token only for signature comparison.
 */
export function isLegacyPluginConnectorWebhookTarget(rawUrl: string | undefined): boolean {
  const target = parseRawOriginFormTarget(rawUrl);
  if (!target) return false;
  const segments = target.rawPath.split('/');
  // ['', 'webhook', '<connectorId>'] or ['', 'webhook', '<connectorId>', '<token>']
  if (segments[1] !== 'webhook' || segments.length < 3 || segments.length > 4) return false;
  // A trailing slash (`/webhook/plugin/`) never matched the legacy segment regex.
  if (segments.length === 4 && segments[3] === '') return false;

  // Reject any shape WHATWG URL normalization would rewrite onto another route.
  let normalizedPathname: string;
  try {
    normalizedPathname = new URL(target.rawPath, 'http://botmux.invalid').pathname;
  } catch {
    return false;
  }
  if (normalizedPathname !== target.rawPath) return false;

  let connectorId: string;
  try {
    connectorId = decodeURIComponent(segments[2]);
  } catch {
    return false;
  }
  if (CONTROL_CHAR_RE.test(connectorId)) return false;
  // Case-insensitive: connectors created before the reservation may use
  // `PLUGIN`/`Plugin`; the legacy router looks up the stored id exactly and
  // re-verifies its own token before delivering. The equality itself also
  // rejects dot segments and any non-`plugin` connector id.
  if (connectorId.toLowerCase() !== 'plugin') return false;

  if (segments.length === 4) {
    // Opaque token: encoded separators stay one wire segment and are allowed.
    // A token that decodes to a complete `.`/`..` cannot reach here because the
    // invariance check above already rejects every such shape, so only guard
    // against malformed percent encoding and control characters.
    let decodedToken: string;
    try {
      decodedToken = decodeURIComponent(segments[3]);
    } catch {
      return false;
    }
    if (CONTROL_CHAR_RE.test(decodedToken)) {
      return false;
    }
  }
  return true;
}

/**
 * Parse and strictly validate a raw request URL targeting `/api/plugins/:id/service/*`.
 */
export function parseRawPluginServiceProxyRequest(rawUrl: string | undefined): ParsedServiceProxyRequest {
  const target = parseRawOriginFormTarget(rawUrl);
  if (!target) return { ok: false, status: 400, error: 'invalid_service_path' };
  const { rawPath, rawSearch } = target;
  const prefixMatch = rawPath.match(/^\/api\/plugins\/([^/]+)\/service(\/.*)?$/);
  if (!prefixMatch) {
    return { ok: false, status: 400, error: 'invalid_service_path' };
  }
  try {
    validateStrictPluginHttpPath(rawPath, {
      allowRoot: false,
      allowTrailingSlash: true,
      maxLength: 2048,
      errorCode: 'invalid_service_path',
    });
  } catch {
    return { ok: false, status: 400, error: 'invalid_service_path' };
  }
  const rawPluginId = prefixMatch[1];
  if (!rawPluginId || rawPluginId.includes('%') || !isValidPluginId(rawPluginId)) {
    return { ok: false, status: 404, error: 'plugin_not_found' };
  }
  const upstreamPath = prefixMatch[2] && prefixMatch[2].length > 0 ? prefixMatch[2] : '/';
  return { ok: true, pluginId: rawPluginId, upstreamPath, rawSearch };
}

export type FramingHeaderValidation =
  | { ok: true; contentLength?: number; chunked: boolean }
  | { ok: false; status: 400 | 501; error: string };

/**
 * Inspect raw HTTP framing headers from `req.rawHeaders` (avoiding Bun/Node
 * `req.headers` normalization differences on duplicate `Content-Length`).
 */
export function validateRawHttpFraming(
  rawHeaders: readonly string[],
  fallbackHeaders?: Record<string, string | string[] | undefined>,
): FramingHeaderValidation {
  const contentLengths: string[] = [];
  const transferEncodings: string[] = [];

  if (rawHeaders.length >= 2) {
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      const name = rawHeaders[i].toLowerCase();
      const value = rawHeaders[i + 1];
      if (name === 'content-length') contentLengths.push(value);
      else if (name === 'transfer-encoding') transferEncodings.push(value);
    }
  } else if (fallbackHeaders) {
    const cl = fallbackHeaders['content-length'];
    if (Array.isArray(cl)) contentLengths.push(...cl);
    else if (typeof cl === 'string') contentLengths.push(cl);
    const te = fallbackHeaders['transfer-encoding'];
    if (Array.isArray(te)) transferEncodings.push(...te);
    else if (typeof te === 'string') transferEncodings.push(te);
  }

  if (contentLengths.length > 0 && transferEncodings.length > 0) {
    return { ok: false, status: 400, error: 'ambiguous_request_framing' };
  }
  if (contentLengths.length > 1) {
    return { ok: false, status: 400, error: 'duplicate_content_length' };
  }
  if (contentLengths.length === 1) {
    const rawCl = contentLengths[0].trim();
    if (!STRICT_NON_NEGATIVE_INT_RE.test(rawCl)) {
      return { ok: false, status: 400, error: 'invalid_content_length' };
    }
    const parsed = Number(rawCl);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { ok: false, status: 400, error: 'invalid_content_length' };
    }
    return { ok: true, contentLength: parsed, chunked: false };
  }
  if (transferEncodings.length > 0) {
    const codings = transferEncodings
      .flatMap(entry => entry.split(','))
      .map(part => part.trim().toLowerCase())
      .filter(Boolean);
    if (codings.length !== 1 || codings[0] !== 'chunked') {
      return { ok: false, status: 501, error: 'unsupported_transfer_encoding' };
    }
    return { ok: true, chunked: true };
  }
  return { ok: true, chunked: false };
}

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

/**
 * Group `rawHeaders` (preserving exact wire duplicates) into a lowercased map.
 */
export function groupRawHeaders(
  rawHeaders: readonly string[],
  fallbackHeaders?: Record<string, string | string[] | undefined>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const push = (rawName: string, value: string) => {
    const name = rawName.toLowerCase();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  };
  if (rawHeaders.length >= 2) {
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      push(rawHeaders[i], rawHeaders[i + 1]);
    }
  } else if (fallbackHeaders) {
    for (const [key, val] of Object.entries(fallbackHeaders)) {
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        for (const item of val) push(key, item);
      } else {
        push(key, val);
      }
    }
  }
  return map;
}

export function collectConnectionNominatedHeaders(grouped: Map<string, string[]>): Set<string> {
  const nominated = new Set<string>();
  const values = grouped.get('connection');
  if (!values) return nominated;
  for (const value of values) {
    for (const token of value.split(',')) {
      const normalized = token.trim().toLowerCase();
      if (normalized) nominated.add(normalized);
    }
  }
  return nominated;
}
