import type { TraexQuotaEvidence } from './traex-quota.js';
import {
  reasoningEffortsForCliModel,
  type CodexReasoningEffort,
} from './codex-reasoning-effort.js';

export const TRAEX_AUTO_MODEL_ID = 'auto';
export const TRAEX_AUTO_MODEL_DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
export const TRAEX_AUTO_MODEL_MIN_QUEUE_TIMEOUT_MS = 5_000;
export const TRAEX_AUTO_MODEL_MAX_QUEUE_TIMEOUT_MS = 300_000;
export const TRAEX_AUTO_MODEL_DEFAULT_SWITCH_COOLDOWN_MS = 60_000;
export const TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT = 100;
export const TRAEX_AUTO_MODEL_MAX_OVERLOAD_THRESHOLD_PERCENT = 65_535;
export const TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS = 8_000;
export const TRAEX_AUTO_MODEL_MIN_PREFLIGHT_TIMEOUT_MS = 100;
export const TRAEX_AUTO_MODEL_MAX_PREFLIGHT_TIMEOUT_MS = 30_000;

export interface TraexAutoModelSettings {
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  modelBackendVariant?: 'standard' | 'max';
}

export interface TraexAutoModelPreviousSettings extends TraexAutoModelSettings {
  model?: string;
}

export interface TraexAutoModelConfig {
  enabled: true;
  models: string[];
  /** Omitted preserves the original capacity/queue policy. */
  trigger?: 'capacity' | 'quota';
  /** Keys are concrete model ids. An explicit empty entry follows that model's
   * native defaults; absence preserves legacy shared settings. */
  modelSettings?: Record<string, TraexAutoModelSettings>;
  /** Off by default: a topic retains its selected model across turns. */
  reselectPerTurn?: boolean;
  /** Off by default for compatibility. Capacity mode only. */
  preflightLoadCheck?: boolean;
  /** A load is overloaded only when it is strictly greater than this value. */
  overloadThresholdPercent?: number;
  /** Bounded native model/list read before an independent turn. */
  preflightTimeoutMs?: number;
  /** Unknown candidates never outrank a later known-available candidate. */
  unknownLoadPolicy?: 'skip';
  /** Deterministic fallback when every known pool load is above the threshold. */
  allOverloadedPolicy?: 'lowest_load';
  /** Dashboard restores these overrides when Auto is disabled. Missing fields
   * inherit defaults; older configs without a snapshot also inherit. This is
   * editor metadata and does not participate in the runtime switching policy. */
  previousSettings?: TraexAutoModelPreviousSettings;
  queueTimeoutMs: number;
  switchCooldownMs?: number;
}

export type TraexAutoModelConfigResult = {
  config?: TraexAutoModelConfig;
  error?: string;
};

/**
 * Strict normalizer for the experimental TraeX auto-model pool.
 *
 * The list is an allowlist, not a suggestion list: runtime fallback may only
 * use these entries and preserves their order. Invalid enabled configs are
 * rejected as a whole so a typo cannot silently widen or reorder the pool.
 * Capability tables can lag behind the CLI: validate setting syntax here,
 * leaving model-specific support to the live catalog in Dashboard saves.
 */
