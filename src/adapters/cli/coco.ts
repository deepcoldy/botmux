import { execSync } from 'node:child_process';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

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
      pty.write(content + '\r');
    },

    ensureMcpConfig(entry: McpServerEntry) {
      // Use `coco mcp add-json` CLI — coco stores config in ~/.trae/traecli.yaml
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
      '消息可能包含 attachments，每个有 path 字段，用 Read 工具查看',
    ],
    altScreen: false,
  };
}

export const create = createCocoAdapter;
