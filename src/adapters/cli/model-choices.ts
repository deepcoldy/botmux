import type { CliId } from './types.js';

/** Static model metadata shared by adapters and the Dashboard.
 * Keep this module free of adapter construction, executable lookup and I/O:
 * option enumeration runs synchronously on the Dashboard request thread. */
const CODEX_MODEL_CHOICES = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'] as const;
const DSH_MODEL_CHOICES = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;

/** Explicitly account for every CLI; undefined means it has no curated list. */
export const CLI_MODEL_CHOICES: Readonly<Record<CliId, readonly string[] | undefined>> = {
  'claude-code': ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  'seed': undefined,
  'relay': undefined,
  'aiden': undefined,
  'coco': [
    'Seed-Dogfooding-2.0',
    'Doubao-Seed-2.0-Code',
    'Doubao-Seed-Code',
    'Gemini-3.1-Pro-Preview',
  ],
  'codex': CODEX_MODEL_CHOICES,
  'codex-app': CODEX_MODEL_CHOICES,
  'cursor': ['auto', 'claude-4-sonnet', 'claude-4-opus', 'gpt-5'],
  'gemini': ['gemini-2.5-pro', 'gemini-2.5-flash'],
  'genius': ['gpt-5.5'],
  'opencode': [
    'anthropic/claude-sonnet-4',
    'anthropic/claude-opus-4',
    'openai/gpt-5',
    'google/gemini-2.5-pro',
  ],
  'opencode2': undefined,
  'antigravity': undefined,
  'mtr': undefined,
  'hermes': undefined,
  'mira': undefined,
  'mir': undefined,
  'traex': [
    'Seed-Dogfooding-2.0',
    'Doubao-Seed-2.0-Code',
    'gpt-5.5',
    'gpt-5',
    'o3',
    'Doubao_1_8',
    'DeepSeek-V4-Pro',
    'kimi-k2.6',
  ],
  'pi': undefined,
  'copilot': ['claude-sonnet-4', 'claude-sonnet-4.5', 'gpt-5'],
  'oh-my-pi': undefined,
  'ebsd': undefined,
  'kimi': [
    'kimi-k2.5',
    'kimi-k2.5-code',
    'kimi-k2.7-code',
  ],
  'grok': [
    'grok-4.6',
    'grok-4.5',
  ],
  'kiro-cli': undefined,
  'riff': undefined,
  'reasonix': [
    'deepseek-flash/deepseek-v4-flash',
    'deepseek-pro/deepseek-v4-pro',
  ],
  'dsh': DSH_MODEL_CHOICES,
  'dsh-tui': DSH_MODEL_CHOICES,
  'mojo': [
    'doubao-seed-2.0-dogfooding',
    'glm-5-turbo',
    'gpt-5.4-2026-03-05',
    'gpt-5.5-2026-04-24',
    'gpt-5.5-ptu',
  ],
  'minimax': [
    'MiniMax-M3',
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
  ],
};
