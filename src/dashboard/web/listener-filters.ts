export type ListenerTargetState = 'listen' | 'ignore';
export type ListenerTargetBulkState = ListenerTargetState | 'mixed';
export type ListenerSenderMode = 'include_only' | 'all_except_excluded';

export interface ListenerFilterTarget {
  openId: string;
  name: string;
  memberType: 'user' | 'bot' | 'unknown';
}

export function filterListenerTargets<T extends ListenerFilterTarget>(targets: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return targets;
  return targets.filter(target =>
    target.openId.toLowerCase().includes(q)
    || target.name.toLowerCase().includes(q)
    || target.memberType.toLowerCase().includes(q),
  );
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

/**
 * Toggle the listen/ignore state of the given targets, honouring the active
 * sender mode:
 *   - include_only: the include allow-list drives matching. "listen" adds the
 *     target open_id to the list; "ignore" removes it. The exclude list is
 *     unused (kept empty).
 *   - all_except_excluded: everything matches by default (this is the only
 *     mode that can listen to a third-party bot whose sender is reported by
 *     app_id and cannot be resolved to an open_id). "ignore" adds the target
 *     to the exclude list; "listen" removes it. The include list is unused.
 */
export function applyListenerFilterState(input: {
  mode: ListenerSenderMode;
  include: readonly string[];
  exclude: readonly string[];
  targetIds: readonly string[];
  listening: boolean;
}): { include: string[]; exclude: string[] } {
  const targetIds = new Set(input.targetIds.filter(Boolean));
  if (input.mode === 'all_except_excluded') {
    const exclude = new Set(input.exclude);
    for (const id of targetIds) {
      exclude.delete(id);
      if (!input.listening) exclude.add(id);
    }
    return { include: [], exclude: unique(exclude) };
  }
  const include = new Set(input.include);
  for (const id of targetIds) {
    include.delete(id);
    if (input.listening) include.add(id);
  }
  return { include: unique(include), exclude: [] };
}

export function listenerTargetStateFor(input: {
  mode: ListenerSenderMode;
  include: readonly string[];
  exclude: readonly string[];
  targetIds: readonly string[];
}): ListenerTargetBulkState {
  const targetIds = input.targetIds.filter(Boolean);
  if (targetIds.length === 0) return input.mode === 'all_except_excluded' ? 'listen' : 'ignore';
  const states = new Set<ListenerTargetState>();
  if (input.mode === 'all_except_excluded') {
    const exclude = new Set(input.exclude);
    for (const id of targetIds) states.add(exclude.has(id) ? 'ignore' : 'listen');
  } else {
    const include = new Set(input.include);
    for (const id of targetIds) states.add(include.has(id) ? 'listen' : 'ignore');
  }
  return states.size === 1 ? [...states][0] : 'mixed';
}

/**
 * Resolve the persisted `excludeSenderKinds` map for a save payload.
 *
 * The runtime fail-close decision (message-listener `exclusionMayBeUnverifiedBot`)
 * needs each excluded id's KIND (user/bot). Live roster is authoritative, but a
 * transient members-list failure must NOT drop an already-persisted kind: the
 * dashboard swallows load errors to an empty roster and does not gate save on
 * loading, so a plain unrelated-field save would otherwise emit the exclusion
 * list WITHOUT its kinds → the backend treats them as legacy/unknown →
 * every unverified third-party bot fail-closes again (the exact scenario the
 * all_except_excluded mode exists to fix).
 *
 * Precedence: live roster kind → persisted kind → absent. A genuinely
 * never-identified open_id stays absent so the runtime keeps its conservative
 * (maybe-a-bot) fail-close.
 */
export function resolveExcludeSenderKinds(
  excludeSenderOpenIds: readonly string[],
  liveKindOf: (openId: string) => 'user' | 'bot' | 'unknown' | undefined,
  persistedKinds?: Readonly<Record<string, 'user' | 'bot'>>,
): Record<string, 'user' | 'bot'> {
  const out: Record<string, 'user' | 'bot'> = {};
  for (const openId of excludeSenderOpenIds) {
    if (!openId) continue;
    // Only a DEFINITE live kind (user|bot) overrides the persisted value. A live
    // 'unknown' is not nullish, so `?? persisted` would wrongly short-circuit on
    // it and then get filtered out below — re-erasing a known kind whenever the
    // members API returns an unknown/absent member_type. Treat 'unknown' like
    // absent and fall back to the persisted kind.
    const liveKind = liveKindOf(openId);
    const kind = liveKind === 'user' || liveKind === 'bot'
      ? liveKind
      : persistedKinds?.[openId];
    if (kind === 'user' || kind === 'bot') out[openId] = kind;
  }
  return out;
}
