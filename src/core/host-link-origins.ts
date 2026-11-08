/**
 * Origins of the capability links this process has issued itself: Web terminal
 * (buildTerminalUrl) and Dashboard / plugin result access (buildDashboardUrls).
 * Without a public external host these point at this machine's own interface
 * (getLocalIp fallback), so the Lark local-address policy lets a card link field
 * through only when its origin is recorded here. Entries come from the host's
 * URL builders, never from a message payload.
 *
 * Kept import-free so the Lark client can depend on it without pulling in the
 * URL builders' module graph.
 */

/** Direct-mode worker ports change on every respawn; old ones age out. */
const MAX_ORIGINS = 256;
const origins = new Set<string>();

export function noteHostLinkOrigin(url: string): void {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return; }
  if (origin === 'null') return;
  origins.delete(origin);
  origins.add(origin);
  if (origins.size > MAX_ORIGINS) origins.delete(origins.values().next().value!);
}

export function isHostLinkOrigin(origin: string): boolean {
  return origins.has(origin);
}

/** Test isolation hook. */
export function resetHostLinkOrigins(): void {
  origins.clear();
}
