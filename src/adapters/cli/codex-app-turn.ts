import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CodexAppTurnInput } from '../../types.js';

export interface CodexVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface CodexAppTurnStartParams {
  threadId: string;
  input: Array<Record<string, unknown>>;
  cwd: string;
  approvalPolicy: 'never';
  sandboxPolicy: { type: 'dangerFullAccess' };
  additionalContext?: CodexAppTurnInput['additionalContext'];
  clientUserMessageId?: string;
}

/** Resolve a runner `final` marker without ever mistaking Codex app-server's
 * native turn id for botmux's stable logical turn. Legacy runner envelopes do
 * not carry a client id, so the worker-owned current turn is their authority. */
export function resolveCodexAppFinalTurnIdentity(
  payload: { turnId?: unknown; nativeTurnId?: unknown },
  currentBotmuxTurnId: string | undefined,
  fallbackTurnId: string,
):
  | { ok: true; turnId: string; nativeTurnId?: string }
  | { ok: false; reason: 'turn_mismatch'; markerTurnId: string; currentBotmuxTurnId?: string } {
  const markerTurnId = typeof payload.turnId === 'string' && payload.turnId.length > 0
    ? payload.turnId
    : undefined;
  const nativeTurnId = typeof payload.nativeTurnId === 'string' && payload.nativeTurnId.length > 0
    ? payload.nativeTurnId
    : undefined;
  // The worker-frozen turn is the authority. A marker id is only a redundant
  // equality assertion; it can never choose or resurrect another turn.
  if (markerTurnId && markerTurnId !== currentBotmuxTurnId) {
    return {
      ok: false,
      reason: 'turn_mismatch',
      markerTurnId,
      ...(currentBotmuxTurnId ? { currentBotmuxTurnId } : {}),
    };
  }
  return {
    ok: true,
    turnId: currentBotmuxTurnId ?? fallbackTurnId,
    ...(nativeTurnId ? { nativeTurnId } : {}),
  };
}

export function parseCodexVersion(output: string): CodexVersion | undefined {
  const m = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function codexVersionAtLeast(version: CodexVersion, major: number, minor: number, patch: number): boolean {
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

/** additionalContext first shipped in 0.135.0; clientUserMessageId followed in
 * 0.136.0. Older serde structs can silently ignore unknown fields, so callers
 * must gate before replacing the legacy prompt rather than relying on errors. */
export function supportsCodexAppCleanInput(version: CodexVersion | undefined): boolean {
  return !!version && codexVersionAtLeast(version, 0, 135, 0);
}

export function supportsClientUserMessageId(version: CodexVersion | undefined): boolean {
  return !!version && codexVersionAtLeast(version, 0, 136, 0);
}

export function isCodexAppTurnInput(value: unknown): value is CodexAppTurnInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string') return false;
  if (input.clientUserMessageId !== undefined && typeof input.clientUserMessageId !== 'string') return false;
  if (input.additionalContext !== undefined) {
    if (!input.additionalContext || typeof input.additionalContext !== 'object' || Array.isArray(input.additionalContext)) return false;
    for (const [key, raw] of Object.entries(input.additionalContext as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_]+$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const entry = raw as Record<string, unknown>;
      if (entry.kind !== 'untrusted' && entry.kind !== 'application') return false;
      if (typeof entry.value !== 'string') return false;
    }
  }
  if (input.localImages !== undefined) {
    if (!Array.isArray(input.localImages)) return false;
    for (const raw of input.localImages) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const image = raw as Record<string, unknown>;
      if (typeof image.path !== 'string') return false;
      if (image.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(String(image.detail))) return false;
    }
  }
  return true;
}

export function buildCodexAppTurnStartParams(opts: {
  threadId: string;
  cwd: string;
  legacyContent: string;
  codexAppInput?: CodexAppTurnInput;
  codexVersion?: CodexVersion;
  structuredDisabled?: boolean;
  pathExists?: (path: string) => boolean;
}): { params: CodexAppTurnStartParams; structured: boolean; skippedImages: string[] } {
  const base = {
    threadId: opts.threadId,
    cwd: opts.cwd,
    approvalPolicy: 'never' as const,
    sandboxPolicy: { type: 'dangerFullAccess' as const },
  };
  if (!opts.codexAppInput || opts.structuredDisabled || !supportsCodexAppCleanInput(opts.codexVersion)) {
    return {
      params: {
        ...base,
        input: [{ type: 'text', text: opts.legacyContent, text_elements: [] }],
      },
      structured: false,
      skippedImages: [],
    };
  }

  const pathExists = opts.pathExists ?? existsSync;
  const skippedImages: string[] = [];
  const images = (opts.codexAppInput.localImages ?? []).filter(image => {
    const usable = isAbsolute(image.path) && pathExists(image.path);
    if (!usable) skippedImages.push(image.path);
    return usable;
  });
  const params: CodexAppTurnStartParams = {
    ...base,
    input: [
      { type: 'text', text: opts.codexAppInput.text, text_elements: [] },
      ...images.map(image => ({ type: 'localImage', path: image.path, ...(image.detail ? { detail: image.detail } : {}) })),
    ],
  };
  if (opts.codexAppInput.additionalContext && Object.keys(opts.codexAppInput.additionalContext).length > 0) {
    params.additionalContext = opts.codexAppInput.additionalContext;
  }
  if (opts.codexAppInput.clientUserMessageId && supportsClientUserMessageId(opts.codexVersion)) {
    params.clientUserMessageId = opts.codexAppInput.clientUserMessageId;
  }
  return { params, structured: true, skippedImages };
}

/** Safe retry is intentionally narrow. A protocol-level rejection naming the
 * experimental field means the request did not start a turn. Generic transport,
 * timeout, model, or turn errors must never be retried (duplicate work risk). */
export function isCleanInputCapabilityError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (!/(additionalContext|clientUserMessageId)/i.test(text)) return false;
  return /(-32600|experimentalApi|unknown field|unsupported|invalid request)/i.test(text);
}
