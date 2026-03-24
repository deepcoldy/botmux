import { execSync } from 'node:child_process';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createGeminiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'gemini');
  return {
    id: 'gemini',
    resolvedBin: bin,

    buildArgs({ initialPrompt }) {
      // Gemini CLI manages sessions internally (--resume takes "latest" or
      // an index/UUID, not our daemon session IDs).  We always start fresh.
      const args = ['--yolo'];
      // Use -i (prompt-interactive) for the initial prompt.  Gemini's Ink TUI
      // has a startup phase where the TextInput component isn't mounted yet
      // (auth, model loading, extensions).  Writing to stdin during this phase
      // is silently lost.  -i injects the prompt inside the session so Gemini
      // processes it once the TUI is fully ready.
      if (initialPrompt) {
        args.push('-i', initialPrompt);
      }
      return args;
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      // Gemini uses Ink TextInput — multi-line paste needs a delay before Enter
      // to let the TUI process the pasted content.
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
      // Remove first so re-registration picks up env changes
      try {
        execSync(`${bin} mcp remove ${entry.name}`, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
      } catch { /* not registered yet — fine */ }

      // gemini mcp add <name> <command> [args...] -e K=V --trust --scope user
      const envArgs = Object.entries(entry.env)
        .map(([k, v]) => `-e ${k}=${v}`)
        .join(' ');
      const argsStr = entry.args.join(' ');
      const cmd = `${bin} mcp add ${entry.name} ${entry.command} ${argsStr} ${envArgs} --trust --scope user`;
      try {
        execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: 'ignore' });
      } catch (err: any) {
        console.warn(`[gemini] Failed to add MCP config: ${err.message}`);
      }
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Ink TUI — '>' is too generic; rely on quiescence + spinner guard
    systemHints: [
      // Gemini does not honour MCP-level `instructions`, so we inject them via the initial prompt.
      '你连接到了飞书话题群，用户在飞书上阅读，看不到你的终端输出。',
      '想让用户看到的内容必须通过 send_to_thread 工具发送，终端输出不会到达聊天。',
      '用 send_to_thread 发送：关键结论、方案（等用户确认再执行）、最终结果、进度更新。消息里有 session_id，调用时传回。',
      '用 react_to_message 确认收到消息（如 THUMBSUP、OnIt）。',
      '需要上下文时用 get_thread_messages 读取之前的对话。',
    ],
    altScreen: true,                // Ink renders in alternate screen buffer by default
  };
}

export const create = createGeminiAdapter;
