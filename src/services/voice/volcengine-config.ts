import { z } from 'zod';
import type { VoiceConfig, VolcengineTtsConfig } from './types.js';

const storedConfig = z.object({
  mode: z.enum(['standard', 'agent-plan']).optional(),
  apiKey: z.string().refine((key) => !/[\x00-\x1f\x7f]/.test(key)).transform((key) => key.trim()).optional(),
});

export function parseVolcengineConfig(raw: unknown): VoiceConfig['volcengine'] {
  if (raw === undefined) return undefined;
  const result = storedConfig.safeParse(raw);
  return result.success ? result.data : null;
}

export function mergeVolcengineConfig(
  base: VoiceConfig['volcengine'],
  over: VoiceConfig['volcengine'],
): VoiceConfig['volcengine'] {
  if (over === null) return null;
  if (over === undefined) return base;
  const mode = over.mode ?? base?.mode;
  const apiKey = over.apiKey ?? (over.mode === undefined || over.mode === base?.mode ? base?.apiKey : undefined);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

export function resolveVolcengineConfig(value: VoiceConfig['volcengine']): VolcengineTtsConfig | null {
  const parsed = parseVolcengineConfig(value);
  if (!parsed?.mode || !parsed.apiKey) return null;
  return { mode: parsed.mode, apiKey: parsed.apiKey };
}
