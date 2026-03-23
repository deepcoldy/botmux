import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createOpenCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'opencode');
  return {
    id: 'opencode',
    resolvedBin: bin,

    buildArgs({ initialPrompt }) {
      // OpenCode manages sessions internally (SQLite store).
      // Resume not supported — always start fresh.  --continue exits
      // immediately (code 0) when there is no prior session, causing a
      // crash-loop in the daemon auto-restart path.
      const args: string[] = [];
      // Use --prompt for the initial prompt.  OpenCode's Bubble Tea TUI
      // has an async startup phase; writing to stdin during this window
      // may be lost.  --prompt injects it once the TUI is ready.
      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
      }
      return args;
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      // Bubble Tea TextInput — delay before Enter to let TUI process pasted content
      pty.write(content);
      await delay(200);
      pty.write('\r');
    },

    ensureMcpConfig(entry: McpServerEntry) {
      // OpenCode reads MCP config from opencode.json under "mcp" key.
      // Global config: ~/.config/opencode/opencode.json
      const configPath = join(homedir(), '.config', 'opencode', 'opencode.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcp) data.mcp = {};

      // Clean up stale entries pointing to the same server script under a different name
      const serverScript = entry.args[0];
      let dirty = false;
      for (const [name, cfg] of Object.entries(data.mcp) as [string, any][]) {
        if (name !== entry.name && Array.isArray(cfg?.command) && cfg.command[1] === serverScript) {
          delete data.mcp[name];
          dirty = true;
        }
      }

      // Check if existing config matches — skip write if up to date
      const existing = data.mcp[entry.name];
      const envMatch = existing && JSON.stringify(existing.environment ?? {}) === JSON.stringify(entry.env);
      const cmdMatch = existing && Array.isArray(existing.command) && existing.command[1] === serverScript;
      if (!dirty && existing && cmdMatch && envMatch) return;

      data.mcp[entry.name] = {
        type: 'local',
        command: [entry.command, ...entry.args],
        environment: entry.env,
      };

      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
      } catch (err: any) {
        console.warn(`[opencode] Failed to write MCP config: ${err.message}`);
      }
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Bubble Tea TUI — no reliable prompt indicator; rely on quiescence + spinner guard
    systemHints: [],
    altScreen: true,                // Bubble Tea renders in alternate screen buffer
  };
}

export const create = createOpenCodeAdapter;
