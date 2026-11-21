import type { Client } from '@larksuiteoapi/node-sdk';
import { getBot } from '../../bot-registry.js';
import { readOncallDeploymentEnv } from '../../services/oncall-deployment-config.js';
import { readOncallIdentityApp, type OncallIdentityApp } from '../../services/oncall-identity-config.js';
import { oncallUsername, type OncallGroupTarget } from '../../services/oncall-group-client.js';
import type { CardActionData } from './card-handler.js';
import { resolveSender } from './identity-cache.js';
import { larkGet } from './lark-get.js';
import { normalizeBrand, sdkDomain } from './lark-hosts.js';

let shared: { settings: OncallIdentityApp; client: Client; tenantKey?: string } | undefined;

async function identityClient(settings: OncallIdentityApp) {
  if (!shared || shared.settings.appId !== settings.appId || shared.settings.appSecret !== settings.appSecret || shared.settings.brand !== settings.brand) {
    const { Client, DefaultCache } = await import('@larksuiteoapi/node-sdk');
    shared = { settings, client: new Client({ appId: settings.appId, appSecret: settings.appSecret,
      // The SDK's default cache is process-global and keyed only by app ID.
      // Keep it per credential generation so rotation cannot reuse an old token.
      cache: new DefaultCache(), domain: sdkDomain(settings.brand),
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } }) };
  }
  return shared;
}

/** Only the caller's verified callback operator may cross the app boundary.
 * Display identities / message text / action values are never identity inputs. */
export async function resolveOncallUsername(appId: string, operator: CardActionData['operator'], target: OncallGroupTarget,
  deployment: NodeJS.ProcessEnv = readOncallDeploymentEnv()): Promise<string> {
  const bot = getBot(appId).config;
  if (bot.oncallGroup?.identitySource !== 'shared') {
    const sender = await resolveSender(appId, operator?.open_id ?? '', 'user');
    if (!sender?.email) throw new Error('无法确认 Oncall 账号：请管理员为当前机器人配置全员通讯录邮箱读取范围，或在高级设置中使用统一身份查询应用');
    return oncallUsername(sender.email, target);
  }
  const settings = readOncallIdentityApp(deployment);
  if (!settings.appId || !settings.appSecret) throw new Error('统一身份查询应用尚未配置，请联系部署管理员在高级设置中填写 App ID 和 App Secret');
  if (settings.brand !== normalizeBrand(bot.brand)) throw new Error('统一身份查询应用与当前机器人的飞书/Lark 平台不一致');
  const userId = operator?.user_id;
  const tenantKey = operator?.tenant_key;
  if (typeof userId !== 'string' || !userId || userId.startsWith('ou_') || userId.length > 64
    || typeof tenantKey !== 'string' || !tenantKey) throw new Error('飞书回调缺少提单人 user_id 或租户信息，请为当前机器人开通“获取用户 user ID”权限并发布');
  let email: unknown;
  try {
    const entry = await identityClient(settings);
    if (!entry.tenantKey) {
      const tenant = await larkGet(entry.client, '/open-apis/tenant/v2/tenant/query', {}, { timeoutMs: 5_000 });
      if (tenant?.code !== 0 || typeof tenant.data?.tenant?.tenant_key !== 'string') throw new Error();
      entry.tenantKey = tenant.data.tenant.tenant_key;
    }
    if (entry.tenantKey !== tenantKey) throw new Error('tenant_mismatch');
    const profile = await larkGet(entry.client, `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`,
      { user_id_type: 'user_id' }, { timeoutMs: 5_000 });
    if (profile?.code !== 0 || profile.data?.user?.user_id !== userId) throw new Error();
    email = profile.data.user.email;
  } catch (error) {
    // SDK errors may contain credentials and headers. Never forward or log them.
    if (error instanceof Error && error.message === 'tenant_mismatch') throw new Error('统一身份查询应用与提单人不在同一租户，请检查应用配置');
    throw new Error('统一身份查询失败，请检查应用凭据、全员通讯录范围，以及通讯录基本信息、用户邮箱、用户 user ID 和企业信息的只读权限是否已发布');
  }
  if (typeof email !== 'string' || !email.trim()) throw new Error('统一身份查询应用未返回提单人邮箱，请检查邮箱字段权限和该员工的工作邮箱');
  return oncallUsername(email, target);
}