export function normalizeTraexAutoModelConfig(raw: unknown): TraexAutoModelConfigResult {
  if (raw === undefined || raw === null || raw === false) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'traexAutoModel must be an object' };
  }
  const value = raw as Record<string, unknown>;
  if (value.enabled !== true) return {};
  if (value.trigger !== undefined && value.trigger !== 'capacity' && value.trigger !== 'quota') {
    return { error: 'traexAutoModel.trigger must be capacity or quota' };
  }
  if (!Array.isArray(value.models)) {
    return { error: 'traexAutoModel.models must be an array' };
  }
  if (value.models.length === 0) {
    return {
      error: 'traexAutoModel.models must contain at least one model',
    };
  }

  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of value.models) {
    if (typeof item !== 'string') {
      return { error: 'traexAutoModel.models entries must be strings' };
    }
    const model = item.trim();
    if (!model || model.length > 256) {
      return { error: 'traexAutoModel.models entries must be 1-256 characters' };
    }
    if (model.toLowerCase() === TRAEX_AUTO_MODEL_ID) {
      return { error: 'traexAutoModel.models cannot contain the virtual auto model' };
    }
    const key = model.toLowerCase();
    if (seen.has(key)) {
      return { error: `traexAutoModel.models contains duplicate model: ${model}` };
    }
    seen.add(key);
    models.push(model);
  }

  let modelSettings: Record<string, TraexAutoModelSettings> | undefined;
  if (value.modelSettings !== undefined) {
    if (!value.modelSettings || typeof value.modelSettings !== 'object' || Array.isArray(value.modelSettings)) {
      return { error: 'traexAutoModel.modelSettings must be an object' };
    }
    modelSettings = {};
    for (const [id, rawSettings] of Object.entries(value.modelSettings)) {
      const model = models.find(candidate => candidate.toLowerCase() === id.trim().toLowerCase());
      if (!model || !rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)
        || Object.prototype.hasOwnProperty.call(modelSettings, model)) {
        return { error: `traexAutoModel.modelSettings has an invalid model entry: ${id}` };
      }
      const settings = rawSettings as Record<string, unknown>;
      const effort = settings.reasoningEffort;
      const variant = settings.modelBackendVariant;
      if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort as string)) {
        return { error: `traexAutoModel.modelSettings.${id}.reasoningEffort is invalid` };
      }
      if (variant !== undefined && variant !== 'standard' && variant !== 'max') {
        return { error: `traexAutoModel.modelSettings.${id}.modelBackendVariant is invalid` };
      }
      // defineProperty safely preserves literal ids such as __proto__.
      Object.defineProperty(modelSettings, model, { enumerable: true, configurable: true, writable: true,
        value: {
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          ...(variant !== undefined ? { modelBackendVariant: variant } : {}),
        },
      });
    }
  }

  let previousSettings: TraexAutoModelPreviousSettings | undefined;
  if (value.previousSettings !== undefined) {
    if (!value.previousSettings || typeof value.previousSettings !== 'object' || Array.isArray(value.previousSettings)) {
      return { error: 'traexAutoModel.previousSettings must be an object' };
    }
    const previous = value.previousSettings as Record<string, unknown>;
    if (previous.model !== undefined && (typeof previous.model !== 'string'
      || previous.model.trim().length > 256 || previous.model.trim().toLowerCase() === TRAEX_AUTO_MODEL_ID)) {
      return { error: 'traexAutoModel.previousSettings.model must be a normal model or empty' };
    }
    if (previous.reasoningEffort !== undefined
      && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(previous.reasoningEffort as string)) {
      return { error: 'traexAutoModel.previousSettings.reasoningEffort is invalid' };
    }
    if (previous.modelBackendVariant !== undefined
      && previous.modelBackendVariant !== 'standard' && previous.modelBackendVariant !== 'max') {
      return { error: 'traexAutoModel.previousSettings.modelBackendVariant is invalid' };
    }
    previousSettings = {
      ...(typeof previous.model === 'string' && previous.model.trim() ? { model: previous.model.trim() } : {}),
      ...(previous.reasoningEffort !== undefined ? { reasoningEffort: previous.reasoningEffort as TraexAutoModelSettings['reasoningEffort'] } : {}),
      ...(previous.modelBackendVariant !== undefined ? { modelBackendVariant: previous.modelBackendVariant } : {}),
    };
  }

  const queueTimeoutMs = value.queueTimeoutMs === undefined
    ? TRAEX_AUTO_MODEL_DEFAULT_QUEUE_TIMEOUT_MS
    : value.queueTimeoutMs;
  if (!Number.isInteger(queueTimeoutMs)
    || (queueTimeoutMs as number) < TRAEX_AUTO_MODEL_MIN_QUEUE_TIMEOUT_MS
    || (queueTimeoutMs as number) > TRAEX_AUTO_MODEL_MAX_QUEUE_TIMEOUT_MS) {
    return {
      error: `traexAutoModel.queueTimeoutMs must be an integer between `
        + `${TRAEX_AUTO_MODEL_MIN_QUEUE_TIMEOUT_MS} and `
        + `${TRAEX_AUTO_MODEL_MAX_QUEUE_TIMEOUT_MS}`,
    };
  }
  const cooldown = value.switchCooldownMs;
  if (value.reselectPerTurn !== undefined && typeof value.reselectPerTurn !== 'boolean') {
    return { error: 'traexAutoModel.reselectPerTurn must be a boolean' };
  }
  if (value.preflightLoadCheck !== undefined && typeof value.preflightLoadCheck !== 'boolean') {
    return { error: 'traexAutoModel.preflightLoadCheck must be a boolean' };
  }
  const preflightLoadCheck = value.preflightLoadCheck === true;
  if (preflightLoadCheck && value.trigger === 'quota') {
    return { error: 'traexAutoModel.preflightLoadCheck is supported only for capacity mode' };
  }
  const overloadThresholdPercent = value.overloadThresholdPercent
    ?? TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT;
  if (!Number.isInteger(overloadThresholdPercent)
    || (overloadThresholdPercent as number) < 0
    || (overloadThresholdPercent as number) > TRAEX_AUTO_MODEL_MAX_OVERLOAD_THRESHOLD_PERCENT) {
    return { error: `traexAutoModel.overloadThresholdPercent must be an integer between 0 and ${TRAEX_AUTO_MODEL_MAX_OVERLOAD_THRESHOLD_PERCENT}` };
  }
  const preflightTimeoutMs = value.preflightTimeoutMs
    ?? TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS;
  if (!Number.isInteger(preflightTimeoutMs)
    || (preflightTimeoutMs as number) < TRAEX_AUTO_MODEL_MIN_PREFLIGHT_TIMEOUT_MS
    || (preflightTimeoutMs as number) > TRAEX_AUTO_MODEL_MAX_PREFLIGHT_TIMEOUT_MS) {
    return { error: `traexAutoModel.preflightTimeoutMs must be an integer between ${TRAEX_AUTO_MODEL_MIN_PREFLIGHT_TIMEOUT_MS} and ${TRAEX_AUTO_MODEL_MAX_PREFLIGHT_TIMEOUT_MS}` };
  }
  if (value.unknownLoadPolicy !== undefined && value.unknownLoadPolicy !== 'skip') {
    return { error: 'traexAutoModel.unknownLoadPolicy must be skip' };
  }
  if (value.allOverloadedPolicy !== undefined && value.allOverloadedPolicy !== 'lowest_load') {
    return { error: 'traexAutoModel.allOverloadedPolicy must be lowest_load' };
  }
  if (cooldown !== undefined && (!Number.isInteger(cooldown)
    || (cooldown as number) < 5_000 || (cooldown as number) > 300_000)) {
    return { error: 'traexAutoModel.switchCooldownMs must be an integer between 5000 and 300000' };
  }

  return {
    config: {
      enabled: true,
      models,
      ...(value.trigger !== undefined ? { trigger: value.trigger as 'capacity' | 'quota' } : {}),
      ...(modelSettings ? { modelSettings } : {}),
      ...(value.reselectPerTurn !== undefined ? { reselectPerTurn: value.reselectPerTurn as boolean } : {}),
      ...(value.preflightLoadCheck !== undefined ? { preflightLoadCheck } : {}),
      ...(preflightLoadCheck || value.overloadThresholdPercent !== undefined
        ? { overloadThresholdPercent: overloadThresholdPercent as number } : {}),
      ...(preflightLoadCheck || value.preflightTimeoutMs !== undefined
        ? { preflightTimeoutMs: preflightTimeoutMs as number } : {}),
      ...(preflightLoadCheck || value.unknownLoadPolicy !== undefined
        ? { unknownLoadPolicy: 'skip' as const } : {}),
      ...(preflightLoadCheck || value.allOverloadedPolicy !== undefined
        ? { allOverloadedPolicy: 'lowest_load' as const } : {}),
      ...(previousSettings !== undefined ? { previousSettings } : {}),
      queueTimeoutMs: queueTimeoutMs as number,
      ...(cooldown !== undefined ? { switchCooldownMs: cooldown as number } : {}),
    },
  };
}

