import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import {
  readFileSync, existsSync, mkdirSync, chmodSync, linkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { dirname } from 'node:path';
import {
  readSecureHostFileSync,
  UnsafeHostAuthorityFileError,
  withSecureHostParentSync,
  writeSecureHostFileSync,
} from '../platform/secure-host-file.js';

const NONCE_TTL_MS = 60_000;
const TS_WINDOW_S = 30;

const seenNonces = new Map<string, number>();   // nonce → expiresAt

export interface HmacAttempt { ts: string; nonce: string; sig: string; }

/**
 * Canonical "binding" string mixed into the signed payload so a captured HMAC
 * header can't be replayed against a different route or port. Without it, a
 * single set of `X-Botmux-Cli-*` headers signed only over `ts:nonce` is valid
 * for ANY `/__cli/*` route on ANY dashboard — which lets a malicious local
 * server, handed a discovery probe, forward the headers to the real dashboard
 * (e.g. a `/__cli/current` probe relayed to `/__cli/ensure` or `/__cli/rotate`
 * to mint a token).
 * Binding `method + path + bound-port` makes the credential single-purpose:
 *  - the verifier uses the port IT actually bound (not the attacker-controlled
 *    Host header), so a forward from port X to the dashboard on port Y mismatches;
 *  - a `/__cli/current` capture can't be replayed to either token-writing route
 *    (path differs).
 */
export function cliAuthBind(method: string, path: string, port: number | string): string {
  return `${String(method).toUpperCase()} ${path} ${port}`;
}

/** Mint the three `X-Botmux-Cli-*` header values for a loopback request.
 *  Pass the same `bind` (see {@link cliAuthBind}) the verifier will reconstruct;
 *  omit it only for the legacy daemon-IPC scheme that signs bare `ts:nonce`. */
export function signCliAuth(secretB64Url: string, bind?: string): HmacAttempt {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const msg = bind ? `${ts}:${nonce}:${bind}` : `${ts}:${nonce}`;
  const sig = createHmac('sha256', secretB64Url).update(msg).digest('base64url');
  return { ts, nonce, sig };
}

/**
 * Verify a CLI rotation HMAC attempt.
 * - Source IP must be loopback (127.0.0.1 / ::1 / IPv4-mapped form).
 * - Timestamp must be within ±TS_WINDOW_S seconds of now.
 * - Nonce must not have been seen in the last NONCE_TTL_MS.
 * - HMAC-SHA256(secret, `${ts}:${nonce}` [+ `:${bind}`]) must match `sig`
 *   (timing-safe). Pass `bind` (method+path+port) to scope the credential to a
 *   single route/port; omit it for the legacy bare daemon-IPC scheme.
 */
export function verifyHmac(
  secretB64Url: string,
  attempt: HmacAttempt,
  remoteAddr: string,
  bind?: string,
): { ok: boolean; reason?: string } {
  if (
    remoteAddr !== '127.0.0.1' &&
    remoteAddr !== '::1' &&
    !remoteAddr.endsWith('::ffff:127.0.0.1')
  ) {
    return { ok: false, reason: 'remote_not_loopback' };
  }
  const tsNum = Number(attempt.ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad_ts' };
  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - tsNum) > TS_WINDOW_S) return { ok: false, reason: 'ts_window' };

  // GC nonces
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(attempt.nonce)) return { ok: false, reason: 'replay' };

  const msg = bind ? `${attempt.ts}:${attempt.nonce}:${bind}` : `${attempt.ts}:${attempt.nonce}`;
  const expected = createHmac('sha256', secretB64Url).update(msg).digest();
  let provided: Buffer;
  try { provided = Buffer.from(attempt.sig, 'base64url'); }
  catch { return { ok: false, reason: 'bad_sig' }; }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'sig_mismatch' };
  }
  seenNonces.set(attempt.nonce, now + NONCE_TTL_MS);
  return { ok: true };
}

/** 32 random bytes base64url-encoded (43 characters, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Load a dashboard HMAC secret from disk. Empty / whitespace-only files are
 * treated as missing so callers never sign requests with an empty key.
 */
