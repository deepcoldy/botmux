import {
  isCodexReasoningEffort,
  type CodexReasoningEffort,
} from './codex-reasoning-effort.js';

export type NativeSubagentModelPolicy = { mode: 'custom'; value: string };

export type NativeSubagentEffortPolicy = { mode: 'custom'; value: CodexReasoningEffort };

export type NativeSubagentRuntimePolicy = {
  model?: NativeSubagentModelPolicy;
  reasoningEffort?: NativeSubagentEffortPolicy;
};

export type NativeSubagentRuntimePolicyNormalization =
  | { ok: true; value?: NativeSubagentRuntimePolicy }
  | { ok: false; error: string };

export type NativeSubagentSpawnRewrite =
  | { kind: 'unchanged'; input: Record<string, unknown> }
  | { kind: 'rewritten'; input: Record<string, unknown> };

const MAX_MODEL_LENGTH = 256;
const POLICY_KEYS = new Set(['model', 'reasoningEffort']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(value).find(key => !allowed.includes(key));
}

function normalizeModelPolicy(raw: unknown):
  | { ok: true; value: NativeSubagentModelPolicy }
  | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'nativeSubagentRuntime.model must be an object' };
  if (raw.mode !== 'custom') {
    return { ok: false, error: 'nativeSubagentRuntime.model.mode must be custom' };
  }
  const extra = unknownKey(raw, ['mode', 'value']);
  if (extra) return { ok: false, error: `nativeSubagentRuntime.model.${extra} is unknown` };
  if (typeof raw.value !== 'string') {
    return { ok: false, error: 'nativeSubagentRuntime.model.value must be a string' };
  }
  const value = raw.value.trim();
  if (!value || value.length > MAX_MODEL_LENGTH) {
    return {
      ok: false,
      error: `nativeSubagentRuntime.model.value must be between 1 and ${MAX_MODEL_LENGTH} characters`,
    };
  }
  return { ok: true, value: { mode: 'custom', value } };
}

function normalizeEffortPolicy(raw: unknown):
  | { ok: true; value: NativeSubagentEffortPolicy }
  | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'nativeSubagentRuntime.reasoningEffort must be an object' };
  }
  if (raw.mode !== 'custom') {
    return { ok: false, error: 'nativeSubagentRuntime.reasoningEffort.mode must be custom' };
  }
  const extra = unknownKey(raw, ['mode', 'value']);
  if (extra) return { ok: false, error: `nativeSubagentRuntime.reasoningEffort.${extra} is unknown` };
  if (!isCodexReasoningEffort(raw.value)) {
    return { ok: false, error: 'nativeSubagentRuntime.reasoningEffort.value is invalid' };
  }
  return { ok: true, value: { mode: 'custom', value: raw.value } };
}

export function normalizeNativeSubagentRuntimePolicy(
  raw: unknown,
): NativeSubagentRuntimePolicyNormalization {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) {
    return { ok: false, error: 'nativeSubagentRuntime must be a policy object' };
  }
  const extra = Object.keys(raw).find(key => !POLICY_KEYS.has(key));
  if (extra) return { ok: false, error: `nativeSubagentRuntime.${extra} is unknown` };

  let model: NativeSubagentModelPolicy | undefined;
  if (raw.model !== undefined) {
    const normalized = normalizeModelPolicy(raw.model);
    if (!normalized.ok) return normalized;
    model = normalized.value;
  }

  let reasoningEffort: NativeSubagentEffortPolicy | undefined;
  if (raw.reasoningEffort !== undefined) {
    const normalized = normalizeEffortPolicy(raw.reasoningEffort);
    if (!normalized.ok) return normalized;
    reasoningEffort = normalized.value;
  }

  if (!model && !reasoningEffort) return { ok: true, value: undefined };
  return {
    ok: true,
    value: {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

export function rewriteNativeSubagentSpawnInput(
  input: Record<string, unknown>,
  policy: NativeSubagentRuntimePolicy | undefined,
): NativeSubagentSpawnRewrite {
  const rewritten = { ...input };
  if (!policy?.model && !policy?.reasoningEffort) {
    return { kind: 'unchanged', input: rewritten };
  }

  if (policy.model) {
    rewritten.model_provider = 'trae';
    rewritten.model = policy.model.value;
  }
  if (policy.reasoningEffort) {
    rewritten.reasoning_effort = policy.reasoningEffort.value;
  }

  return { kind: 'rewritten', input: rewritten };
}
