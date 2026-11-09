import { mkdirSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { join } from 'node:path';
import { readOncallDeploymentEnv } from './oncall-deployment-config.js';

export interface OncallGroupBusinessTarget {
  tenantId: number;
  typeId?: number;
  region?: string;
}

export interface OncallGroupTarget extends OncallGroupBusinessTarget {
  /** BytedOncall OpenAPI endpoint, supplied by the deployment. */
  endpoint: string;
  emailDomain: string;
}

type StoredTarget = OncallGroupBusinessTarget & Partial<Pick<OncallGroupTarget, 'endpoint' | 'emailDomain'>>;

function readTargets(dataDir: string): Record<string, StoredTarget> {
  try {
    const targets = JSON.parse(readFileSync(join(dataDir, 'oncall-group-targets.json'), 'utf8'));
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new Error('invalid targets');
    return targets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Oncall 目标配置文件无效，请联系管理员检查');
  }
}

export function normalizeOncallConnection({ endpoint, emailDomain }: Partial<OncallGroupTarget>): Pick<OncallGroupTarget, 'endpoint' | 'emailDomain'> {
  if (!endpoint || !emailDomain) throw new Error('平台连接尚未配置，请联系部署管理员');
  if (typeof emailDomain !== 'string' || !/^[a-z0-9.-]+$/i.test(emailDomain)) throw new Error('Oncall 部署邮箱域配置无效');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Oncall 建群接口地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Oncall 建群接口必须使用 HTTPS');
  return { endpoint, emailDomain };
}

function connectionValues(target: StoredTarget | undefined, env: NodeJS.ProcessEnv): Pick<OncallGroupTarget, 'endpoint' | 'emailDomain'> {
  return { endpoint: env.ONCALL_GROUP_ENDPOINT?.trim() || target?.endpoint || '',
    emailDomain: env.ONCALL_EMAIL_DOMAIN?.trim() || target?.emailDomain || '' };
}

function connection(target: StoredTarget | undefined, env: NodeJS.ProcessEnv): Pick<OncallGroupTarget, 'endpoint' | 'emailDomain'> {
  return normalizeOncallConnection(connectionValues(target, env));
}

/** The deployment supplies the platform connection; the editor shows it unvalidated, including empty. */
export function readOncallConnectionDraft(dataDir: string, appId: string, env: NodeJS.ProcessEnv = readOncallDeploymentEnv()) {
  return connectionValues(readTargets(dataDir)[appId], env);
}

export function readOncallDeploymentConnection(dataDir: string, appId: string, env: NodeJS.ProcessEnv = readOncallDeploymentEnv()) {
  return connection(readTargets(dataDir)[appId], env);
}

function businessTarget(input: StoredTarget): OncallGroupBusinessTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['tenantId', 'typeId', 'region', 'endpoint', 'emailDomain'].includes(key))) throw new Error('Oncall 目标配置无效');
  return normalizeOncallGroupBusinessTarget({ tenantId: input?.tenantId, typeId: input?.typeId, region: input?.region });
}

export function normalizeOncallGroupBusinessTarget(input: unknown): OncallGroupBusinessTarget {
  const target = input as OncallGroupBusinessTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).some(key => !['tenantId', 'typeId', 'region'].includes(key))) throw new Error('Oncall 业务目标包含未知字段');
  if (!Number.isSafeInteger(target.tenantId) || target.tenantId <= 0
    || (target.typeId !== undefined && (!Number.isSafeInteger(target.typeId) || target.typeId <= 0))
    || (target.region !== undefined && (typeof target.region !== 'string' || !target.region.trim()))) {
    throw new Error('请填写有效的 Oncall 业务线、区域和分类');
  }
  return { tenantId: target.tenantId, ...(target.typeId !== undefined ? { typeId: target.typeId } : {}),
    ...(target.region !== undefined ? { region: target.region.trim() } : {}) };
}

export function readOncallGroupSettings(dataDir: string, appId: string): {
  target: OncallGroupBusinessTarget | null; connectionReady: boolean; connectionError?: string;
} {
  const stored = readTargets(dataDir)[appId];
  const target = stored === undefined ? null : businessTarget(stored);
  try {
    connection(stored, readOncallDeploymentEnv());
    return { target, connectionReady: true };
  } catch (error) {
    return { target, connectionReady: false, connectionError: (error as Error).message };
  }
}

export function loadOncallGroupTarget(dataDir: string, appId: string, env: NodeJS.ProcessEnv = readOncallDeploymentEnv()): OncallGroupTarget {
  const stored = readTargets(dataDir)[appId];
  if (!stored) throw new Error('Oncall 业务目标尚未配置，请联系机器人管理员');
  return normalizeOncallGroupTarget({ ...stored, ...connection(stored, env) });
}

export function normalizeOncallGroupTarget(input: unknown): OncallGroupTarget {
  const target = input as OncallGroupTarget;
  businessTarget(target);
  normalizeOncallConnection(target);
  return target;
}


/** This business-only route preserves legacy connection values without
 * copying shared deployment defaults into each bot. */
export function saveOncallGroupTarget(dataDir: string, appId: string, value: unknown): OncallGroupBusinessTarget {
  const target = normalizeOncallGroupBusinessTarget(value);
  const path = join(dataDir, 'oncall-group-targets.json');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  withFileLockSync(path, () => {
    const existing = readTargets(dataDir);
    const previous = existing[appId];
    if (previous !== undefined) businessTarget(previous);
    const legacy = { ...(previous?.endpoint !== undefined ? { endpoint: previous.endpoint } : {}),
      ...(previous?.emailDomain !== undefined ? { emailDomain: previous.emailDomain } : {}) };
    atomicWriteFileSync(path, JSON.stringify({ ...existing, [appId]: { ...legacy, ...target } }), { mode: 0o600, durable: true });
  });
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
  fetcher: typeof fetch = fetch, selection?: { region: string; typeId: number; priority: 'P2' | 'P1' | 'P0' }): Promise<{ flowId: string; openChatId: string }> {
  if (!selection && (!target.typeId || !target.region)) throw new Error('直接建群需要配置固定区域和分类');
  let response: Response;
  try {
    response = await fetcher(target.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}`, 'x-api-user': username },
      body: JSON.stringify({ tenant_id: target.tenantId, type_id: selection?.typeId ?? target.typeId, region: selection?.region ?? target.region,
        type: 'create_chat', priority: selection?.priority ?? 'P2', source_type: 'open_api', source_location: 'botmux', trigger_message: message }),
    });
  } catch { throw new OncallGroupApiError(true); }
  if (!response.ok) throw new OncallGroupApiError(![400, 401, 403, 404, 422, 429].includes(response.status), response.status);
  let body: any;
  try { body = await response.json(); } catch { throw new OncallGroupApiError(true); }
  if (body?.code !== 0 || !/^oc_[a-zA-Z0-9]+$/.test(body?.data?.open_chat_id ?? '')
    || !body?.data?.oncall_flow_id) throw new OncallGroupApiError(true);
  return { flowId: String(body.data.oncall_flow_id), openChatId: body.data.open_chat_id };
}