export function loadDashboardSecret(secretPath: string): string | null {
  if (!existsSync(secretPath)) return null;
  const secret = readFileSync(secretPath, 'utf8').trim();
  return secret.length > 0 ? secret : null;
}

/** Load the dashboard HMAC secret, creating a fresh 0600 secret when absent. */
export function loadOrCreateDashboardSecret(secretPath: string): string {
  const existing = loadDashboardSecret(secretPath);
  if (existing) return existing;
  const secret = randomBytes(32).toString('base64url');
  mkdirSync(dirname(secretPath), { recursive: true });
  // Daemon fleets and the dashboard start concurrently on a fresh install.
  // A rename-based "atomic write" is individually atomic but not
  // create-if-absent: two winners can each return a different key while only
  // the last rename remains on disk. Publish a fully-written temp inode with
  // link(2) instead. The link is atomic and fails with EEXIST for every loser;
  // losers then read the single winner's complete value.
  const temp = `${secretPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, secret, { mode: 0o600, flag: 'wx' });
    try {
      linkSync(temp, secretPath);
      chmodSync(secretPath, 0o600);
      return secret;
    } catch (err) {
      const raced = loadDashboardSecret(secretPath);
      if (raced) return raced;
      // Existing-but-empty/corrupt file: publish one permanent repair seed via
      // link(2). Every concurrent initializer either wins that O_EXCL election
      // or reads the same fully-written seed, then atomically restores the main
      // path with the identical value. Keeping the 0600 seed makes crash recovery
      // replayable and avoids stale PID locks (and their delete/recreate races).
      const repairSeedPath = `${secretPath}.repair-seed`;
      let repairSecret: string;
      try {
        linkSync(temp, repairSeedPath);
        chmodSync(repairSeedPath, 0o600);
        repairSecret = secret;
      } catch (seedErr) {
        if ((seedErr as NodeJS.ErrnoException).code !== 'EEXIST') throw seedErr;
        const published = loadDashboardSecret(repairSeedPath);
        if (!published) {
          throw new Error(`dashboard secret repair seed is unreadable: ${repairSeedPath}`);
        }
        repairSecret = published;
      }
      atomicWriteFileSync(secretPath, repairSecret, { mode: 0o600 });
      chmodSync(secretPath, 0o600);
      return repairSecret;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* already absent */ }
  }
}

/**
 * Load the persisted active dashboard token from `tokenPath`, or `null` when
 * the file is genuinely absent or empty. Unsafe credential-file shapes fail
 * closed instead of being treated as a missing token.
 *
 * Persisting the active token lets a previously-issued dashboard URL survive a
 * `botmux restart` and keeps multiple dashboard processes on one authority.
 * Only `botmux dashboard rotate` replaces the file, which invalidates the old
 * link for every process on its next request.
 */
export function loadPersistedToken(tokenPath: string): string | null {
  return readSecureHostFileSync(tokenPath, 256)?.trim() || null;
}

/** Durably persist the active dashboard token without following a leaf symlink. */
export function persistToken(tokenPath: string, token: string): void {
  writeSecureHostFileSync(tokenPath, token);
}

/**
 * Load the active token, creating and persisting the first one when absent.
 * The file lock makes get-or-create linearizable across dashboard processes:
 * every concurrent caller returns the same durable token.
 *
 * The credential directory is pinned once (Linux: via an open directory
 * descriptor) and the lock, the read, and the write all resolve through that
 * same anchor. This keeps the whole critical section on one directory inode —
 * so a symlinked HOME whose target sits under a shared-drive / 0777 ancestor
 * still succeeds, while an ancestor rename mid-section cannot redirect the lock
 * or the token write into a substituted directory. `~/.botmux` itself must
 * still be 0700 and owned by the current user; a leaf symlink is still refused.
 */
export function loadOrCreatePersistedToken(tokenPath: string): string {
  return withSecureHostParentSync(tokenPath, (parent) =>
    parent.withLeafLock(() => {
      const existing = parent.readLeaf(256)?.trim() || null;
      if (existing) return existing;
      const token = generateToken();
      parent.writeLeaf(token);
      return token;
    }),
  );
}

/** Generate and durably replace the token while serialized with first creation. */
export function rotatePersistedToken(tokenPath: string): string {
  return withSecureHostParentSync(tokenPath, (parent) =>
    parent.withLeafLock(() => {
      const token = generateToken();
      parent.writeLeaf(token);
      return token;
    }),
  );
}

/**
 * POSIX-single-quote a path for safe copy-paste into a shell, but only when it
 * contains characters a shell treats specially — a clean path stays unquoted so
 * the common-case hint reads naturally. Only ever used to build a POSIX command
 * (never on win32, where we emit prose, not a command).
 */
function shellQuoteIfNeeded(p: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Diagnostic body for a dashboard token 500. The `/__cli/*` HTTP layer used to
 * return a bare `{ error: 'token_persist_failed' | 'token_unavailable' }`, which
 * the CLI printed verbatim — so a user whose `~/.botmux` (or `.dashboard-token`)
 * has loose perms only saw an opaque code and had to be diagnosed remotely. The
 * real, actionable cause is already on the thrown {@link
 * UnsafeHostAuthorityFileError} (`message` is a precise reason like
 * "宿主凭证目录可被组内或其它用户写入" / "宿主凭证文件权限必须严格为 0600" /
 * "宿主凭证拒绝符号链接"). This surfaces that reason plus a one-line remediation
 * hint WITHOUT changing any validation — every fail-closed check still fails
 * closed; we only make the failure legible.
 *
 * `error` keeps the stable machine code (unchanged for programmatic callers);
 * `reason`/`hint` are additive human-facing fields.
 */
export function describeDashboardTokenError(
  code: 'token_persist_failed' | 'token_unavailable',
  err: unknown,
  tokenPath: string,
): { error: string; reason?: string; hint?: string } {
  if (!(err instanceof UnsafeHostAuthorityFileError)) return { error: code };
  const reason = err.message;
  // Map the credential-shape reason to a concrete fix. Remediations are
  // intentionally NOT auto-applied: a group/other-writable (or wrongly-owned)
  // credential dir may already be compromised, so tightening it is the user's
  // explicit decision, not a silent self-heal — we only make the failure
  // legible. Guard rails for the hint (the reason itself is always surfaced):
  //   - Owner errors carry the failing node in their label ("宿主凭证目录" vs
  //     "宿主凭证文件"); branch on it so we never tell someone to chmod the dir
  //     when the *file* is the wrong owner (chmod can't fix ownership anyway).
  //   - Never hand a single destructive command when the node kind is unknown:
  //     a directory leaf makes a blind `rm -f` fail with "Is a directory", so
  //     the generic non-regular-file case degrades to an inspection step.
  //   - On non-POSIX hosts a chmod/rm one-liner is unusable, so degrade to prose
  //     and quote paths (spaces / shell metacharacters) on POSIX.
  const dir = dirname(tokenPath);
  const posix = process.platform !== 'win32';
  const qDir = shellQuoteIfNeeded(dir);
  const qFile = shellQuoteIfNeeded(tokenPath);
  const ownerErr = reason.includes('不属于当前用户');
  let hint: string | undefined;
  if (reason.includes('组内或其它用户写入') || (ownerErr && reason.includes('宿主凭证目录'))) {
    hint = posix
      ? `凭证目录权限过松或属主不对。请确认 ${dir} 归当前用户所有,并执行 chmod 700 ${qDir} 后重试。`
      : `凭证目录权限过松或属主不对。请确认 ${dir} 归当前用户所有、且未对其他用户开放写权限后重试。`;
  } else if (ownerErr && reason.includes('宿主凭证文件')) {
    // Wrong-owner file: chmod can't change ownership; removing it lets ensure/
    // rotate regenerate it as the current user (the dir is 0700-owned, so the
    // unlink is permitted).
    hint = posix
      ? `凭证文件不属于当前用户。请执行 rm -f ${qFile} 让其以当前用户身份重新生成后重试。`
      : `凭证文件不属于当前用户。请删除 ${tokenPath} 让其以当前用户身份重新生成后重试。`;
  } else if (reason.includes('权限必须严格为 0600')) {
    hint = posix
      ? `凭证文件权限过松。请执行 chmod 600 ${qFile} 后重试。`
      : `凭证文件权限过松。请将 ${tokenPath} 收紧为仅当前用户可读写后重试。`;
  } else if (reason.includes('拒绝符号链接')) {
    // ELOOP — definitely a symlink; `rm -f` removes a symlink safely.
    hint = posix
      ? `凭证文件是符号链接。请执行 rm -f ${qFile} 让其重新生成后重试。`
      : `凭证文件是符号链接。请删除 ${tokenPath} 让其重新生成后重试。`;
  } else if (reason.includes('必须是普通文件')) {
    // Non-regular file of unknown kind (possibly a directory): give an
    // inspection step, not a blind `rm -f` that could fail or over-delete.
    hint = posix
      ? `凭证路径不是普通文件(可能是目录/管道/设备等)。请先 ls -ld ${qFile} 查看,再手动移除该节点后重试。`
      : `凭证路径不是普通文件(可能是目录等)。请检查并手动移除 ${tokenPath} 后重试。`;
  } else if (reason.includes('祖先') || reason.includes('句柄')) {
    hint = `凭证目录的某级祖先不安全或运行期被改动。请确认 ${dir} 及其上级目录属可信用户后重试。`;
  }
  return { error: code, reason, ...(hint ? { hint } : {}) };
}

/** Extract `botmux_dashboard_token` value from a Cookie header. */
export function parseCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'botmux_dashboard_token') return v;
  }
  return undefined;
}

