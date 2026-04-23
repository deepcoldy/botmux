import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed) for \d+[smh]/;

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'claude');
  return {
    id: 'claude-code',
    resolvedBin: bin,
    supportsTypeAhead: true,

    buildArgs({ sessionId, resume, botName, botOpenId }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--dangerously-skip-permissions');
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      const identityLines =
        botName || botOpenId
          ? [
              '',
              '你的身份：',
              `- 名字：${botName ?? '(未知)'}`,
              `- open_id：${botOpenId ?? '(未知)'}`,
              '同一群里可能有多个机器人同时被 @，消息里会以 `@名字` 和 `open_id` 区分。',
              '判断本条消息是不是分派给你：对照上面的名字和 open_id。',
              '- 只执行明确分给自己的那部分，别抢别的机器人的活',
              '- 整条消息都指派给别的机器人时，保持沉默不要回复',
              '- 需要找对端协作时先用 `botmux bots list` 查 open_id，再用 `botmux send --mention <open_id>` @ 对方',
            ]
          : [];
      args.push('--append-system-prompt', [
        '你连接到了飞书（Lark）话题群。用户在飞书上阅读，看不到你的终端输出。',
        '想让用户看到的内容必须通过 `botmux send` 命令发送，终端输出不会到达聊天。',
        '',
        '使用指南：',
        '- 用 `botmux send` 发送：关键结论、方案（等用户确认再执行）、最终结果、进度更新。',
        '- 发送纯文本即可：`botmux send "消息"` 或用 heredoc 传多行。格式自动处理。',
        '- 附带图片：`botmux send --images /path/to/img.png "说明文字"`',
        '- 附带文件：`botmux send --files /path/to/file.pdf "请查收"`',
        '- 需要上下文时用 `botmux thread messages` 读取之前的对话。',
        '- 查看可协作的机器人：`botmux bots list`',
        ...identityLines,
      ].join('\n'));
      return args;
    },

    injectsSessionContext: true,

    async writeInput(pty, content) {
      // Always use bracketed paste: Claude Code's paste-burst heuristic can
      // swallow a trailing Enter sent via send-keys -l + send-keys Enter,
      // leaving content in the input box. Bracketed paste marks an explicit
      // \x1b[201~ boundary so the post-paste Enter is unambiguously submit.
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;

      if (pty.pasteText && pty.sendSpecialKeys) {
        pty.pasteText(content);
        await new Promise(r => setTimeout(r, submitDelay));
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write('\x1b[200~' + content + '\x1b[201~');
        await new Promise(r => setTimeout(r, submitDelay));
        pty.write('\r');
      }
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
    systemHints: [],
    altScreen: false,
    skillsDir: '~/.claude/skills',
  };
}

export const create = createClaudeCodeAdapter;
