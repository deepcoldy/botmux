export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
/** Common verified effort levels honored by both Antigravity terminal and ACP. */
export const ANTIGRAVITY_REASONING_EFFORTS: readonly CodexReasoningEffort[] = ['low', 'medium', 'high'];
/** Doubao's model-independent CLI flag accepts these BotMux levels; the
 * selected provider decides how to honour them. `ultra` is rejected by the CLI. */
export const DOUBAO_REASONING_EFFORTS: readonly CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_COMMON_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);
export const GROK_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);
export const GROK_COMMON_REASONING_EFFORTS = GROK_REASONING_EFFORTS.slice(0, 3);
export const TRAEX_COMMON_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 3);
/** Remote providers validate what they support. BotMux transports its generic
 * reasoning vocabulary without borrowing any one provider's model catalog. */
export const REMOTE_RUNNER_REASONING_EFFORTS = CODEX_REASONING_EFFORTS;
/** Claude Code's `--effort` flag parses exactly low|medium|high|xhigh|max —
 *  `ultra` is codex/traex-only and Claude answers it with an unknown-value
 *  warning. Spelled out rather than sliced off CODEX_REASONING_EFFORTS: the two
 *  lists agree today by coincidence, and a level inserted mid-list upstream
 *  would silently drop `max` here and admit a level Claude rejects.
 *
 *  Flag parsing is model-independent (opus-5 / sonnet-5 / haiku-4.5 all print
 *  the same `Valid values:`), but *honouring* a level is not — the Claude docs'
 *  effort page lists no Haiku model at all. See claudeReasoningEffortsForModel. */
const CLAUDE_ALL_REASONING_EFFORTS: readonly CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Exported for the adapter's arg filter: the widest set any Claude model takes. */
export const CLAUDE_REASONING_EFFORTS = CLAUDE_ALL_REASONING_EFFORTS;

/** MCode's thinkingEffort option advertises these levels for M3.1-Flash.
 * `default` means no BotMux override; `ultra` is not an advertised level. */
const MINIMAX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Only Haiku is withheld: it takes no effort parameter at all, yet the adapter
 *  lists it in `modelChoices` (both `haiku` and the pinned `claude-haiku-4-5-…`),
 *  so it is the one selectable pairing that would be accepted and never honoured.
 *
 *  Everything else — including gateway-mapped names such as `model_hub/…` that
 *  cannot be matched to a row, and models released after this table — gets the
 *  full set. Withholding levels from an unrecognised name would silently cap
 *  relay users at `high` on a model that may well honour `max`, and an
 *  unsupported level costs only a warning on the CLI, while a missing one is
 *  unrecoverable from config. */
export function claudeReasoningEffortsForModel(model: string | undefined): readonly CodexReasoningEffort[] {
  if (model?.trim().toLowerCase().includes('haiku')) return [];
  return CLAUDE_ALL_REASONING_EFFORTS;
}

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

/** One model row of a runtime catalogue (`codex debug models`), reduced to what
 *  the reasoning judgment reads. `DebugModelCapabilities` satisfies it. */
export interface ReasoningCatalogEntry {
  readonly slug: string;
  readonly reasoningEfforts?: readonly string[];
}
export type ReasoningCatalog = readonly ReasoningCatalogEntry[];

// Rows are copied from `codex debug models --bundled` (codex-cli 0.170.0 for
// the gpt-6.2 / gpt-6.1-terra rows), never inferred from a name. A row is the
// verified upper bound for its model: paths without a catalogue refute levels
// above it, and a catalogue may narrow it but never widen it. Only rows that
// are known to stop short of `ultra` can be capped that way, so the table
// lists max-capable models only; anything else is the catalogue's to decide.
const SIX_LEVEL_MODELS = new Set([
  'gpt-6.2-sol', 'gpt-6.2-astra',
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol',
  'gpt-5.6-sol', 'gpt-5.6-terra',
]);
const FIVE_LEVEL_MODELS = new Set(['gpt-6-luna', 'gpt-5.6-luna']);
// Grok's model catalog advertises xhigh for both 4.7 variants too.
const GROK_XHIGH_MODELS = new Set(['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']);
const TRAEX_REASONING_EFFORTS_BY_MODEL = new Map<string, readonly CodexReasoningEffort[]>([
  ['gpt-6-astra', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-6.1-sol', CODEX_COMMON_REASONING_EFFORTS],
  ['seed-evolving', []],
  ['seed-2.1-pro', []],
  ['seed-2.1-turbo', []],
  ['openrouter-3o', CODEX_REASONING_EFFORTS.slice(0, 5)],
  ['openrouter-2o', CODEX_REASONING_EFFORTS.slice(0, 5)],
  ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'ultra']],
  ['gpt-5.6-terra', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.6-luna', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.5', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.4', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.4-mini', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.3-codex', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.2', CODEX_COMMON_REASONING_EFFORTS],
  ['codex-auto-review', CODEX_COMMON_REASONING_EFFORTS],
  ['deepseek-v4-pro', TRAEX_COMMON_REASONING_EFFORTS],
  ['deepseek-v4-flash', TRAEX_COMMON_REASONING_EFFORTS],
  ['seed-dogfooding-2.0', TRAEX_COMMON_REASONING_EFFORTS],
  ['seed-code', []],
  ['openrouter-1o', ['low', 'medium', 'high', 'max']],
  ['openrouter-1', ['low', 'medium', 'high', 'max']],
  ['gemini-3.1-pro-preview', TRAEX_COMMON_REASONING_EFFORTS],
  ['gemini-3-flash-preview', TRAEX_COMMON_REASONING_EFFORTS],
]);

