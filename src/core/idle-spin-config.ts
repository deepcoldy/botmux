import type { CliId } from '../adapters/cli/types.js';

/**
 * Per-bot CPU-driven idle suspension.
 *
 * Layer 1 (`idleSpinSuspend`) parks an idle worker whose CLI process subtree
 * keeps burning CPU after it stopped producing turns. Layer 2
 * (`hostPressure`) is the machine-overload backstop. Both reuse the strict
 * idle-suspend selector and `suspendWorker`; neither introduces a new kill
 * path.
 *
 * `cpuPercent` is PERCENT OF ONE LOGICAL CORE, not host-wide CPU. A value of
 * 20 means the session subtree sustained ~0.2 core. This is intentionally
 * different from the dashboard's host-wide CPU percentage.
 */
export interface IdleSpinHostPressureConfig {
  /** Enable the host-pressure backstop. Default true. */
  enabled?: boolean;
  /** Consecutive overloaded samples required before the first reclaim. Default 3. */
  afterSamples?: number;
  /** Cooldown after an episode ends or an empty pass. Default 10 minutes. */
  cooldownMinutes?: number;
  /** Max idle workers suspended per pass. Default 16. */
  maxSuspendsPerPass?: number;
  /** Enter when host CPU (all cores) >= this percent. Default 85. */
  enterCpuPercent?: number;
  /** Leave only when host CPU <= this percent. Default 70. */
  exitCpuPercent?: number;
}

export interface IdleSpinSuspendConfig {
  /** Master switch for BOTH layers. Default true. */
  enabled?: boolean;
  /**
   * CLI ids BOTH layers may suspend (Layer 2 never widens this scope; an empty
   * list disables both). Default `['traex']`: the TRAE CLI's
   * skills-directory inotify self-excitation is the known root cause; other
   * CLIs (notably claude-code keep-alive / idle auto-compact) have legitimate
   * idle CPU and must opt in explicitly.
   */
  cliIds?: CliId[];
  /** Per-session CPU threshold as percent of ONE core. Default 20 (0.2 core). */
  cpuPercent?: number;
  /** Consecutive over-threshold samples before suspending. Default 3. */
  consecutiveSamples?: number;
  /** Sampling interval. Default 30 seconds (min 10). */
  sampleIntervalSeconds?: number;
  /** Minimum continuous idle age before a session is eligible. Default 5 minutes. */
  minIdleMinutes?: number;
  /** Max sessions suspended by Layer 1 in one tick. Default 8. */
  maxSuspendsPerSample?: number;
  hostPressure?: IdleSpinHostPressureConfig;
}

export interface ResolvedIdleSpinHostPressureConfig {
  enabled: boolean;
  afterSamples: number;
  cooldownMinutes: number;
  maxSuspendsPerPass: number;
  enterCpuPercent: number;
  exitCpuPercent: number;
}

export interface ResolvedIdleSpinSuspendConfig {
  enabled: boolean;
  cliIds: CliId[];
  cpuPercent: number;
  consecutiveSamples: number;
  sampleIntervalSeconds: number;
  minIdleMinutes: number;
  maxSuspendsPerSample: number;
  hostPressure: ResolvedIdleSpinHostPressureConfig;
}

