import {
  isPreviewLoopbackHost,
  previewBackendSupported,
  safeSessionPreviewTarget,
  sessionPreviewDescriptor,
  sessionPreviewFingerprint,
  type SessionPreviewDescriptor,
  type SessionPreviewTarget,
} from '../core/session-preview.js';

/** Internal daemon rows carry the literal loopback target so the central
 * dashboard can proxy it. Browser rows never do: they receive only a
 * same-origin path plus a timestamp.
 *
 * Riff 矩阵：远端 sandbox 会话在 daemon 的 loopback 上不可能有 Web 服务，注册路由
 * 已经拒绝它们；这里再拦一道，让任何来源（历史行、切后端前留下的行）都不会给
 * 浏览器一个点进去必然失败的预览入口。 */
export function projectSessionPreviewForBrowser(session: unknown): unknown {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  const source = session as Record<string, unknown>;
  const {
    previewTarget: _previewTarget,
    preview: _stalePreview,
    ...rest
  } = source;
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
  const preview = sessionId && previewBackendSupported(source.backendType)
    ? sessionPreviewDescriptor(sessionId, source.previewTarget)
    : undefined;
  return preview ? { ...rest, preview } : rest;
}

export function projectSessionPreviewsForBrowser(sessions: unknown[]): unknown[] {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.map(projectSessionPreviewForBrowser);
}

/** Projection for daemon `GET /api/sessions/:id` envelopes. Keep this beside
 * the list/SSE projectors so every browser delivery path shares one rule. */
export function projectSessionDetailForBrowser(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, 'session')) return body;
  return { ...source, session: projectSessionPreviewForBrowser(source.session) };
}

/** Apply the identical projection to the central SSE stream. A future clear
 * patch maps to `preview: null`, ensuring browser stores discard stale state. */
export function projectSessionPreviewEventForBrowser(type: string, body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const eventBody = body as Record<string, unknown>;
  if (type === 'session.spawned') {
    return {
      ...eventBody,
      session: projectSessionPreviewForBrowser(eventBody.session),
    };
  }
  if (
    type === 'session.update'
    && eventBody.patch
    && typeof eventBody.patch === 'object'
    && !Array.isArray(eventBody.patch)
  ) {
    const rawPatch = eventBody.patch as Record<string, unknown>;
    const hasTarget = Object.prototype.hasOwnProperty.call(rawPatch, 'previewTarget');
    const hasStalePreview = Object.prototype.hasOwnProperty.call(rawPatch, 'preview');
    if (!hasTarget && !hasStalePreview) return body;
    const { previewTarget, preview: _stalePreview, ...patch } = rawPatch;
    if (!hasTarget) return { ...eventBody, patch };
    const sessionId = typeof eventBody.sessionId === 'string' ? eventBody.sessionId : '';
    const descriptor = sessionId
      ? sessionPreviewDescriptor(sessionId, previewTarget)
      : undefined;
    return {
      ...eventBody,
      patch: { ...patch, preview: descriptor ?? null },
    };
  }
  return body;
}

export type SessionPreviewResolution =
  | { ok: true; target: SessionPreviewTarget }
  | {
      ok: false;
      status: 403 | 404 | 409 | 501;
      error: 'unknown_session' | 'session_owner_mismatch' | 'session_not_active'
        | 'preview_not_registered' | 'remote_host_forbidden' | 'invalid_preview_target'
        /** Riff 等远端 backend：daemon loopback 天然不可达，明确不支持而非「不可达」。 */
        | 'preview_unsupported'
        /** P1-12：端口已经不由注册时那个进程持有，路由失效。 */
        | 'preview_target_stale';
    };

/** Resolve an aggregator row under positive session + daemon ownership proof.
 * The requested URL never supplies a host or port; both come solely from this
 * exact owned row and are revalidated as literal loopback data. */
export function resolveSessionPreviewFromRow(input: {
  row: unknown;
  sessionId: string;
  ownerLarkAppId: string | undefined;
}): SessionPreviewResolution {
  if (!input.row || typeof input.row !== 'object' || Array.isArray(input.row)) {
    return { ok: false, status: 404, error: 'unknown_session' };
  }
  const row = input.row as Record<string, unknown>;
  if (
    typeof row.sessionId !== 'string'
    || row.sessionId !== input.sessionId
    || typeof row.larkAppId !== 'string'
    || !input.ownerLarkAppId
    || row.larkAppId !== input.ownerLarkAppId
  ) {
    return { ok: false, status: 404, error: 'session_owner_mismatch' };
  }
  if (row.status === 'closed') {
    return { ok: false, status: 409, error: 'session_not_active' };
  }
  // Riff/远端 backend：不是「暂时连不上」，是这条路径在这种会话上根本不存在。
  if (!previewBackendSupported(row.backendType)) {
    return { ok: false, status: 501, error: 'preview_unsupported' };
  }
  const target = safeSessionPreviewTarget(row.previewTarget);
  if (target) return { ok: true, target };
  if (row.previewTarget !== undefined && row.previewTarget !== null) {
    const raw = typeof row.previewTarget === 'object' && !Array.isArray(row.previewTarget)
      ? row.previewTarget as Record<string, unknown>
      : undefined;
    if (raw && !isPreviewLoopbackHost(raw.host)) {
      return { ok: false, status: 403, error: 'remote_host_forbidden' };
    }
    return { ok: false, status: 409, error: 'invalid_preview_target' };
  }
  return { ok: false, status: 404, error: 'preview_not_registered' };
}

