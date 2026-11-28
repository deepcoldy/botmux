import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { githubAuthHeaders } from '../github-auth.js';
import { requestReleaseHop, resolveHttpProxy } from '../release-download.js';

export const ALLOWED_GITHUB_RELEASE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_RELEASE_TAG_RE = /^[A-Za-z0-9@._/+~-]{1,200}$/;
export const SRI_SHA512_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const MAX_GITHUB_RELEASE_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_GITHUB_RELEASE_CHECKSUM_BYTES = 16 * 1024;
export const MAX_GITHUB_RELEASE_METADATA_BYTES = 2 * 1024 * 1024;
export const MAX_GITHUB_RELEASE_REDIRECTS = 5;
export const DEFAULT_GITHUB_RELEASE_METADATA_TIMEOUT_MS = 15_000;
export const DEFAULT_GITHUB_RELEASE_ARCHIVE_TIMEOUT_MS = 120_000;

const GH_TOKEN_CACHE_TTL_MS = 10 * 60_000;
const GITHUB_RELEASE_USER_AGENT = 'botmux-plugin-github-release';

export type GithubReleaseErrorCode =
  | 'invalid_spec'
  | 'disallowed_url'
  | 'too_many_redirects'
  | 'invalid_redirect'
  | 'asset_too_large'
  | 'timeout'
  | 'http_error'
  | 'rate_limited'
  | 'invalid_release_payload'
  | 'release_not_published'
  | 'tag_mismatch'
  | 'tarball_not_found'
  | 'ambiguous_tarball'
  | 'integrity_asset_not_found'
  | 'invalid_integrity_file'
  | 'invalid_release_version'
  | 'integrity_mismatch'
  | 'sha256_mismatch'
  | 'manifest_mismatch';

export class GithubReleaseError extends Error {
  constructor(
    public readonly code: GithubReleaseErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'GithubReleaseError';
  }
}

export interface ParsedGithubRepo {
  owner: string;
  name: string;
  repo: string;
}

export interface ParsedGithubReleaseSpec extends ParsedGithubRepo {
  tag?: string;
}

export interface ResolvedGithubReleaseAsset {
  repo: string;
  tag: string;
  version?: string;
  asset: string;
  downloadUrl: string;
  integrity: string;
  expectedSha256?: string;
}

export type GithubReleaseHopResponse =
  | { kind: 'redirect'; statusCode: number; location: string }
  | {
      kind: 'response';
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      stream: AsyncIterable<Uint8Array | Buffer> & { destroy?: () => void; resume?: () => void };
    };

export type GithubReleaseHopTransport = (
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<GithubReleaseHopResponse>;

export interface GithubReleaseClientOptions {
  transport?: GithubReleaseHopTransport;
  resolveToken?: () => Promise<string | null>;
  metadataTimeoutMs?: number;
  archiveTimeoutMs?: number;
  maxArchiveBytes?: number;
  maxRedirects?: number;
}

export function isGithubReleaseSpec(spec: string): boolean {
  return spec.trim().startsWith('github:');
}

export function parseGithubRepo(raw: string): ParsedGithubRepo {
  const repo = raw.trim();
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new GithubReleaseError('invalid_spec', `github_release_invalid_repo:${repo}`);
  }
  const [owner, name] = repo.split('/');
  if (!owner || !name || name === '.' || name === '..') {
    throw new GithubReleaseError('invalid_spec', `github_release_invalid_repo:${repo}`);
  }
  return { owner, name, repo: `${owner}/${name}` };
}

export function validateGithubReleaseTag(rawTag: string): string {
  const tag = rawTag.trim();
  if (
    !tag
    || !GITHUB_RELEASE_TAG_RE.test(tag)
    || tag.includes('..')
    || tag.includes('//')
    || tag.startsWith('/')
    || tag.endsWith('/')
  ) {
    throw new GithubReleaseError('invalid_spec', `github_release_invalid_tag:${rawTag}`);
  }
  return tag;
}

