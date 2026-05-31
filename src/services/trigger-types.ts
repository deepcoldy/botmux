export type TriggerSourceType = 'webhook' | 'ui' | 'workflow' | 'schedule';
export type TriggerTargetKind = 'turn' | 'workflow';
export type TriggerAction = 'queued' | 'delivered' | 'dry_run' | 'ignored';

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
  options?: {
    dryRun?: boolean;
    dedupKey?: string;
    status?: 'firing' | 'resolved' | string;
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
  | 'group_create_failed'
  | 'lifecycle_extract_failed'
  | 'rate_limited'
  | 'replay'
  | 'session_not_found'
  | 'target_required'
  | 'trigger_failed'
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
  promptPreview?: string;
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
  if (target.kind === 'turn' && typeof target.chatId !== 'string' && typeof target.sessionId !== 'string') {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'turn target requires chatId or sessionId' } };
  }
  if (target.kind === 'workflow' && typeof target.workflowId !== 'string') {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'target_required', error: 'workflow target requires workflowId' } };
  }
  if (typeof envelope.sourceName !== 'string' || envelope.trusted !== false) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'envelope.sourceName is required and envelope.trusted must be false' } };
  }
  return { ok: true, request: raw as unknown as TriggerRequest };
}
