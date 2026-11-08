/**
 * Capability links this process has issued itself: Web terminal, session and
 * v3 terminal pages, Dashboard / workbench / v3 run detail, workflow entries,
 * decision-board items and plugin result access. Without a public external
 * host these point at this machine's own interface (getLocalIp fallback), so
 * the Lark local-address policy lets a card link field through only when its
 * origin and path were recorded here. Query and fragment carry the per-link
 * capability and client route, so they are not part of the key. Entries come
 * from the host's URL builders, or from a body the host vetted before it was
 * frozen for replay, never from a message payload.
 *
 * Kept import-free so the Lark client can depend on it without pulling in the
 * URL builders' module graph.
 */

/** Direct-mode worker ports and session paths keep changing; old ones age out. */
const MAX_LINKS = 4096;
const links = new Set<string>();

function linkKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin === 'null' || parsed.username || parsed.password) return undefined;
    return parsed.origin + parsed.pathname;
  } catch { return undefined; }
}

/** Records a link the caller is about to put on a card and returns it unchanged. */
export function issueHostLink<T extends string | null | undefined>(url: T): T {
  const key = url ? linkKey(url) : undefined;
  if (!key) return url;
  links.delete(key);
  links.add(key);
  if (links.size > MAX_LINKS) links.delete(links.values().next().value!);
  return url;
}

export function isHostIssuedLink(url: string): boolean {
  const key = linkKey(url);
  return key !== undefined && links.has(key);
}

/** Test isolation hook. */
export function resetHostIssuedLinks(): void {
  links.clear();
}
