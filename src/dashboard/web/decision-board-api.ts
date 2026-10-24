// 决策看板页面的请求封装：只和 Dashboard 的 /api/decision-board/* 说话（同源、cookie 鉴权），
// 由 Dashboard 转给管家 bot 的 daemon。失败统一抛 BoardRequestError，message 已是给人看的话。
import { t, ui } from './ui.js';
import { controlCsrfHeaders } from './control-csrf.js';
import {
  boardErrorText,
  boardsFromResponse,
  type BoardBatch,
  type BoardDecision,
  type BoardDetailResponse,
  type BoardDraft,
  type BoardFile,
  type BoardListResponse,
  type BoardSummary,
  type BoardView,
  type DraftInput,
} from './decision-board-model.js';

export class BoardRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  /** 服务端给了明确答复（JSON 里 ok:false）。false = 网络错误或网关错误，结果未知。 */
  readonly answered: boolean;
  constructor(message: string, status: number, code: string | undefined, answered: boolean) {
    super(message);
    this.name = 'BoardRequestError';
    this.status = status;
    this.code = code;
    this.answered = answered;
  }
}

const BASE = '/api/decision-board';

function appPath(appId: string): string {
  return `${BASE}/${encodeURIComponent(appId)}`;
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', ...init });
  } catch (error) {
    throw new BoardRequestError(t('decisionBoard.errGeneric', { error: error instanceof Error ? error.message : String(error) }), 0, undefined, false);
  }
  const body = await response.json().catch(() => undefined) as { ok?: boolean; error?: unknown } | undefined;
  if (!response.ok || !body || body.ok === false) {
    const code = typeof body?.error === 'string' ? body.error : undefined;
    throw new BoardRequestError(boardErrorText(body, response.status, t, ui.locale), response.status, code, !!body && body.ok === false);
  }
  return body as T;
}

// 写请求顺带捎上控制类 CSRF 票据（有就带）：看板接口目前不强制，带上不影响。
function jsonInit(method: string, body: unknown, extra: RequestInit = {}): RequestInit {
  return { method, headers: { 'content-type': 'application/json', ...controlCsrfHeaders() }, body: JSON.stringify(body), ...extra };
}

export function boardFileUrl(appId: string, fileId: string): string {
  return `${appPath(appId)}/files/${encodeURIComponent(fileId)}`;
}

export async function fetchBoards(): Promise<BoardSummary[]> {
  return boardsFromResponse(await call<unknown>(`${BASE}/boards`));
}

export function fetchBoardItems(appId: string, view: BoardView, q?: string): Promise<BoardListResponse> {
  const qs = new URLSearchParams({ view });
  if (q?.trim()) qs.set('q', q.trim());
  return call<BoardListResponse>(`${appPath(appId)}/items?${qs.toString()}`);
}

export function fetchBoardItem(appId: string, seq: number): Promise<BoardDetailResponse> {
  return call<BoardDetailResponse>(`${appPath(appId)}/items/${seq}`);
}

export async function markBoardItemSeen(appId: string, seq: number): Promise<void> {
  await call(`${appPath(appId)}/items/${seq}/seen`, { method: 'POST', headers: controlCsrfHeaders() });
}

/**
 * 存草稿；空草稿等于删除（回 draft:null）。`keepalive` 用于离开页面时的最后一次保存
 * （浏览器在页面卸载后仍把请求发完）。
 */
export async function saveBoardDraft(appId: string, seq: number, draft: DraftInput, baseRev: number, opts: { keepalive?: boolean } = {}): Promise<BoardDraft | null> {
  const body = await call<{ draft: BoardDraft | null }>(`${appPath(appId)}/items/${seq}/draft`, jsonInit('PUT', {
    ...(draft.choice ? { choice: draft.choice } : {}),
    text: draft.text,
    fileIds: draft.fileIds,
    baseRev,
  }, opts.keepalive ? { keepalive: true } : {}));
  return body.draft ?? null;
}

export async function uploadBoardImage(appId: string, image: { name: string; mimeType: string; dataBase64: string }): Promise<BoardFile> {
  const body = await call<{ file: BoardFile }>(`${appPath(appId)}/files`, jsonInit('POST', { image }));
  return body.file;
}

export interface SubmitResult {
  batch: BoardBatch;
  decisions: BoardDecision[];
  duplicate: boolean;
}

export function submitBoardDecisions(appId: string, nonce: string, items: Array<{ seq: number; draftUpdatedAt: number }>): Promise<SubmitResult> {
  return call<SubmitResult>(`${appPath(appId)}/submit`, jsonInit('POST', { nonce, items }));
}

export async function redeliverBoardBatch(appId: string, batchId: number): Promise<BoardBatch> {
  const body = await call<{ batch: BoardBatch }>(`${appPath(appId)}/batches/${batchId}/redeliver`, { method: 'POST', headers: controlCsrfHeaders() });
  return body.batch;
}

export function fetchStewardGuide(appId: string): Promise<{ effective: string; preset: string }> {
  return call<{ effective: string; preset: string }>(`${appPath(appId)}/guide`);
}
