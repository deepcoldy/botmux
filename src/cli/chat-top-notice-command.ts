import { fetchDaemonIpc, loadDaemonIpcSecret } from '../core/daemon-ipc-auth.js';
import { dashboardSecretPath } from '../core/dashboard-secret.js';
import { putChatTopNotice } from '../im/lark/chat-top-notice.js';
import { findOnlineDaemon, parseDaemonIpcPort } from '../utils/daemon-discovery.js';

const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]{1,128}$/;
const LARK_APP_ID_PATTERN = /^cli_[A-Za-z0-9_-]{1,128}$/;

export const CHAT_TOP_NOTICE_CLI_USAGE = `用法:
  botmux top-notice set <message_id> [--session-id <id>] [--chat-id <oc_xxx>] [--json]
  botmux top-notice set <message_id> --bot <cli_xxx> --chat-id <oc_xxx> [--json]

set 会把指定群消息设置为群置顶；重复执行同一命令是安全的。
传入 --bot <cli_xxx> 时无需会话上下文，通过目标 bot 的 Daemon IPC 执行置顶（须同时传 --chat-id）。`;

export interface ParsedChatTopNoticeCli {
  action: 'set';
  messageId: string;
  sessionId?: string;
  chatId?: string;
  bot?: string;
  json: boolean;
}

function flagValue(args: string[], flag: string): string | undefined {
  const matches = args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => arg === flag || arg.startsWith(`${flag}=`));
  if (!matches.length) return undefined;
  if (matches.length > 1) throw new Error(`参数重复: ${flag}`);
  const { arg, index } = matches[0]!;
  const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} 缺少值`);
  return value;
}

function positionals(args: string[]): string[] {
  const valueFlags = new Set(['--session-id', '--chat-id', '--bot']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i]!)) { i++; continue; }
    if ([...valueFlags].some(flag => args[i]!.startsWith(`${flag}=`)) || args[i] === '--json') continue;
    if (args[i]!.startsWith('-')) throw new Error(`未知参数: ${args[i]}`);
    out.push(args[i]!);
  }
  return out;
}

export function parseChatTopNoticeCli(args: string[]): ParsedChatTopNoticeCli {
  if (args.includes('--help') || args.includes('-h')) throw new Error(CHAT_TOP_NOTICE_CLI_USAGE);
  if (args.filter(arg => arg === '--json').length > 1) throw new Error('参数重复: --json');
  const pos = positionals(args);
  const action = (pos.shift() ?? '').toLowerCase();
  if (action !== 'set') throw new Error(`未知 top-notice 子命令: ${action || '(空)'}`);
  const messageId = pos.shift();
  if (!messageId || pos.length) throw new Error('set 需要且只接受一个 message_id');
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error(`message_id 无效: ${messageId}`);
  const sessionId = flagValue(args, '--session-id');
  const chatId = flagValue(args, '--chat-id');
  const bot = flagValue(args, '--bot');
  if (chatId && !CHAT_ID_PATTERN.test(chatId)) throw new Error(`chat_id 无效: ${chatId}`);
  if (bot && !LARK_APP_ID_PATTERN.test(bot)) throw new Error(`bot 无效（需要 cli_ 开头的 larkAppId）: ${bot}`);
  if (bot && sessionId) throw new Error('--bot 与 --session-id 不能同时指定');
  if (bot && !chatId) throw new Error('使用 --bot 时必须同时指定 --chat-id <oc_xxx>');
  return {
    action: 'set',
    messageId,
    sessionId,
    chatId,
    ...(bot ? { bot } : {}),
    json: args.includes('--json'),
  };
}

export async function executeChatTopNoticeCli(input: ParsedChatTopNoticeCli & {
  larkAppId: string;
  resolvedChatId: string;
}): Promise<{ action: 'set'; messageId: string }> {
  await putChatTopNotice(input.larkAppId, input.resolvedChatId, input.messageId);
  return { action: 'set', messageId: input.messageId };
}

export interface ChatTopNoticeViaDaemonIpcDeps {
  dataDir?: string;
  findDaemon?: (larkAppId: string, dataDir?: string) => { ipcPort?: unknown } | null;
  loadSecret?: () => string;
  fetchIpc?: typeof fetchDaemonIpc;
}

export async function executeChatTopNoticeViaDaemonIpc(
  input: { larkAppId: string; chatId: string; messageId: string },
  deps: ChatTopNoticeViaDaemonIpcDeps = {},
): Promise<{ action: 'set'; messageId: string; chatId: string; larkAppId: string }> {
  const findDaemon = deps.findDaemon ?? findOnlineDaemon;
  const daemon = findDaemon(input.larkAppId, deps.dataDir);
  const port = parseDaemonIpcPort(daemon?.ipcPort);
  if (!port) {
    throw new Error(`daemon_offline: bot ${input.larkAppId} 不在线`);
  }
  const secret = deps.loadSecret ? deps.loadSecret() : loadDaemonIpcSecret(dashboardSecretPath());
  const fetchIpc = deps.fetchIpc ?? fetchDaemonIpc;
  const response = await fetchIpc(
    port,
    `/api/groups/${encodeURIComponent(input.chatId)}/top-notice`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: input.messageId, larkAppId: input.larkAppId }),
      signal: AbortSignal.timeout(30_000),
    },
    secret,
  );
  const receipt = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const rawError = typeof receipt?.error === 'string' ? receipt.error : `http_${response.status}`;
    const error = response.status === 404 && rawError === 'not_found'
      ? 'daemon_top_notice_unsupported'
      : rawError;
    throw new Error(error);
  }
  if (
    receipt?.ok !== true
    || receipt.larkAppId !== input.larkAppId
    || receipt.chatId !== input.chatId
    || receipt.messageId !== input.messageId
  ) {
    throw new Error('invalid_ipc_response');
  }
  return {
    action: 'set',
    messageId: input.messageId,
    chatId: input.chatId,
    larkAppId: input.larkAppId,
  };
}
