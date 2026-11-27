import { closeResidualClause, parseCloseResidual } from '../../../core/close-residual.js';
import {
  NATIVE_GATEWAY_TRIGGER_PATH,
  nativeGatewayAskCallbackPath,
  nativeGatewayAsksPath,
  nativeGatewayInterruptPath,
  nativeGatewayProgressPath,
  nativeGatewayReminderStatePath,
  nativeGatewaySessionActionPath,
  nativeGatewaySlashPath,
  nativeGatewayTriggerResultPath,
  type NativeGatewayAskCallback,
  type NativeGatewayAskSnapshot,
  type NativeGatewayProgressResponse,
  type NativeGatewayReminderStateResponse,
} from '../../../core/native-gateway-contract.js';
import type { CoreOnlyReminderState } from '../../../core/core-only-reminder-state.js';
import type { TriggerRequest, TriggerResponse } from '../../../services/trigger-types.js';
import { validateWecomCoreUrl } from '../config/core-url.js';
import type { WecomCore } from './bridge.js';
import type { WecomProgress } from './presentation.js';

/**
 * The core refused a request (a 4xx other than 408 / 429): retrying it as it is
 * cannot succeed. Carries the HTTP status and, when the answer is a JSON body,
 * its `errorCode` and `error` (absent when the body cannot be read).
 */
export class CoreRejectedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorCode?: string,
    readonly error?: string,
  ) {
    super(message);
  }
}

/**
 * The core refused a turn because it has no session with the request's
 * `sessionId` (closed, e.g. when the agent was switched or by a core restart,
 * or never there): exactly the trigger route's 404 `session_not_found`.
 */
export function isTurnSessionGone(error: unknown): boolean {
  return error instanceof CoreRejectedError && error.status === 404 && error.errorCode === 'session_not_found';
}

/**
 * The same refusal from the session slash route, which states it as 404
 * `session_not_active` (core/dashboard-ipc-server.ts, POST /api/sessions/:id/slash).
 */
export function isSlashSessionGone(error: unknown): boolean {
  return error instanceof CoreRejectedError && error.status === 404 && error.error === 'session_not_active';
}

/**
 * The core refused an ask answer because the ask's execution is no longer the
 * live one (its session closed, or the turn / worker generation moved on):
 * exactly the ask callback route's 409 `stale_execution`
 * (core/dashboard-ipc-server.ts, POST NATIVE_GATEWAY_ROUTE_PATTERNS.asks).
 */
export function isAskExecutionStale(error: unknown): boolean {
  return error instanceof CoreRejectedError && error.status === 409 && error.error === 'stale_execution';
}

export class WecomHttpCore implements WecomCore {
  private readonly base: string;

  /**
   * `options.beforeTrigger` runs before every new turn is sent (a managed core
   * syncs its settings there, gateway/core-profile-sync.ts); it must not reject.
   */
  constructor(
    url: string,
    private readonly request: typeof fetch = fetch,
    private readonly options: { beforeTrigger?: () => Promise<void> } = {},
  ) {
    this.base = validateWecomCoreUrl(url);
  }

  async asks(sessionId: string, triggerId: string): Promise<NativeGatewayAskSnapshot[]> {
    const response = await this.json(nativeGatewayAsksPath(sessionId, triggerId)) as any;
    return response.ok ? response.asks ?? [] : [];
  }

  async answerAsk(sessionId: string, body: NativeGatewayAskCallback): Promise<{ outcome: string }> {
    return await this.json(nativeGatewayAskCallbackPath(sessionId), body) as any;
  }

  async progress(sessionId: string, triggerId: string): Promise<WecomProgress | undefined> {
    const response = await this.json(nativeGatewayProgressPath(sessionId, triggerId)) as TriggerResponse
      & Partial<Pick<NativeGatewayProgressResponse, 'progress'>>;
    // A null `progress` (not the live turn) passes through; callers only test it for truthiness.
    return response.ok ? response.progress as WecomProgress | undefined : undefined;
  }

  async reminderState(sessionId: string, triggerId: string): Promise<CoreOnlyReminderState | undefined> {
    const response = await this.json(nativeGatewayReminderStatePath(sessionId, triggerId)) as TriggerResponse
      & Partial<Pick<NativeGatewayReminderStateResponse, 'reminder'>>;
    // A null `reminder` (not the latest turn) passes through; callers only test it for truthiness.
    return response.ok ? response.reminder as CoreOnlyReminderState | undefined : undefined;
  }

  /**
   * Close one core session (the reply-card close button).
   *
   * The core can close the row LOCALLY yet leave a remote session, or a local
   * subtree it cannot prove gone, still running; it reports that as
   * `outcome: 'closed_with_residual'`. That is not a clean close. Like the
   * cross-daemon `/close wt` sibling close, log the residual and report
   * `ok: false`, so controlSession records the intent as uncertain and keeps the
   * management lock that the Dashboard shows, instead of clearing it as done.
   */
  async close(sessionId: string): Promise<{ ok: boolean }> {
    const body = await this.json(nativeGatewaySessionActionPath(sessionId, 'close'), {});
    const residual = parseCloseResidual(body);
    if (residual) {
      console.error(`[wecom] 会话 ${sessionId} 已在 core 本地关闭，但${closeResidualClause(residual)}`);
      return { ok: false };
    }
    return { ok: body.ok === true };
  }

  async slash(sessionId: string, command: string): Promise<void> {
    const response = await this.json(nativeGatewaySlashPath(sessionId), { command });
    if (!response.ok) {
      throw new Error('wecom_slash_rejected');
    }
  }

  private async json(path: string, body?: unknown): Promise<TriggerResponse> {
    const response = await this.request(`${this.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        let body: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(await response.text());
          body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
        } catch { /* no readable body: status only */ }
        throw new CoreRejectedError(
          `core API HTTP ${response.status}`,
          response.status,
          typeof body?.errorCode === 'string' ? body.errorCode : undefined,
          typeof body?.error === 'string' ? body.error : undefined,
        );
      }
      throw new Error(`core API HTTP ${response.status}`);
    }
    return await response.json() as TriggerResponse;
  }

  async trigger(request: TriggerRequest): Promise<TriggerResponse> {
    await this.options.beforeTrigger?.();
    return this.json(NATIVE_GATEWAY_TRIGGER_PATH, request);
  }

  result(sessionId: string, triggerId: string): Promise<TriggerResponse> {
    return this.json(nativeGatewayTriggerResultPath(sessionId, triggerId));
  }

  async interrupt(sessionId: string, triggerId: string): Promise<void> {
    const response = await this.json(nativeGatewayInterruptPath(sessionId, triggerId), {});
    if (!response.ok) {
      throw new Error('停止任务失败');
    }
  }
}
