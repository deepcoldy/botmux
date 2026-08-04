export const TRAEX_INITIAL_PROMPT_MAX_LENGTH = 4_000;

export const TRAEX_INITIALIZATION_MODES = [
  'traex',
  'forge-pipeline',
  'forge-pilot',
] as const;

export type TraexInitializationMode = (typeof TRAEX_INITIALIZATION_MODES)[number];

export type TraexInitializationSelection =
  | {
      kind: 'directory';
      path: string;
      label: string;
      pinWorkingDir: boolean;
    }
  | {
      kind: 'auto-worktree';
      path: string;
      label: string;
    }
  | {
      kind: 'worktree';
      repoPaths: string[];
      label: string;
      branch?: string;
      parentPath?: string;
    };

export interface PendingTraexInitialization {
  nonce: string;
  ownerOpenId?: string;
  originalPrompt: string;
  promptPrefix: string;
  mode?: TraexInitializationMode;
  selection: TraexInitializationSelection;
  commitInFlight?: boolean;
}

export type TraexInitialPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; error: 'empty' | 'too_long' };

export function normalizeTraexInitializationMode(value: unknown): TraexInitializationMode | null {
  return typeof value === 'string'
    && (TRAEX_INITIALIZATION_MODES as readonly string[]).includes(value)
    ? value as TraexInitializationMode
    : null;
}

export function normalizeTraexInitialPrompt(value: unknown): TraexInitialPromptResult {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'empty' };
  const prompt = value.trim();
  if (prompt.length > TRAEX_INITIAL_PROMPT_MAX_LENGTH) {
    return { ok: false, error: 'too_long' };
  }
  return { ok: true, prompt };
}

export function buildTraexInitializationPrompt(
  mode: TraexInitializationMode,
  prompt: string,
): string {
  if (mode === 'traex') return prompt;
  return `$${mode}\n${prompt}`;
}

export function composeTraexPendingPrompt(
  prefix: string,
  mode: TraexInitializationMode,
  prompt: string,
): string {
  return prefix + buildTraexInitializationPrompt(mode, prompt);
}
