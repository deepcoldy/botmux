import {
  isPreviewLoopbackHost,
  safeSessionPreviewTarget,
  sessionPreviewDescriptor,
  type SessionPreviewDescriptor,
  type SessionPreviewTarget,
} from '../core/session-preview.js';

/** Internal daemon rows carry the literal loopback target so the central
 * dashboard can proxy it. Browser rows never do: they receive only a
 * same-origin path plus a timestamp. */
export function projectSessionPreviewForBrowser(session: unknown): unknown {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  const source = session as Record<string, unknown>;
  const {
    previewTarget: _previewTarget,
    preview: _stalePreview,
    ...rest
  } = source;
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
  const preview = sessionId
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
      status: 403 | 404 | 409;
      error: 'unknown_session' | 'session_owner_mismatch' | 'session_not_active'
        | 'preview_not_registered' | 'remote_host_forbidden' | 'invalid_preview_target';
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

export function previewDescriptorFromRow(row: unknown): SessionPreviewDescriptor | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const source = row as Record<string, unknown>;
  if (typeof source.sessionId !== 'string') return undefined;
  return sessionPreviewDescriptor(source.sessionId, source.previewTarget);
}
