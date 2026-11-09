/**
 * Dashboard 工作流编排页面的接口调用（design 2026-11-03
 * workflow-dashboard-orchestration D3）。写接口一律 POST 且带 JSON 对象请求体
 * （至少 `{}`）：平台会把没有请求体的请求走直连路径，那里认不出人（D1）。
 */
import type { WorkflowDraftProjectOptions, WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { WorkflowDraftInitiator, WorkflowDraftSummary } from '../../workflows/v3/draft-store.js';
import type { WorkflowOrchestratorBotOption } from '../workflow-drafts-api.js';
import { readWorkflowSwitches, type WorkflowSwitches } from './workflow-draft-model.js';

export type DraftFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type DraftApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; message?: string; retryable: boolean; body: Record<string, unknown> };

const DRAFTS = '/api/v3/orchestration/drafts';

async function call<T>(fetcher: DraftFetch, path: string, init?: RequestInit): Promise<DraftApiResult<T>> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch {
    return { ok: false, status: 0, error: 'network_error', retryable: true, body: {} };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // The auth wall may answer HTML: keep the status only.
  }
  if (!response.ok || body.ok === false) {
    // A spec that did not validate answers 200 with `ok: false` and the
    // problems (plus the refreshed draft) — a result, not a transport error.
    const specInvalid = response.ok && Array.isArray(body.problems);
    return {
      error: specInvalid ? 'spec_invalid' : typeof body.error === 'string' ? body.error : `http_${response.status}`,
      ok: false,
      status: response.status,
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      retryable: body.retryable === true,
      body,
    };
  }
  return { ...(body as T), ok: true };
}