/**
 * 中央 Dashboard 每一跳预览请求的完整判定。顺序即安全次序，任何一步失败都不代理：
 *
 *   会话归属 → 会话仍活着 → backend 支持预览 → 目标本身合法 → 拥有它的 daemon 在线
 *   → **端口此刻仍由注册时那个进程持有**（P1-12）。
 *
 * 最后一条是每次落地前都要重跑的：注册时的一次 TCP connect 只证明当时有人在监听，
 * 而 dev server 退出后端口号会被内核回收，下一个抢到它的本机进程就继承了这条已登录
 * 用户可达的同源代理路由。判定失效时同步回 `preview_target_stale`，并通过
 * `onStaleTarget` 触发收口（断掉既有预览长连接、收回交互租约、让 daemon 清 target 并
 * 广播 `preview: null`）。
 */
export function resolveSessionPreviewForProxy(input: {
  row: unknown;
  sessionId: string;
  ownerLarkAppId: string | undefined;
  daemonOnline: boolean;
  isTargetOwned: (target: SessionPreviewTarget) => boolean;
  /** P1-3：把判定失效的**那一个** target 一起交出去，收口方据此只作废这一次注册
   *  （见 `takeSessionPreviewTarget` 的 `expectedRegisteredAt`）。 */
  onStaleTarget?: (sessionId: string, staleTarget: SessionPreviewTarget) => void;
}): SessionPreviewResolution | { ok: false; status: 503; error: 'daemon_offline' } {
  const resolution = resolveSessionPreviewFromRow({
    row: input.row,
    sessionId: input.sessionId,
    ownerLarkAppId: input.ownerLarkAppId,
  });
  if (!resolution.ok) return resolution;
  if (!input.ownerLarkAppId || !input.daemonOnline) {
    return { ok: false, status: 503, error: 'daemon_offline' };
  }
  if (!input.isTargetOwned(resolution.target)) {
    input.onStaleTarget?.(input.sessionId, resolution.target);
    return { ok: false, status: 409, error: 'preview_target_stale' };
  }
  return resolution;
}

export function previewDescriptorFromRow(row: unknown): SessionPreviewDescriptor | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const source = row as Record<string, unknown>;
  if (typeof source.sessionId !== 'string') return undefined;
  if (!previewBackendSupported(source.backendType)) return undefined;
  return sessionPreviewDescriptor(source.sessionId, source.previewTarget);
}

/**
 * P1-1：daemon 生命周期事件 → 「这个会话的预览长连接要不要收口」。
 *
 * 原来只认两件事：`session.exited`，以及带 `previewTarget` 的 `session.update`。
 * 漏掉的是 `session.spawned`——daemon 的 `/api/events` **每次**被连上都会把全部会话
 * 重放成 spawned（SSE attach 的确定性重放），而 daemon 重启期间广播的
 * `preview: null` 是丢的（事件总线没有 replay buffer），重连之后只以 spawned 形式
 * 补齐。于是「目标已经没了，浏览器那条流还在流」这一支完全不在收口范围内。
 *
 * 但 spawned 不能无条件收口：aggregator 在通知监听器**之前**就把整行覆盖掉了，
 * 每次 SSE 重连都会重放全部会话，无条件 teardown 等于每次重连误杀全部预览长连接。
 * 所以 dashboard 侧自记一份「上次见过的目标指纹」，只有指纹**确实变了**才收口；
 * 第一次见到某个会话不算变（那是重放/新建，不是换靶）。
 *
 * `lastSeenFingerprints` 由调用方持有并在此原地更新——收口判据和记忆必须是同一个
 * 动作，分开写迟早会漏更新一条分支。
 */
export function previewTeardownForDaemonEvent(
  event: { type: string; body: unknown },
  lastSeenFingerprints: Map<string, string>,
): string | undefined {
  const body = event.body && typeof event.body === 'object' && !Array.isArray(event.body)
    ? event.body as Record<string, unknown>
    : {};
  if (event.type === 'session.exited') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    if (!sessionId) return undefined;
    lastSeenFingerprints.delete(sessionId);
    return sessionId;
  }
  if (event.type === 'session.spawned') {
    const row = body.session && typeof body.session === 'object' && !Array.isArray(body.session)
      ? body.session as Record<string, unknown>
      : undefined;
    const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : undefined;
    if (!sessionId) return undefined;
    const fingerprint = sessionPreviewFingerprint(row?.previewTarget);
    const previous = lastSeenFingerprints.get(sessionId);
    lastSeenFingerprints.set(sessionId, fingerprint);
    return previous !== undefined && previous !== fingerprint ? sessionId : undefined;
  }
  if (event.type !== 'session.update') return undefined;
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
    ? body.patch as Record<string, unknown>
    : undefined;
  if (!sessionId || !patch || !Object.prototype.hasOwnProperty.call(patch, 'previewTarget')) {
    return undefined;
  }
  // 记忆同步更新，否则下一次 SSE 重放会把「已经处理过的这次变更」再当成一次变更。
  lastSeenFingerprints.set(sessionId, sessionPreviewFingerprint(patch.previewTarget));
  return sessionId;
}
