import { join } from 'node:path';
import type { BackendType } from '../adapters/backend/types.js';
import { hcCorePaths, hcRuntimeDirError } from '../adapters/backend/hc/core.js';
import { detectPlatform } from '../setup/detect-platform.js';
import { HC_MIN_VERSION, hcBotmuxRoot, probeHcAvailability } from '../setup/ensure-hc.js';
import { ensureHerdr, type HerdrResult } from '../setup/ensure-herdr.js';
import { ensureTmux, type TmuxResult } from '../setup/ensure-tmux.js';
import { probeZellijFunctional } from '../setup/ensure-zellij.js';
import { probeZmxFunctional } from '../setup/ensure-zmx.js';

export type BackendAvailabilityResult =
  | { ok: true; backendType: BackendType; version?: string }
  | { ok: false; backendType: BackendType; reason: string; manualCommand?: string };

export type HcFunctionalProbe = { ok: true; version: string } | { ok: false; reason: string };

export interface BackendAvailabilityDeps {
  ensureTmux(): Promise<TmuxResult>;
  ensureHerdr(): Promise<HerdrResult>;
  probeZellijFunctional(): ReturnType<typeof probeZellijFunctional>;
  probeZmxFunctional(): ReturnType<typeof probeZmxFunctional>;
  probeHcFunctional(): HcFunctionalProbe;
}

/**
 * A usable herdr-core binary plus a botmux core address this host can serve:
 * the socket path fits and its runtime dir exists. Never starts a core.
 */
export function probeHcFunctional(env: NodeJS.ProcessEnv = process.env): HcFunctionalProbe {
  const availability = probeHcAvailability({ env });
  if (!availability.ok) return availability;
  try {
    const noRuntimeDir = hcRuntimeDirError(hcCorePaths(env));
    if (noRuntimeDir) return { ok: false, reason: noRuntimeDir };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, version: availability.version };
}

const defaultDeps: BackendAvailabilityDeps = {
  ensureTmux: () => ensureTmux(detectPlatform()),
  ensureHerdr,
  probeZellijFunctional,
  probeZmxFunctional,
  probeHcFunctional: () => probeHcFunctional(),
};

/**
 * Prepare a backend before persisting a dashboard override. This keeps the UI
 * promise honest: a successful save means the next session can actually start
 * on that backend. tmux/herdr may install through their existing official
 * bootstrap paths; zellij/zmx/hc are probe-only and return actionable failures.
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

  if (backendType === 'zmx') {
    const result = deps.probeZmxFunctional();
    return result.ok
      ? { ok: true, backendType, version: result.version }
      : {
          ok: false,
          backendType,
          reason: result.reason,
          manualCommand: '安装 ZMX >= 0.7.0：macOS 用 brew install neurosnap/tap/zmx；Linux 用官方 release binary；或 mise use -g github:neurosnap/zmx@latest',
        };
  }

  if (backendType === 'hc') {
    const result = deps.probeHcFunctional();
    return result.ok
      ? { ok: true, backendType, version: result.version }
      : {
          ok: false,
          backendType,
          reason: result.reason,
          manualCommand: `把 herdr-core >= ${HC_MIN_VERSION.join('.')} 放到 ${join(hcBotmuxRoot(), 'bin', 'herdr-core')}，或用 BOTMUX_HC_BIN 指定其绝对路径（botmux 不会自动安装）`,
        };
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