export function isCodexReasoningCliId(cliId: string | undefined): boolean {
  return cliId === 'codex' || cliId === 'codex-app';
}

/** Codex App restores a thread's persisted effort only when the EFFECTIVE
 * launch still resumes that thread. Worker resume-demotion probes may turn an
 * init-time resume into a fresh start; those must go through the launch gate. */
export function codexAppResumeRestoresReasoningEffort(input: {
  cliId: string | undefined;
  resume: boolean;
  cliSessionId: string | undefined;
}): boolean {
  return input.cliId === 'codex-app' && input.resume && !!input.cliSessionId;
}

/** Backend variants are a TraeX launch capability, either local or delegated
 * through the provider-neutral Remote Runner start/resume contract. */
export function isBackendVariantCliId(cliId: string | undefined): boolean {
  return cliId === 'traex' || cliId === 'remote-runner';
}

export function isConfigurableReasoningCliId(cliId: string | undefined): boolean {
  return isCodexReasoningCliId(cliId) || cliId === 'grok' || isBackendVariantCliId(cliId)
    || cliId === 'claude-code' || cliId === 'kimi' || cliId === 'minimax' || cliId === 'doubao'
    // ZCode's per-model levels are declared in its own provider catalog and can
    // differ per model (grok-4.6 tops out at xhigh, GLM/Opus go to max, MiMo is
    // a switch). The launch path resolves the closest supported level, so the
    // whole vocabulary is offered here instead of a per-model subset.
    || cliId === 'zcode' || cliId === 'antigravity';
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

/** Levels the static table has verified for exactly this model; undefined when
 *  the table has no row for it. */
function verifiedCodexReasoningEfforts(model: string | undefined): readonly CodexReasoningEffort[] | undefined {
  const normalized = model?.trim().toLowerCase() ?? '';
  if (SIX_LEVEL_MODELS.has(normalized)) return CODEX_REASONING_EFFORTS;
  if (FIVE_LEVEL_MODELS.has(normalized)) return CODEX_REASONING_EFFORTS.slice(0, 5);
  return undefined;
}

/** Levels a runtime catalogue advertises for this model, in BotMux order.
 *  undefined when there is no catalogue, it does not list the model, or the row
 *  carries no level BotMux knows (`none` / missing field) — none of which says
 *  anything about max/ultra. An exact slug wins over a case-insensitive one. */
export function catalogReasoningEffortsForModel(
  model: string | undefined,
  catalog: ReasoningCatalog | null | undefined,
): readonly CodexReasoningEffort[] | undefined {
  const name = model?.trim();
  if (!name || !catalog) return undefined;
  const lower = name.toLowerCase();
  const entry = catalog.find(item => item.slug === name)
    ?? catalog.find(item => item.slug.trim().toLowerCase() === lower);
  if (!entry?.reasoningEfforts) return undefined;
  const advertised = new Set(entry.reasoningEfforts);
  const efforts = CODEX_REASONING_EFFORTS.filter(effort => advertised.has(effort));
  return efforts.length > 0 ? efforts : undefined;
}

/**
 * Codex reasoning choices for a model — the one judgment behind the Dashboard
 * chooser, save validation, `/modelpin` and the worker's launch-time check.
 *
 *  - When the live catalogue of the runtime that will launch the model lists
 *    it, the catalogue decides: a model the table has never seen gets exactly
 *    what the catalogue advertises, and a catalogue advertising fewer levels
 *    than the table (a gateway provider) narrows the choice.
 *  - A table row is the upper bound for its model; a catalogue never widens a
 *    verified row. Config load and the daemon's launch resolution cannot run
 *    the catalogue and enforce the rows ({@link cliModelMayKeepReasoningEffort}),
 *    so a wider catalogue would let the Dashboard save a level those paths drop.
 *  - Without a catalogue, or when it does not list the model: the table row,
 *    else the common four every Codex model takes.
 */
export function codexReasoningEffortsForModel(
  model: string | undefined,
  catalog?: ReasoningCatalog | null,
): readonly CodexReasoningEffort[] {
  const verified = verifiedCodexReasoningEfforts(model);
  const advertised = catalogReasoningEffortsForModel(model, catalog);
  if (advertised) return verified ? verified.filter(effort => advertised.includes(effort)) : advertised;
  return verified ?? CODEX_COMMON_REASONING_EFFORTS;
}

export function codexModelSupportsReasoningEffort(
  model: string | undefined,
  effort: CodexReasoningEffort,
  catalog?: ReasoningCatalog | null,
): boolean {
  return codexReasoningEffortsForModel(model, catalog).includes(effort);
}

/**
 * Whether a path that cannot run the catalogue — config load, the daemon's
 * launch resolution, pin-effort resolution — may keep a saved level.
 *
 * Codex table rows are enforced exactly as {@link codexReasoningEffortsForModel}
 * enforces them. A level on a model the table has no row for cannot be refuted
 * there: it may have been verified against the live catalogue when it was
 * saved, and dropping it would undo a choice the Dashboard offered. It is kept,
 * and the worker's launch-time check ({@link resolveCodexLaunchReasoningEffort})
 * makes the final call with the catalogue. An empty model ("whatever the CLI
 * defaults to") keeps only the common four: no catalogue row can vouch for it.
 *
 * Every other CLI keeps its existing contract.
 */
export function cliModelMayKeepReasoningEffort(
  cliId: string | undefined,
  model: string | undefined,
  effort: CodexReasoningEffort,
): boolean {
  if (!isCodexReasoningCliId(cliId)) return cliModelSupportsReasoningEffort(cliId, model, effort);
  const verified = verifiedCodexReasoningEfforts(model);
  if (verified) return verified.includes(effort);
  return model?.trim()
    ? isCodexReasoningEffort(effort)
    : CODEX_COMMON_REASONING_EFFORTS.includes(effort);
}

/**
 * A launch that reuses the target bot's own saved model/effort pair unchanged
 * is judged by the keep-rule config load applied to that pair; any override of
 * either half is judged by the full capability check. Shared by external
 * triggers and both sides of dispatch so they cannot disagree.
 */
export function cliLaunchAcceptsReasoningEffort(
  cliId: string | undefined,
  model: string | undefined,
  effort: CodexReasoningEffort,
  inheritsSavedPair: boolean,
): boolean {
  return inheritsSavedPair
    ? cliModelMayKeepReasoningEffort(cliId, model, effort)
    : cliModelSupportsReasoningEffort(cliId, model, effort);
}

export interface CodexReasoningEffortDrop {
  effort: CodexReasoningEffort;
  supported: readonly CodexReasoningEffort[];
  catalog: boolean;
}

export type CodexLaunchReasoningEffort =
  | { effort?: CodexReasoningEffort; dropped?: undefined }
  | { effort?: undefined; dropped: CodexReasoningEffortDrop };

/** User-facing explanation shared by the worker's direct-launch gate and the
 * Codex App runner's signed fresh-fallback marker. The saved setting is
 * deliberately untouched in both paths. */
export function codexReasoningEffortDroppedNotice(
  model: string | undefined,
  dropped: CodexReasoningEffortDrop,
): string {
  const name = model?.trim() || '(CLI default)';
  return `本次启动未使用思考强度 ${dropped.effort}：${dropped.catalog
    ? `codex 模型目录显示 ${name} 不支持该档位`
    : `拿不到可用于 ${name} 的 codex 模型目录，按内置档位表该档位不受支持`}，已按 CLI 默认强度启动；设置未改动。`;
}

/**
 * Launch-time gate for a Codex reasoning level, run by the worker with the
 * exact binary and environment it is about to launch.
 *
 * The common four are what every Codex model takes (the table's own floor), so
 * they are passed through without a probe, as before. Anything above them is
 * checked with {@link codexReasoningEffortsForModel} against the catalogue when
 * `loadCatalog` is given (null = the catalogue cannot speak for this launch, e.g.
 * a wrapper or Codex profile selects the provider). An unsupported level is
 * left out of this launch only; the saved setting is untouched, so a catalogue
 * that is briefly unreachable never erases a choice.
 */
export async function resolveCodexLaunchReasoningEffort(input: {
  cliId: string | undefined;
  model: string | undefined;
  effort: CodexReasoningEffort | undefined;
  loadCatalog: (() => Promise<ReasoningCatalog | null>) | null;
}): Promise<CodexLaunchReasoningEffort> {
  const { effort } = input;
  if (!effort || !isCodexReasoningCliId(input.cliId) || CODEX_COMMON_REASONING_EFFORTS.includes(effort)) {
    return { effort };
  }
  let catalog: ReasoningCatalog | null = null;
  if (input.loadCatalog) {
    try { catalog = await input.loadCatalog(); } catch { catalog = null; }
  }
  const supported = codexReasoningEffortsForModel(input.model, catalog);
  if (supported.includes(effort)) return { effort };
  return {
    dropped: {
      effort,
      supported,
      catalog: catalogReasoningEffortsForModel(input.model, catalog) !== undefined,
    },
  };
}

/** Unknown Grok models get the verified catalog-wide safe intersection. */
export function grokReasoningEffortsForModel(model: string | undefined): readonly CodexReasoningEffort[] {
  const normalized = model?.trim().toLowerCase() ?? '';
  if (GROK_XHIGH_MODELS.has(normalized)) return GROK_REASONING_EFFORTS;
  return GROK_COMMON_REASONING_EFFORTS;
}

export function knownTraexReasoningEffortsForModel(model: string): readonly CodexReasoningEffort[] | undefined {
  return TRAEX_REASONING_EFFORTS_BY_MODEL.get(model.trim().toLowerCase());
}

export function traexReasoningEffortsForModel(model: string | undefined): readonly CodexReasoningEffort[] {
  const normalized = model?.trim().toLowerCase() ?? '';
  if (!normalized) return TRAEX_COMMON_REASONING_EFFORTS;
  return TRAEX_REASONING_EFFORTS_BY_MODEL.get(normalized) ?? TRAEX_COMMON_REASONING_EFFORTS;
}

/** Reasoning choices exposed by a CLI's Botmux control plane. `catalog` is the
 *  live catalogue of the runtime that will launch the model, when the caller
 *  has one; only Codex consults it (see codexReasoningEffortsForModel). */
export function reasoningEffortsForCliModel(
  cliId: string | undefined,
  model: string | undefined,
  catalog?: ReasoningCatalog | null,
): readonly CodexReasoningEffort[] {
  if (cliId === 'antigravity') return ANTIGRAVITY_REASONING_EFFORTS;
  if (cliId === 'doubao') return DOUBAO_REASONING_EFFORTS;
  if (cliId === 'grok') return grokReasoningEffortsForModel(model);
  if (cliId === 'remote-runner') return REMOTE_RUNNER_REASONING_EFFORTS;
  if (cliId === 'traex') return traexReasoningEffortsForModel(model);
  if (isCodexReasoningCliId(cliId)) return codexReasoningEffortsForModel(model, catalog);
  if (cliId === 'claude-code') return claudeReasoningEffortsForModel(model);
  // ZCode: every level is accepted here and narrowed to the model's real
  // capability at launch (services/zcode-model-config.ts), which keeps the
  // chooser model-independent while the card still shows what actually ran.
  if (cliId === 'zcode') return CODEX_REASONING_EFFORTS;
  if (cliId === 'kimi') {
    // Kimi 的 effort 环境变量只作用于 kimi provider，不猜测自定义别名的能力。
    return model?.trim() === 'kimi-code/k3' || model?.trim() === 'kimi-code/k3-256k'
      ? ['low', 'high', 'max'] : [];
  }
  if (cliId === 'minimax') {
    // Match only launchable names of the verified model/variant. An omitted
    // model follows the user's MCode default, which may be M3 or a custom
    // provider; neither an alias nor a substring proves effort support.
    return /^(?:minimax\/)?MiniMax-M3\.1-Flash(?:#thinking)?$/.test(model?.trim() ?? '')
      ? MINIMAX_REASONING_EFFORTS : [];
  }
  return [];
}

export function cliModelSupportsReasoningEffort(
  cliId: string | undefined,
  model: string | undefined,
  effort: CodexReasoningEffort,
  catalog?: ReasoningCatalog | null,
): boolean {
  return reasoningEffortsForCliModel(cliId, model, catalog).includes(effort);
}
