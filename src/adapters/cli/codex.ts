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
    readyPattern: /›/,  // prompt indicator — present when Codex's input box is rendered
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