export function resolveTraexAutoModelSettings(
  config: TraexAutoModelConfig,
  model: string,
  legacy: TraexAutoModelSettings = {},
): TraexAutoModelSettings {
  const entry = config.modelSettings && Object.entries(config.modelSettings).find(
    ([key]) => key.toLowerCase() === model.toLowerCase(),
  );
  return { ...(entry ? entry[1] : legacy) };
}

export function traexAutoModelPreflightEnabled(config: TraexAutoModelConfig): boolean {
  return config.trigger !== 'quota' && config.preflightLoadCheck === true;
}

/** Prefer max/xhigh for the deep-reasoning models that advertise them, while
 * still honoring the actual highest effort of every other catalog model. */
export function strongestTraexPreflightReasoningEffort(
  model: string,
  advertised?: readonly string[],
): CodexReasoningEffort | undefined {
  const efforts = advertised ?? reasoningEffortsForCliModel('traex', model);
  return (['max', 'xhigh', 'high', 'medium', 'low'] as const)
    .find(effort => efforts.includes(effort));
}

export function resolveTraexAutoModelRuntimeSettings(
  config: TraexAutoModelConfig,
  model: string,
  legacy: TraexAutoModelSettings = {},
  advertised?: readonly CodexReasoningEffort[],
): TraexAutoModelSettings {
  const settings = resolveTraexAutoModelSettings(config, model, legacy);
  if (!traexAutoModelPreflightEnabled(config)) return settings;
  const strongest = advertised === undefined && settings.reasoningEffort === 'max'
    ? 'max'
    : strongestTraexPreflightReasoningEffort(model, advertised);
  return strongest ? { ...settings, reasoningEffort: strongest } : settings;
}

export interface TraexAutoModelRuntimeState {
  model: string;
  waitingOnFinalModel: boolean;
  policyKey: string;
  nativeSessionId: string;
  skillCatalogFingerprint?: string;
  sharedSettings?: TraexAutoModelSettings;
  quotaBlocks?: Array<{ model: string; resetAtMs?: number }>;
  stoppedRecoveryTurnId?: string;
  modelAccessRecovery?: {
    turnId: string;
    blockedModels: string[];
    queuedModels: string[];
    queuePositions?: Array<{ model: string; position: number; atMs: number }>;
  };
}

export function traexAutoModelPolicyKey(config: TraexAutoModelConfig): string {
  return JSON.stringify([config.models, config.reselectPerTurn === true,
    config.queueTimeoutMs, config.switchCooldownMs ?? TRAEX_AUTO_MODEL_DEFAULT_SWITCH_COOLDOWN_MS,
    config.models.map(model => {
      const settings = resolveTraexAutoModelSettings(config, model);
      return [Object.prototype.hasOwnProperty.call(config.modelSettings ?? {}, model),
        settings.reasoningEffort ?? null, settings.modelBackendVariant ?? null];
    }), ...(config.trigger === 'quota' ? ['quota'] : []),
    ...(traexAutoModelPreflightEnabled(config) ? [{
      preflightLoadCheck: true,
      overloadThresholdPercent: config.overloadThresholdPercent
        ?? TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT,
      preflightTimeoutMs: config.preflightTimeoutMs
        ?? TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS,
      unknownLoadPolicy: config.unknownLoadPolicy ?? 'skip',
      allOverloadedPolicy: config.allOverloadedPolicy ?? 'lowest_load',
    }] : [])]);
}

export function validTraexAutoModelRuntime(
  config: TraexAutoModelConfig, state: TraexAutoModelRuntimeState | undefined,
  nativeSessionId: string | undefined,
): state is TraexAutoModelRuntimeState {
  return !!state && !!nativeSessionId && state.nativeSessionId === nativeSessionId
    && state.policyKey === traexAutoModelPolicyKey(config)
    && typeof state.waitingOnFinalModel === 'boolean' && config.models.includes(state.model);
}

export type TraexAutoModelAction =
  | { kind: 'none' }
  | { kind: 'load_check'; turnId: string }
  | {
      kind: 'switch';
      reason: 'new_turn' | 'quota_exhausted' | 'capacity_timeout' | 'queued_backup' | 'available_model' | 'shortest_queue' | 'lowest_load' | 'preflight_available' | 'preflight_lowest_load' | 'model_access_restricted';
      turnId: string;
      fromModel: string;
      toModel: string;
      toIndex: number;
      queuePosition?: number;
      loadPercent?: number;
      restrictionRecovery?: true;
    }
  | {
      kind: 'exhausted';
      turnId: string;
      model: string;
      modelCount: number;
      queuePosition?: number;
      loadPercent?: number;
      restrictionRecovery?: true;
    };

export type TraexAutoModelPreflightDecision =
  | {
      kind: 'keep';
      reason: 'disabled' | 'load_unavailable' | 'within_threshold';
      model: string;
      checkedModel: string;
      checkedLoadPercent?: number;
      loadPercent?: number;
    }
  | {
      kind: 'hold';
      reason: 'lowest_load';
      model: string;
      checkedModel: string;
      checkedLoadPercent: number;
      loadPercent: number;
    }
  | (Extract<TraexAutoModelAction, { kind: 'switch' }> & {
      reason: 'preflight_available' | 'preflight_lowest_load';
      checkedModel: string;
      checkedLoadPercent: number;
    });

