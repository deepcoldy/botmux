import { safeScrubAndTruncate } from './scrub.js';
import type { SafeTextPreview } from './types.js';

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function commandFromInput(input: unknown): string | undefined {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      const parsedCommand = commandFromInput(parsed);
      if (parsedCommand) return parsedCommand;
    } catch {
      // Plain shell command strings are valid inputs too.
    }
    return input;
  }
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return undefined;
}

export function safeTextPreview(value: unknown, max: number): SafeTextPreview | undefined {
  const raw = stringifyValue(value)?.replace(/\r\n?/g, '\n').replace(/\p{C}/gu, ch => ch === '\n' || ch === '\t' ? ch : '').trim();
  if (!raw) return undefined;
  return safeScrubAndTruncate(raw, max);
}

export function safeCommandPreview(input: unknown): SafeTextPreview | undefined {
  return safeTextPreview(commandFromInput(input), 800);
}

export function safeOutputPreview(output: unknown): SafeTextPreview | undefined {
  return safeTextPreview(output, 2000);
}
