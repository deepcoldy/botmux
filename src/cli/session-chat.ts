export const SESSION_CHAT_HELP = `botmux chat create --name <群名> [--member <本应用 open_id|邮箱> ...] [--chat-mode group|topic]
botmux chat members [--chat-id <oc_...>]

使用当前会话的机器人身份。建群自动加入当前真人发起人和机器人自身；不会发送通知。
建群需要与 /group 相同的权限（管理员，或机器人已向对话用户开放 /group），且发起人在新群也能对话；只在来源群获得的授权（单群授权、oncall 群、整群放行）不延伸到新群。
成员查询返回本应用下的 open_id，可用于 send --chat-id <群> --mention <open_id>。
输出为 JSON；建群回执含 chatId、complete 和 invalidUserIds。已有 chatId 或结果未知时先核验，勿重建。`;

export type SessionChatInput =
  | { action: 'create'; name: string; members: string[]; chatMode: 'group' | 'topic' }
  | { action: 'members'; chatId?: string };

export function parseSessionChatArgs(argv: string[]): SessionChatInput {
  const action = argv[0];
  if (action !== 'create' && action !== 'members') throw new Error('chat_subcommand_unsupported');
  const flags: Record<string, string[]> = {};
  const allowed = action === 'create' ? ['--name', '--member', '--chat-mode'] : ['--chat-id'];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') continue;
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (!allowed.includes(flag)) throw new Error(`chat_flag_unsupported:${flag}`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (!value || value.startsWith('-')) throw new Error(`chat_missing_value:${flag}`);
    if (flag !== '--member' && flags[flag]) throw new Error(`chat_duplicate_flag:${flag}`);
    (flags[flag] ??= []).push(value);
  }
  if (action === 'members') return { action, ...(flags['--chat-id'] ? { chatId: flags['--chat-id'][0] } : {}) };
  const name = flags['--name']?.[0]?.trim();
  const chatMode = flags['--chat-mode']?.[0] ?? 'group';
  if (!name || name.length > 100) throw new Error('chat_name_required_max_100');
  if (chatMode !== 'group' && chatMode !== 'topic') throw new Error('chat_mode_invalid');
  return { action, name, members: flags['--member'] ?? [], chatMode };
}
