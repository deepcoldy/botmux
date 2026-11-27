import { createHash } from 'node:crypto';
import { oncallCreationSource, type OncallGroupCreation, type OncallGroupTarget } from './oncall-group-client.js';
import { larkHosts, type Brand } from '../im/lark/lark-hosts.js';
import { ensureSelectedOncallQuery, isNativeOncallSelectionMarker, nativeSelectionSourceType } from './oncall-sidebar-link.js';

export interface OncallCategory {
  id: number;
  name: string;
  tenant_id: number;
  category_id?: number | null;
  type_action: string;
  workflow_id?: number;
  question_type_stage_list?: string[];
}
export interface OncallChoices { regions: Record<string, OncallCategory[]> }
/** The choices API only returns routing keys. Use the display name from Oncall's region list. */
export function oncallRegionLabel(region: string): string {
  return region === 'cn_all' ? 'CN/所有区域' : region;
}
export interface OncallNativeSelection { region: string; typeId: number; priority: 'P2' | 'P1' | 'P0'; formId?: string }
export type OncallSelection = OncallCategory & { requiresNativeForm: boolean; workflow?: unknown[] };

/** Reconcile an uncertain create by its opaque attempt marker, never by question text. */
export async function readOncallGroupResult(creation: OncallGroupCreation, secret: string, attemptId: string,
  fetcher: typeof fetch = fetch): Promise<{ flowId: string; openChatId: string } | undefined> {
  const { target, username, region, typeId } = creation;
  if (!secret || !attemptId || !username) throw new Error('Oncall 提单结果查询配置不完整');
  const source = oncallCreationSource(attemptId);
  const response = await fetcher(endpoint(target, 'oncall_flow/list').href, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ filter_fields: [
      { field: 'tenant_id', value: [target.tenantId], operator: 'in' },
      { field: 'source_location', value: [source], operator: 'in' },
    ], current_page: 1, page_size: 2 }),
  });
  if (!response.ok) throw new Error('Oncall 提单结果查询失败');
  const body = await response.json();
  if (body?.code !== 0 || !Array.isArray(body.data)) throw new Error('Oncall 提单结果格式无效');
  if (!body.data.length) return;
  if (body.data.length !== 1) throw new Error('同一建群请求存在多个工单，请管理员核对');
  const row = body.data[0];
  if (row.source_location !== source || row.tenant_id !== target.tenantId || row.originator_user !== username
    || row.region !== region || row.oncall_question_type_id !== typeId || !Number.isSafeInteger(row.id) || row.id <= 0) {
    throw new Error('Oncall 提单结果与原请求不匹配');
  }
  if (!row.chat_id) return; // A ticket can exist before group creation finishes.
  const openChatId = await get(target, secret, '', 'platform/chat_id_to_open_chat_id', { chat_id: String(row.chat_id) }, fetcher);
  if (typeof openChatId !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(openChatId)) throw new Error('Oncall 人工群标识无效');
  return { flowId: String(row.id), openChatId };
}

/** Official tenant info endpoint, shared with `oncall-cli tenant get`. */
export async function readOncallBusinessName(target: OncallGroupTarget, secret: string,
  fetcher: typeof fetch = fetch): Promise<string> {
  const data = await get(target, secret, '', `tenant/${target.tenantId}/info`, {}, fetcher);
  if (data.id !== target.tenantId || typeof data.name !== 'string' || !data.name.trim()) {
    throw new Error('Oncall 业务线信息无效');
  }
  return data.name.trim();
}

function endpoint(target: OncallGroupTarget, path: string): URL {
  const base = new URL(target.endpoint);
  const marker = '/api/inf/v1/';
  const index = base.pathname.indexOf(marker);
  if (index < 0 || !base.pathname.endsWith('/chat/')) throw new Error('请配置官方 Oncall 建群网关地址');
  base.pathname = base.pathname.slice(0, index) + marker + path;
  return base;
}

