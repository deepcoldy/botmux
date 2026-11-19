/**
 * Dashboard 工作流模板页面的接口调用（design 2026-11-03
 * workflow-dashboard-orchestration §5，D5）。读：列表、详情（Dashboard 读盘）；
 * 写：从运行 / 草稿存模板、运行模板，一律 POST 且带 JSON 对象请求体。
 */
import type { SavedWorkflowCatalogEntry, SavedWorkflowDetailView } from '../../workflows/v3/library-catalog.js';
import type { WorkflowDraftTemplateSavePreview, WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { SavedWorkflowBotChange } from '../../workflows/v3/library-schema.js';
import type { SavedWorkflowParamEdit } from '../../workflows/v3/library-params.js';
import type { DraftApiResult, DraftFetch } from './workflow-draft-api.js';

const LIBRARY = '/api/v3/orchestration/library';
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
  } catch { /* the auth wall may answer HTML */ }
  if (!response.ok || body.ok === false) {
    return {
      ok: false,
      status: response.status,
      error: typeof body.error === 'string' ? body.error : `http_${response.status}`,
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      retryable: body.retryable === true,
      body,
    };
  }
  return { ...(body as T), ok: true };
}

function post<T>(fetcher: DraftFetch, path: string, body: Record<string, unknown>) {
  return call<T>(fetcher, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export function fetchTemplates(fetcher: DraftFetch = fetch) {
  return call<{ templates: SavedWorkflowCatalogEntry[]; unreadable: number }>(fetcher, LIBRARY);
}

export function fetchTemplate(workflowId: string, fetcher: DraftFetch = fetch) {
  return call<{ template: SavedWorkflowDetailView }>(fetcher, `${LIBRARY}/${encodeURIComponent(workflowId)}`);
}

/** 保存确认框要显示的东西（运行来源多出改派差异与运行结果）。 */
export type TemplateSavePreview = WorkflowDraftTemplateSavePreview & {
  botChanges?: SavedWorkflowBotChange[];
  runtimeRevisions?: number;
  sourceStatus?: 'succeeded' | 'failed' | 'blocked';
  publish?: boolean;
};

/** 存模板的来源：已结束的运行，或通过第二道确认的草稿。 */
export type TemplateSaveSource = { kind: 'run'; runId: string } | { kind: 'draft'; runId: string };

function sourcePath(source: TemplateSaveSource, tail: 'preview' | 'save'): string {
  const id = encodeURIComponent(source.runId);
  return source.kind === 'run'
    ? `${LIBRARY}/runs/${id}/save${tail === 'preview' ? '/preview' : ''}`
    : `${DRAFTS}/${id}/template/${tail}`;
}

export interface TemplateSaveInput {
  /** 追加到自己的这个模板；不填 = 新模板。 */
  workflowId?: string;
  expectedLatestRevision?: string;
  displayName?: string;
  paramEdits?: SavedWorkflowParamEdit[];
  requestKey?: string;
  flowSummarySha256?: string;
  allowDraft?: boolean;
  acknowledgeUnsafeLiterals?: boolean;
}

/** One request body for a preview / save (only the fields the source takes). */
export function templateSaveRequest(source: TemplateSaveSource, tail: 'preview' | 'save', input: TemplateSaveInput): { path: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {};
  if (input.workflowId) body.workflowId = input.workflowId;
  if (input.paramEdits?.length) body.paramEdits = input.paramEdits;
  if (source.kind === 'run' && input.allowDraft) body.allowDraft = true;
  if (tail === 'save') {
    if (input.workflowId && input.expectedLatestRevision) body.expectedLatestRevision = input.expectedLatestRevision;
    if (!input.workflowId && input.displayName) body.displayName = input.displayName;
    // New template and append alike: a retried request finds what it wrote.
    if (input.requestKey) body.requestKey = input.requestKey;
    if (source.kind === 'draft' && input.flowSummarySha256) body.flowSummarySha256 = input.flowSummarySha256;
    if (input.acknowledgeUnsafeLiterals) body.acknowledgeUnsafeLiterals = true;
  }
  return { path: sourcePath(source, tail), body };
}

export function previewTemplateSave(source: TemplateSaveSource, input: TemplateSaveInput, fetcher: DraftFetch = fetch) {
  const request = templateSaveRequest(source, 'preview', input);
  return post<{ preview: TemplateSavePreview }>(fetcher, request.path, request.body);
}

export function saveTemplate(source: TemplateSaveSource, input: TemplateSaveInput, fetcher: DraftFetch = fetch) {
  const request = templateSaveRequest(source, 'save', input);
  return post<{ saved: { workflowId: string; revisionId: string; humanVersion: number; created: boolean; published?: boolean } }>(fetcher, request.path, request.body);
}

/** 「运行」：按模板建一个草稿（参数在 daemon 上按 /workflow run 的规则转换）。 */
export function runTemplate(workflowId: string, input: { params: Record<string, string>; expectedRevisionId?: string; project?: string }, fetcher: DraftFetch = fetch) {
  return post<{ draft: WorkflowDraftView }>(fetcher, `${LIBRARY}/${encodeURIComponent(workflowId)}/run`, {
    params: input.params,
    ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}),
    ...(input.project ? { project: input.project } : {}),
  });
}
