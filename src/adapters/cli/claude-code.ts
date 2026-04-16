import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed) for \d+[smh]/;

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'claude');
  return {
    id: 'claude-code',
    resolvedBin: bin,
    supportsTypeAhead: true,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--dangerously-skip-permissions');
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      args.push('--append-system-prompt', [
        '你连接到了飞书（Lark）话题群。用户在飞书上阅读，看不到你的终端输出。',
        '想让用户看到的内容必须通过 send_to_thread 工具发送，终端输出不会到达聊天。',
        '',
        '使用指南：',
        '- 用 send_to_thread 发送：关键结论、方案（等用户确认再执行）、最终结果、进度更新。',
        '- 发送纯文本即可，格式会自动处理。也可以通过 images 和 files 参数附带图片和文件。',
        '- 需要上下文时用 get_thread_messages 读取之前的对话。',
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

    ensureMcpConfig(entry) {
      const configPath = join(homedir(), '.claude.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcpServers) data.mcpServers = {};

      // Clean up stale entries pointing to the same server script under a different name.
      // Old installations may have entries (e.g. "claude-code-robot") with hardcoded
      // LARK_APP_ID/SECRET that override per-bot credentials from the worker env.
      const serverScript = entry.args[0];
      let dirty = false;
      for (const [name, cfg] of Object.entries(data.mcpServers) as [string, any][]) {
        if (name !== entry.name && cfg?.args?.[0] === serverScript) {
          delete data.mcpServers[name];
          dirty = true;
        }
      }

      const existing = data.mcpServers[entry.name];
      const envMatch = existing && JSON.stringify(existing.env) === JSON.stringify(entry.env);
      if (!dirty && existing && existing.args?.[0] === serverScript && envMatch) return;
      data.mcpServers[entry.name] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
      };
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
      } catch (err: any) {
        console.warn(`[claude-code] Failed to write MCP config: ${err.message}`);
      }
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
    systemHints: [],
    altScreen: false,
  };
}

export const create = createClaudeCodeAdapter;