/** Build the `Set-Cookie` header value for a fresh dashboard token. */
export function buildSetCookie(token: string): string {
  return `botmux_dashboard_token=${token}; HttpOnly; SameSite=Lax; Path=/`;
}

// ─── Per-request auth decision ──────────────────────────────────────────────

/**
 * The dashboard splits incoming requests into three categories before the
 * route handlers run:
 *
 *   - `allow`            — request can proceed (auth succeeded OR endpoint
 *                          is public)
 *   - `allow+set-cookie` — `?t=<correct-token>` query: the cookie is set
 *                          and we redirect to a clean URL.  This is the
 *                          only branch that mints a Set-Cookie header.
 *   - `deny401`          — endpoint requires an authenticated session and
 *                          none was presented.
 *
 * Public surfaces today (codex review v0.1.2 → canary.3):
 *   - `GET/HEAD /`, `/assets/*`, root icons    — static SPA shell
 *   - `GET /api/workflows/*`                   — zero-I/O legacy retirement
 *                                                tombstone (HTTP 410).
 *
 * Outside those always-public surfaces, the explicit `publicReadOnly`
 * allow-list controls tokenless observation. Mutations and private reads still
 * require the active session token, matching the chat web terminal's
 * capability boundary.
 */
export type AuthDecision =
  | { kind: 'allow' }
  | { kind: 'allow+set-cookie'; token: string; redirectTo: string }
  | { kind: 'deny401' };

