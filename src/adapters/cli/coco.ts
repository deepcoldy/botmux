import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,
    readyPattern: /⏵⏵/,   // status bar indicator — present when CoCo's TUI is rendered
    systemHints: [
      // CoCo does not honour MCP-level `instructions`, so we must inject them here via the initial prompt.
      '你连接到了飞书话题群，用户在飞书上阅读，看不到你的终端输出。',
      '想让用户看到的内容必须通过 send_to_thread 工具发送，终端输出不会到达聊天。',
      '用 send_to_thread 发送：关键结论、方案（等用户确认再执行）、最终结果、进度更新。消息里有 session_id，调用时传回。',

      '需要上下文时用 get_thread_messages 读取之前的对话。',
    ],
    altScreen: false,
  };
}

export const create = createCocoAdapter;
