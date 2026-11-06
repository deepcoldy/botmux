import type { CliId } from '../adapters/cli/types.js';
import type { BackendType } from '../adapters/backend/types.js';
import { botAcceptsLaunchModel } from './launch-model-capability.js';
import { cliModelSupportsReasoningEffort, isCodexReasoningEffort, type CodexReasoningEffort } from '../services/codex-reasoning-effort.js';

export interface ModelPin {
  model: string;
  effort?: CodexReasoningEffort;
  source: 'topic-header' | 'command' | 'card';
  setBy: string;
  setAt: string;
}

export function cliMatchesBot(session: { cliId?: string }, bot?: { cliId?: string }): boolean {
  return !session.cliId || !bot?.cliId || session.cliId === bot.cliId;
}

/** Same syntax/capability boundary for all explicit pin writers. */
export function validateModelPin(input: { model: string; effort?: string }, cfg: { cliId?: CliId; backendType?: BackendType }): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*(\[[A-Za-z0-9_.-]+\])?$/.test(input.model) || input.model.length > 64) return '模型名无效（仅支持不含空白的 ASCII 模型 ID，最长 64 字符）';
  if (!botAcceptsLaunchModel(cfg)) return `CLI ${cfg.cliId ?? 'unknown'} / ${cfg.backendType ?? 'default'} 不支持启动模型覆盖`;
  if (input.effort !== undefined && (!isCodexReasoningEffort(input.effort) || !cliModelSupportsReasoningEffort(cfg.cliId, input.model, input.effort))) return `模型 ${input.model} 不支持推理强度 ${input.effort}`;
  return undefined;
}

export function samePinModel(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Omitted effort keeps only an existing choice for this exact model. */
export function retainPinEffort(pin: ModelPin, previous: ModelPin | undefined): ModelPin {
  return pin.effort === undefined && previous?.effort && samePinModel(pin.model, previous.model)
    ? { ...pin, effort: previous.effort } : pin;
}

export function modelPinView(
  session: { cliId?: string; modelPin?: ModelPin; dispatchLaunchSpec?: { effective: { model: string } }; adoptedFrom?: unknown; existingAppServerEndpoint?: string },
  bot?: { cliId?: string },
  launch: { spawnModelOverride?: string; model?: string; effort?: CodexReasoningEffort; currentModel?: string; currentEffort?: string; adopted?: boolean } = {},
) {
  const pin = session.modelPin;
  if (!pin) return undefined;
  const matches = cliMatchesBot(session, bot);
  // An adopted CLI (external pane or a --remote viewer of an App Server thread)
  // is never relaunched with botmux launch args, so a pin cannot apply while
  // adopted. `launch.adopted` carries the live DaemonSession's in-memory flags
  // (ds.adoptedFrom / initConfig.adoptMode); a durable row falls back to its own.
  const adopted = launch.adopted ?? (!!session.adoptedFrom || !!session.existingAppServerEndpoint);
  const shadowedBy = session.dispatchLaunchSpec ? 'dispatch' as const
    : launch.spawnModelOverride ? 'spawn-override' as const : undefined;
  const inactiveReason = adopted ? '会话由外部 CLI 接管，模型固定暂不生效；断开接管后恢复'
    : !matches ? '会话 CLI 与 bot 当前 CLI 不匹配，模型固定已停用' : undefined;
  const shadowNote = shadowedBy ? `模型固定已保存；当前启动优先使用 ${shadowedBy}：${launch.model ?? session.dispatchLaunchSpec?.effective.model ?? launch.spawnModelOverride}${launch.effort ? ` · ${launch.effort}` : ''}。重启仍遵循此优先级` : undefined;
  const effortDowngradeNote = !adopted && matches && shadowedBy !== 'dispatch' && (!shadowedBy || samePinModel(launch.model, pin.model)) && pin.effort && !cliModelSupportsReasoningEffort(session.cliId ?? bot?.cliId, pin.model, pin.effort)
    ? `固定的推理强度 ${pin.effort} 不受支持，已降级；模型固定仍保留` : undefined;
  const pendingEffortNote = !adopted && matches && pin.effort && cliModelSupportsReasoningEffort(session.cliId ?? bot?.cliId, pin.model, pin.effort)
    && launch.currentModel && launch.currentEffort
    && !samePinModel(launch.currentModel, pin.model) && launch.currentEffort !== pin.effort
    ? `当前模型 ${launch.currentModel} 的推理强度选择为 ${launch.currentEffort}；固定模型 ${pin.model} 生效时使用 ${pin.effort}` : undefined;
  return { ...pin, ...(pendingEffortNote ? { pendingEffortNote } : {}), active: matches && !shadowedBy && !adopted, ...(inactiveReason ? { inactiveReason } : {}),
    ...(shadowedBy ? { shadowedBy, shadowNote } : {}), ...(effortDowngradeNote ? { effortDowngradeNote } : {}),
    launchModel: launch.model, launchEffort: launch.effort };
}

export function modelPinText(pin: ReturnType<typeof modelPinView>): string | undefined {
  if (!pin) return undefined;
  return `📌 ${pin.model}${pin.effort ? ` · ${pin.effort}` : ''}（${pin.source}）`
    + [pin.inactiveReason, pin.shadowNote, pin.effortDowngradeNote, pin.pendingEffortNote].filter(Boolean).map(note => ` · ${note}`).join('');
}

export type ModelPinBusyReason = 'transferring' | 'restarting' | 'effort_change';
export class ModelPinBusyError extends Error {
  readonly busySessionIds: string[];
  constructor(readonly busySessions: { sessionId: string; reason: ModelPinBusyReason }[]) {
    super('session_busy');
    this.busySessionIds = busySessions.map(s => s.sessionId);
  }
}
export function modelPinClearError(error: unknown) {
  return error instanceof ModelPinBusyError
    ? { ok: false as const, error: 'session_busy', busySessionIds: error.busySessionIds, busySessions: error.busySessions }
    : { ok: false as const, error: error instanceof Error ? error.message : String(error) };
}
export function modelPinClearErrorText(body: { error?: string; busySessions?: { sessionId: string; reason: string }[]; busySessionIds?: string[] }): string {
  if (body.error !== 'session_busy') return body.error === 'session_not_found'
    ? '会话不存在或不属于当前 Bot，请刷新会话列表后重试' : '解除失败，请刷新后重试';
  const reasons: Record<string, string> = { transferring: '正在迁移', restarting: '正在重启 CLI', effort_change: '正在修改推理强度' };
  const details = body.busySessions?.map(s => `${s.sessionId}（${reasons[s.reason] ?? '正在处理操作'}）`)
    ?? body.busySessionIds ?? [];
  return `本次清除未提交；忙碌会话：${details.join('、')}。请相关操作结束后稍后重试`;
}

/** App thread takeover owns its native model; no BotMux source may leak in. */
export function clearTakeoverModelSources(ds: { session: { model?: string; modelPin?: ModelPin }; spawnModelOverride?: string }): void {
  delete ds.session.model;
  delete ds.session.modelPin;
  delete ds.spawnModelOverride;
}
