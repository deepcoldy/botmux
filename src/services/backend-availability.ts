import type { BackendType } from '../adapters/backend/types.js';
import { detectPlatform } from '../setup/detect-platform.js';
import { ensureHerdr, type HerdrResult } from '../setup/ensure-herdr.js';
import { ensureTmux, type TmuxResult } from '../setup/ensure-tmux.js';
import { probeZellijFunctional } from '../setup/ensure-zellij.js';

export type BackendAvailabilityResult =
  | { ok: true; backendType: BackendType; version?: string }
  | { ok: false; backendType: BackendType; reason: string; manualCommand?: string };

export interface BackendAvailabilityDeps {
  ensureTmux(): Promise<TmuxResult>;
  ensureHerdr(): Promise<HerdrResult>;
  probeZellijFunctional(): ReturnType<typeof probeZellijFunctional>;
}

const defaultDeps: BackendAvailabilityDeps = {
  ensureTmux: () => ensureTmux(detectPlatform()),
  ensureHerdr,
  probeZellijFunctional,
};

/**
 * Prepare a backend before persisting a dashboard override. This keeps the UI
 * promise honest: a successful save means the next session can actually start
 * on that backend. tmux/herdr may install through their existing official
 * bootstrap paths; zellij is probe-only and returns an actionable failure.
 */
export async function ensureBackendAvailable(
  backendType: BackendType,
  overrides: Partial<BackendAvailabilityDeps> = {},
): Promise<BackendAvailabilityResult> {
  const deps = { ...defaultDeps, ...overrides };
  if (backendType === 'pty') return { ok: true, backendType };

  if (backendType === 'tmux') {
    const result = await deps.ensureTmux();
    return result.installed
      ? { ok: true, backendType, version: result.version }
      : { ok: false, backendType, reason: result.reason ?? 'tmux 不可用', manualCommand: result.manualCommand };
  }

  if (backendType === 'herdr') {
    const result = await deps.ensureHerdr();
    return result.installed
      ? { ok: true, backendType, version: result.version }
      : { ok: false, backendType, reason: result.reason ?? 'herdr 不可用', manualCommand: result.manualCommand };
  }

  const result = deps.probeZellijFunctional();
  return result.ok
    ? { ok: true, backendType, version: result.version }
    : {
        ok: false,
        backendType,
        reason: result.reason,
        manualCommand: '请安装 zellij >= 0.44.0 后重试',
      };
}