/**
 * Feishu/Lark H5 sessions are deliberately narrower than the legacy owner
 * cookie.  They can render the Workbench, observe its session stream, and use
 * the two explicitly leased interaction surfaces; they can never fall through
 * into Dashboard administration merely because a new route was added.
 *
 * Keep this as a positive capability map.  In particular, broad rules such as
 * "all GETs" would expose config/secrets, while "all POSTs under /api/sessions"
 * would turn an H5 viewer into a host operator.
 */
export type WorkbenchH5Capability =
  | 'workbench.view'
  | 'terminal.view'
  | 'terminal.operate'
  | 'preview.view'
  | 'preview.operate';

export function workbenchH5Capability(method: string, pathname: string): WorkbenchH5Capability | null {
  const normalizedMethod = method.toUpperCase();
  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD')
    && (pathname === '/api/sessions' || pathname === '/events' || pathname === '/api/workbench/h5-context'
      // P1-4：只读的能力集投影（canLocate/canControl/canInteract 三布尔）。它
      // 只描述该身份在本 capability 表 + 角色映射下的既有权限，不授予任何新
      // 权限，所以归入观察级的 workbench.view。
      || pathname === '/api/workbench/capabilities')) {
    return 'workbench.view';
  }

  // Read-only terminal capability URL. A view capability cannot send input, so
  // observing identities may fetch it; since P1-5 the returned URL carries a
  // SHORT-LIVED read grant bound to this very auth session (revoked on
  // logout/expiry), never a stable token. The writable twin (write-link) stays
  // behind the local management cookie — H5 identities can never mint it (see
  // the explicit dashboard-auth test): H5 write access exists only as the
  // releasable/expiring /control/takeover lease.
  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD')
    && /^\/api\/sessions\/[^/]+\/view-link$/.test(pathname)) {
    return 'terminal.view';
  }
  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD')
    && /^\/api\/sessions\/[^/]+\/preview$/.test(pathname)) {
    return 'preview.view';
  }

  const terminal = pathname.match(/^\/api\/sessions\/[^/]+\/control(?:\/(takeover|release))?$/);
  if (terminal) {
    if (normalizedMethod === 'GET' && !terminal[1]) return 'terminal.view';
    if (normalizedMethod === 'POST' && terminal[1]) return 'terminal.operate';
    return null;
  }

  const preview = pathname.match(/^\/api\/sessions\/[^/]+\/preview-interaction(?:\/(unlock|activity|lock))?$/);
  if (preview) {
    if (normalizedMethod === 'GET' && !preview[1]) return 'preview.view';
    if (normalizedMethod === 'POST' && preview[1]) return 'preview.operate';
    return null;
  }
  return null;
}

