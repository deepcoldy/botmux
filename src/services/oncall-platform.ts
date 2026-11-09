import type { OncallGroupTarget } from './oncall-group-client.js';
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

/** Fail closed on schemas that have not been mapped: silently dropping custom
 * fields or bypassing a configured diagnostic step would create the wrong ticket. */
export async function validateOncallSelection(target: OncallGroupTarget, secret: string, username: string,
  region: string, typeId: number, fetcher: typeof fetch = fetch): Promise<OncallCategory> {
  const choices = await readOncallChoices(target, secret, username, fetcher);
  const category = choices.regions[region]?.find(item => item.id === typeId);
  if (!category || category.type_action !== 'create_chat') throw new Error('请选择可创建工单的有效分类');
  // This is the explicit human-handoff path: recommended document search and
  // self-diagnosis stages do not add a second prerequisite after confirmation.
  if (!category.workflow_id) throw new Error('此分类未返回表单配置，请使用原生侧栏');
  const data = await get(target, secret, username, `workflow/${category.workflow_id}`, {}, fetcher);
  if (data.tenant_id !== target.tenantId || data.type_id !== typeId) throw new Error('表单与当前分类不匹配，请重选');
  let fields: unknown;
  try { fields = typeof data.config === 'string' ? JSON.parse(data.config) : data.config; }
  catch { throw new Error('平台表单配置无效'); }
  if (!Array.isArray(fields) || fields.length) throw new Error('此分类包含尚未映射的自定义表单，请使用原生侧栏');
  return category;
}

export async function createNativeOncallLink(target: OncallGroupTarget, secret: string, username: string,
  description: string, brand: Brand = 'feishu', fetcher: typeof fetch = fetch): Promise<string> {
  const data = await get(target, secret, username, 'tools/lark_dialog_url',
    { tenant_id: String(target.tenantId), source_type: 'botmux' }, fetcher);
  let link: URL;
  let page: URL;
  try { link = new URL(data.lark_dialog_url); page = new URL(link.searchParams.get('url') ?? ''); }
  catch { throw new Error('Oncall 平台未返回有效飞书入口'); }
  if (link.protocol !== 'https:' || link.hostname !== larkHosts(brand).applink || link.pathname !== '/client/web_url/open'
    || page.protocol !== 'https:' || page.username || page.password || link.username || link.password
    || page.searchParams.get('tenant') !== String(target.tenantId)) throw new Error('Oncall 原生入口与租户不匹配');
  page.searchParams.delete('type'); // classify: never force the legacy fixed category.
  page.searchParams.delete('region');
  page.searchParams.set('step', 'launch-oncall');
  // The link rides in late card chrome (2000-byte reserve); a CJK character costs ~15 bytes after two URL encodings.
  const chars = [...description];
  const trigger = chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : description;
  page.searchParams.set('context', JSON.stringify({ trigger_message: trigger }));
  link.searchParams.set('mode', 'sidebar-semi');
  link.searchParams.set('width', '430');
  link.searchParams.set('url', page.href);
  return link.href;
}
