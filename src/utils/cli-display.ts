import type { CliId } from '../adapters/cli/types.js';

const cliDisplayNames: Record<CliId, string> = {
  'claude-code': 'Claude',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'gemini': 'Gemini',
  'opencode': 'OpenCode',
};

export function getCliDisplayName(cliId: CliId | string): string {
  return (cliDisplayNames as Record<string, string>)[cliId] ?? cliId;
}
