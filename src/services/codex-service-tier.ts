import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import { codexHome } from './codex-paths.js';

/** Executor-confirmed settings copied from Codex's rollout. */
export interface CodexThreadSettings {
  model?: string;
  serviceTier: string;
}

/** Card-facing snapshot. `fastActive` is derived from Codex's model catalog. */
export interface CodexServiceTierSnapshot extends CodexThreadSettings {
  fastActive: boolean;
}

const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * Resolve whether the executor tier is the catalog entry named "Fast" for the
 * concrete model. Unknown/missing catalogs fail closed: botmux must never call
 * an arbitrary non-default tier (for example `flex`) Fast.
 */
export function resolveCodexServiceTierSnapshot(
  settings: CodexThreadSettings,
): CodexServiceTierSnapshot {
  const snapshot: CodexServiceTierSnapshot = { ...settings, fastActive: false };
  if (!settings.model || !settings.serviceTier || settings.serviceTier === 'default') return snapshot;

  const catalogPath = join(codexHome(), 'models_cache.json');
  try {
    if (!existsSync(catalogPath)) return snapshot;
    const size = statSync(catalogPath).size;
    if (size <= 0 || size > MAX_MODEL_CATALOG_BYTES) return snapshot;
    const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return snapshot;
    const model = parsed.models.find((entry: any) => entry?.slug === settings.model) as any;
    if (!model || !Array.isArray(model.service_tiers)) return snapshot;
    snapshot.fastActive = model.service_tiers.some((tier: any) => (
      tier?.id === settings.serviceTier
      && typeof tier?.name === 'string'
      && tier.name.trim().toLowerCase() === 'fast'
    ));
  } catch {
    // Read-only presentation must fail closed; executor state remains untouched.
  }
  return snapshot;
}

/** A stale Codex snapshot can never decorate another CLI's card. */
export function codexFastBadgeActive(
  cliId: CliId,
  snapshot: CodexServiceTierSnapshot | undefined,
): boolean {
  return cliId === 'codex' && snapshot?.fastActive === true;
}

function snapshotsEqual(
  left: CodexServiceTierSnapshot | undefined,
  right: CodexServiceTierSnapshot,
): boolean {
  return left?.model === right.model
    && left?.serviceTier === right.serviceTier
    && left?.fastActive === right.fastActive;
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