function post<T>(fetcher: DraftFetch, path: string, body: Record<string, unknown>): Promise<DraftApiResult<T>> {
  return call<T>(fetcher, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const draftPath = (runId: string, tail = '') => `${DRAFTS}/${encodeURIComponent(runId)}${tail}`;

export async function fetchWorkflowSwitches(fetcher: DraftFetch = fetch): Promise<WorkflowSwitches | null> {
  try {
    const response = await fetcher('/api/settings');
    if (!response.ok) return null;
    return readWorkflowSwitches(await response.json());
  } catch {
    return null;
  }
}

export function fetchOrchestratorBots(fetcher: DraftFetch = fetch) {
  return call<{ bots: WorkflowOrchestratorBotOption[] }>(fetcher, '/api/v3/orchestration/bots');
}

/** 当前登录在这个编排 Bot 视角下的发起人（不创建任何东西）。 */
export function fetchInitiator(larkAppId: string, fetcher: DraftFetch = fetch) {
  return post<{ initiator: WorkflowDraftInitiator }>(fetcher, '/api/v3/orchestration/initiator', { larkAppId });
}

export function fetchDrafts(fetcher: DraftFetch = fetch) {
  return call<{ drafts: WorkflowDraftSummary[] }>(fetcher, DRAFTS);
}

export function fetchDraft(runId: string, fetcher: DraftFetch = fetch) {
  return call<{ draft: WorkflowDraftView }>(fetcher, draftPath(runId));
}

/** No `project` = the bot's default dir (the daemon refuses it when the bot has none). */
export function createDraft(input: { larkAppId: string; goal: string; project?: string }, fetcher: DraftFetch = fetch) {
  return post<{ draft: WorkflowDraftView }>(fetcher, DRAFTS, input);
}

/**
 * 「项目」 of a new draft of this bot: its default dir, or the repo picker's
 * candidates to choose from. `{ runId }` = the bot that copying this run
 * defaults to.
 */
export function fetchProjectOptions(target: { larkAppId: string } | { runId: string }, fetcher: DraftFetch = fetch) {
  const query = 'larkAppId' in target
    ? `larkAppId=${encodeURIComponent(target.larkAppId)}`
    : `runId=${encodeURIComponent(target.runId)}`;
  return call<{ project: WorkflowDraftProjectOptions }>(fetcher, `/api/v3/orchestration/projects?${query}`);
}

/** 复制为新工作流（D6）的来源：一个运行，或模板的某个版本。 */
export type CopySource = { kind: 'run'; runId: string } | { kind: 'template'; workflowId: string; revisionId: string };

/** Path and body of 「复制为新工作流」. No `larkAppId` = the source's orchestrating bot. */
export function copyRequest(source: CopySource, larkAppId?: string, project?: string): { path: string; body: Record<string, unknown> } {
  return { path: `${DRAFTS}/from-source`, body: { source, ...(larkAppId ? { larkAppId } : {}), ...(project ? { project } : {}) } };
}

export function copyAsNewWorkflow(source: CopySource, larkAppId?: string, project?: string, fetcher: DraftFetch = fetch) {
  const request = copyRequest(source, larkAppId, project);
  return post<{ draft: WorkflowDraftView }>(fetcher, request.path, request.body);
}

type DraftAction =
  | { kind: 'message'; text: string }
  /** `project`: the one picked for a draft that has none (and a bot without a default dir). */
  | { kind: 'continue'; project?: string }
  | { kind: 'spec'; specMarkdown?: string; relayProblems?: boolean }
  | { kind: 'approve-spec' }
  | { kind: 'architect'; note?: string }
  | { kind: 'architect-cancel' }
  | { kind: 'node-bot'; nodeId: string; larkAppId: string }
  | { kind: 'approve-flow'; flowSummarySha256: string }
  | { kind: 'revise-spec' }
  | { kind: 'abandon' }
  | { kind: 'delete' }
  /** D4 拉群开始：群名（不带标记，daemon 补）和额外成员（邮箱 / union_id）。 */
  | { kind: 'launch'; groupName?: string; extraMembers?: string[] }
  | { kind: 'launch-continue' }
  | { kind: 'launch-abandon' }
  /** 人工确认群里没有这张卡 / 这条摘要后重发（新 uuid）。 */
  | { kind: 'launch-resend-root' }
  | { kind: 'launch-resend-summary' }
  /** D6：复制出来的草稿改目标、改节点文字。 */
  | { kind: 'copy-goal'; goal: string; mode: 'text_only' | 'rearchitect' | 'reclarify' }
  | { kind: 'node-text'; nodeId: string; goal?: string; completion?: string }
  /** 换编排 Bot（Dashboard 依次问新 Bot、让现编排 Bot 交出、新 Bot 接管）；中途断了再发一次接着做。 */
  | { kind: 'orchestrator'; larkAppId: string }
  /** 取消进行中的更换（草稿留在现编排 Bot）。 */
  | { kind: 'handoff-cancel' };

/** Path and body of one draft write. `baseVersion` pins the version the page showed. */
export function draftActionRequest(runId: string, action: DraftAction, baseVersion?: number): { path: string; body: Record<string, unknown> } {
  const base = baseVersion !== undefined ? { baseVersion } : {};
  switch (action.kind) {
    case 'message': return { path: draftPath(runId, '/messages'), body: { text: action.text, ...base } };
    case 'continue': return { path: draftPath(runId, '/clarify/continue'), body: { ...(action.project ? { project: action.project } : {}), ...base } };
    case 'spec': return {
      path: draftPath(runId, '/spec'),
      body: {
        ...(action.specMarkdown !== undefined ? { specMarkdown: action.specMarkdown } : {}),
        ...(action.relayProblems ? { relayProblems: true } : {}),
        ...base,
      },
    };
    case 'approve-spec': return { path: draftPath(runId, '/approve-spec'), body: { ...base } };
    case 'architect': return { path: draftPath(runId, '/architect'), body: { ...(action.note ? { note: action.note } : {}), ...base } };
    // Cancel / abandon / delete act on whatever the draft is now.
    case 'architect-cancel': return { path: draftPath(runId, '/architect/cancel'), body: {} };
    case 'node-bot': return {
      path: draftPath(runId, `/nodes/${encodeURIComponent(action.nodeId)}/bot`),
      body: { larkAppId: action.larkAppId, ...base },
    };
    case 'approve-flow': return { path: draftPath(runId, '/approve-flow'), body: { flowSummarySha256: action.flowSummarySha256, ...base } };
    case 'revise-spec': return { path: draftPath(runId, '/revise-spec'), body: { ...base } };
    case 'abandon': return { path: draftPath(runId, '/abandon'), body: {} };
    case 'delete': return { path: draftPath(runId, '/delete'), body: {} };
    case 'launch': return {
      path: draftPath(runId, '/launch'),
      body: {
        ...(action.groupName ? { groupName: action.groupName } : {}),
        ...(action.extraMembers?.length ? { extraMembers: action.extraMembers } : {}),
        ...base,
      },
    };
    case 'launch-continue': return { path: draftPath(runId, '/launch/continue'), body: { ...base } };
    // Abandon acts on whatever the launch is now (the daemon refuses a running one).
    case 'launch-abandon': return { path: draftPath(runId, '/launch/abandon'), body: {} };
    case 'launch-resend-root': return { path: draftPath(runId, '/launch/resend-root'), body: { confirmedAbsent: true, ...base } };
    case 'launch-resend-summary': return { path: draftPath(runId, '/launch/resend-summary'), body: { confirmedAbsent: true } };
    case 'copy-goal': return { path: draftPath(runId, '/copy/goal'), body: { goal: action.goal, mode: action.mode, ...base } };
    case 'node-text': return {
      path: draftPath(runId, `/nodes/${encodeURIComponent(action.nodeId)}/text`),
      body: {
        ...(action.goal !== undefined ? { goal: action.goal } : {}),
        ...(action.completion !== undefined ? { completion: action.completion } : {}),
        ...base,
      },
    };
    case 'orchestrator': return { path: draftPath(runId, '/orchestrator'), body: { larkAppId: action.larkAppId, ...base } };
    case 'handoff-cancel': return { path: draftPath(runId, '/handoff/cancel'), body: {} };
  }
}

export function postDraftAction(runId: string, action: DraftAction, baseVersion?: number, fetcher: DraftFetch = fetch) {
  const request = draftActionRequest(runId, action, baseVersion);
  return post<{ draft?: WorkflowDraftView; problems?: string[]; deleted?: string }>(fetcher, request.path, request.body);
}

export type { DraftAction };
