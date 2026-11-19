import { oncallCreationSource, type OncallGroupCreation, type OncallGroupTarget } from './oncall-group-client.js';
import { larkHosts, type Brand } from '../im/lark/lark-hosts.js';

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
export interface OncallNativeSelection { region: string; typeId: number; priority: 'P2' | 'P1' | 'P0'; formId?: string }
export type OncallSelection = OncallCategory & { requiresNativeForm: boolean };

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

/** Validate the current route before deciding whether the card or the platform
 * should collect the form. Custom fields are handled by the native form. */
export async function validateOncallSelection(target: OncallGroupTarget, secret: string, username: string,
  region: string, typeId: number, fetcher: typeof fetch = fetch): Promise<OncallSelection> {
  const choices = await readOncallChoices(target, secret, username, fetcher);
  const category = choices.regions[region]?.find(item => item.id === typeId);
  if (!category || category.type_action !== 'create_chat') throw new Error('请选择可创建工单的有效分类');
  return { ...category, requiresNativeForm: await requiresNativeOncallForm(target, secret, category, fetcher, username) };
}

/** Workflow metadata is reusable when the authorized choices were just loaded. */
export async function requiresNativeOncallForm(target: OncallGroupTarget, secret: string, category: OncallCategory,
  fetcher: typeof fetch = fetch, username = ''): Promise<boolean> {
  if (category.tenant_id !== target.tenantId || category.type_action !== 'create_chat') throw new Error('请选择可创建工单的有效分类');
  // This is the explicit human-handoff path: recommended document search and
  // self-diagnosis stages do not add a second prerequisite after confirmation.
  if (!category.workflow_id) return true;
  const data = await get(target, secret, username, `workflow/${category.workflow_id}`, {}, fetcher);
  if (data.tenant_id !== target.tenantId || data.type_id !== category.id) throw new Error('表单与当前分类不匹配，请重选');
  let fields: unknown;
  try { fields = typeof data.config === 'string' ? JSON.parse(data.config) : data.config; }
  catch { throw new Error('平台表单配置无效'); }
  if (!Array.isArray(fields)) throw new Error('平台表单配置无效');
  return fields.length > 0;
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
  // The platform persists only the first 200 characters of source_location.
  // Put the form identity first, before description/context can consume it.
  if (selection?.formId) {
    const params = new URLSearchParams({ bm_form: selection.formId });
    for (const [key, value] of page.searchParams) if (key !== 'bm_form') params.append(key, value);
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
}
export interface NativeOncallResult { flowId: string; openChatId: string; createdAtMs: number }
export interface NativeOncallResultCandidate<T extends NativeOncallResultQuery = NativeOncallResultQuery> {
  attempt: T;
  result: NativeOncallResult;
}

function nativeSourceMatcher(sourceLocation: string) {
  const source = new URL(sourceLocation);
  const formId = source.searchParams.get('bm_form');
  return {
    formId,
    matches(value: unknown): boolean {
      if (!formId) return value === sourceLocation;
      try {
        const actual = new URL(String(value));
        return actual.origin === source.origin && actual.pathname === source.pathname
          && actual.searchParams.getAll('bm_form').length === 1 && actual.searchParams.get('bm_form') === formId;
      } catch { return false; }
    },
  };
}

/** Match every published selection in one complete scan. Multiple distinct
 * orders remain ambiguous; one order may match several equivalent attempts. */
export async function readNativeOncallResultCandidates<T extends NativeOncallResultQuery>(
  target: OncallGroupTarget, secret: string, expected: T | readonly T[],
  fetcher: typeof fetch = fetch): Promise<NativeOncallResultCandidate<T>[]> {
  const queries: readonly T[] = Array.isArray(expected) ? expected : [expected as T];
  if (!queries.length) return [];
  if (!secret || queries.some(item => !item.username || !item.sourceLocation)) throw new Error('Oncall 提单结果查询配置不完整');
  const username = queries[0]!.username;
  if (queries.some(item => item.username !== username)) throw new Error('同一表单的提单人不一致');
  const sources = queries.map(item => nativeSourceMatcher(item.sourceLocation));
  const formId = sources[0]!.formId;
  if (sources.some(item => item.formId !== formId) || (!formId && queries.length !== 1)) {
    throw new Error('同一批原生提单缺少统一关联标识');
  }
  // Lark/platform may normalize channel parameters. Match the opaque form ID
  // inside source_location, rather than requiring an identical query string.
  // Legacy unmarked forms retain exact-source matching for verified migration.
  const found = new Map<number, { row: any; attempts: T[] }>();
  const fallbackPreparedAtMs = Date.now() - 24 * 60 * 60_000;
  const preparedAtMs = Math.min(...queries.map(item => item.preparedAtMs ?? fallbackPreparedAtMs));
  const since = new Date(preparedAtMs + 8 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error('Oncall 查询结果过多，请管理员核对');
    let response: Response;
    try {
      response = await fetcher(endpoint(target, 'oncall_flow/list').href, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filter_fields: [
          { field: 'tenant_id', value: [target.tenantId], operator: 'in' },
          ...(formId ? [{ field: 'create_time', value: since, operator: 'greater_or_equals' }]
            : [{ field: 'source_location', value: [queries[0]!.sourceLocation], operator: 'in' }]),
          { field: 'originator_user', value: username, operator: 'equals' },
          { field: 'stage', value: ['launch_oncall'], operator: 'in' },
        ], current_page: page, page_size: formId ? 100 : 2, sort: { field: 'create_time', operator: 'asc' } }),
      });
    } catch { throw new Error('Oncall 提单结果暂不可读取'); }
    if (!response.ok) throw new Error('Oncall 服务账号缺少工单查询权限或连接失败');
    const body = await response.json();
    if (body?.code !== 0 || !Array.isArray(body.data)) throw new Error('Oncall 提单结果格式无效');
    for (const row of body.data) {
      const sourceAttempts = queries.filter((_, index) => sources[index]!.matches(row?.source_location));
      if (!sourceAttempts.length) continue;
      if (row.tenant_id !== target.tenantId || row.originator_user !== username || row.stage !== 'launch_oncall'
        || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Oncall 提单结果与原表单不匹配');
      const attempts = sourceAttempts.filter(item => row.oncall_question_type_id === item.typeId && row.region === item.region);
      const previous = found.get(row.id);
      found.set(row.id, { row, attempts: [...(previous?.attempts ?? []), ...attempts]
        .filter((item, index, all) => all.indexOf(item) === index) });
      if (found.size > 1) throw new Error('同一表单存在多个工单，请管理员核对');
    }
    if (!formId || body.data.length < 100) break;
  }
  if (!found.size) return [];
  const { row, attempts } = [...found.values()][0]!;
  if (!attempts.length) return [];
  const timestamp = String(row.create_time ?? '');
  // This platform's unqualified timestamps are China Standard Time, in both
  // T- and space-separated forms. Qualify them explicitly: an unqualified
  // string passed to Date.parse is interpreted in the daemon's local timezone,
  // which silently shifts the result on a host outside UTC+8.
  const qualified = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?$/.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}+08:00` : timestamp;
  const createdAtMs = Date.parse(qualified);
  if (!Number.isFinite(createdAtMs)) throw new Error('Oncall 提单时间无效');
  if (!row.chat_id) return []; // The ticket may exist before its group is ready.
  const openChatId = await get(target, secret, '', 'platform/chat_id_to_open_chat_id', { chat_id: String(row.chat_id) }, fetcher);
  if (typeof openChatId !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(openChatId)) throw new Error('Oncall 人工群标识无效');
  const result = { flowId: String(row.id), openChatId, createdAtMs };
  return attempts.map(attempt => ({ attempt, result }));
}

/** Exact source and actor matching; an ambiguous result is never guessed. */
export async function readNativeOncallResult(target: OncallGroupTarget, secret: string,
  expected: NativeOncallResultQuery, fetcher: typeof fetch = fetch): Promise<NativeOncallResult | undefined> {
  const matches = await readNativeOncallResultCandidates(target, secret, expected, fetcher);
  return matches[0]?.result;
}
