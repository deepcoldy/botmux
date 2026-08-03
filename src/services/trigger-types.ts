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
  /** Trusted presentation chosen by the connector owner. Undefined keeps the
   * localized default topic seed; null suppresses the seed entirely. */
  presentation?: {
    topicMessage?: string | null;
  };
  options?: {
    dryRun?: boolean;
    dedupKey?: string;
    status?: 'firing' | 'resolved' | string;
    waitForFinalOutput?: boolean;
    asyncReturnSessionId?: boolean;
    timeoutMs?: number;
    /** Connector-owner opt-in: drop the daemon-rendered final_output reply for
     * this loud trigger's turn. The streaming card / start notice still show;
     * only the trailing transcript-driven summary is suppressed. */
    suppressFinalOutput?: boolean;
    /** Per-turn CLI model override (e.g. a codex model id). Applies only to a
     *  freshly-spawned session; ignored when folding into an existing worker.
     *  Empty/omitted → the bot's configured default. */
    model?: string;
    /** Per-turn reasoning effort (codex `model_reasoning_effort`). Same
     *  fresh-spawn-only semantics as `model`. */
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
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
  | 'no_output'
  | 'workflow_trigger_not_implemented';

/** Four-state async lifecycle for `GET /api/sessions/:id/trigger-result`.
 *  Programmatic callers (task runners) branch on this instead of ok/action:
 *  - running:   turn still in flight — keep polling
 *  - completed: final output captured (see output.content)
 *  - failed:    session terminated without a captured output (soft terminal —
 *               may be a genuine failure OR a caller-initiated close/cancel)
 *  - not_found: no session record on disk (never existed / invalid id) */
export type AsyncTriggerState = 'running' | 'completed' | 'failed' | 'not_found';

export interface TriggerResponse {
  ok: boolean;
  triggerId?: string;
  action?: TriggerAction;
  /** Four-state async lifecycle. Present on trigger-result (async polling)
   *  responses; absent on synchronous turn/workflow dispatch responses. */
  state?: AsyncTriggerState;
  /** ISO8601 completion/termination time. Present on completed/failed states. */
  finishedAt?: string;
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
  /** Per-turn token usage for a completed async turn (codex-app). Present on
   *  `state:'completed'` when captured; omitted otherwise. Field names mirror the
   *  caller's TaskTokenUsage. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  async?: {
    status: TriggerAsyncStatus;
    sessionId?: string;
    completedAt?: string;
  };
  /** Read-only web-terminal URL for the live session's CLI pane, present only
   *  while a worker web server is up (typically `state:'running'` and at
   *  `'completed'` before the session closes). Lets an async caller (e.g. riff's
   *  in-sandbox task-runner) open a live view of the visible CLI TUI — form C.
   *  Carries the `?viewToken=` read capability inline; knowing it grants read
   *  only, never terminal input. Omitted when no live worker terminal exists. */
  readOnlyUrl?: string;
  /** The bare read capability behind `readOnlyUrl`'s `?viewToken=`, exposed
   *  separately for callers that build their own URL. Omitted with readOnlyUrl. */
  viewToken?: string;
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
  if (raw.presentation !== undefined) {
    if (!isRecord(raw.presentation)) {
      return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'presentation must be an object' } };
    }
    const topicMessage = raw.presentation.topicMessage;
    if (topicMessage !== undefined && topicMessage !== null && typeof topicMessage !== 'string') {
      return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'presentation.topicMessage must be a string or null' } };
    }
    if (typeof topicMessage === 'string' && (!topicMessage.trim() || Array.from(topicMessage.trim()).length > 200)) {
      return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'presentation.topicMessage must contain 1 to 200 characters' } };
    }
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
  if (options.suppressFinalOutput !== undefined && typeof options.suppressFinalOutput !== 'boolean') {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'options.suppressFinalOutput must be a boolean' } };
  }
  if (options.model !== undefined && (typeof options.model !== 'string' || options.model.length > 200)) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'options.model must be a string (<=200 chars)' } };
  }
  if (options.reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(options.reasoningEffort as string)) {
    return { ok: false, status: 400, body: { ok: false, errorCode: 'bad_request', error: 'options.reasoningEffort must be one of low|medium|high|xhigh' } };
  }
  return { ok: true, request: raw as unknown as TriggerRequest };
}
