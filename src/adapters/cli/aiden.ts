import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createAidenAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'aiden');
  return {
    id: 'aiden',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      }
      // Aiden auto-generates session id for new sessions
      args.push('--permission-mode', 'agentFull');
      return args;
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content);
      await delay(200);
      pty.write('\r');
      if (content.includes('\n')) {
        await delay(200);
        pty.write('\r');
      }
    },

    ensureMcpConfig(entry: McpServerEntry) {
      const configPath = join(homedir(), '.aiden', '.mcp.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcpServers) data.mcpServers = {};

      // Clean up stale entries pointing to the same server script under a different name
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
        console.warn(`[aiden] Failed to write MCP config: ${err.message}`);
      }
    },

    completionPattern: undefined,  // quiescence only
    systemHints: [
      '消息可能包含 attachments，每个有 path 字段，用 Read 工具查看',
    ],
    altScreen: false,
  };
}

export const create = createAidenAdapter;
