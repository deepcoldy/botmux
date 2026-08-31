import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { requestLiteralLoopback } from '../core/loopback-target.js';
import { TERMINAL_VIEW_FORWARD_HEADER } from '../core/terminal-control-grant.js';
import { TERMINAL_PLATFORM_READONLY_HINT_HEADER } from '../core/terminal-write-auth.js';
import type {
  TerminalControlManager,
  TerminalDashboardActor,
  TerminalProxyGrant,
} from './terminal-control.js';

export const TERMINAL_CONTROL_HEADER = 'x-botmux-terminal-control';
export { TERMINAL_VIEW_FORWARD_HEADER };
/** Covers a daemon wake-up plus a bounded worker handshake. Cleared as soon as
 * response/upgrade headers arrive, so live streams stay unbounded.
 *
 * Note this 30s is now SHORTER than the wake it has to cover:
 * `ensureTerminalWorkerPort` allows up to 40s for a cold wake (create the pane,
 * boot the CLI), and the daemon sends no bytes until it resolves, so the last
 * 10s is unreachable through this hop. That is not a lost wake — the fork is
 * not cancelled by the 502 that follows, so the first click starts it and a
 * later one hits the fast `resolvePort` path. A dashboard talking to the daemon
 * proxy directly has no such ceiling and can use the full 40s.
 *
 * Raising this is a separate change, not a follow-up to that one: it is armed
 * on both the HTTP and the upgrade path, so it also bounds requests that have
 * nothing to do with waking. */
export const TERMINAL_UPSTREAM_RESPONSE_TIMEOUT_MS = 30_000;
/**
 * P1-2：upgrade 请求收到非 101 回应 = 一次拒绝，不是长连接。清掉唯一那道计时器
 * 之后，一个不结束 body 的上游能把上游 socket 与浏览器 socket 一起挂死，没有任
 * 何东西会回收它们。所以这条路保留总时限 + idle 时限（只有 idle 时限时，每 N 秒
 * 滴一个字节就能永久续命），并给拒绝体加一个上限——预览那一跳早就有了。
 */
export const TERMINAL_UPGRADE_REJECTION_TIMEOUT_MS = 15_000;
export const TERMINAL_UPGRADE_REJECTION_IDLE_TIMEOUT_MS = 10_000;
export const MAX_TERMINAL_UPGRADE_REJECTION_BYTES = 64 * 1024;

export interface TerminalFrontProxyOptions {
  resolvePort(sessionId: string): number | undefined;
  resolveActor(req: IncomingMessage): TerminalDashboardActor | null;
  control: TerminalControlManager;
  /** P1-5: resolve which auth session a bound `?viewToken=` read capability
   * belongs to (null for anything that is not a valid bound capability for
   * this session). Lets the proxy refuse revoked capabilities and index the
   * bridged socket for logout-time closing. */
  viewCapabilityAuthSession?(sessionId: string, viewToken: string): string | null;
  /** P1-5: liveness of the auth session behind a bound capability. `false`
   * means logout/expiry already revoked it — the request is refused even
   * though the worker's stateless check would still accept the signature. */
  isAuthSessionLive?(authSessionId: string): boolean;
  /** P1-5: countersign an accepted view capability for the loopback hop. Only
   * emitted after liveness passed, so the header IS the statement "the
   * component holding the revocation state let this one through". Without it
   * the worker refuses the capability, which is what makes a raw view URL
   * aimed at the worker port or the daemon's own `/s/` proxy fail closed. */
  viewCapabilityForwardProof?(viewToken: string): string | undefined;
}

function safeDecodeSessionId(raw: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  return decoded && decoded.length <= 512 && !/[\\/\0]/.test(decoded) ? decoded : undefined;
}

export function parseTerminalFrontPath(pathname: string): { sessionId: string } | null {
  if (!pathname.startsWith('/s/')) return null;
  const raw = pathname.slice(3).split('/')[0];
  const sessionId = safeDecodeSessionId(raw);
  return sessionId ? { sessionId } : null;
}

function sensitiveBrowserHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'cookie'
    || lower === 'authorization'
    || lower === 'proxy-authorization'
    || lower === 'referer'
    || lower === 'forwarded'
    || lower.startsWith('x-forwarded-')
    || lower.startsWith('x-botmux-');
}

/**
 * Authenticated Dashboard requests are converted to one signed loopback grant.
 * Client-supplied cookies/role/grant headers are removed first. Token/viewToken
 * query capabilities remain supported for legacy direct links and are handled
 * independently by the worker.
 */
export function terminalForwardHeaders(
  headers: IncomingHttpHeaders,
  grant: string | undefined,
  options: { stripBrowserCredentials?: boolean } = {},
): OutgoingHttpHeaders {
  if (!grant && !options.stripBrowserCredentials) {
    // Legacy query capabilities and platform headers retain their historical
    // behavior, but an unauthenticated browser may never supply/replay the new
    // internal grant header itself.
    const forwarded = { ...headers };
    delete forwarded[TERMINAL_CONTROL_HEADER];
    return forwarded;
  }
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || sensitiveBrowserHeader(name)) continue;
    forwarded[name] = value;
  }
  if (grant) forwarded[TERMINAL_CONTROL_HEADER] = grant;
  return forwarded;
}

function plainError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(message);
}

