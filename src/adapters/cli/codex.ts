import { execSync } from 'node:child_process';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs() {
      // Codex manages its own session IDs internally — we cannot pass ours.
      // Resume is not supported; daemon always starts a fresh Codex session.
      return [
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
      ];
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content);
      await delay(200);
      pty.write('\r');
    },

    ensureMcpConfig(entry: McpServerEntry) {
      // Clean up stale entries (e.g. old "claude-code-robot" → renamed to "botmux")
      for (const stale of ['claude-code-robot']) {
        if (stale !== entry.name) {
          try {
            execSync(`${bin} mcp remove ${stale}`, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
          } catch { /* not present — fine */ }
        }
      }
      // Remove first so re-registration picks up env changes (e.g. new SESSION_DATA_DIR)
      try {
        execSync(`${bin} mcp remove ${entry.name}`, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
      } catch { /* not registered yet — fine */ }

      const envArgs = Object.entries(entry.env)
        .map(([k, v]) => `--env ${k}=${v}`)
        .join(' ');
      const cmd = `${bin} mcp add ${entry.name} ${envArgs} -- ${entry.command} ${entry.args.join(' ')}`;
      try {
        execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
      } catch (err: any) {
        console.warn(`[codex] Failed to add MCP config: ${err.message}`);
      }
    },

    completionPattern: undefined,
    readyPattern: /›|\d+% left/,  // › for input box, or status bar pattern (e.g. "97% left")
    systemHints: [
      // Codex does not honour MCP-level `instructions`, so we inject them via the initial prompt.
      '你连接到了飞书话题群，用户在飞书上阅读，看不到你的终端输出。',
      '想让用户看到的内容必须通过 send_to_thread 工具发送，终端输出不会到达聊天。',
      '用 send_to_thread 发送：关键结论、方案（等用户确认再执行）、最终结果、进度更新。消息里有 session_id，调用时传回。',
      '用 react_to_message 确认收到消息（如 THUMBSUP、OnIt）。',
      '需要上下文时用 get_thread_messages 读取之前的对话。',
    ],
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
