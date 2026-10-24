import type { CliId } from './types.js';

/**
 * Human-facing CLI names, shared by Feishu cards, worker notices and the
 * setup / dashboard pickers. Keyed by the full CliId union, so adding a CLI id
 * fails to compile until it has a name here.
 */
export const CLI_DISPLAY_NAMES: Readonly<Record<CliId, string>> = {
  'claude-code': 'Claude',
  'seed': 'Seed',
  'relay': 'Relay',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'codex-app': 'Codex App',
  'cursor': 'Cursor',
  'gemini': 'Gemini',
  'genius': 'Genius',
  'opencode': 'OpenCode',
  'opencode2': 'OpenCode 2',
  'mimocode': 'MiMoCode',
  'antigravity': 'Antigravity',
  'mtr': 'MTR',
  'hermes': 'Hermes',
  'mira': 'Mira',
  'mir': 'Mir CLI',
  'traex': 'TRAE',
  'pi': 'Pi',
  'copilot': 'Copilot',
  'oh-my-pi': 'Oh My Pi',
  'ebsd': 'ebsd',
  'kimi': 'Kimi',
  'grok': 'Grok Build',
  'kiro-cli': 'Kiro',
  'riff': 'Riff',
  'reasonix': 'Reasonix',
  'dsh': 'DeepSeek Harness',
  'dsh-tui': 'DeepSeek Harness TUI',
  'mojo': 'Mojo',
  'minimax': 'MiniMax Code',
  'remote-runner': 'Remote Runner',
  'codem': 'CodeM',
};

/** Display name for a possibly-unknown id (persisted / runtime-supplied). */
export function lookupCliDisplayName(cliId: string): string | undefined {
  return Object.hasOwn(CLI_DISPLAY_NAMES, cliId) ? CLI_DISPLAY_NAMES[cliId as CliId] : undefined;
}