/** Fail-closed auth decision for an already-authenticated H5/readonly-platform
 * identity. Static shell reads retain the ordinary public behavior; everything
 * else must name one of the Workbench capabilities above. */
export function decideWorkbenchH5Auth(opts: {
  method: string;
  pathname: string;
}): AuthDecision {
  if (workbenchH5Capability(opts.method, opts.pathname)) return { kind: 'allow' };
  return decideDashboardAuth({
    method: opts.method,
    pathname: opts.pathname,
    hasTokenParam: false,
    presentedToken: undefined,
    activeToken: '',
    // An authenticated Workbench identity is not an anonymous public-read
    // viewer. Do not let a deployment-wide publicReadOnly flag broaden this
    // capability set to settings/schedules/groups.
    publicReadOnly: false,
  });
}

/** Tokenless-readable API paths when `config.dashboard.publicReadOnly` is on.
 *  ALLOW-LIST (fail-closed): only the "watch work" surfaces the read-only
 *  dashboard renders. Anything NOT in this set stays behind the active token
 *  even in public mode — so a newly-added GET endpoint is private by default
 *  and can't silently leak (connector configs, webhook-secret metadata,
 *  trigger logs, role/persona files, per-bot config, onboarding, raw PTY are
 *  all absent on purpose). The static SPA shell and the zero-I/O legacy
 *  workflow tombstone are handled separately in decideDashboardAuth. Full v3
 *  workflow projections stay private because goals, node ids, and run ids can
 *  contain project or personal information.
 *  口径：公开 = 运行摘要 / 会话板 / 排程(脱敏) / 设置(只读) / 群名册 / 事件流。 */
const PUBLIC_READ_PATHS: ReadonlySet<string> = new Set([
  '/api/dashboard/v1/summary', // strongly-redacted dashboard aggregate
  '/api/sessions',    // session board
  '/api/schedules',   // schedules page — task prompt redacted for anon upstream
  '/api/settings',    // read-only settings — only public flags + authed:false
  '/api/groups',      // board name maps: bot friendly name + group name
  '/events',          // SSE stream — schedule prompt redacted for anon upstream
]);

