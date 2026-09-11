import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OncallGroupTarget {
  /** BytedOncall OpenAPI endpoint, supplied by the deployment. */
  endpoint: string;
  tenantId: number;
  typeId: number;
  region: string;
  emailDomain: string;
}

export function loadOncallGroupTarget(dataDir: string, appId: string): OncallGroupTarget {
  let target: OncallGroupTarget;
  try { target = JSON.parse(readFileSync(join(dataDir, 'oncall-group-targets.json'), 'utf8'))[appId]; }
  catch { throw new Error('Oncall 建群服务尚未配置，请联系机器人管理员'); }
  if (!target || !Number.isSafeInteger(target.tenantId) || target.tenantId <= 0
    || !Number.isSafeInteger(target.typeId) || target.typeId <= 0
    || typeof target.region !== 'string' || !target.region.trim()
    || typeof target.emailDomain !== 'string' || !/^[a-z0-9.-]+$/i.test(target.emailDomain)) {
    throw new Error('Oncall 建群服务配置无效，请联系机器人管理员');
  }
  let url: URL;
  try { url = new URL(target.endpoint); } catch { throw new Error('Oncall 建群接口地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Oncall 建群接口必须使用 HTTPS');
  return target;
}

export function oncallUsername(email: string | undefined, target: OncallGroupTarget): string {
  const parts = email?.trim().split('@');
  if (!parts || parts.length !== 2 || parts[1].toLowerCase() !== target.emailDomain.toLowerCase()
    || !/^[a-zA-Z0-9._-]+$/.test(parts[0])) throw new Error('无法确认 Oncall 账号，请联系管理员检查通讯录邮箱权限');
  return parts[0];
}

export class OncallGroupApiError extends Error {
  constructor(readonly uncertain: boolean, status?: number) {
    super(status === 401 ? 'Oncall 服务账号凭据无效或已失效，请联系管理员更新 ONCALL_SERVICE_SECRET'
      : status === 403 ? 'Oncall 服务账号缺少接口或租户权限，请联系管理员授权'
        : uncertain ? '建群结果待确认，请联系管理员核对，勿重复创建' : '建群失败，请稍后重试或联系管理员');
  }
}

export async function createOncallGroup(target: OncallGroupTarget, secret: string, username: string, message: string,
  fetcher: typeof fetch = fetch): Promise<{ flowId: string; openChatId: string }> {
  let response: Response;
  try {
    response = await fetcher(target.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}`, 'x-api-user': username },
      body: JSON.stringify({ tenant_id: target.tenantId, type_id: target.typeId, region: target.region,
        type: 'create_chat', priority: 'P2', source_type: 'open_api', source_location: 'botmux', trigger_message: message }),
    });
  } catch { throw new OncallGroupApiError(true); }
  if (!response.ok) throw new OncallGroupApiError(![400, 401, 403, 404, 422, 429].includes(response.status), response.status);
  let body: any;
  try { body = await response.json(); } catch { throw new OncallGroupApiError(true); }
  if (body?.code !== 0 || !/^oc_[a-zA-Z0-9]+$/.test(body?.data?.open_chat_id ?? '')
    || !body?.data?.oncall_flow_id) throw new OncallGroupApiError(true);
  return { flowId: String(body.data.oncall_flow_id), openChatId: body.data.open_chat_id };
}
