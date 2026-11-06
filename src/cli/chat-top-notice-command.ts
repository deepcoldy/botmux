import { putChatTopNotice } from '../im/lark/chat-top-notice.js';

const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]{1,128}$/;

export const CHAT_TOP_NOTICE_CLI_USAGE = `用法:
  botmux top-notice set <message_id> [--session-id <id>] [--chat-id <oc_xxx>] [--json]

set 会把指定群消息设置为群置顶；重复执行同一命令是安全的。`;

export interface ParsedChatTopNoticeCli {
  action: 'set';
  messageId: string;
  sessionId?: string;
  chatId?: string;
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
  const valueFlags = new Set(['--session-id', '--chat-id']);
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
  if (chatId && !CHAT_ID_PATTERN.test(chatId)) throw new Error(`chat_id 无效: ${chatId}`);
  return { action: 'set', messageId, sessionId, chatId, json: args.includes('--json') };
}

export async function executeChatTopNoticeCli(input: ParsedChatTopNoticeCli & {
  larkAppId: string;
  resolvedChatId: string;
}): Promise<{ action: 'set'; messageId: string }> {
  await putChatTopNotice(input.larkAppId, input.resolvedChatId, input.messageId);
  return { action: 'set', messageId: input.messageId };
}