function socketError(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = message;
  const reason = status === 403 ? 'Forbidden'
    : status === 404 ? 'Not Found'
    : status === 409 ? 'Conflict'
    : 'Bad Gateway';
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'content-type: text/plain; charset=utf-8',
    'cache-control: no-store',
    'connection: close',
    `content-length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

type PreparedTerminalRequest =
  | { sessionId: string; port: number | undefined; revoked: true }
  | {
      sessionId: string;
      port: number | undefined;
      revoked: false;
      actor: TerminalDashboardActor | null;
      proxyGrant: TerminalProxyGrant | undefined;
      /** Auth session whose read stream this bridge would carry — registered so
       * logout/expiry of that authentication closes the socket immediately. */
      readAuthSessionId: string | undefined;
      headers: OutgoingHttpHeaders;
    };

/**
 * P1-4: the auth session this bridge belongs to, or `undefined` when the
 * request is authorized by something other than a dashboard authentication.
 *
 * An explicit `?token=` / `?viewToken=` query capability that did NOT resolve
 * to a bound view capability is deliberately excluded: P1-6 made that token the
 * SOLE authorization basis, so the opener's ambient authentication must not
 * decide its fate in either direction. Everything else — a bound view
 * capability, an injected read grant, an injected write grant (leased or the
 * platform owner's fixed one) — lives and dies with its auth session.
 */
function bridgeAuthSession(
  prepared: Extract<PreparedTerminalRequest, { revoked: false }>,
): string | undefined {
  return prepared.readAuthSessionId
    ?? (prepared.proxyGrant ? prepared.actor?.authSessionId : undefined);
}

export function createTerminalFrontProxy(options: TerminalFrontProxyOptions): {
  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
} {
  const prepare = (req: IncomingMessage, url: URL): PreparedTerminalRequest | null => {
    const parsed = parseTerminalFrontPath(url.pathname);
    if (!parsed) return null;
    const port = options.resolvePort(parsed.sessionId);
    const actor = options.resolveActor(req);
    // An explicit `?token=` / `?viewToken=` query capability — no matter who
    // carries it, platform/H5 actors included — is the SOLE authorization basis
    // for the request (P1-6). No internal grant is injected next to it: a
    // platform teammate/guest opening a correct write link used to receive a
    // read grant that silently outranked the token at the worker, turning the
    // explicitly issued 「操作链接」 read-only. Ambient Cookie / X-Botmux-Role
    // headers are stripped for the same reason in the other direction: a wrong
    // token must not become writable by borrowing the opener's owner ambient.
    const hasExplicitQueryCapability = url.searchParams.has('token')
      || url.searchParams.has('viewToken');
    // P1-5: a bound view capability names the auth session it was minted for.
    // Refuse it once that authentication ended (logout/expiry) — the worker's
    // stateless signature/expiry check alone would still accept it.
    let readAuthSessionId: string | undefined;
    let viewForwardProof: string | undefined;
    if (hasExplicitQueryCapability) {
      const viewToken = url.searchParams.get('viewToken');
      const boundAuthSession = viewToken
        ? options.viewCapabilityAuthSession?.(parsed.sessionId, viewToken) ?? null
        : null;
      if (boundAuthSession && viewToken) {
        if (options.isAuthSessionLive?.(boundAuthSession) === false) {
          return { ...parsed, port, revoked: true };
        }
        readAuthSessionId = boundAuthSession;
        // Countersign only what this proxy just validated as live. The proof is
        // bound to the exact capability string, so it can neither be moved onto
        // a different grant nor be replayed by a browser that never sees it.
        viewForwardProof = options.viewCapabilityForwardProof?.(viewToken);
      }
    }
    // P1-6: an explicit `?token=`/`?viewToken=` query capability is normally the
    // SOLE authorization basis — no proxy grant is injected next to it, so a wrong
    // token can't borrow the opener's owner ambient. But a `?viewToken=` READ link
    // is the one the Feishu card hands the owner, and stripping the owner's proxy
    // grant there regressed the pre-3.16 behavior "owner logs in → can operate":
    // the viewToken forced read-only and the owner's platform identity was dropped
    // (#933). Carve out exactly that case — a verified platform OWNER opening a
    // viewToken-only link (never `?token=`, which keeps its independent-capability
    // path) still gets the signed WRITE grant. This does NOT reopen P1-6: the grant
    // is minted here from `actor` — whose owner role is itself gated on the
    // platform-injected dashboard-token cookie matching this machine's live secret
    // (resolveDashboardIdentity), a value a viewToken holder does not possess — and
    // travels as an HMAC-signed `X-Botmux-Terminal-Control` header, never as a
    // passed-through client cookie/role. A guest/teammate viewToken opener has no
    // owner actor, so this branch does not fire and they stay read-only.
    const ownerWithViewToken = actor?.terminalCapability === 'owner'
      && url.searchParams.has('viewToken')
      && !url.searchParams.has('token');
    const proxyGrant = actor && (!hasExplicitQueryCapability || ownerWithViewToken)
      ? options.control.grantForProxy(actor, parsed.sessionId)
      : undefined;
    if (actor && proxyGrant?.scope === 'read') readAuthSessionId = actor.authSessionId;
    const headers = terminalForwardHeaders(req.headers, proxyGrant?.token, {
      // Validate the explicit capability at the worker, but do not also send
      // the legacy management cookie: a garbage `?token=` must not become a
      // writable request merely because its opener is the owner Dashboard.
      stripBrowserCredentials: hasExplicitQueryCapability,
    });
    // Set AFTER the header build, which drops every client-supplied `x-botmux-*`
    // on this path: a browser can never smuggle its own forward proof through.
    if (viewForwardProof) headers[TERMINAL_VIEW_FORWARD_HEADER] = viewForwardProof;
    // #933 回归修复：`terminalCapability === 'readonly'` 只可能来自平台注入身份
    // （teammate/guest —— legacy/H5 都是 'controlled'，平台 owner 是 'owner'）。上面
    // 两条路都已把平台注入的 Cookie / X-Botmux-Role 剥掉（P1-6 strip 或换内部 grant），
    // worker 便判不出「平台认证过的只读访客」→ platformReadonly 恒 false → 只读终端页
    // 上的「owner 登录后可操作 →」SSO 引导消失，冷打开卡片链接的人困在无登录入口的
    // 只读页里。补一个仅展示用的提示头（授权判定完全不读它，见常量注释）；同样设在
    // terminalForwardHeaders 之后，客户端自带的同名头已被整片丢弃、无法夹带。
    if (actor?.terminalCapability === 'readonly') {
      headers[TERMINAL_PLATFORM_READONLY_HINT_HEADER] = '1';
    }
    return { ...parsed, port, revoked: false, actor, proxyGrant, readAuthSessionId, headers };
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (!(url.pathname === '/s' || url.pathname.startsWith('/s/'))) return false;
    const prepared = prepare(req, url);
    if (!prepared?.port) {
      plainError(res, 404, 'session terminal not available');
      return true;
    }
    if (prepared.revoked) {
      plainError(res, 403, 'view capability revoked');
      return true;
    }
    const upstream = requestLiteralLoopback({ host: '127.0.0.1', port: prepared.port }, {
      method: req.method,
      path: req.url,
      headers: prepared.headers,
    }, up => {
      upstream.setTimeout(0);
      res.writeHead(up.statusCode ?? 502, up.headers);
      // P1-2：浏览器提前断开时把上游一起收掉。`up.pipe(res)` 在 dest 关闭时只做
      // unpipe，不会 destroy source；headers 一到又把 30s 的前置超时拆掉了，于是
      // 这条上游没有任何东西会回收——终端这一跳同样有长响应（日志/流式输出）。
      // `ClientRequest.destroy()` 可重入；响应已自然写完的情况不必多此一举。
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      up.pipe(res);
    });
    upstream.setTimeout(TERMINAL_UPSTREAM_RESPONSE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) plainError(res, 502, 'terminal proxy error');
      else res.end();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
    return true;
  };

  const handleUpgrade = (req: IncomingMessage, clientSocket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return false; }
    if (!(url.pathname === '/s' || url.pathname.startsWith('/s/'))) return false;
    // Install this synchronously for every claimed upgrade path. Browser
    // disconnects can race DNS/connect/401/404/502 handling; an EventEmitter
    // `error` without a listener would otherwise terminate the Dashboard.
    let upstreamRequest: ReturnType<typeof requestLiteralLoopback> | undefined;
    let bridgedSocket: Duplex | undefined;
    clientSocket.on('error', () => {
      upstreamRequest?.destroy();
      bridgedSocket?.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    const prepared = prepare(req, url);
    if (!prepared?.port) {
      socketError(clientSocket, 404, 'session terminal not available');
      return true;
    }
    if (prepared.revoked) {
      socketError(clientSocket, 403, 'view capability revoked');
      return true;
    }

    let responded = false;
    const upstream = requestLiteralLoopback({ host: '127.0.0.1', port: prepared.port }, {
      method: req.method,
      path: req.url,
      headers: prepared.headers,
    });
    upstreamRequest = upstream;
    upstream.setTimeout(TERMINAL_UPSTREAM_RESPONSE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      responded = true;
      bridgedSocket = upstreamSocket;
      upstream.setTimeout(0);
      upstreamSocket.setTimeout(0);

      // P1-4: the liveness check in `prepare` is a snapshot taken BEFORE the
      // dial. Between it and this upstream 101 sits a real worker handshake
      // (the response timeout alone allows 30s of daemon wake-up), and a
      // logout / expiry / rotation / unbind landing inside that window revokes
      // nothing here: the socket exists only as a local variable, so the
      // revocation sweep walks the authSession→socket index and finds it
      // absent. Registering it afterwards would file a live bridge under an
      // already-dead auth session, where no future revocation reaches it
      // either — it would survive until the worker's own read-capability
      // expiry, up to ten more minutes.
      //
      // Re-check here, in the same synchronous tick that registers the socket.
      // Revocation always deletes the session from the liveness authority
      // BEFORE it sweeps the index (see DashboardSessionStore.endHash and
      // dashboard.ts's endDashboardAuthSession), so the two possible orders are
      // now: we register first and the sweep closes us, or the sweep already
      // ran and this check refuses. There is no third order that leaks.
      const authSessionId = bridgeAuthSession(prepared);
      if (authSessionId !== undefined && options.isAuthSessionLive?.(authSessionId) === false) {
        // Nothing is relayed: no 101, no registration, and the upstream socket
        // dies so the worker does not keep a half-open bridge either.
        upstreamSocket.destroy();
        socketError(clientSocket, 403, 'authentication ended');
        return;
      }

      let acquisition: string | undefined;
      if (prepared.actor && prepared.proxyGrant?.scope === 'write' && prepared.proxyGrant.acquisition) {
        const registered = options.control.registerWritableSocket(
          prepared.actor,
          prepared.sessionId,
          clientSocket,
          prepared.proxyGrant.acquisition,
        );
        acquisition = registered.acquisition;
        if (!registered.registered) {
          // The worker may have accepted a grant that was valid when the dial
          // began but was released/expired/replaced during its async handshake.
          // Never relay that 101: revoke the matching old lease (if any) and
          // make the browser reconnect through the now-read-only path.
          // `disconnect` is acquisition-scoped, so if the reason we could not
          // register is that a NEWER acquisition took the lease over, this call
          // is a no-op instead of collateral damage.
          options.control.disconnect(
            prepared.actor,
            prepared.sessionId,
            prepared.proxyGrant.acquisition,
          );
          upstreamSocket.destroy();
          socketError(clientSocket, 409, 'terminal control expired');
          return;
        }
      }

      // P1-5: index the stream under its auth session so logout/expiry closes
      // it now rather than at the worker's grant-expiry timer. A leased write
      // bridge is already carried by its lease's own socket set; everything
      // else (bound view capability, injected read grant, and the platform
      // owner's fixed write grant, which has no lease behind it) is indexed
      // here — otherwise the liveness re-check above would only have moved the
      // leak one tick later instead of closing it.
      const deregisterBridgeSocket = authSessionId !== undefined && !acquisition
        ? options.control.registerReadSocket(authSessionId, clientSocket)
        : undefined;

      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`];
      const raw = upRes.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);

      let disconnected = false;
      const releaseOnDisconnect = () => {
        if (disconnected) return;
        disconnected = true;
        deregisterBridgeSocket?.();
        if (prepared.actor && acquisition) {
          options.control.disconnect(prepared.actor, prepared.sessionId, acquisition);
        }
      };

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const cleanup = () => {
        releaseOnDisconnect();
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on('error', cleanup);
      upstreamSocket.on('close', () => { releaseOnDisconnect(); clientSocket.destroy(); });
      clientSocket.on('close', () => { releaseOnDisconnect(); upstreamSocket.destroy(); });
    });
    upstream.on('response', upRes => {
      responded = true;
      // P1-2：拒绝体必须在限期内读完，且有上限（见常量注释）。
      let settled = false;
      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      const disarm = (): void => {
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        totalTimer = undefined;
      };
      const abandon = (): void => {
        if (settled) return;
        disarm();
        upRes.destroy();
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.setTimeout(TERMINAL_UPGRADE_REJECTION_IDLE_TIMEOUT_MS, abandon);
      totalTimer = setTimeout(abandon, TERMINAL_UPGRADE_REJECTION_TIMEOUT_MS);
      totalTimer.unref?.();
      // 客户端先走时也要回收上游。升级请求的 socket 被 http server 摘掉 data 监听
      // 后是暂停态，且 http server 建的 socket 是 allowHalfOpen——不 `resume()` 就
      // 收不到 FIN，收到了也不会自动关。升级已被拒，客户端 FIN 即视为它走了。
      clientSocket.on('close', abandon);
      clientSocket.on('end', abandon);
      clientSocket.resume();
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? 'Bad Gateway'}`, 'connection: close'];
      const raw = upRes.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i].toLowerCase();
        if (name === 'transfer-encoding' || name === 'content-length' || name === 'connection') continue;
        lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      let bodyBytes = 0;
      upRes.on('data', chunk => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buffer.byteLength;
        if (bodyBytes > MAX_TERMINAL_UPGRADE_REJECTION_BYTES) {
          abandon();
          return;
        }
        clientSocket.write(buffer);
      });
      upRes.on('end', () => {
        if (settled) return;
        disarm();
        upstream.setTimeout(0);
        clientSocket.end();
      });
      upRes.on('error', () => { disarm(); clientSocket.destroy(); });
    });
    upstream.on('error', () => {
      if (!responded) socketError(clientSocket, 502, 'terminal proxy error');
      else clientSocket.destroy();
    });
    upstream.end();
    return true;
  };

  return { handleHttp, handleUpgrade };
}
