export type TriggerSourceType = 'webhook' | 'ui' | 'workflow' | 'schedule' | 'vc_meeting';
export type TriggerTargetKind = 'turn' | 'workflow';
export type TriggerAction = 'queued' | 'delivered' | 'dry_run' | 'ignored' | 'completed';
export type TriggerAsyncStatus = 'pending' | 'completed';
export type LegacyWorkflowRetirementReason =
  | 'pending'
  | 'migrated'
  | 'changed_after_migration'
  | 'identity_conflict';

export interface TriggerRequest {
  source: {
    type: TriggerSourceType;
    connectorId?: string;
    requestId?: string;
    receivedAt?: string;
  };
  target: {
    kind: TriggerTargetKind;
    botId?: string;
    chatId?: string;
    sessionId?: string;
    rootMessageId?: string;
    workflowId?: string;
  };
  envelope: {
    format: string;
    sourceName: string;
    trusted: false;
    headers?: Record<string, unknown>;
    payload?: unknown;
    rawText?: string;
  };
  // Trusted task set by the connector owner ("what to do with the event"). Kept
  // OUTSIDE envelope so it is never serialized into the untrusted event JSON;
  // the prompt builder renders it as a trusted directive above the event data.
  instruction?: string;
  options?: {
    dryRun?: boolean;
    dedupKey?: string;
    status?: 'firing' | 'resolved' | string;
    waitForFinalOutput?: boolean;
    asyncReturnSessionId?: boolean;
    timeoutMs?: number;
  };
}

export type TriggerErrorCode =
  | 'bad_json'
  | 'bad_request'
  | 'bot_not_found'
  | 'bot_not_in_chat'
  | 'daemon_offline'
  | 'dry_run'
  | 'invalid_signature'
  | 'chat_not_allowed'
  | 'legacy_workflow_retired'
  | 'group_create_failed'
  | 'lifecycle_extract_failed'
  | 'rate_limited'
  | 'replay'
  | 'session_not_found'
  | 'target_required'
  | 'trigger_failed'
  | 'wait_timeout'
  | 'workflow_trigger_not_implemented';

export interface TriggerResponse {
  ok: boolean;
  triggerId?: string;
  action?: TriggerAction;
  target?: {
    kind: TriggerTargetKind;
    sessionId?: string;
    workflowRunId?: string;
    chatId?: string;
  };
  message?: string;
  errorCode?: TriggerErrorCode;
  error?: string;
  /** Structured recovery metadata when a v2 definition is no longer runnable. */
  reason?: LegacyWorkflowRetirementReason;
  targetWorkflowId?: string;
  targetRevisionId?: string;
  promptPreview?: string;
  output?: {
    content: string;
  };
  async?: {
    status: TriggerAsyncStatus;
    sessionId?: string;
    completedAt?: string;
  };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function validateTriggerRequest(raw: unknown): { ok: true; request: TriggerRequest } | { ok: false; status: number; body: TriggerResponse } {
  if (!isRecord(raw)) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'request body must be an object' } };
  }
  const source = raw.source;
  const target = raw.target;
  const envelope = raw.envelope;
  if (!isRecord(source) || !isRecord(target) || !isRecord(envelope)) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'source, target, and envelope are required objects' } };
  }
  if (target.kind !== 'turn' && target.kind !== 'workflow') {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'target.kind must be turn or workflow' } };
  }
  const options = isRecord(raw.options) ? raw.options : {};
  const waitForFinalOutput = options.waitForFinalOutput === true;
  const asyncReturnSessionId = options.asyncReturnSessionId === true;
  const hasChatId = typeof target.chatId === 'string' && target.chatId.trim().length > 0;
  const hasSessionId = typeof target.sessionId === 'string' && target.sessionId.trim().length > 0;
  const hasRootMessageId = typeof target.rootMessageId === 'string' && target.rootMessageId.trim().length > 0;
  if (target.rootMessageId !== undefined && !hasRootMessageId) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'target.rootMessageId must be a non-empty string' } };
  }
  if (hasRootMessageId && !hasChatId && !hasSessionId) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'turn target with rootMessageId requires chatId unless sessionId is specified' } };
  }
  if (target.kind === 'turn' && !waitForFinalOutput && !asyncReturnSessionId && !hasChatId && !hasSessionId && !hasRootMessageId) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'turn target requires chatId, sessionId, or rootMessageId' } };
  }
  if (target.kind === 'workflow' && typeof target.workflowId !== 'string') {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'workflow target requires workflowId' } };
  }
  if (typeof envelope.sourceName !== 'string' || envelope.trusted !== false) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'envelope.sourceName is required and envelope.trusted must be false' } };
  }
  if (waitForFinalOutput && target.kind !== 'turn') {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'waitForFinalOutput is only supported for turn targets' } };
  }
  if (waitForFinalOutput && asyncReturnSessionId) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'waitForFinalOutput and asyncReturnSessionId cannot be used together' } };
  }
  if (options.timeoutMs !== undefined) {
    if (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300_000) {
      return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'options.timeoutMs must be between 1000 and 300000' } };
    }
  }
  return { ok: true, request: raw as unknown as TriggerRequest };
}
