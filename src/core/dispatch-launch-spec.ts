import type { BackendType } from '../adapters/backend/types.js';
import type { CliId } from '../adapters/cli/types.js';
import { cliModelSupportsReasoningEffort, isCodexReasoningEffort, type CodexReasoningEffort } from '../services/codex-reasoning-effort.js';
import { botAcceptsLaunchModel } from './launch-model-capability.js';

export async function resolveDispatchLaunchSpec(input: {
  requested: { model?: string; reasoningEffort?: string };
  target: { cliId?: CliId; backendType?: BackendType; model?: string; reasoningEffort?: CodexReasoningEffort };
  detectModels: () => Promise<readonly string[] | null>;
}): Promise<
  | { ok: true; requested: { model?: string; reasoningEffort?: CodexReasoningEffort }; effective: { model: string; reasoningEffort?: CodexReasoningEffort } }
  | { ok: false; error: string }
> {
  const model = input.requested.model?.trim();
  const effort = input.requested.reasoningEffort?.trim().toLowerCase();
  if (input.requested.model !== undefined && !model) return { ok: false, error: '--model 需要非空 catalog id。' };
  if (input.requested.reasoningEffort !== undefined && !isCodexReasoningEffort(effort)) {
    return { ok: false, error: '--reasoning-effort 只接受 low|medium|high|xhigh|max|ultra。' };
  }
  if (!botAcceptsLaunchModel(input.target)) return { ok: false, error: `目标 Bot 的 ${input.target.cliId ?? 'unknown'} 启动路径不支持显式 model。` };
  const effectiveModel = model ?? input.target.model?.trim();
  if (!effectiveModel) return { ok: false, error: '指定 --reasoning-effort 时目标 Bot 必须有可解析的 model。' };
  const catalog = await input.detectModels().catch(() => null);
  if (!catalog?.includes(effectiveModel)) return { ok: false, error: `目标 Bot 的实时 model catalog 不包含 ${effectiveModel}。` };
  const requestedEffort = effort as CodexReasoningEffort | undefined;
  const effectiveEffort = requestedEffort ?? input.target.reasoningEffort;
  if (effectiveEffort && !cliModelSupportsReasoningEffort(input.target.cliId, effectiveModel, effectiveEffort)) {
    return { ok: false, error: `模型 ${effectiveModel} 不支持 reasoning effort ${effectiveEffort}。` };
  }
  return {
    ok: true,
    requested: { ...(model ? { model } : {}), ...(requestedEffort ? { reasoningEffort: requestedEffort } : {}) },
    effective: { model: effectiveModel, ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}) },
  };
}
