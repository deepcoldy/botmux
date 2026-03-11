import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      // Codex uses subcommand pattern: `codex resume <id>`
      if (resume) return ['resume', sessionId];
      return ['--yolo'];
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content + '\r');
    },

    ensureMcpConfig(_entry: McpServerEntry) {
      // Codex uses TOML config (~/.codex/config.toml). Stub — log only.
      console.warn('[codex] MCP config requires TOML support — skipping auto-install');
    },

    completionPattern: undefined,
    altScreen: true,
  };
}

export const create = createCodexAdapter;