/**
 * Worker-local ordered pool state.
 *
 * It intentionally never discovers or appends models. Prefer the first later
 * model whose load allows an attempt (<=100%, or unknown). If that attempt
 * queues, continue forward after brief confirmation. A topic keeps its model
 * and final-wait decision unless per-turn reselection is explicitly enabled.
 */
export class TraexAutoModelController {
  private currentIndex = 0;
  private turnId: string | undefined;
  private queueSinceMs: number | undefined;
  /** Latest live "this pane is parked in a capacity queue" observation. */
  private liveCapacityQueued = false;
  private exhausted = false;
  private lastSwitchAtMs: number | undefined;
  private queuePositions = new Map<number, { position: number; atMs: number }>();
  private loadCheckDone = false;
  private loadCheckPending = false;
  private searchingBackups = false;
  private progressSinceMs: number | undefined;
  private awaitingActivity = false;
  private quotaBlocks = new Map<string, { resetAtMs?: number }>();
  private modelAccessRecoveryTurnId: string | undefined;
  private stoppedRecoveryTurnId: string | undefined;
  private accessBlockedModels = new Set<number>();
  private accessQueuedModels = new Set<number>();

  readonly sharedSettings?: TraexAutoModelSettings;

  constructor(readonly config: TraexAutoModelConfig, restored?: TraexAutoModelRuntimeState,
    sharedSettings?: TraexAutoModelSettings) {
    this.sharedSettings = sharedSettings === undefined ? undefined : { ...sharedSettings };
    if (restored && restored.policyKey === traexAutoModelPolicyKey(config)
      && config.models.includes(restored.model)) {
      if (restored.sharedSettings) this.sharedSettings = { ...restored.sharedSettings };
      this.currentIndex = config.models.indexOf(restored.model);
      this.exhausted = restored.waitingOnFinalModel;
      const access = restored.modelAccessRecovery;
      if (access && typeof access.turnId === 'string' && access.turnId
        && Array.isArray(access.blockedModels) && Array.isArray(access.queuedModels)) {
        this.turnId = this.modelAccessRecoveryTurnId = access.turnId;
        this.awaitingActivity = true;
        this.searchingBackups = !this.exhausted;
        for (const model of access.blockedModels) {
          const index = config.models.indexOf(model);
          if (index >= 0) this.accessBlockedModels.add(index);
        }
        for (const model of access.queuedModels) {
          const index = config.models.indexOf(model);
          if (index >= 0 && !this.accessBlockedModels.has(index)) this.accessQueuedModels.add(index);
        }
        if (Array.isArray(access.queuePositions)) {
          const nowMs = Date.now();
          for (const evidence of access.queuePositions) {
            if (!evidence || typeof evidence !== 'object') continue;
            const index = config.models.indexOf(evidence.model);
            if (this.accessQueuedModels.has(index) && Number.isSafeInteger(evidence.position)
              && evidence.position >= 0 && Number.isFinite(evidence.atMs) && evidence.atMs >= 0
              && evidence.atMs <= nowMs && nowMs - evidence.atMs <= 10 * 60_000) {
              this.queuePositions.set(index, { position: evidence.position, atMs: evidence.atMs });
            }
          }
        }
      }
      if (typeof restored.stoppedRecoveryTurnId === 'string' && restored.stoppedRecoveryTurnId
        && (!this.turnId || this.turnId === restored.stoppedRecoveryTurnId)) {
        this.turnId = this.stoppedRecoveryTurnId = restored.stoppedRecoveryTurnId;
      }
      if (config.trigger === 'quota' && Array.isArray(restored.quotaBlocks)) {
        for (const block of restored.quotaBlocks) {
          if (config.models.includes(block.model)) this.quotaBlocks.set(block.model, {
            ...(typeof block.resetAtMs === 'number' && Number.isFinite(block.resetAtMs)
              ? { resetAtMs: block.resetAtMs } : {}),
          });
        }
      }
    }
  }

  runtimeState(nativeSessionId: string): TraexAutoModelRuntimeState {
    return { model: this.currentModel(), waitingOnFinalModel: this.exhausted,
      policyKey: traexAutoModelPolicyKey(this.config), nativeSessionId,
      ...(this.config.trigger === 'quota' ? { quotaBlocks: [...this.quotaBlocks].map(([model, block]) => ({ model, ...block })) } : {}),
      ...(this.stoppedRecoveryTurnId ? { stoppedRecoveryTurnId: this.stoppedRecoveryTurnId } : {}),
      ...(this.modelAccessRecoveryTurnId ? { modelAccessRecovery: {
        turnId: this.modelAccessRecoveryTurnId,
        blockedModels: [...this.accessBlockedModels].map(index => this.config.models[index]!),
        queuedModels: [...this.accessQueuedModels].map(index => this.config.models[index]!),
        queuePositions: [...this.queuePositions].filter(([index]) => this.accessQueuedModels.has(index)
          && !this.accessBlockedModels.has(index)).map(([index, evidence]) => ({
          model: this.config.models[index]!, ...evidence,
        })),
      } } : {}),
      ...(this.sharedSettings !== undefined ? { sharedSettings: { ...this.sharedSettings } } : {}) };
  }

  /** A live persistent pane may predate this controller after a worker update. */
  observeRunningModel(model: string): void {
    const index = this.config.models.findIndex(candidate => candidate.toLowerCase() === model.toLowerCase());
    if (index < 0 || index === this.currentIndex) return;
    this.currentIndex = index;
    this.exhausted = false;
    this.searchingBackups = false;
    this.queueSinceMs = undefined;
    this.liveCapacityQueued = false;
  }

  currentModel(): string {
    return this.config.models[this.currentIndex]!;
  }