async function get(target: OncallGroupTarget, secret: string, username: string, path: string,
  params: Record<string, string> = {}, fetcher: typeof fetch = fetch): Promise<any> {
  if (!secret) throw new Error('Oncall 服务凭据未配置');
  const url = endpoint(target, path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${secret}`, ...(username ? { 'x-api-user': username } : {}) } });
  } catch { throw new Error('Oncall 平台读取失败，请重试'); }
  if (!response.ok) throw new Error(response.status === 403 ? 'Oncall 服务账号缺少读取权限' : 'Oncall 平台读取失败，请检查连接');
  let body: any;
  try { body = await response.json(); } catch { throw new Error('Oncall 平台返回格式无效'); }
  if (body?.code !== 0 || !body.data) throw new Error('Oncall 平台未返回有效配置');
  return body.data;
}

export async function readOncallChoices(target: OncallGroupTarget, secret: string, username: string,
  fetcher: typeof fetch = fetch): Promise<OncallChoices> {
  const data = await get(target, secret, username, 'type/multi_region_type_with_user', { tenant_id: String(target.tenantId) }, fetcher);
  if (!data.region || typeof data.region !== 'object' || Array.isArray(data.region)) throw new Error('Oncall 区域配置无效');
  const regions: OncallChoices['regions'] = {};
  for (const [region, values] of Object.entries(data.region)) {
    if (!Array.isArray(values) || !values.every(item => Number.isSafeInteger(item?.id) && item.tenant_id === target.tenantId && typeof item.name === 'string')) {
      throw new Error('Oncall 分类配置无效');
    }
    regions[region] = values;
  }
  return { regions };
}

/** Validate the current route and load the current custom-field definition. */
export async function validateOncallSelection(target: OncallGroupTarget, secret: string, username: string,
  region: string, typeId: number, fetcher: typeof fetch = fetch): Promise<OncallSelection> {
  const choices = await readOncallChoices(target, secret, username, fetcher);
  const category = choices.regions[region]?.find(item => item.id === typeId);
  if (!category || category.type_action !== 'create_chat') throw new Error('请选择可创建工单的有效分类');
  const workflow = await readOncallWorkflow(target, secret, category, fetcher, username);
  return { ...category, workflow, requiresNativeForm: workflow === undefined || workflow.length > 0 };
}

/** Workflow metadata is reusable when the authorized choices were just loaded. */
export async function readOncallWorkflow(target: OncallGroupTarget, secret: string, category: OncallCategory,
  fetcher: typeof fetch = fetch, username = ''): Promise<unknown[] | undefined> {
  if (category.tenant_id !== target.tenantId || category.type_action !== 'create_chat') throw new Error('请选择可创建工单的有效分类');
  // This is the explicit human-handoff path: recommended document search and
  // self-diagnosis stages do not add a second prerequisite after confirmation.
  if (!category.workflow_id) return undefined;
  const data = await get(target, secret, username, `workflow/${category.workflow_id}`, {}, fetcher);
  if (data.tenant_id !== target.tenantId || data.type_id !== category.id) throw new Error('表单与当前分类不匹配，请重选');
  let fields: unknown;
  try { fields = typeof data.config === 'string' ? JSON.parse(data.config) : data.config; }
  catch { throw new Error('平台表单配置无效'); }
  if (!Array.isArray(fields)) throw new Error('平台表单配置无效');
  return fields;
}

export async function createNativeOncallLink(target: OncallGroupTarget, secret: string, username: string,
  description: string, brand: Brand = 'feishu', fetcher: typeof fetch = fetch,
  selection?: OncallNativeSelection): Promise<string> {
  const data = await get(target, secret, username, 'tools/lark_dialog_url',
    { tenant_id: String(target.tenantId), source_type: 'botmux' }, fetcher);
  let link: URL;
  let page: URL;
  try { link = new URL(data.lark_dialog_url); page = new URL(link.searchParams.get('url') ?? ''); }
  catch { throw new Error('Oncall 平台未返回有效飞书入口'); }
  if (link.protocol !== 'https:' || link.hostname !== larkHosts(brand).applink || link.pathname !== '/client/web_url/open'
    || page.protocol !== 'https:' || page.username || page.password || link.username || link.password
    || page.searchParams.get('tenant') !== String(target.tenantId)) throw new Error('Oncall 原生入口与租户不匹配');
  if (selection) {
    page.searchParams.set('type', String(selection.typeId));
    page.searchParams.set('region', selection.region);
    page.searchParams.set('level', selection.priority);
  } else {
    // A generic entry must not inherit a fixed category from the legacy target.
    page.searchParams.delete('type');
    page.searchParams.delete('region');
    page.searchParams.delete('level');
  }
  page.searchParams.set('directly', 'true');
  page.searchParams.delete('step');
  // The generic link rides in late card chrome (2000-byte reserve). The
  // question appears in both context and query, each encoded twice.
  const chars = [...description];
  // Selected forms use a separate classification card, outside late chrome's
  // small URL reserve, so preserve the full draft description there.
  const trigger = selection ? description : chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : description;
  page.searchParams.set('context', JSON.stringify({ trigger_message: trigger }));
  // query is the SDK's current question text (not search results). Keeping
  // this already-asked question lets the selected category proceed to its form
  // after tenant initialization resets the initial `directly` step.
  page.searchParams.set('query', trigger);
  if (selection) ensureSelectedOncallQuery(page);
  // The platform persists only the first 200 characters of source_location.
  // Put the form identity first, before description/context can consume it.
  if (selection?.formId) {
    const params = new URLSearchParams({ bm_form: selection.formId });
    const sourceType = nativeSelectionSourceType(selection.formId);
    if (sourceType) params.set('bizFrom', sourceType);
    for (const [key, value] of page.searchParams) {
      if (key !== 'bm_form' && !(sourceType && key === 'bizFrom')) params.append(key, value);
    }
    page.search = params.toString();
  }
  link.searchParams.set('mode', 'sidebar-semi');
  link.searchParams.set('width', '430');
  link.searchParams.set('url', page.href);
  return link.href;
}

export interface NativeOncallResultQuery {
  sourceLocation: string;
  username: string;
  typeId: number;
  region: string;
  preparedAtMs?: number;
  hostedSourceLocation?: string;
}
export interface NativeOncallResult { flowId: string; openChatId: string; handoffAtMs: number }
export interface NativeOncallResultCandidate<T extends NativeOncallResultQuery = NativeOncallResultQuery> {
  attempt: T;
  result: NativeOncallResult;
}

export interface NativeOncallScan {
  key: string;
  createdThrough: string;
  afterId: number;
  flowId?: number;
  /** A candidate is adoptable only after this fresh full-window check stays unique. */
  verifyFlowId?: number;
  /** Completed verification passes that still could not prove a stable one-page window. */
  verifyRounds?: number;
}
const MAX_NATIVE_ONCALL_VERIFICATION_ROUNDS = 2;
interface NativeOncallScanProgress {
  checkpoint?: NativeOncallScan;
  save: (checkpoint: NativeOncallScan | undefined) => void;
}

function platformTime(timeMs: number): string {
  return new Date(timeMs + 8 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

function nativeSourceMatcher(query: NativeOncallResultQuery) {
  const source = new URL(query.sourceLocation);
  const formId = source.searchParams.get('bm_form');
  const tag = nativeSelectionSourceType(formId);
  // A reused platform draft can retain the first topic's channel at handoff.
  // A channel can contradict the marked URL, but cannot establish ownership.
  const conflictingChannel = (value: unknown) =>
    typeof value === 'string' && /^botmux_[a-f0-9]{24}$/.test(value) && value !== tag;
  return {
    formId,
    matches(value: unknown, channel: unknown): boolean {
      if (conflictingChannel(channel)) return false;
      if (!formId) return value === query.sourceLocation;
      if (typeof value !== 'string') return false;
      let actual: URL;
      try { actual = new URL(value); } catch { return false; }
      return actual.origin === source.origin && actual.pathname === source.pathname
        && actual.searchParams.getAll('bm_form').length === 1 && actual.searchParams.get('bm_form') === formId
        && !actual.searchParams.getAll('bizFrom').some(conflictingChannel);
    },
  };
}

/** Match every published selection in one complete scan. Multiple distinct
 * orders for one draft remain ambiguous. */
export async function readNativeOncallResultCandidates<T extends NativeOncallResultQuery>(
  target: OncallGroupTarget, secret: string, expected: T | readonly T[],
  fetcher: typeof fetch = fetch, progress?: NativeOncallScanProgress): Promise<NativeOncallResultCandidate<T>[]> {
  const queries: readonly T[] = Array.isArray(expected) ? expected : [expected as T];
  if (!queries.length) return [];
  if (!secret || queries.some(item => !item.username || !item.sourceLocation)) throw new Error('Oncall 提单结果查询配置不完整');
  const username = queries[0]!.username;
  if (queries.some(item => item.username !== username)) throw new Error('同一表单的提单人不一致');
  const sources = queries.map(nativeSourceMatcher);
  if (!sources.every(item => item.formId) && queries.length !== 1) throw new Error('同一批原生提单缺少统一关联标识');
  const exactSources = queries.map((item, index) => item.hostedSourceLocation ?? (sources[index]!.formId ? undefined : item.sourceLocation));
  const key = createHash('sha256').update(JSON.stringify([target, queries])).digest('hex');
  const checkpoint = progress?.checkpoint?.key === key ? progress.checkpoint : undefined;
  const verifyFlowId = checkpoint?.verifyFlowId;
  const afterIdAtStart = checkpoint?.afterId ?? 0;
  const resumedVerification = verifyFlowId !== undefined && afterIdAtStart > 0;
  const verifyRounds = checkpoint?.verifyRounds ?? 0;
  // Verification always uses the normalized-source scan, even for hosted links.
  const exact = verifyFlowId === undefined && exactSources.every(source => source !== undefined);
  const since = platformTime(Math.min(...queries.map(item => item.preparedAtMs ?? Date.now() - 24 * 60 * 60_000)));
  // A fresh verification must include orders created since the candidate was found.
  // Once its paginated scan starts, the horizon stays fixed across checkpoints.
  const createdThrough = verifyFlowId !== undefined && afterIdAtStart === 0
    ? platformTime(Date.now()) : checkpoint?.createdThrough ?? platformTime(Date.now());
  let afterId = afterIdAtStart;
  let flowId = checkpoint?.flowId;
  let matched: { row: any; attempts: T[] } | undefined;
  let scannedMultiplePages = false;

  async function list(filters: Array<{ field: string; value: string | Array<string | number>; operator: string }>, pageSize: number) {
    let response: Response;
    try {
      response = await fetcher(endpoint(target, 'oncall_flow/list').href, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filter_fields: [
          { field: 'tenant_id', value: [target.tenantId], operator: 'in' },
          { field: 'originator_user', value: username, operator: 'equals' },
          { field: 'stage', value: ['launch_oncall'], operator: 'in' },
          ...filters,
        ], current_page: 1, page_size: pageSize, sort: { field: 'id', operator: 'asc' } }),
      });
    } catch { throw new Error('Oncall 提单结果暂不可读取'); }
    if (!response.ok) throw new Error('Oncall 服务账号缺少工单查询权限或连接失败');
    const body = await response.json();
    if (body?.code !== 0 || !Array.isArray(body.data)) throw new Error('Oncall 提单结果格式无效');
    return body.data;
  }

  function match(row: any, exactSource = false) {
    const matches = sources.map((source, index) => {
      const expectedSource = exactSources[index];
      return (!exactSource || !expectedSource || row?.source_location === expectedSource)
        && source.matches(row?.source_location, row?.source_type);
    });
    if (!matches.some(Boolean)) return;
    if (row.tenant_id !== target.tenantId || row.originator_user !== username || row.stage !== 'launch_oncall'
      || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Oncall 提单结果与原表单不匹配');
    if (flowId !== undefined && flowId !== row.id) {
      progress?.save(undefined);
      throw new Error('同一表单存在多个工单，请管理员核对');
    }
    flowId = row.id;
    // A selection-specific marker identifies the category at submission time.
    matched = { row, attempts: queries.filter((item, index) => matches[index] && row.region === item.region
      && (isNativeOncallSelectionMarker(sources[index]!.formId) || row.oncall_question_type_id === item.typeId)) };
  }

  if (exact) {
    // Re-check every row in case a gateway ignores the source filter. Only a
    // second distinct matching flow ID is ambiguous; unrelated rows are not.
    const rows = await list([{ field: 'source_location', value: [...new Set(exactSources)], operator: 'in' }], 2);
    for (const row of rows) match(row, true);
  }
  // A normalized hosted source may not satisfy exact equality. Fall back to
  // the bounded normalized-source scan instead of treating zero exact hits as absence.
  if (!exact || !matched) {
    const pageSize = 100;
    for (let page = 0; page < 10; page++) {
      if (page > 0) scannedMultiplePages = true;
      const rows = await list([
        { field: 'update_time', value: since, operator: 'greater_or_equals' },
        // An order that is updated while we scan must stay in the same window.
        { field: 'create_time', value: createdThrough, operator: 'less_or_equals' },
        ...(afterId ? [{ field: 'id', value: String(afterId + 1), operator: 'greater_or_equals' }] : []),
      ], pageSize);
      for (const row of rows) {
        if (!Number.isSafeInteger(row?.id) || row.id <= afterId) throw new Error('Oncall 工单分页未按 ID 推进');
        afterId = row.id;
        match(row);
      }
      if (rows.length < pageSize) break;
      if (page === 9) {
        if (!progress) throw new Error('Oncall 查询结果过多，请管理员核对');
        progress.save({ key, createdThrough, afterId, flowId, verifyFlowId,
          ...(verifyFlowId !== undefined ? { verifyRounds } : {}) });
        return [];
      }
    }
    if (!matched && flowId !== undefined) {
      // Persist only the ID. Re-read the matched row before adopting it.
      const rows = await list([{ field: 'id', value: [String(flowId)], operator: 'in' }], 2);
      if (rows.length === 1 && rows[0]?.id === flowId) match(rows[0]);
    }
  }
  // Chat creation is the handoff boundary even if duty is queued until later.
  const handoffTime = matched?.row.create_chat_time || matched?.row.oncall_start_time;
  if (!matched?.attempts.length || !matched.row.chat_id || !handoffTime) {
    if (progress?.checkpoint) progress.save(undefined);
    return [];
  }
  const { row, attempts } = matched;
  const timestamp = String(handoffTime);
  // This platform's unqualified timestamps are China Standard Time, in both
  // T- and space-separated forms. Qualify them explicitly: an unqualified
  // string passed to Date.parse is interpreted in the daemon's local timezone,
  // which silently shifts the result on a host outside UTC+8.
  const qualified = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}+08:00` : timestamp;
  const handoffAtMs = Date.parse(qualified);
  if (!Number.isFinite(handoffAtMs)) throw new Error('Oncall 发起人工时间无效');
  if (verifyFlowId !== undefined && row.id !== verifyFlowId) {
    progress?.save(undefined);
    throw new Error('原生提单复核结果已变化，请管理员核对');
  }
  if (progress && verifyFlowId !== undefined && (resumedVerification || scannedMultiplePages)) {
    // A paginated verification can reproduce the same late-lower-ID blind spot
    // it was meant to close. Only a fresh, single-page pass proves uniqueness.
    const nextRound = verifyRounds + 1;
    if (nextRound >= MAX_NATIVE_ONCALL_VERIFICATION_ROUNDS) {
      progress.save(undefined);
      throw new Error('原生提单复核窗口未稳定，请管理员核对');
    }
    progress.save({ key, createdThrough: platformTime(Date.now()), afterId: 0, verifyFlowId, verifyRounds: nextRound });
    return [];
  }
  const openChatId = await get(target, secret, '', 'platform/chat_id_to_open_chat_id', { chat_id: String(row.chat_id) }, fetcher);
  if (typeof openChatId !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(openChatId)) throw new Error('Oncall 人工群标识无效');
  const result = { flowId: String(row.id), openChatId, handoffAtMs };
  if (progress && verifyFlowId === undefined && (checkpoint !== undefined || exact || scannedMultiplePages)) {
    // A cursor that has already passed older IDs cannot see a late update there.
    // Re-scan from the beginning before adoption; exact-source hits also use
    // this pass when a gateway ignores its filter or normalizes the stored URL.
    progress.save({ key, createdThrough: platformTime(Date.now()), afterId: 0, verifyFlowId: row.id, verifyRounds: 0 });
    return [];
  }
  return attempts.map(attempt => ({ attempt, result }));
}
