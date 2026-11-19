import { compareVersions, parseVersion } from '../../core/update-check.js';

/**
 * Is the live fleet running the same botmux as the app? The app's runtime is the
 * reference version: when another install runs the fleet with an OLDER build,
 * the app aligns it; a NEWER one is never downgraded.
 *
 *  · aligned       — owned by the app runtime, or same version
 *  · owner-older   — another install runs an older build. `auto` when that
 *                    install is a packaged release (npm / install.sh) — replacing
 *                    it costs nothing. A git checkout is someone's dev deploy
 *                    (`bun run switch:here && daemon:restart`), so it is only
 *                    offered, never taken over silently.
 *  · owner-newer   — another install runs a newer build; update the app runtime
 *  · unknown       — no fleet, or the owner's version cannot be determined
 */
export type FleetAlignment =
  | { kind: 'aligned' }
  | { kind: 'owner-older'; ownerVersion: string; appVersion: string; auto: boolean }
  | { kind: 'owner-newer'; ownerVersion: string; appVersion: string }
  | { kind: 'unknown' };

export function computeFleetAlignment(input: {
  appVersion: string;
  owner: { version: string; isCheckout: boolean } | null;
  fleetRunning: boolean;
}): FleetAlignment {
  if (!input.fleetRunning) return { kind: 'unknown' };
  if (!input.owner) return { kind: 'aligned' };
  const ownerVersion = input.owner.version;
  if (!parseVersion(ownerVersion) || !parseVersion(input.appVersion) || input.appVersion === '0.0.0') {
    return { kind: 'unknown' };
  }
  const order = compareVersions(ownerVersion, input.appVersion);
  if (order === 0) return { kind: 'aligned' };
  if (order < 0) {
    return { kind: 'owner-older', ownerVersion, appVersion: input.appVersion, auto: !input.owner.isCheckout };
  }
  return { kind: 'owner-newer', ownerVersion, appVersion: input.appVersion };
}
