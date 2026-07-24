export type ListenerTargetState = 'listen' | 'ignore';
export type ListenerTargetBulkState = ListenerTargetState | 'mixed';

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

export function applyListenerFilterState(input: {
  include: readonly string[];
  exclude: readonly string[];
  targetIds: readonly string[];
  listening: boolean;
}): { include: string[]; exclude: string[] } {
  const targetIds = new Set(input.targetIds.filter(Boolean));
  const include = new Set(input.include);
  for (const id of targetIds) {
    include.delete(id);
    if (input.listening) include.add(id);
  }
  return {
    include: unique(include),
    exclude: [],
  };
}

export function listenerTargetStateFor(input: {
  include: readonly string[];
  exclude: readonly string[];
  targetIds: readonly string[];
}): ListenerTargetBulkState {
  const targetIds = input.targetIds.filter(Boolean);
  if (targetIds.length === 0) return 'ignore';
  const include = new Set(input.include);
  const states = new Set<ListenerTargetState>();
  for (const id of targetIds) {
    states.add(include.has(id) ? 'listen' : 'ignore');
  }
  return states.size === 1 ? [...states][0] : 'mixed';
}
