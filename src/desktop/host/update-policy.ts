import { compareVersions, parseVersion } from '../../core/update-check.js';

/**
 * Who updates the app runtime (`~/.botmux/app-runtime/botmux`), so the app and
 * the CLI's own auto-update never both act on the same file — and never fight.
 *
 * There is ONE switch for both: `maintenance.autoUpdate` in ~/.botmux/config.json
 * (the same setting the dashboard and `botmux` CLI already expose).
 *
 *  · autoUpdate ON, fleet runs from the app runtime → `leave-to-cli`. The daemon's
 *    maintenance tick replaces this very file at its scheduled time (and restarts
 *    when autoRestart is on). The app only reports what happened.
 *  · autoUpdate ON, the app runtime is NOT what runs the fleet → `auto-apply`.
 *    Nothing else will ever update this file, so the app does, silently, without
 *    touching the fleet (another install owns it; alignment handles that).
 *  · autoUpdate OFF → `remind`. Notify once per version; the user decides.
 *
 * Both paths call the same `botmux update` code under the same cross-process lock
 * (`<dataDir>/npm-global-update`), so they serialize even when they coincide.
 * Neither ever downgrades, and the app never takes over a NEWER fleet, so the
 * two auto-updaters converge on the latest version instead of ping-ponging.
 */
export type UpdatePolicy = 'cli-auto' | 'remind';
export type UpdateAction = 'leave-to-cli' | 'auto-apply' | 'remind' | 'none';

export function updatePolicyFromConfig(maintenance: { autoUpdate?: { enabled?: boolean } } | undefined): UpdatePolicy {
  return maintenance?.autoUpdate?.enabled === true ? 'cli-auto' : 'remind';
}

export function decideUpdateAction(input: {
  available: boolean;
  policy: UpdatePolicy;
  /** The live fleet runs from the app runtime. */
  fleetOwnedByApp: boolean;
  fleetRunning: boolean;
}): UpdateAction {
  if (!input.available) return 'none';
  if (input.policy === 'remind') return 'remind';
  return input.fleetRunning && input.fleetOwnedByApp ? 'leave-to-cli' : 'auto-apply';
}

/**
 * The runtime file was replaced after the fleet started (maintenance updated it
 * with autoRestart off, or a manual `botmux update`): the fleet still runs the old
 * build until a restart.
 */
export function isRestartPending(input: {
  fleetOwnedByApp: boolean;
  fleetRunning: boolean;
  supervisorStartedAt: string | undefined;
  runtimeMtimeMs: number | null;
}): boolean {
  if (!input.fleetOwnedByApp || !input.fleetRunning || input.runtimeMtimeMs === null || !input.supervisorStartedAt) return false;
  const started = Date.parse(input.supervisorStartedAt);
  return Number.isFinite(started) && input.runtimeMtimeMs > started + 1_000;
}

/** A newer Botmux.app (the native shell) is published for this release. */
export function isShellUpdateAvailable(shellVersion: string | undefined, latest: string | null, assetExists: boolean): boolean {
  if (!shellVersion || !latest || !assetExists || !parseVersion(shellVersion) || !parseVersion(latest)) return false;
  return compareVersions(latest, shellVersion) > 0;
}

export function shellAssetName(version: string): string {
  return `Botmux-${version}-mac-arm64.dmg`;
}
