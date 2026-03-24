import type { ImEventHandler, ImMessage } from '../types.js';

export interface WeixinCommandContext {
  sendReply: (userId: string, text: string) => Promise<void>;
  handler: ImEventHandler;
  getActiveSessionKey: (userId: string) => string | undefined;
  clearSession: (userId: string) => void;
}

export function isCommand(content: string): boolean {
  return content.startsWith('/');
}

export async function handleCommand(msg: ImMessage, ctx: WeixinCommandContext): Promise<void> {
  const [cmd, ...args] = msg.content.trim().split(/\s+/);
  switch (cmd) {
    case '/help':
      await ctx.sendReply(msg.senderId, [
        '可用命令：',
        '  /new [prompt] — 开新 session',
        '  /restart — 重启当前 CLI',
        '  /close — 关闭 session',
        '  /switch <cli> — 切换 CLI',
        '  /help — 显示此帮助',
      ].join('\n'));
      break;
    case '/new': {
      ctx.clearSession(msg.senderId);
      const newMsg = { ...msg, content: args.join(' ') || '' };
      await ctx.handler.onNewTopic(newMsg, 'weixin', 'p2p');
      break;
    }
    case '/restart': {
      const sk = ctx.getActiveSessionKey(msg.senderId);
      if (sk) {
        await ctx.handler.onCardAction({ actionType: 'restart', threadId: sk });
      } else {
        await ctx.sendReply(msg.senderId, '当前没有活跃 session。发消息开始新 session。');
      }
      break;
    }
    case '/close':
      ctx.clearSession(msg.senderId);
      await ctx.sendReply(msg.senderId, 'Session 已关闭。');
      break;
    case '/switch':
      await ctx.sendReply(msg.senderId, '功能开发中。请用 /new 开新 session。');
      break;
    default:
      await ctx.sendReply(msg.senderId, `未知命令: ${cmd}\n输入 /help 查看命令`);
  }
}
