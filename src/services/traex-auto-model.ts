export const TRAEX_AUTO_MODEL_ID = 'auto';
export const TRAEX_AUTO_MODEL_DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
export const TRAEX_AUTO_MODEL_MIN_QUEUE_TIMEOUT_MS = 5_000;
export const TRAEX_AUTO_MODEL_MAX_QUEUE_TIMEOUT_MS = 300_000;
export const TRAEX_AUTO_MODEL_DEFAULT_SWITCH_COOLDOWN_MS = 60_000;

export interface TraexAutoModelSettings {
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  modelBackendVariant?: 'standard' | 'max';
}

export interface TraexAutoModelConfig {
  enabled: true;
  models: string[];
  /** Keys are concrete model ids. An explicit empty entry follows that model's
   * native defaults; absence preserves legacy shared settings. */
  modelSettings?: Record<string, TraexAutoModelSettings>;
  /** Off by default: a topic retains its selected model across turns. */
  reselectPerTurn?: boolean;
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
  if (cooldown !== undefined && (!Number.isInteger(cooldown)
    || (cooldown as number) < 5_000 || (cooldown as number) > 300_000)) {
    return { error: 'traexAutoModel.switchCooldownMs must be an integer between 5000 and 300000' };
  }

  return {
    config: {
      enabled: true,
      models,
      ...(modelSettings ? { modelSettings } : {}),
      ...(value.reselectPerTurn !== undefined ? { reselectPerTurn: value.reselectPerTurn as boolean } : {}),
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

export interface TraexAutoModelRuntimeState {
  model: string;
  waitingOnFinalModel: boolean;
  policyKey: string;
  nativeSessionId: string;
  skillCatalogFingerprint?: string;
  sharedSettings?: TraexAutoModelSettings;
}

export function traexAutoModelPolicyKey(config: TraexAutoModelConfig): string {
  return JSON.stringify([config.models, config.reselectPerTurn === true,
    config.queueTimeoutMs, config.switchCooldownMs ?? TRAEX_AUTO_MODEL_DEFAULT_SWITCH_COOLDOWN_MS,
    config.models.map(model => {
      const settings = resolveTraexAutoModelSettings(config, model);
      return [Object.prototype.hasOwnProperty.call(config.modelSettings ?? {}, model),
        settings.reasoningEffort ?? null, settings.modelBackendVariant ?? null];
    })]);
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
      reason: 'new_turn' | 'capacity_timeout' | 'queued_backup' | 'available_model' | 'shortest_queue' | 'lowest_load';
      turnId: string;
      fromModel: string;
      toModel: string;
      toIndex: number;
      queuePosition?: number;
      loadPercent?: number;
    }
  | {
      kind: 'exhausted';
      turnId: string;
      model: string;
      modelCount: number;
      queuePosition?: number;
      loadPercent?: number;
    };

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
  private exhausted = false;
  private lastSwitchAtMs: number | undefined;
  private queuePositions = new Map<number, { position: number; atMs: number }>();
  private loadCheckDone = false;
  private loadCheckPending = false;
  private searchingBackups = false;
  private progressSinceMs: number | undefined;
  private awaitingActivity = false;

  readonly sharedSettings?: TraexAutoModelSettings;

  constructor(readonly config: TraexAutoModelConfig, restored?: TraexAutoModelRuntimeState,
    sharedSettings?: TraexAutoModelSettings) {
    this.sharedSettings = sharedSettings === undefined ? undefined : { ...sharedSettings };
    if (restored && restored.policyKey === traexAutoModelPolicyKey(config)
      && config.models.includes(restored.model)) {
      if (restored.sharedSettings) this.sharedSettings = { ...restored.sharedSettings };
      this.currentIndex = config.models.indexOf(restored.model);
      this.exhausted = restored.waitingOnFinalModel;
    }
  }

  runtimeState(nativeSessionId: string): TraexAutoModelRuntimeState {
    return { model: this.currentModel(), waitingOnFinalModel: this.exhausted,
      policyKey: traexAutoModelPolicyKey(this.config), nativeSessionId,
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
  }

  currentModel(): string {
    return this.config.models[this.currentIndex]!;
  }

  currentModelIndex(): number {
    return this.currentIndex;
  }

  currentTurnId(): string | undefined {
    return this.turnId;
  }

  queueObserved(): boolean {
    return this.queueSinceMs !== undefined || this.exhausted;
  }

  /** A resumed continuation must show activity before queued corrections can
   * follow it; process startup alone does not finish a capacity transition. */
  awaitingModelActivity(): boolean {
    return this.awaitingActivity;
  }

  beginTurn(turnId: string, options: { retainCurrentModel?: boolean } = {}): TraexAutoModelAction {
    if (!turnId || this.turnId === turnId) return { kind: 'none' };
    const fromModel = this.currentModel();
    if (options.retainCurrentModel || !this.config.reselectPerTurn || this.currentIndex === 0) {
      this.turnId = turnId;
      this.queueSinceMs = undefined;
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

  /** Advance only after the host has admitted the exact native-session restart.
   * Refused proposals leave the real running model and controller in agreement. */
  commitSwitch(action: Extract<TraexAutoModelAction, { kind: 'switch' }>, nowMs = Date.now()): boolean {
    if (action.fromModel !== this.currentModel()
      || this.config.models[action.toIndex] !== action.toModel
      || (action.reason !== 'new_turn' && action.turnId !== this.turnId)) {
      return false;
    }
    this.currentIndex = action.toIndex;
    this.turnId = action.turnId;
    this.queueSinceMs = undefined;
    this.exhausted = action.reason === 'shortest_queue' || action.reason === 'lowest_load';
    this.searchingBackups = action.reason !== 'new_turn' && !this.exhausted;
    this.awaitingActivity = action.reason !== 'new_turn';
    this.progressSinceMs = undefined;
    this.lastSwitchAtMs = nowMs;
    this.loadCheckDone = false;
    this.loadCheckPending = false;
    if (action.reason === 'new_turn') {
      this.queuePositions.clear();
    }
    return true;
  }

  endTurn(turnId: string): void {
    if (this.turnId !== turnId) return;
    this.awaitingActivity = false;
    this.turnId = undefined;
    this.queueSinceMs = undefined;
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
    if (turnId !== this.turnId || !this.loadCheckPending) return { kind: 'none' };
    this.loadCheckPending = false;
    if (this.queueSinceMs === undefined) return { kind: 'none' };
    this.loadCheckDone = true;
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
