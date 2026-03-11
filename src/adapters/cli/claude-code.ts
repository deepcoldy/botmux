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
      return args;
    },

    async writeInput(pty, content) {
      pty.write(content + '\r');
    },

    ensureMcpConfig(entry) {
      const configPath = join(homedir(), '.claude.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcpServers) data.mcpServers = {};
      const existing = data.mcpServers[entry.name];
      if (existing && existing.args?.[0] === entry.args[0]) return;
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
    altScreen: false,
  };
}

export const create = createClaudeCodeAdapter;
