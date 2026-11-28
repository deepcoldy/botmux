import { commandSpec } from '../../../core/command-schema.js';

/** Gateway namespaces are distinct from daemon classification. No arbitrary
 * native registry name is forwarded as a host/core command. */
export const NATIVE_WECOM_COMMANDS = {
  '/grant': 'core',
  '/revoke': 'core',
  '/grant-approve': 'core',
  '/repo': 'core',
  '/help': 'platform',
  '/commands': 'platform',
  '/summary': 'platform',
  '/start': 'platform',
  '/ask': 'platform',
  '/feedback': 'platform',
} as const;

/** Shared commands the gateway itself answers (bridge/inbound.ts), first on the help card. */
const WECOM_GATEWAY_SHARED_COMMANDS = ['/status', '/stop', '/restart'] as const;

type WecomHelpCommand =
  | keyof typeof NATIVE_WECOM_COMMANDS
  | typeof WECOM_GATEWAY_SHARED_COMMANDS[number];

/** What the help shows for each command: its usage line and what it does. Every command needs one. */
const WECOM_COMMAND_HELP: Readonly<Record<WecomHelpCommand, { usage?: string; description: string }>> = {
  '/status': { description: '查看当前任务状态' },
  '/stop': { description: '停止当前任务' },
  '/restart': { description: '下一条消息开始新会话' },
  '/grant': { usage: '/grant <userid> [talk|operate]', description: '给成员授予当前会话权限' },
  '/revoke': { usage: '/revoke <userid>', description: '撤销成员的当前会话权限' },
  '/grant-approve': { usage: '/grant-approve <申请号>', description: '批准对话权限申请' },
  '/repo': { usage: '/repo [序号|名称]', description: '列出或选择仓库' },
  '/help': { description: '显示命令帮助' },
  '/commands': { description: '显示命令帮助' },
  '/summary': { description: '总结本机器人经手的对话' },
  '/start': { description: '开始一轮对话' },
  '/ask': { usage: '/ask <askId> <答案>', description: '用文字回答 CLI 提问' },
  '/feedback': { usage: '/feedback <卡片任务ID> <评论>', description: '补充反馈评论' },
};

/**
 * The commands of the help card and its text fallback, in order: the shared
 * commands the gateway answers, then the gateway's own.
 */
export function wecomHelpEntries(): Array<{ command: string; usage: string; description: string }> {
  const own = Object.keys(NATIVE_WECOM_COMMANDS) as Array<keyof typeof NATIVE_WECOM_COMMANDS>;
  return [...WECOM_GATEWAY_SHARED_COMMANDS, ...own].map(command => ({
    command,
    usage: WECOM_COMMAND_HELP[command].usage ?? command,
    description: WECOM_COMMAND_HELP[command].description,
  }));
}

export function nativeWecomCommand(text: string): {
  name: string;
  owner: 'core' | 'platform' | 'shared';
} | undefined {
  const head = text.trim().split(/\s+/, 1)[0].toLowerCase();
  const own = NATIVE_WECOM_COMMANDS[head as keyof typeof NATIVE_WECOM_COMMANDS];
  if (own) {
    return { name: head, owner: own };
  }
  const shared = commandSpec(head);
  return shared ? { name: shared.name, owner: 'shared' } : undefined;
}
