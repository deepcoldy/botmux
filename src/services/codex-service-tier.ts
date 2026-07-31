import type { CliId } from '../adapters/cli/types.js';

/** Executor-confirmed settings copied from Codex's rollout. */
export interface CodexThreadSettings {
  model?: string;
  serviceTier: string;
}

/** Card-facing snapshot. `nonDefault` is true when the executor is running on a
 *  tier other than `default`. We deliberately do NOT try to map the tier id to
 *  the catalog display name "Fast": the rollout records only the tier id, and
 *  the catalog (`models_cache.json`) is not guaranteed to exist in every
 *  execution environment — under read-isolation the per-bot CODEX_HOME is
 *  provisioned with auth/config only, so a catalog lookup there fails closed and
 *  the badge would never appear even when the faster tier IS active. The badge
 *  therefore names the concrete tier id (`⚡ priority`), which is truthful,
 *  provider-agnostic, and needs no external catalog. */
export interface CodexServiceTierSnapshot extends CodexThreadSettings {
  nonDefault: boolean;
}

/**
 * Derive the read-only presentation snapshot from executor-confirmed settings.
 * No filesystem / catalog dependency — a non-`default` tier id is surfaced as-is.
 */
export function resolveCodexServiceTierSnapshot(
  settings: CodexThreadSettings,
): CodexServiceTierSnapshot {
  const nonDefault = !!settings.serviceTier && settings.serviceTier !== 'default';
  return { ...settings, nonDefault };
}

/** Card badge text for a session's tier snapshot, or undefined for
 *  default / non-codex / no snapshot. A stale Codex snapshot can never decorate
 *  another CLI's card (the cliId gate). Names the concrete tier id rather than
 *  asserting "Fast" — see CodexServiceTierSnapshot. */
export function codexServiceTierBadge(
  cliId: CliId,
  snapshot: CodexServiceTierSnapshot | undefined,
): string | undefined {
  if (cliId !== 'codex' || !snapshot?.nonDefault) return undefined;
  return `⚡ ${snapshot.serviceTier}`;
}

function snapshotsEqual(
  left: CodexServiceTierSnapshot | undefined,
  right: CodexServiceTierSnapshot,
): boolean {
  return left?.model === right.model
    && left?.serviceTier === right.serviceTier
    && left?.nonDefault === right.nonDefault;
}

/**
 * Binds observations to one rollout generation. `bind` and `detach` publish an
 * explicit null so a daemon never carries a previous rollout's badge while the
 * new executor state is still unknown.
 */
export class CodexServiceTierTracker {
  private rolloutPath: string | undefined;
  private snapshot: CodexServiceTierSnapshot | undefined;

  constructor(
    private readonly resolve: (settings: CodexThreadSettings) => CodexServiceTierSnapshot,
    private readonly publish: (snapshot: CodexServiceTierSnapshot | null) => void,
  ) {}

  bind(path: string, initial?: CodexThreadSettings): void {
    if (this.rolloutPath !== path) {
      this.rolloutPath = path;
      this.snapshot = undefined;
      this.publish(null);
    }
    if (initial) this.observe(path, initial);
  }

  observe(path: string, settings: CodexThreadSettings | undefined): void {
    if (!settings || path !== this.rolloutPath) return;
    const next = this.resolve(settings);
    if (snapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    this.publish(next);
  }

  detach(): void {
    if (!this.rolloutPath && !this.snapshot) return;
    this.rolloutPath = undefined;
    this.snapshot = undefined;
    this.publish(null);
  }
}