export function decideDashboardAuth(opts: {
  method: string;
  pathname: string;
  hasTokenParam: boolean;
  presentedToken: string | undefined;
  activeToken: string;
  /** When true (config.dashboard.publicReadOnly), the GET/HEAD paths in
   *  PUBLIC_READ_PATHS (the "watch work" board surfaces) are readable WITHOUT
   *  a token — a tokenless (or stale-token) visitor gets a read-only dashboard
   *  instead of a 401 wall. Everything else (management/config reads, raw PTY,
   *  all writes) still requires the active token. */
  publicReadOnly?: boolean;
}): AuthDecision {
  const { method, pathname, hasTokenParam, presentedToken, activeToken, publicReadOnly } = opts;

  // Historical `…/terminal-log/raw` routes are gone, but keep the generic raw
  // suffix excluded from public-read policy so future APIs cannot expose a PTY
  // transcript by accidentally inheriting this carve-out.
  const isRawTerminalLog = pathname.endsWith('/terminal-log/raw');

  // The legacy workflow prefix is now a public zero-I/O 410 tombstone. Keeping
  // it public lets stale cards/clients receive an actionable retirement result.
  const isWorkflowReadOnly =
    method === 'GET' &&
    (pathname === '/api/workflows' || pathname.startsWith('/api/workflows/')) &&
    !isRawTerminalLog;
  const isStaticShell =
    (method === 'GET' || method === 'HEAD') &&
    (
      pathname === '/' ||
      pathname === '/favicon.ico' ||
      pathname === '/favicon.png' ||
      pathname === '/apple-touch-icon.png' ||
      // The install manifest is fetched by the OS, not the signed-in page, so a
      // gated response silently disables "add to home screen". It names icons
      // and a start URL — no session data.
      pathname === '/workbench.webmanifest' ||
      // Self-service diagnostics page. It is needed exactly when a device
      // cannot authenticate or cannot load the SPA, so gating it behind the
      // token would lock it out of its only job. The page is a static shell
      // like the others: it reads no server state and renders no session data,
      // and every probe it runs is the visitor's own browser calling the same
      // gated APIs under the visitor's own (possibly absent) credentials.
      pathname === '/workbench-doctor' ||
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/game/')
    );

  // Public read-only mode opens ONLY the allow-listed "watch work" reads
  // (PUBLIC_READ_PATHS) — fail-closed: a path not on the list stays token-gated
  // even under publicReadOnly, so new endpoints don't silently become public.
  const isPublicRead =
    !!publicReadOnly &&
    (method === 'GET' || method === 'HEAD') &&
    PUBLIC_READ_PATHS.has(pathname);

  const authed = !!presentedToken && presentedToken === activeToken;

  if (!authed && !isWorkflowReadOnly && !isStaticShell && !isPublicRead) {
    return { kind: 'deny401' };
  }

  // First hit with `?t=<correct token>` sets the cookie + redirects to the
  // clean URL.  Only reached when the token matched (`authed === true`).
  if (hasTokenParam && authed && presentedToken) {
    return {
      kind: 'allow+set-cookie',
      token: presentedToken,
      // The fragment-free Workbench entries are redirects themselves. Sending
      // the cleaned URL back to the same path would bounce between "strip the
      // token" and "redirect again", so resolve them to their real destination
      // in this one hop.
      redirectTo: pathname === '/workbench'
        ? '/#/agent-workbench'
        : pathname === '/workbench/dock'
          ? '/#/agent-workbench-dock'
          : pathname || '/',
    };
  }

  return { kind: 'allow' };
}

// ─── P1-4：工作台最小操作能力集投影 ──────────────────────────────────────────

