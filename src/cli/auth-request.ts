import { AUTH_PROVIDERS, type AuthProvider } from '../core/provider-auth-request.js';
import { MEEGO_TENANTS, type MeegoTenant } from '../services/bytedcli-home.js';

export const AUTH_REQUEST_USAGE = `用法: botmux auth request [--scope "<scope1 scope2,...>"] [--allow-unknown] [--json]
      botmux auth request --provider <meego|bytedcli> [--tenant dcar] [--json]
      botmux auth wait --request-id <id> [--json]

为当前会话的本轮发起人生成飞书授权链接，返回 daemon 的 JSON 结果。
--scope 指定本次所需权限，以空格或逗号分隔；省略时使用默认授权。
--allow-unknown (或 --force) 允许放行未录入静态清单的合法格式权限（运行时逃生通道）。
补授权前先核对当前任务已确定的操作，把所需的多个权限合并到一次 --scope 请求，不要逐项发链接或申请无关权限。
单聊里返回 authUrl，由 Agent 通过 botmux send 发给用户；群聊里 botmux 直接私聊发起人发链接，返回 delivery=dm、不含 authUrl。授权链接只发给发起人本人，不要贴到群里。可用 auth wait 等待授权就绪。
Daemon 自动完成授权；本轮结束后，用户也可在有效期内授权，再发消息恢复操作。
wait 每 2 秒查询一次，最多等待 5 分钟，返回 JSON。
--provider 由 bytedcli 包装脚本调用：botmux 把 Meego / ByteCloud 授权链接直接私下发给本轮发起人，只输出一句不含链接的说明。
--tenant 仅用于 Meego，取值同 bytedcli meego login --tenant。
退出码 0 已授权，3 尚未授权（链接已发出或发不出去），4 授权服务暂不可用。`;

export type ParsedAuthArgs =
  | { help: true }
  | { help: false; command: 'request'; scopes: string[]; allowUnknown: boolean; provider?: AuthProvider; tenant?: MeegoTenant; json?: boolean }
  | { help: false; command: 'wait'; requestId: string };

export function parseAuthRequestArgs(args: string[]): ParsedAuthArgs {
  if (args.length === 1 && args[0] === '--help'
    || args.length === 2 && ['request', 'wait'].includes(args[0]) && args[1] === '--help') {
    return { help: true };
  }
  const command = args[0];
  if (command !== 'request' && command !== 'wait') throw new Error('需要 auth request 或 auth wait 子命令');
  let scopes: string[] | undefined;
  let requestId: string | undefined;
  let provider: AuthProvider | undefined;
  let tenant: MeegoTenant | undefined;
  let json = false;
  let allowUnknown = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json' && !json) {
      json = true;
    } else if (command === 'request' && (argument === '--allow-unknown' || argument === '--force') && !allowUnknown) {
      allowUnknown = true;
    } else if (command === 'request' && argument === '--scope' && scopes === undefined) {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error('--scope 需要权限名称');
      scopes = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
      if (scopes.length === 0) throw new Error('--scope 需要权限名称');
    } else if (command === 'request' && argument === '--provider' && provider === undefined) {
      const value = args[++index];
      if (!AUTH_PROVIDERS.includes(value as AuthProvider)) throw new Error(`--provider 只支持 ${AUTH_PROVIDERS.join(' / ')}`);
      provider = value as AuthProvider;
    } else if (command === 'request' && argument === '--tenant' && tenant === undefined) {
      const value = args[++index];
      if (!MEEGO_TENANTS.includes(value as MeegoTenant)) throw new Error(`--tenant 只支持 ${MEEGO_TENANTS.join(' / ')}`);
      tenant = value as MeegoTenant;
    } else if (command === 'wait' && argument === '--request-id' && requestId === undefined) {
      requestId = args[++index]?.trim();
      if (!requestId || requestId.startsWith('-')) throw new Error('--request-id 需要授权请求 ID');
    } else {
      throw new Error(`未知或重复参数: ${argument}`);
    }
  }
  if (command === 'wait') {
    if (!requestId) throw new Error('--request-id 需要授权请求 ID');
    return { help: false, command, requestId };
  }
  if (provider && (scopes || allowUnknown)) throw new Error('--provider 不能和 --scope / --allow-unknown 一起用');
  if (tenant && provider !== 'meego') throw new Error('--tenant 只能和 --provider meego 一起用');
  return { help: false, command, scopes: scopes ?? [], allowUnknown, ...(provider ? { provider, json, ...(tenant ? { tenant } : {}) } : {}) };
}

/** Exit status of `auth request --provider`, which the bytedcli wrapper reads. */
export function providerAuthExitCode(ok: boolean, status: unknown): number {
  if (!ok) return status === 'refused' ? 3 : 1;
  switch (status) {
    case 'ready': return 0;
    case 'delivered': case 'pending': case 'undeliverable': return 3;
    case 'unavailable': return 4;
    default: return 1;
  }
}
