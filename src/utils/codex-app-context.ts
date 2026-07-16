import { Buffer } from 'node:buffer';
import type { CodexAppAdditionalContextEntry, CodexAppTurnInput } from '../types.js';

/** Codex currently caps each additionalContext value at roughly 1k tokens.
 * A byte ceiling is conservative across ASCII, CJK, emoji, and arbitrary
 * Unicode because a token cannot encode fewer than one input byte. */
export const CODEX_APP_CONTEXT_CHUNK_BYTES = 900;

export function chunkCodexAppContext(value: string): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current && bytes + charBytes > CODEX_APP_CONTEXT_CHUNK_BYTES) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += charBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function addCodexAppContext(
  target: Record<string, CodexAppAdditionalContextEntry>,
  key: string,
  value: string,
  kind: CodexAppAdditionalContextEntry['kind'],
): void {
  if (!value) return;
  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    throw new Error(`Unsafe Codex App additionalContext key: ${key}`);
  }
  const chunks = chunkCodexAppContext(value);
  for (let i = 0; i < chunks.length; i++) {
    // app-server normalizes additionalContext through a BTreeMap, so keys are
    // delivered lexicographically. Fixed-width suffixes keep 10+ chunks in the
    // original byte order (`_0009`, `_0010`) instead of `_1`, `_10`, `_2`.
    target[chunks.length === 1 ? key : `${key}_${String(i + 1).padStart(4, '0')}`] = { kind, value: chunks[i] };
  }
}

export function withCodexAppContext(
  input: CodexAppTurnInput,
  key: string,
  value: string,
  kind: CodexAppAdditionalContextEntry['kind'],
): CodexAppTurnInput {
  if (!value) return input;
  const additionalContext = { ...input.additionalContext };
  addCodexAppContext(additionalContext, key, value, kind);
  return { ...input, additionalContext };
}