export function parseGithubReleaseSpec(rawSpec: string): ParsedGithubReleaseSpec {
  const trimmed = rawSpec.trim();
  if (!trimmed.startsWith('github:')) {
    throw new GithubReleaseError('invalid_spec', `github_release_invalid_spec:${rawSpec}`);
  }
  const rest = trimmed.slice('github:'.length);
  const atIndex = rest.indexOf('@');
  if (atIndex < 0) {
    return parseGithubRepo(rest);
  }
  const repoPart = rest.slice(0, atIndex);
  const tagPart = rest.slice(atIndex + 1);
  if (!tagPart) {
    throw new GithubReleaseError('invalid_spec', `github_release_empty_tag:${rawSpec}`);
  }
  const parsedRepo = parseGithubRepo(repoPart);
  const tag = validateGithubReleaseTag(tagPart);
  return { ...parsedRepo, tag };
}

export function assertAllowedGithubReleaseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GithubReleaseError('disallowed_url', `github_release_invalid_url:${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new GithubReleaseError('disallowed_url', `github_release_https_required:${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new GithubReleaseError('disallowed_url', 'github_release_url_credentials_forbidden');
  }
  if (url.port && url.port !== '443') {
    throw new GithubReleaseError('disallowed_url', `github_release_disallowed_port:${url.port}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_GITHUB_RELEASE_HOSTS.has(hostname)) {
    throw new GithubReleaseError('disallowed_url', `github_release_disallowed_host:${hostname}`);
  }
  return url;
}

export function matchAssetPattern(assetName: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexSource = `^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`;
  return new RegExp(regexSource).test(assetName);
}

export function parseSha512IntegrityText(text: string, expectedAssetName?: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new GithubReleaseError('invalid_integrity_file', 'github_release_invalid_integrity_lines');
  }
  const line = lines[0];
  const match = /^(\S+)(?:\s+(.+))?$/.exec(line);
  if (!match) {
    throw new GithubReleaseError('invalid_integrity_file', 'github_release_invalid_integrity_format');
  }
  const [, sri, rawTarget] = match;
  if (!SRI_SHA512_RE.test(sri)) {
    throw new GithubReleaseError('invalid_integrity_file', 'github_release_invalid_sri_sha512');
  }
  if (rawTarget !== undefined) {
    let target = rawTarget.trim();
    if (target.startsWith('*')) target = target.slice(1);
    if (target.startsWith('./')) target = target.slice(2);
    if (expectedAssetName !== undefined && target !== expectedAssetName) {
      throw new GithubReleaseError('invalid_integrity_file', 'github_release_integrity_filename_mismatch');
    }
  }
  return sri;
}

export function deriveReleaseVersion(tagName: string, assetName?: string): string | undefined {
  const trimmedTag = tagName.trim();
  const bareTag = /^[vV]/.test(trimmedTag) ? trimmedTag.slice(1) : trimmedTag;
  if (SEMVER_RE.test(bareTag)) return bareTag;

  const atMatch = /@([^@]+)$/.exec(trimmedTag);
  if (atMatch) {
    const afterAt = /^[vV]/.test(atMatch[1]) ? atMatch[1].slice(1) : atMatch[1];
    if (SEMVER_RE.test(afterAt)) return afterAt;
  }

  const suffixTagMatch = /(?:[-/])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(trimmedTag);
  if (suffixTagMatch && SEMVER_RE.test(suffixTagMatch[1])) return suffixTagMatch[1];

  if (assetName && assetName.endsWith('.tgz')) {
    const assetMatch = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\.tgz$/.exec(assetName);
    if (assetMatch && SEMVER_RE.test(assetMatch[1])) return assetMatch[1];
  }

  return undefined;
}

export function computeSha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function computeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let cachedGhToken: { token: string | null; at: number } | undefined;

export function resetGithubReleaseTokenCache(): void {
  cachedGhToken = undefined;
}

function readGhAuthTokenAsync(): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile('gh', ['auth', 'token', '--hostname', 'github.com'], {
        timeout: 5_000,
        encoding: 'utf8',
      }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Resolve an optional read-only GitHub token to raise the API rate limit from
 * 60/h to 5,000/h. Tokens are never logged, never included in errors, and only
 * sent to `api.github.com`.
 */
export async function resolveOptionalGithubApiToken(options?: {
  now?: () => number;
  readEnvHeaders?: () => Record<string, string>;
  readGhToken?: () => Promise<string | null>;
}): Promise<string | null> {
  const fromEnv = (options?.readEnvHeaders ?? (() => githubAuthHeaders()))();
  if (fromEnv.Authorization) {
    const token = fromEnv.Authorization.replace(/^Bearer\s+/i, '').trim();
    if (token) return token;
  }
  const now = options?.now ?? Date.now;
  if (options?.readGhToken) {
    return (await options.readGhToken().catch(() => null))?.trim() || null;
  }
  if (!cachedGhToken || now() - cachedGhToken.at > GH_TOKEN_CACHE_TTL_MS) {
    const token = await readGhAuthTokenAsync().catch(() => null);
    cachedGhToken = { token, at: now() };
  }
  return cachedGhToken.token;
}

function defaultGithubHopTransport(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<GithubReleaseHopResponse> {
  const proxy = resolveHttpProxy();
  return requestReleaseHop(url.toString(), proxy, GITHUB_RELEASE_USER_AGENT, {
    headers,
    signal,
    respectNoProxy: true,
  });
}

function headerString(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== key.toLowerCase()) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function drainAndDestroy(stream: { destroy?: () => void; resume?: () => void }): void {
  try {
    if (typeof stream.destroy === 'function') stream.destroy();
    else if (typeof stream.resume === 'function') stream.resume();
  } catch {
    // Ignore cleanup errors on failed responses.
  }
}

interface SafeRequestOptions {
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  allowAuth: boolean;
  maxRedirects: number;
  transport: GithubReleaseHopTransport;
  resolveToken: () => Promise<string | null>;
}

async function openValidatedGithubStream(
  rawUrl: string,
  options: SafeRequestOptions,
): Promise<{
  stream: AsyncIterable<Uint8Array | Buffer> & { destroy?: () => void; resume?: () => void };
  headers: Record<string, string | string[] | undefined>;
  signal: AbortSignal;
  cleanup: () => void;
}> {
  const initialUrl = assertAllowedGithubReleaseUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new GithubReleaseError('timeout', 'github_release_request_timeout'));
  }, options.timeoutMs);
  const cleanup = () => clearTimeout(timer);

  const token = options.allowAuth && initialUrl.hostname.toLowerCase() === 'api.github.com'
    ? await options.resolveToken().catch(() => null)
    : null;

  let allowTokenForApi = Boolean(token);
  let retriedWithoutAuth = false;

  try {
    for (;;) {
      let currentUrl = initialUrl;
      let retryAnon = false;

      for (let hop = 0; hop <= options.maxRedirects; hop++) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          throw reason instanceof Error ? reason : new GithubReleaseError('timeout', 'github_release_request_timeout');
        }
        const isApiHost = currentUrl.hostname.toLowerCase() === 'api.github.com';
        const headers: Record<string, string> = {
          Accept: options.accept,
          'User-Agent': GITHUB_RELEASE_USER_AGENT,
        };
        if (isApiHost) {
          headers['X-GitHub-Api-Version'] = '2022-11-28';
          if (allowTokenForApi && token) {
            headers.Authorization = `Bearer ${token}`;
          }
        }

        let response: GithubReleaseHopResponse;
        try {
          response = await options.transport(currentUrl, headers, controller.signal);
        } catch (error) {
          if (error instanceof GithubReleaseError) throw error;
          if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            throw reason instanceof GithubReleaseError
              ? reason
              : new GithubReleaseError('timeout', 'github_release_request_timeout');
          }
          throw error;
        }

        if (response.kind === 'redirect') {
          if (!response.location) {
            throw new GithubReleaseError('invalid_redirect', 'github_release_redirect_missing_location', response.statusCode);
          }
          if (hop >= options.maxRedirects) {
            throw new GithubReleaseError('too_many_redirects', 'github_release_too_many_redirects', response.statusCode);
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(response.location, currentUrl);
          } catch {
            throw new GithubReleaseError('invalid_redirect', 'github_release_redirect_invalid_url', response.statusCode);
          }
          currentUrl = assertAllowedGithubReleaseUrl(nextUrl.toString());
          continue;
        }

        if (response.statusCode === 401 && isApiHost && allowTokenForApi && !retriedWithoutAuth) {
          drainAndDestroy(response.stream);
          allowTokenForApi = false;
          retriedWithoutAuth = true;
          retryAnon = true;
          break;
        }

        if (response.statusCode === 403 || response.statusCode === 429) {
          const remaining = headerString(response.headers, 'x-ratelimit-remaining');
          const retryAfter = headerString(response.headers, 'retry-after');
          drainAndDestroy(response.stream);
          if (response.statusCode === 429 || remaining === '0' || retryAfter) {
            throw new GithubReleaseError('rate_limited', `github_release_rate_limited:${response.statusCode}`, response.statusCode);
          }
          throw new GithubReleaseError('http_error', `github_release_http_${response.statusCode}`, response.statusCode);
        }

        if (response.statusCode !== 200) {
          drainAndDestroy(response.stream);
          throw new GithubReleaseError('http_error', `github_release_http_${response.statusCode}`, response.statusCode);
        }

        const contentLengthRaw = headerString(response.headers, 'content-length');
        if (contentLengthRaw !== undefined) {
          const contentLength = Number(contentLengthRaw);
          if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
            drainAndDestroy(response.stream);
            throw new GithubReleaseError('asset_too_large', `github_release_asset_too_large:${contentLength}`);
          }
        }

        const onAbort = () => drainAndDestroy(response.stream);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        return {
          stream: response.stream,
          headers: response.headers,
          signal: controller.signal,
          cleanup: () => {
            controller.signal.removeEventListener('abort', onAbort);
            cleanup();
          },
        };
      }

      if (!retryAnon) {
        throw new GithubReleaseError('too_many_redirects', 'github_release_too_many_redirects');
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function fetchGithubReleaseBytes(
  rawUrl: string,
  options: {
    accept?: string;
    maxBytes?: number;
    timeoutMs?: number;
    allowAuth?: boolean;
  } & GithubReleaseClientOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_GITHUB_RELEASE_METADATA_BYTES;
  const { stream, signal, cleanup } = await openValidatedGithubStream(rawUrl, {
    accept: options.accept ?? 'application/octet-stream',
    maxBytes,
    timeoutMs: options.timeoutMs ?? options.metadataTimeoutMs ?? DEFAULT_GITHUB_RELEASE_METADATA_TIMEOUT_MS,
    allowAuth: options.allowAuth ?? false,
    maxRedirects: options.maxRedirects ?? MAX_GITHUB_RELEASE_REDIRECTS,
    transport: options.transport ?? defaultGithubHopTransport,
    resolveToken: options.resolveToken ?? resolveOptionalGithubApiToken,
  });

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const part of stream) {
      if (signal.aborted) {
        throw signal.reason instanceof GithubReleaseError
          ? signal.reason
          : new GithubReleaseError('timeout', 'github_release_request_timeout');
      }
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      total += chunk.length;
      if (total > maxBytes) {
        drainAndDestroy(stream);
        throw new GithubReleaseError('asset_too_large', `github_release_asset_too_large:${total}`);
      }
      chunks.push(chunk);
    }
    if (signal.aborted) {
      throw signal.reason instanceof GithubReleaseError
        ? signal.reason
        : new GithubReleaseError('timeout', 'github_release_request_timeout');
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    drainAndDestroy(stream);
    if (error instanceof GithubReleaseError) throw error;
    if (signal.aborted) {
      throw signal.reason instanceof GithubReleaseError
        ? signal.reason
        : new GithubReleaseError('timeout', 'github_release_request_timeout');
    }
    throw error;
  } finally {
    cleanup();
  }
}

export async function downloadGithubReleaseAssetToFile(
  rawUrl: string,
  destPath: string,
  options: {
    expectedIntegrity?: string;
    expectedSha256?: string;
  } & GithubReleaseClientOptions = {},
): Promise<{ integrity: string; sha256: string; bytesWritten: number }> {
  const maxBytes = options.maxArchiveBytes ?? MAX_GITHUB_RELEASE_ARCHIVE_BYTES;
  const { stream, signal, cleanup } = await openValidatedGithubStream(rawUrl, {
    accept: 'application/octet-stream',
    maxBytes,
    timeoutMs: options.archiveTimeoutMs ?? DEFAULT_GITHUB_RELEASE_ARCHIVE_TIMEOUT_MS,
    allowAuth: false,
    maxRedirects: options.maxRedirects ?? MAX_GITHUB_RELEASE_REDIRECTS,
    transport: options.transport ?? defaultGithubHopTransport,
    resolveToken: options.resolveToken ?? resolveOptionalGithubApiToken,
  });

  const sha512 = createHash('sha512');
  const sha256 = createHash('sha256');
  const handle = await open(destPath, 'w', 0o600);
  let total = 0;
  let failed = false;

  try {
    for await (const part of stream) {
      if (signal.aborted) {
        throw signal.reason instanceof GithubReleaseError
          ? signal.reason
          : new GithubReleaseError('timeout', 'github_release_request_timeout');
      }
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      total += chunk.length;
      if (total > maxBytes) {
        drainAndDestroy(stream);
        throw new GithubReleaseError('asset_too_large', `github_release_asset_too_large:${total}`);
      }
      sha512.update(chunk);
      sha256.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const res = await handle.write(chunk, written, chunk.length - written);
        written += res.bytesWritten;
      }
    }
    if (signal.aborted) {
      throw signal.reason instanceof GithubReleaseError
        ? signal.reason
        : new GithubReleaseError('timeout', 'github_release_request_timeout');
    }

    const integrity = `sha512-${sha512.digest('base64')}`;
    const actualSha256 = sha256.digest('hex');

    if (options.expectedIntegrity && integrity !== options.expectedIntegrity) {
      throw new GithubReleaseError('integrity_mismatch', 'github_release_integrity_mismatch');
    }
    if (options.expectedSha256 && actualSha256 !== options.expectedSha256.toLowerCase()) {
      throw new GithubReleaseError('sha256_mismatch', 'github_release_sha256_mismatch');
    }

    return { integrity, sha256: actualSha256, bytesWritten: total };
  } catch (error) {
    failed = true;
    drainAndDestroy(stream);
    if (error instanceof GithubReleaseError) throw error;
    if (signal.aborted) {
      throw signal.reason instanceof GithubReleaseError
        ? signal.reason
        : new GithubReleaseError('timeout', 'github_release_request_timeout');
    }
    throw error;
  } finally {
    cleanup();
    await handle.close().catch(() => {});
    if (failed) {
      try { rmSync(destPath, { force: true }); } catch { /* ignore */ }
    }
  }
}

interface RawReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string | null;
}

function isPlainAssetFilename(name: string): boolean {
  return Boolean(name)
    && basename(name) === name
    && !name.includes('/')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..';
}

function encodeTagPath(tag: string): string {
  return tag.split('/').map(encodeURIComponent).join('/');
}

/**
 * Query GitHub Releases API for a repository's latest published release (or a
 * specific tag), locate its single `.tgz` asset and mandatory companion
 * `.tgz.sha512` integrity file, and return locked metadata for download.
 */
export async function resolveGithubReleaseAsset(
  target: { repo: string; tag?: string; assetPattern?: string },
  options: GithubReleaseClientOptions = {},
): Promise<ResolvedGithubReleaseAsset> {
  const { owner, name, repo } = parseGithubRepo(target.repo);
  const requestedTag = target.tag !== undefined ? validateGithubReleaseTag(target.tag) : undefined;
  const apiUrl = requestedTag
    ? `https://api.github.com/repos/${owner}/${name}/releases/tags/${encodeTagPath(requestedTag)}`
    : `https://api.github.com/repos/${owner}/${name}/releases/latest`;

  const payloadBytes = await fetchGithubReleaseBytes(apiUrl, {
    ...options,
    accept: 'application/vnd.github+json',
    maxBytes: MAX_GITHUB_RELEASE_METADATA_BYTES,
    timeoutMs: options.metadataTimeoutMs ?? DEFAULT_GITHUB_RELEASE_METADATA_TIMEOUT_MS,
    allowAuth: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new GithubReleaseError('invalid_release_payload', 'github_release_invalid_json');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GithubReleaseError('invalid_release_payload', 'github_release_invalid_payload');
  }
  const release = parsed as {
    draft?: unknown;
    prerelease?: unknown;
    tag_name?: unknown;
    assets?: unknown;
  };

  if (release.draft === true) {
    throw new GithubReleaseError('release_not_published', 'github_release_draft_rejected');
  }
  if (!requestedTag && release.prerelease === true) {
    throw new GithubReleaseError('release_not_published', 'github_release_prerelease_rejected');
  }
  if (typeof release.tag_name !== 'string' || !release.tag_name.trim()) {
    throw new GithubReleaseError('invalid_release_payload', 'github_release_missing_tag_name');
  }
  const releaseTag = validateGithubReleaseTag(release.tag_name);
  if (requestedTag && releaseTag !== requestedTag) {
    throw new GithubReleaseError('tag_mismatch', `github_release_tag_mismatch:${releaseTag}`);
  }
  if (!Array.isArray(release.assets)) {
    throw new GithubReleaseError('invalid_release_payload', 'github_release_missing_assets');
  }

  const assets: RawReleaseAsset[] = [];
  for (const raw of release.assets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown };
    if (typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') continue;
    if (!isPlainAssetFilename(item.name)) continue;
    assets.push({
      name: item.name,
      browser_download_url: item.browser_download_url,
      ...(typeof item.size === 'number' && Number.isFinite(item.size) ? { size: item.size } : {}),
      ...(typeof item.digest === 'string' ? { digest: item.digest } : {}),
    });
  }

  const tarballCandidates = assets.filter(asset => (
    asset.name.endsWith('.tgz')
    && (!target.assetPattern || matchAssetPattern(asset.name, target.assetPattern))
  ));
  if (tarballCandidates.length === 0) {
    throw new GithubReleaseError('tarball_not_found', `github_release_tarball_not_found:${repo}@${releaseTag}`);
  }
  if (tarballCandidates.length > 1) {
    throw new GithubReleaseError('ambiguous_tarball', `github_release_ambiguous_tarball:${repo}@${releaseTag}`);
  }
  const tgzAsset = tarballCandidates[0];

  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_GITHUB_RELEASE_ARCHIVE_BYTES;
  if (tgzAsset.size !== undefined && tgzAsset.size > maxArchiveBytes) {
    throw new GithubReleaseError('asset_too_large', `github_release_asset_too_large:${tgzAsset.size}`);
  }

  const checksumName = `${tgzAsset.name}.sha512`;
  const checksumAsset = assets.find(asset => asset.name === checksumName);
  if (!checksumAsset) {
    throw new GithubReleaseError('integrity_asset_not_found', `github_release_integrity_asset_not_found:${checksumName}`);
  }

  // Validate both asset download URLs before fetching anything.
  const tgzDownloadUrl = assertAllowedGithubReleaseUrl(tgzAsset.browser_download_url).toString();
  const checksumDownloadUrl = assertAllowedGithubReleaseUrl(checksumAsset.browser_download_url).toString();

  const checksumBytes = await fetchGithubReleaseBytes(checksumDownloadUrl, {
    ...options,
    accept: 'text/plain, application/octet-stream',
    maxBytes: MAX_GITHUB_RELEASE_CHECKSUM_BYTES,
    timeoutMs: options.metadataTimeoutMs ?? DEFAULT_GITHUB_RELEASE_METADATA_TIMEOUT_MS,
    allowAuth: false,
  });
  const integrity = parseSha512IntegrityText(checksumBytes.toString('utf8'), tgzAsset.name);

  let expectedSha256: string | undefined;
  if (typeof tgzAsset.digest === 'string') {
    const digestMatch = /^sha256:([a-f0-9]{64})$/i.exec(tgzAsset.digest.trim());
    if (digestMatch) expectedSha256 = digestMatch[1].toLowerCase();
  }

  const version = deriveReleaseVersion(releaseTag, tgzAsset.name);
  return {
    repo,
    tag: releaseTag,
    ...(version ? { version } : {}),
    asset: tgzAsset.name,
    downloadUrl: tgzDownloadUrl,
    integrity,
    ...(expectedSha256 ? { expectedSha256 } : {}),
  };
}
