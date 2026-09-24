import {
  deleteChatTab,
  ensureUrlChatTab,
  isCompleteChatTabOrder,
  listChatTabs,
  sortChatTabs,
  updateChatTab,
  type ChatTab,
} from '../im/lark/chat-tabs.js';

export const CHAT_TABS_CLI_USAGE = `用法:
  botmux tabs list [--session-id <id>] [--chat-id <oc_xxx>] [--json]
  botmux tabs add <url> [--name <名称>] [--session-id <id>] [--chat-id <oc_xxx>] [--json]
  botmux tabs update <tab_id> [--name <名称>] [--url <url>] [--session-id <id>] [--chat-id <oc_xxx>] [--json]
  botmux tabs remove <tab_id> [--session-id <id>] [--chat-id <oc_xxx>] [--json]
  botmux tabs sort <tab_id>... [--session-id <id>] [--chat-id <oc_xxx>] [--json]

add 按 URL 幂等：同一页面已存在时复用，并按需更新名称。`;

export interface ParsedChatTabsCli {
  action: 'list' | 'add' | 'update' | 'remove' | 'sort';
  sessionId?: string;
  chatId?: string;
  json: boolean;
  url?: string;
  name?: string;
  tabId?: string;
  tabIds?: string[];
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
  if (i < 0) return undefined;
  return args[i]!.startsWith(`${flag}=`) ? args[i]!.slice(flag.length + 1) : args[i + 1];
}

function positionals(args: string[]): string[] {
  const valueFlags = new Set(['--name', '--url', '--session-id', '--chat-id']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i]!)) { i++; continue; }
    if ([...valueFlags].some(flag => args[i]!.startsWith(`${flag}=`)) || args[i] === '--json') continue;
    if (args[i]!.startsWith('-')) throw new Error(`未知参数: ${args[i]}`);
    out.push(args[i]!);
  }
  return out;
}

function httpUrl(raw: string | undefined): string {
  if (!raw) throw new Error('缺少 URL');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`URL 无效: ${raw}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL 只支持 http/https');
  return parsed.toString();
}

export function parseChatTabsCli(args: string[]): ParsedChatTabsCli {
  if (args.includes('--help') || args.includes('-h')) throw new Error(CHAT_TABS_CLI_USAGE);
  const pos = positionals(args);
  const actionRaw = (pos.shift() ?? 'list').toLowerCase();
  const action = actionRaw === 'delete' || actionRaw === 'rm' ? 'remove' : actionRaw;
  if (!['list', 'add', 'update', 'remove', 'sort'].includes(action)) throw new Error(`未知 tabs 子命令: ${actionRaw}`);
  const common = {
    action: action as ParsedChatTabsCli['action'],
    sessionId: flagValue(args, '--session-id'),
    chatId: flagValue(args, '--chat-id'),
    json: args.includes('--json'),
  };
  if (action === 'list') {
    if (pos.length) throw new Error('list 不接受位置参数');
    return common;
  }
  if (action === 'add') {
    const url = httpUrl(pos.shift());
    if (pos.length) throw new Error('名称请通过 --name 传入');
    return { ...common, url, name: flagValue(args, '--name') };
  }
  if (action === 'update') {
    const tabId = pos.shift();
    if (!tabId || pos.length) throw new Error('update 需要且只接受一个 tab_id');
    const name = flagValue(args, '--name');
    const rawUrl = flagValue(args, '--url');
    if (!name && !rawUrl) throw new Error('update 至少需要 --name 或 --url');
    return { ...common, tabId, name, ...(rawUrl ? { url: httpUrl(rawUrl) } : {}) };
  }
  if (action === 'remove') {
    const tabId = pos.shift();
    if (!tabId || pos.length) throw new Error('remove 需要且只接受一个 tab_id');
    return { ...common, tabId };
  }
  if (!pos.length) throw new Error('sort 至少需要一个 tab_id');
  return { ...common, tabIds: pos };
}

function displayTab(tab: ChatTab): string {
  return `${tab.tab_id ?? '-'}\t${tab.tab_name ?? '(未命名)'}\t${tab.tab_type}\t${tab.tab_content?.url ?? tab.tab_content?.doc ?? ''}`;
}

export async function executeChatTabsCli(
  input: ParsedChatTabsCli & { larkAppId: string; resolvedChatId: string },
): Promise<unknown> {
  const { larkAppId, resolvedChatId: chatId } = input;
  if (input.action === 'list') return { tabs: await listChatTabs(larkAppId, chatId) };
  if (input.action === 'add') {
    const result = await ensureUrlChatTab(larkAppId, chatId, input.url!, input.name);
    return { action: result.created ? 'created' : 'reused', tab: result.tab };
  }
  if (input.action === 'update') {
    const tabs = await updateChatTab(larkAppId, chatId, input.tabId!, { name: input.name, url: input.url });
    return { action: 'updated', tab: tabs[0] ?? { tab_id: input.tabId, tab_name: input.name, tab_content: { url: input.url }, tab_type: 'url' } };
  }
  if (input.action === 'remove') {
    await deleteChatTab(larkAppId, chatId, input.tabId!);
    return { action: 'removed', tabId: input.tabId };
  }
  const current = await listChatTabs(larkAppId, chatId);
  if (!isCompleteChatTabOrder(current, input.tabIds!)) {
    throw new Error('sort 必须包含当前群全部 Tab ID（包括内置消息标签页）');
  }
  return { action: 'sorted', tabs: await sortChatTabs(larkAppId, chatId, input.tabIds!) };
}

export function formatChatTabsCliResult(result: any): string {
  if (Array.isArray(result?.tabs)) return result.tabs.length ? result.tabs.map(displayTab).join('\n') : '当前群没有标签页';
  const tab = result?.tab as ChatTab | undefined;
  if (result?.action === 'created') return `已新增标签页 ${tab?.tab_id ?? ''}`.trim();
  if (result?.action === 'reused') return `已复用标签页 ${tab?.tab_id ?? ''}`.trim();
  if (result?.action === 'updated') return `已更新标签页 ${tab?.tab_id ?? ''}`.trim();
  if (result?.action === 'removed') return `已删除标签页 ${result.tabId}`;
  if (result?.action === 'sorted') return '已完成标签页排序';
  return JSON.stringify(result);
}