/**
 * 前端可见的"最小操作能力集"。`workbenchAuthed` 只能证明可进工作台，不代表任何
 * 一项操作权限；三布尔各自对应一条真实路由的门禁：
 *
 *   - `canLocate`   → `POST /api/sessions/:id/locate`（话题定位）。
 *   - `canControl`  → `POST /api/sessions/:id/control/takeover|release`
 *                     （终端接管/释放）。
 *   - `canInteract` → `POST /api/sessions/:id/preview-interaction/unlock|
 *                     activity|lock`（Preview 交互解锁）。
 *
 * 边界（P1-6 write token）：`canControl` 只描述该身份**不带显式 token 时**在
 * Dashboard control API 上的默认能力。显式 `?token=`（write token）走终端前置
 * 代理的独立授权链——它既不经过这三条 API，也不受本投影影响；一个 teammate 被
 * 递了显式 write token 仍可直接写终端，本投影不试图（也不可能）描述那条通道。
 */
export interface WorkbenchOperationCapabilities {
  canLocate: boolean;
  canControl: boolean;
  canInteract: boolean;
}

/** 匿名 / 解析失败时的 fail-closed 值：三项全 false。 */
export const WORKBENCH_NO_OPERATION_CAPABILITIES: Readonly<WorkbenchOperationCapabilities> =
  Object.freeze({ canLocate: false, canControl: false, canInteract: false });

/** 投影所需的最小身份切面——与 dashboard.ts 的 DashboardRequestIdentity 结构兼容
 *  （kind 枚举 + terminal-control.ts 的角色能力字段）。 */
export interface WorkbenchCapabilityActor {
  kind: 'legacy-dashboard' | 'platform-dashboard' | 'feishu-h5';
  terminalCapability?: 'controlled' | 'owner' | 'readonly';
  previewCapability: 'operate' | 'readonly';
}

/**
 * 由身份投影三布尔能力集。**不是一张平行的权限表**：每一项都通过复算真实路由
 * 的两层门禁得出——
 *
 *   1. 路由级 auth 决策：workbench-only 身份（H5 / platform）走
 *      {@link decideWorkbenchH5Auth}（capability 表里没有 /locate，所以 H5 与
 *      platform 全员 canLocate=false）；legacy owner 走
 *      {@link decideDashboardAuth}（cookie == active token，等价于 allow）。
 *   2. 处理器级角色检查：dashboard.ts 对 control/preview-interaction 写操作分别
 *      用 `terminalCapability === 'readonly'` / `previewCapability === 'readonly'`
 *      403，这里逐字复用同一判据。
 *
 * 因此「投影为 true 而路由 401/403」或反向漂移只可能来自这两层规则本身的改动，
 * 而 test/dashboard-auth.test.ts 的矩阵测试把两边钉在一起。
 */
export function projectWorkbenchOperationCapabilities(
  identity: WorkbenchCapabilityActor | null,
): WorkbenchOperationCapabilities {
  if (!identity) return { ...WORKBENCH_NO_OPERATION_CAPABILITIES };
  const legacy = identity.kind === 'legacy-dashboard';
  // 会话 id 只是路由 pattern 的占位（[^/]+ 全匹配），对决策无影响；legacy 侧的
  // probe token 复现的是「cookie 与 active token 相等」这一既成事实。
  const routeAllows = (method: string, pathname: string): boolean => (legacy
    ? decideDashboardAuth({
        method,
        pathname,
        hasTokenParam: false,
        presentedToken: 'capability-probe-token',
        activeToken: 'capability-probe-token',
        publicReadOnly: false,
      }).kind === 'allow'
    : decideWorkbenchH5Auth({ method, pathname }).kind === 'allow');
  return {
    canLocate: routeAllows('POST', '/api/sessions/probe/locate'),
    // terminalCapability 缺失按 readonly 处理（fail closed）；'owner' 与
    // 'controlled' 都不落入 403 分支，与 dashboard.ts 的判据一字不差。
    canControl: routeAllows('POST', '/api/sessions/probe/control/takeover')
      && identity.terminalCapability !== undefined
      && identity.terminalCapability !== 'readonly',
    canInteract: routeAllows('POST', '/api/sessions/probe/preview-interaction/unlock')
      && identity.previewCapability !== 'readonly',
  };
}
