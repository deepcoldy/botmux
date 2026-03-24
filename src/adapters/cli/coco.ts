import { execSync } from 'node:child_process';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

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
      // CoCo is a Claude Code fork but may not enable bracketed paste mode.
      // Use split-write + delay like Codex/Gemini/OpenCode.
      pty.write(content);
      await delay(200);
      pty.write('\r');
    },

    ensureMcpConfig(entry: McpServerEntry) {
      // Use `coco mcp add-json` CLI — coco stores config in ~/.trae/traecli.yaml
      // Clean up stale entries (e.g. old "claude-code-robot" → renamed to "botmux")
      for (const stale of ['claude-code-robot']) {
        if (stale !== entry.name) {
          try {
            execSync(`${bin} mcp remove ${stale}`, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
          } catch { /* not present — fine */ }
        }
      }

      // Remove existing entry first to ensure env is fully replaced (no stale LARK_APP_ID)
      try {
        execSync(`${bin} mcp remove ${entry.name}`, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
      } catch { /* not present — fine */ }

      const json = JSON.stringify({
        command: entry.command,
        args: entry.args,
        env: entry.env,
      });
      try {
        execSync(`${bin} mcp add-json ${entry.name} ${JSON.stringify(json)}`, {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: 'ignore',
        });
      } catch (err: any) {
        console.warn(`[coco] Failed to add MCP config: ${err.message}`);
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