  currentModelIndex(): number {
    return this.currentIndex;
  }

  /** Read-only admission decision for one independent turn. Unknown loads are
   * skipped; if no known model is under the threshold, known loads are ranked
   * with pool order as the stable tie-breaker. The caller commits a switch only
   * after it has proven that the exact queued input and native session remain
   * eligible. */
  preflightDecision(
    turnId: string,
    loads: ReadonlyMap<string, number> | null,
    options: { preferFirstModel?: boolean } = {},
  ): TraexAutoModelPreflightDecision {
    const currentModel = this.currentModel();
    if (this.modelAccessRecoveryTurnId === turnId || this.recoveryStopped(turnId)) {
      return { kind: 'keep', reason: 'disabled', model: currentModel, checkedModel: currentModel };
    }
    const checkedIndex = options.preferFirstModel ? 0 : this.currentIndex;
    const checkedModel = this.config.models[checkedIndex]!;
    if (!traexAutoModelPreflightEnabled(this.config)) {
      return { kind: 'keep', reason: 'disabled', model: currentModel, checkedModel };
    }
    const threshold = this.config.overloadThresholdPercent
      ?? TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT;
    const loadAt = (index: number): number | undefined => {
      const value = loads?.get(this.config.models[index]!.toLowerCase());
      return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const checkedLoad = loadAt(checkedIndex);
    if (checkedLoad === undefined) {
      return { kind: 'keep', reason: 'load_unavailable', model: currentModel, checkedModel };
    }

    let selectedIndex = checkedIndex;
    let selectedLoad = checkedLoad;
    let reason: 'preflight_available' | 'preflight_lowest_load' = 'preflight_available';
    if (checkedLoad > threshold) {
      selectedIndex = -1;
      for (let index = 0; index < this.config.models.length; index++) {
        if (index === checkedIndex) continue;
        const candidateLoad = loadAt(index);
        if (candidateLoad !== undefined && candidateLoad <= threshold) {
          selectedIndex = index;
          selectedLoad = candidateLoad;
          break;
        }
      }
      if (selectedIndex < 0) {
        reason = 'preflight_lowest_load';
        selectedIndex = -1;
        selectedLoad = Infinity;
        for (let index = 0; index < this.config.models.length; index++) {
          const candidateLoad = loadAt(index);
          if (candidateLoad !== undefined && candidateLoad < selectedLoad) {
            selectedIndex = index;
            selectedLoad = candidateLoad;
          }
        }
        if (selectedIndex < 0) {
          selectedIndex = checkedIndex;
          selectedLoad = checkedLoad;
        }
      }
    }

    if (selectedIndex === this.currentIndex) {
      if (reason === 'preflight_lowest_load') {
        return { kind: 'hold', reason: 'lowest_load', model: currentModel, checkedModel,
          checkedLoadPercent: checkedLoad, loadPercent: selectedLoad };
      }
      return { kind: 'keep', reason: 'within_threshold', model: currentModel, checkedModel,
        checkedLoadPercent: checkedLoad, loadPercent: selectedLoad };
    }
    return {
      kind: 'switch', reason, turnId, fromModel: currentModel,
      toModel: this.config.models[selectedIndex]!, toIndex: selectedIndex,
      loadPercent: selectedLoad, checkedModel, checkedLoadPercent: checkedLoad,
    };
  }

  hasQuotaBlocks(): boolean {
    return this.quotaBlocks.size > 0;
  }

  currentTurnId(): string | undefined {
    return this.turnId;
  }

  queueObserved(): boolean {
    return this.queueSinceMs !== undefined || this.exhausted;
  }

  /** Capacity still owns the live input surface: either a queue-confirmation
   *  window is open, or the pool was declared exhausted while the pane is
   *  STILL parked in the queue (the exhausted latch outlives queueSinceMs,
   *  which both walk-off branches clear at the moment of exhaustion). */
  capacityCurrentlyBlocking(): boolean {
    return this.queueSinceMs !== undefined || (this.exhausted && this.liveCapacityQueued);
  }

  /**
   * The pool is exhausted on a non-preferred model while per-turn reselection
   * is on: an independent follow-up turn must wait for the preferred-model
   * reset instead of being written into the current degraded model.
   *
   * Unlike {@link capacityCurrentlyBlocking} this deliberately ignores the
   * pane observation (`liveCapacityQueued`): the degraded CLI returns to its
   * composer and stops painting the capacity queue frame well before the
   * preferred relaunch, so a screen-only latch lets the follow-up slip through
   * as type-ahead onto the wrong model. The `exhausted` flag itself is cleared
   * by the reselection switch, so this cannot hold past the reset. Off when
   * reselection is disabled (the exhausted latch then correctly outlives the
   * pane for the whole session). */
  awaitingPreferredModelReset(): boolean {
    return this.exhausted === true
      && this.config.reselectPerTurn === true
      && this.currentIndex > 0;
  }

  /** A resumed continuation must show activity before queued corrections can
   * follow it; process startup alone does not finish a capacity transition. */
  awaitingModelActivity(): boolean {
    return this.awaitingActivity;
  }

  modelProgressConfirmed(): boolean {
    return this.progressSinceMs !== undefined && Date.now() - this.progressSinceMs >= 2_000;
  }

  modelAccessRecoveryActive(): boolean {
    return this.turnId !== undefined && this.modelAccessRecoveryTurnId === this.turnId;
  }

  requestRecoveryStop(turnId: string): boolean {
    if (turnId !== this.turnId) return false;
    this.stoppedRecoveryTurnId = turnId;
    return true;
  }

  recoveryStopped(turnId: string): boolean {
    return this.stoppedRecoveryTurnId === turnId;
  }

  /** Submission can leave the previous composer visible until the first
   * native activity frame. Keep follow-ups outside the CLI during that gap. */
  markInputSubmitted(turnId: string): void {
    if (turnId === this.turnId) this.awaitingActivity = true;
  }

  /** An unplanned process death can never paint the activity frame a
   *  submitted input was waiting for: the crash-restarted process evaluates
   *  the turn afresh, so its recovery input must not be held for a dead
   *  process's frame. A PLANNED model switch keeps the latch — its
   *  replacement owns the same waiting window and buffering contract. */
  noteProcessExited(planned: boolean): void {
    if (!planned) this.awaitingActivity = false;
  }

  beginTurn(turnId: string, options: { retainCurrentModel?: boolean } = {}): TraexAutoModelAction {
    if (!turnId || this.turnId === turnId) return { kind: 'none' };
    if (this.stoppedRecoveryTurnId !== turnId) this.stoppedRecoveryTurnId = undefined;
    if (this.modelAccessRecoveryTurnId !== turnId) {
      if (this.modelAccessRecoveryTurnId) this.exhausted = false;
      this.modelAccessRecoveryTurnId = undefined;
      this.accessBlockedModels.clear();
      this.accessQueuedModels.clear();
    }
    const fromModel = this.currentModel();
    if (this.config.trigger === 'quota' && !options.retainCurrentModel) {
      this.turnId = turnId;
      this.awaitingActivity = false;
      const toIndex = this.config.models.findIndex(model => !this.quotaBlocked(model, Date.now()));
      if (toIndex < 0) return { kind: 'exhausted', turnId, model: fromModel, modelCount: this.config.models.length };
      if (toIndex === this.currentIndex) return { kind: 'none' };
      return { kind: 'switch', reason: 'new_turn', turnId, fromModel, toModel: this.config.models[toIndex]!, toIndex };
    }
    if (options.retainCurrentModel || !this.config.reselectPerTurn || this.currentIndex === 0) {
      this.turnId = turnId;
      this.queueSinceMs = undefined;
      this.liveCapacityQueued = false;
      if (this.config.reselectPerTurn) this.exhausted = false;
      this.searchingBackups = false;
      this.progressSinceMs = undefined;
      this.queuePositions.clear();
      this.loadCheckDone = false;
      this.loadCheckPending = false;
      return { kind: 'none' };
    }
    return {
      kind: 'switch',
      reason: 'new_turn',
      turnId,
      fromModel,
      toModel: this.config.models[0]!,
      toIndex: 0,
    };
  }

  private quotaBlocked(model: string, nowMs: number): boolean {
    const block = this.quotaBlocks.get(model);
    if (!block) return false;
    if (block.resetAtMs !== undefined && block.resetAtMs <= nowMs) {
      this.quotaBlocks.delete(model);
      return false;
    }
    return true;
  }

  /** Native failure wins over an older catalog's optimistic reading. Only
   * later entries are eligible in this recovery; no load ranking or wraparound. */
  refreshQuotaEvidence(quotas: ReadonlyMap<string, TraexQuotaEvidence> | null, nowMs = Date.now()): void {
    for (const model of this.config.models) {
      const evidence = quotas?.get(model.toLowerCase());
      if (evidence?.depleted === true) this.quotaBlocks.set(model, {
        ...(evidence.resetAtMs !== undefined && evidence.resetAtMs > nowMs ? { resetAtMs: evidence.resetAtMs } : {}),
      });
      else if (evidence?.depleted === false) this.quotaBlocks.delete(model);
    }
  }

  observeQuotaFailure(turnId: string, quotas: ReadonlyMap<string, TraexQuotaEvidence> | null,
    nowMs = Date.now()): TraexAutoModelAction {
    if (this.config.trigger !== 'quota' || turnId !== this.turnId || this.recoveryStopped(turnId)) return { kind: 'none' };
    this.refreshQuotaEvidence(quotas, nowMs);
    if (!this.quotaBlocks.has(this.currentModel())) this.quotaBlocks.set(this.currentModel(), {});
    for (let index = this.currentIndex + 1; index < this.config.models.length; index++) {
      if (this.quotaBlocked(this.config.models[index]!, nowMs)) continue;
      return { kind: 'switch', reason: 'quota_exhausted', turnId, fromModel: this.currentModel(),
        toModel: this.config.models[index]!, toIndex: index };
    }
    return { kind: 'exhausted', turnId, model: this.currentModel(), modelCount: this.config.models.length };
  }

  /** A native access refusal excludes only the attempted model, not its family.
   * Queue candidates must have real queue evidence before a final wait. */
  recordUnavailableModel(turnId: string): boolean {
    if (turnId !== this.turnId || this.recoveryStopped(turnId)) return false;
    this.modelAccessRecoveryTurnId = turnId;
    this.accessBlockedModels.add(this.currentIndex);
    this.accessQueuedModels.delete(this.currentIndex);
    this.queuePositions.delete(this.currentIndex);
    for (const index of this.queuePositions.keys()) {
      if (!this.accessBlockedModels.has(index)) this.accessQueuedModels.add(index);
    }
    this.exhausted = false;
    this.searchingBackups = true;
    this.queueSinceMs = undefined;
    this.liveCapacityQueued = false;
    this.loadCheckPending = false;
    return true;
  }

  observeModelAccessFailure(turnId: string, loads: ReadonlyMap<string, number> | null): TraexAutoModelAction {
    if (!this.recordUnavailableModel(turnId)) return { kind: 'none' };
    return this.selectModelAccessCandidate(turnId, loads);
  }

  private selectModelAccessCandidate(turnId: string, loads: ReadonlyMap<string, number> | null): TraexAutoModelAction {
    const loadAt = (index: number): number | undefined => {
      const value = loads?.get(this.config.models[index]!.toLowerCase());
      return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const blocked = (index: number) => this.accessBlockedModels.has(index)
      || this.quotaBlocked(this.config.models[index]!, Date.now());
    const untried: number[] = [];
    for (let offset = 1; offset <= this.config.models.length; offset++) {
      const index = (this.currentIndex + offset) % this.config.models.length;
      if (!blocked(index) && !this.accessQueuedModels.has(index)) untried.push(index);
    }
    const threshold = this.config.overloadThresholdPercent ?? TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT;
    const index = untried.find(candidate => loadAt(candidate) === undefined || loadAt(candidate)! <= threshold)
      ?? untried[0];
    if (index !== undefined) {
      const percent = loadAt(index);
      return { kind: 'switch', reason: percent !== undefined && percent <= threshold
        ? 'available_model' : 'model_access_restricted', restrictionRecovery: true,
        turnId, fromModel: this.currentModel(), toModel: this.config.models[index]!, toIndex: index,
        ...(percent !== undefined ? { loadPercent: percent } : {}) };
    }
    const queued = [...this.accessQueuedModels].filter(candidate => !blocked(candidate))
      .sort((a, b) => a - b);
    if (!queued.length) {
      this.exhausted = true;
      return { kind: 'exhausted', restrictionRecovery: true, turnId,
        model: this.currentModel(), modelCount: this.config.models.length };
    }
    let best = queued.includes(this.currentIndex) ? this.currentIndex : queued.at(-1)!;
    let reason: 'lowest_load' | 'shortest_queue' = 'shortest_queue';
    let position = Infinity;
    if (queued.every(candidate => loadAt(candidate) !== undefined)) {
      reason = 'lowest_load';
      best = queued[0]!;
      for (const candidate of queued) if (loadAt(candidate)! < loadAt(best)!) best = candidate;
    } else {
      for (const candidate of queued) {
        const evidence = this.queuePositions.get(candidate);
        if (evidence && evidence.atMs <= Date.now() && Date.now() - evidence.atMs <= 10 * 60_000
          && evidence.position < position) { best = candidate; position = evidence.position; }
      }
    }
    const evidence = { ...(loadAt(best) !== undefined ? { loadPercent: loadAt(best) } : {}),
      ...(Number.isFinite(position) ? { queuePosition: position } : {}) };
    if (best === this.currentIndex) {
      this.exhausted = true;
      return { kind: 'exhausted', restrictionRecovery: true, turnId,
        model: this.currentModel(), modelCount: queued.length, ...evidence };
    }
    return { kind: 'switch', reason, restrictionRecovery: true, turnId,
      fromModel: this.currentModel(), toModel: this.config.models[best]!, toIndex: best, ...evidence };
  }

  /** Advance only after the host has admitted the exact native-session restart.
   * Refused proposals leave the real running model and controller in agreement. */
  commitSwitch(action: Extract<TraexAutoModelAction, { kind: 'switch' }>, nowMs = Date.now()): boolean {
    const admissionSwitch = action.reason === 'new_turn'
      || action.reason === 'preflight_available'
      || action.reason === 'preflight_lowest_load';
    if (action.fromModel !== this.currentModel()
      || this.config.models[action.toIndex] !== action.toModel
      || this.accessBlockedModels.has(action.toIndex) || this.recoveryStopped(action.turnId)
      || (!admissionSwitch && action.turnId !== this.turnId)) {
      return false;
    }
    this.currentIndex = action.toIndex;
    this.turnId = action.turnId;
    this.queueSinceMs = undefined;
    this.liveCapacityQueued = false;
    this.exhausted = action.reason === 'shortest_queue' || action.reason === 'lowest_load';
    const preflight = action.reason === 'preflight_available' || action.reason === 'preflight_lowest_load';
    this.searchingBackups = action.reason !== 'new_turn' && !preflight && !this.exhausted;
    this.awaitingActivity = action.reason !== 'new_turn' && !preflight;
    this.progressSinceMs = undefined;
    // Admission happens before inference and is not a completed queue episode;
    // it must not consume the runtime queue fallback's cooldown window.
    this.lastSwitchAtMs = preflight ? undefined : nowMs;
    this.loadCheckDone = false;
    this.loadCheckPending = false;
    if (action.reason === 'new_turn') {
      this.queuePositions.clear();
    }
    return true;
  }

  endTurn(turnId: string): void {
    if (this.turnId !== turnId) return;
    this.stoppedRecoveryTurnId = undefined;
    if (this.modelAccessRecoveryTurnId) this.exhausted = false;
    this.modelAccessRecoveryTurnId = undefined;
    this.accessBlockedModels.clear();
    this.accessQueuedModels.clear();
    this.awaitingActivity = false;
    this.turnId = undefined;
    this.queueSinceMs = undefined;
    // liveCapacityQueued describes the PANE, not the turn: a structured
    // terminal does not repaint the queued pane, so keep that fact across
    // endTurn until the next beginTurn/commitSwitch/observeRunningModel.
    this.searchingBackups = false;
    this.progressSinceMs = undefined;
    this.queuePositions.clear();
    this.loadCheckDone = false;
    this.loadCheckPending = false;
  }

  /** Read once per attempted model after sustained queueing. A load snapshot
   * is only an availability hint: an earlier <=100% backup beats a later,
   * lighter backup. Missing loads require an ordered attempt, not an invented
   * zero. Reaching the end with complete data chooses one final lowest-load
   * wait, with preference order breaking ties. */
  resolveModelLoads(turnId: string, loads: ReadonlyMap<string, number> | null): TraexAutoModelAction {
    if (turnId !== this.turnId || !this.loadCheckPending || this.recoveryStopped(turnId)) return { kind: 'none' };
    this.loadCheckPending = false;
    if (this.queueSinceMs === undefined) return { kind: 'none' };
    this.loadCheckDone = true;
    if (this.modelAccessRecoveryTurnId === turnId) return this.selectModelAccessCandidate(turnId, loads);
    if (!loads) return { kind: 'none' };
    const loadAt = (index: number): number | undefined => {
      const value = loads.get(this.config.models[index]!.toLowerCase());
      return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    for (let index = this.currentIndex + 1; index < this.config.models.length; index++) {
      const percent = loadAt(index);
      if (percent === undefined || percent <= 100) {
        return { kind: 'switch', reason: percent === undefined
          ? this.searchingBackups ? 'queued_backup' : 'capacity_timeout' : 'available_model',
          turnId, fromModel: this.currentModel(), toModel: this.config.models[index]!, toIndex: index,
          ...(percent !== undefined ? { loadPercent: percent } : {}) };
      }
    }
    // Do not rank incomplete snapshots. Sequential fallback can still observe
    // real queue positions and finish with a bounded final queue-rank choice.
    if (this.config.models.some((_, index) => loadAt(index) === undefined)) return { kind: 'none' };
    let bestIndex = -1;
    let bestLoad = Infinity;
    this.config.models.forEach((_, index) => {
      const percent = loadAt(index)!;
      if (percent < bestLoad) {
        bestIndex = index;
        bestLoad = percent;
      }
    });
    if (bestIndex < 0) return { kind: 'none' };
    if (bestIndex === this.currentIndex) {
      this.exhausted = true;
      return { kind: 'exhausted', turnId, model: this.currentModel(),
        modelCount: this.config.models.length, loadPercent: bestLoad };
    }
    return { kind: 'switch', reason: 'lowest_load', turnId,
      fromModel: this.currentModel(), toModel: this.config.models[bestIndex]!,
      toIndex: bestIndex, loadPercent: bestLoad };
  }

  observeCapacityQueue(input: {
    turnId: string | undefined;
    queued: boolean;
    progressing?: boolean;
    nowMs: number;
    queuePosition?: number;
  }): TraexAutoModelAction {
    if (input.turnId && this.recoveryStopped(input.turnId)) return { kind: 'none' };
    if (this.config.trigger === 'quota' && !this.modelAccessRecoveryTurnId) {
      if (input.turnId === this.turnId && (input.queued || input.progressing)) this.awaitingActivity = false;
      return { kind: 'none' };
    }
    // Record the live viewport fact before any early return: the exhausted
    // latch outlives queueSinceMs, so "still parked in the queue" is an
    // observation of the current pane, independent of turn-id ownership.
    this.liveCapacityQueued = input.queued;
    if (!input.turnId || input.turnId !== this.turnId) return { kind: 'none' };
    if (input.queued || input.progressing) this.awaitingActivity = false;
    if (!input.queued) {
      this.queueSinceMs = undefined;
      // Startup frames alone do not prove that a backup has left its queue.
      if (input.progressing) {
        this.progressSinceMs ??= input.nowMs;
        if (input.nowMs - this.progressSinceMs >= 2_000) this.searchingBackups = false;
      } else this.progressSinceMs = undefined;
      return { kind: 'none' };
    }
    this.progressSinceMs = undefined;
    if (!this.accessBlockedModels.has(this.currentIndex)) this.accessQueuedModels.add(this.currentIndex);
    if (Number.isSafeInteger(input.queuePosition) && input.queuePosition! >= 0) {
      this.queuePositions.set(this.currentIndex, { position: input.queuePosition!, atMs: input.nowMs });
    }
    if (this.exhausted || this.loadCheckPending) return { kind: 'none' };
    if (this.queueSinceMs === undefined) {
      this.queueSinceMs = input.nowMs;
      return { kind: 'none' };
    }
    const confirmationMs = this.searchingBackups ? 1_000 : this.config.queueTimeoutMs;
    if (input.nowMs - this.queueSinceMs < confirmationMs) {
      return { kind: 'none' };
    }
    if (!this.searchingBackups && this.lastSwitchAtMs !== undefined && input.nowMs - this.lastSwitchAtMs
      < (this.config.switchCooldownMs ?? TRAEX_AUTO_MODEL_DEFAULT_SWITCH_COOLDOWN_MS)) {
      return { kind: 'none' };
    }
    if (!this.loadCheckDone) {
      this.loadCheckPending = true;
      return { kind: 'load_check', turnId: input.turnId };
    }

    if (this.modelAccessRecoveryTurnId === input.turnId) {
      this.queueSinceMs = undefined;
      return this.selectModelAccessCandidate(input.turnId, null);
    }
    const nextIndex = this.currentIndex + 1;
    this.queueSinceMs = undefined;
    if (nextIndex >= this.config.models.length) {
      // Compare recent actual queue ranks, never the elapsed spinner duration.
      // Preserve preference order for ties; unknown/stale ranks cannot win.
      let bestIndex = this.currentIndex;
      let bestPosition = Infinity;
      for (const [index, evidence] of this.queuePositions) {
        if (input.nowMs - evidence.atMs > 10 * 60_000) continue;
        if (evidence.position < bestPosition || (evidence.position === bestPosition && index < bestIndex)) {
          bestIndex = index;
          bestPosition = evidence.position;
        }
      }
      if (bestIndex !== this.currentIndex) {
        return {
          kind: 'switch', reason: 'shortest_queue', turnId: input.turnId,
          fromModel: this.currentModel(), toModel: this.config.models[bestIndex]!,
          toIndex: bestIndex, queuePosition: bestPosition,
        };
      }
      this.exhausted = true;
      return {
        kind: 'exhausted',
        turnId: input.turnId,
        model: this.currentModel(),
        modelCount: this.config.models.length,
        ...(Number.isFinite(bestPosition) ? { queuePosition: bestPosition } : {}),
      };
    }

    const fromModel = this.currentModel();
    return {
      kind: 'switch',
      reason: this.searchingBackups ? 'queued_backup' : 'capacity_timeout',
      turnId: input.turnId,
      fromModel,
      toModel: this.config.models[nextIndex]!,
      toIndex: nextIndex,
    };
  }
}
