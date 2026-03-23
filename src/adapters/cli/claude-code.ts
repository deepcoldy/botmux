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

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--dangerously-skip-permissions');
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      return args;
    },

    async writeInput(pty, content) {
      if (content.includes('\n')) {
        // Use bracketed paste mode so Claude Code reliably detects paste
        // boundaries instead of relying on timing-based heuristics.
        pty.write('\x1b[200~' + content + '\x1b[201~');
        // Image file paths in pasted text trigger Claude Code's async image
        // attachment, which needs extra time before Enter is accepted.
        const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
        await new Promise(r => setTimeout(r, hasImagePath ? 800 : 150));
        pty.write('\r');
      } else {
        pty.write(content + '\r');
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
