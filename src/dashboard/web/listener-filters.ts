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
