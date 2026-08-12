import type { WorkbenchH5Context } from './agent-workbench-chat.js';

export interface TerminalControlState {
  mode: 'readonly' | 'controlled';
  owned: boolean;
  expiresAt?: number;
  reused?: boolean;
  /** Trusted platform owners have a fixed role, not a releasable takeover lease. */
  fixed?: boolean;
}

export interface PreviewInteractionState {
  mode: 'preview' | 'interactive';
  label: string;
  securityNotice: string;
  idleExpiresAt?: number;
}

export interface WorkbenchApi {
  getTerminalControl(sessionId: string, signal?: AbortSignal): Promise<TerminalControlState>;
  takeoverTerminal(sessionId: string, signal?: AbortSignal): Promise<TerminalControlState>;
  releaseTerminal(sessionId: string, signal?: AbortSignal): Promise<TerminalControlState>;
  getPreviewInteraction(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  unlockPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  touchPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  lockPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  getH5Context(signal?: AbortSignal): Promise<WorkbenchH5Context | null>;
}

export class WorkbenchApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'WorkbenchApiError';
  }
}

async function jsonRequest<T>(fetchImpl: typeof fetch, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchImpl(path, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || body.ok === false) {
    throw new WorkbenchApiError(response.status, String(body?.error ?? `http_${response.status}`));
  }
  return body as T;
}

function responseObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkbenchApiError(502, code);
  }
  return value as Record<string, unknown>;
}

function optionalDeadline(value: unknown, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new WorkbenchApiError(502, code);
  }
  return value;
}

function terminalControlState(value: unknown, fallbackOwned?: boolean): TerminalControlState {
  const body = responseObject(value, 'invalid_control_response');
  if (body.mode !== 'readonly' && body.mode !== 'controlled') {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  const owned = typeof body.owned === 'boolean' ? body.owned : fallbackOwned;
  if (typeof owned !== 'boolean') throw new WorkbenchApiError(502, 'invalid_control_response');
  const expiresAt = optionalDeadline(body.expiresAt, 'invalid_control_response');
  const fixed = body.fixed === undefined ? undefined : body.fixed;
  if (fixed !== undefined && typeof fixed !== 'boolean') {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  if ((body.mode === 'readonly' && (owned || expiresAt !== undefined))
    || (body.mode === 'controlled' && expiresAt === undefined && fixed !== true)) {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  const reused = body.reused === undefined ? undefined : body.reused;
  if (reused !== undefined && typeof reused !== 'boolean') {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  if (fixed === true && (body.mode !== 'controlled' || !owned || expiresAt !== undefined)) {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  return {
    mode: body.mode,
    owned,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(reused === undefined ? {} : { reused }),
    ...(fixed === undefined ? {} : { fixed }),
  };
}

function previewInteractionState(value: unknown): PreviewInteractionState {
  const body = responseObject(value, 'invalid_preview_interaction_response');
  if (body.mode !== 'preview' && body.mode !== 'interactive') {
    throw new WorkbenchApiError(502, 'invalid_preview_interaction_response');
  }
  if (typeof body.label !== 'string' || !body.label || body.label.length > 256
    || typeof body.securityNotice !== 'string' || !body.securityNotice || body.securityNotice.length > 1_024) {
    throw new WorkbenchApiError(502, 'invalid_preview_interaction_response');
  }
  const idleExpiresAt = optionalDeadline(body.idleExpiresAt, 'invalid_preview_interaction_response');
  if ((body.mode === 'preview' && idleExpiresAt !== undefined)
    || (body.mode === 'interactive' && idleExpiresAt === undefined)) {
    throw new WorkbenchApiError(502, 'invalid_preview_interaction_response');
  }
  return {
    mode: body.mode,
    label: body.label,
    securityNotice: body.securityNotice,
    ...(idleExpiresAt === undefined ? {} : { idleExpiresAt }),
  };
}

function controlPath(sessionId: string, action?: 'takeover' | 'release'): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/control${action ? `/${action}` : ''}`;
}

function previewPath(sessionId: string, action?: 'unlock' | 'activity' | 'lock'): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview-interaction${action ? `/${action}` : ''}`;
}

export function createWorkbenchApi(fetchImpl: typeof fetch = fetch): WorkbenchApi {
  return {
    getTerminalControl: async (sessionId, signal) => terminalControlState(
      await jsonRequest(fetchImpl, controlPath(sessionId), { signal }),
    ),
    takeoverTerminal: async (sessionId, signal) => terminalControlState(
      await jsonRequest(fetchImpl, controlPath(sessionId, 'takeover'), { method: 'POST', signal }),
      true,
    ),
    releaseTerminal: async (sessionId, signal) => terminalControlState(
      await jsonRequest(fetchImpl, controlPath(sessionId, 'release'), { method: 'POST', signal }),
      false,
    ),
    getPreviewInteraction: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId), { signal }),
    ),
    unlockPreview: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId, 'unlock'), { method: 'POST', signal }),
    ),
    touchPreview: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId, 'activity'), { method: 'POST', signal }),
    ),
    lockPreview: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId, 'lock'), { method: 'POST', signal }),
    ),
    async getH5Context(signal) {
      try {
        const body = responseObject(
          await jsonRequest<unknown>(fetchImpl, '/api/workbench/h5-context', { signal }),
          'invalid_h5_context_response',
        );
        const h5 = responseObject(body.h5, 'invalid_h5_context_response');
        if (typeof h5.enabled !== 'boolean'
          || typeof h5.appId !== 'string' || h5.appId.length > 256
          || (h5.brand !== 'feishu' && h5.brand !== 'lark')
          || typeof h5.entryPath !== 'string' || !/^\/[A-Za-z0-9/_-]{1,127}$/.test(h5.entryPath)) {
          throw new WorkbenchApiError(502, 'invalid_h5_context_response');
        }
        return {
          enabled: h5.enabled,
          appId: h5.appId,
          brand: h5.brand,
          entryPath: h5.entryPath,
        };
      } catch {
        return null;
      }
    },
  };
}