export const DEFAULT_IDLE_SPIN_SUSPEND_CONFIG: ResolvedIdleSpinSuspendConfig = {
  enabled: true,
  cliIds: ['traex'],
  cpuPercent: 20,
  consecutiveSamples: 3,
  sampleIntervalSeconds: 30,
  minIdleMinutes: 5,
  maxSuspendsPerSample: 8,
  hostPressure: {
    enabled: true,
    afterSamples: 3,
    cooldownMinutes: 10,
    maxSuspendsPerPass: 16,
    enterCpuPercent: 85,
    exitCpuPercent: 70,
  },
};

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function normalizeCliIds(raw: unknown): CliId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CliId[] = [];
  for (const entry of raw) {
    // Do NOT import the CLI registry here: `bot-config-store` → this module →
    // `adapters/cli/registry` closes a cycle that leaves `ALL_CLI_IDS` in TDZ
    // during dashboard/daemon startup. An unknown id is harmless — it simply
    // never matches a live session's CLI.
    if (typeof entry !== 'string' || !entry.trim()) return undefined;
    const id = entry.trim() as CliId;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function normalizeHostPressure(raw: unknown): IdleSpinHostPressureConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: IdleSpinHostPressureConfig = {};
  if ('enabled' in obj) {
    if (typeof obj.enabled !== 'boolean') return undefined;
    out.enabled = obj.enabled;
  }
  if ('afterSamples' in obj) {
    if (!isIntInRange(obj.afterSamples, 1, 60)) return undefined;
    out.afterSamples = obj.afterSamples;
  }
  if ('cooldownMinutes' in obj) {
    if (!isFiniteInRange(obj.cooldownMinutes, 0, 1440)) return undefined;
    out.cooldownMinutes = obj.cooldownMinutes;
  }
  if ('maxSuspendsPerPass' in obj) {
    if (!isIntInRange(obj.maxSuspendsPerPass, 1, 64)) return undefined;
    out.maxSuspendsPerPass = obj.maxSuspendsPerPass;
  }
  if ('enterCpuPercent' in obj) {
    if (!isFiniteInRange(obj.enterCpuPercent, 1, 100)) return undefined;
    out.enterCpuPercent = obj.enterCpuPercent;
  }
  if ('exitCpuPercent' in obj) {
    if (!isFiniteInRange(obj.exitCpuPercent, 0, 100)) return undefined;
    out.exitCpuPercent = obj.exitCpuPercent;
  }
  // Validate the MERGED pair, not only an explicitly supplied pair: a partial
  // override such as `{ enterCpuPercent: 60 }` inherits the default exit (70)
  // and would otherwise produce reverse hysteresis (exit >= enter → flapping).
  const mergedEnter = out.enterCpuPercent ?? DEFAULT_IDLE_SPIN_SUSPEND_CONFIG.hostPressure.enterCpuPercent;
  const mergedExit = out.exitCpuPercent ?? DEFAULT_IDLE_SPIN_SUSPEND_CONFIG.hostPressure.exitCpuPercent;
  if (mergedExit >= mergedEnter) return undefined;
  return out;
}

/**
 * Validate and normalize a raw `idleSpinSuspend` value. Returns `undefined`
 * for any invalid known field so the forgiving config readers can keep the
 * previous/default value instead of half-applying a typo. Unknown keys are
 * ignored for forward compatibility.
 */
export function normalizeIdleSpinSuspendConfig(raw: unknown): IdleSpinSuspendConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: IdleSpinSuspendConfig = {};
  if ('enabled' in obj) {
    if (typeof obj.enabled !== 'boolean') return undefined;
    out.enabled = obj.enabled;
  }
  if ('cliIds' in obj) {
    const ids = normalizeCliIds(obj.cliIds);
    if (ids === undefined) return undefined;
    out.cliIds = ids;
  }
  if ('cpuPercent' in obj) {
    if (!isFiniteInRange(obj.cpuPercent, 1, 400)) return undefined;
    out.cpuPercent = obj.cpuPercent;
  }
  if ('consecutiveSamples' in obj) {
    if (!isIntInRange(obj.consecutiveSamples, 1, 60)) return undefined;
    out.consecutiveSamples = obj.consecutiveSamples;
  }
  if ('sampleIntervalSeconds' in obj) {
    if (!isIntInRange(obj.sampleIntervalSeconds, 10, 600)) return undefined;
    out.sampleIntervalSeconds = obj.sampleIntervalSeconds;
  }
  if ('minIdleMinutes' in obj) {
    // 0 would make the strict selector return no candidates at all (it rejects
    // non-positive ages), silently disabling Layer 1. Require at least 1.
    if (!isFiniteInRange(obj.minIdleMinutes, 1, 1440)) return undefined;
    out.minIdleMinutes = obj.minIdleMinutes;
  }
  if ('maxSuspendsPerSample' in obj) {
    if (!isIntInRange(obj.maxSuspendsPerSample, 1, 64)) return undefined;
    out.maxSuspendsPerSample = obj.maxSuspendsPerSample;
  }
  if ('hostPressure' in obj) {
    const hp = normalizeHostPressure(obj.hostPressure);
    if (hp === undefined) return undefined;
    out.hostPressure = hp;
  }
  return out;
}

/** Merge a validated config over the conservative defaults. */
export function resolveIdleSpinSuspendConfig(
  raw: IdleSpinSuspendConfig | undefined,
): ResolvedIdleSpinSuspendConfig {
  const hostPressure = {
    ...DEFAULT_IDLE_SPIN_SUSPEND_CONFIG.hostPressure,
    ...(raw?.hostPressure ?? {}),
  };
  // Last-resort safety for callers that bypass normalize: never hand a reverse
  // hysteresis pair to evaluateOverload.
  if (hostPressure.exitCpuPercent >= hostPressure.enterCpuPercent) {
    hostPressure.exitCpuPercent = Math.max(0, hostPressure.enterCpuPercent - 1);
  }
  return {
    ...DEFAULT_IDLE_SPIN_SUSPEND_CONFIG,
    ...(raw ?? {}),
    hostPressure,
    cliIds: raw?.cliIds ?? DEFAULT_IDLE_SPIN_SUSPEND_CONFIG.cliIds,
  };
}
