import type { GroupContextMessageRecord } from './group-context-store.js';
import { sanitizeGroupContextText } from './group-context-content.js';

/** Without a provider version, a turn-card body is only known to exist at
 * observation time, not at the original status card's creation time. Reuse
 * that bound for identical canonical bodies so repeated reads do not postpone
 * the same answer forever. This value is a conservative cutoff, not a claimed
 * historical publication timestamp. */
export function groupContextCardObservationTime(
  previous: GroupContextMessageRecord | undefined,
  text: string,
  resources: readonly { type: string; key?: string; name?: string }[],
  observedAt = Date.now(),
): number {
  const refs = resources.filter(resource => !!resource.key).map(resource => ({
    type: resource.type, key: resource.key!, ...(resource.name ? { name: resource.name } : {}),
  }));
  if (previous?.cardContentVersion === 1 && !previous.deleted
      && previous.text === sanitizeGroupContextText(text)
      && JSON.stringify(previous.resourceRefs) === JSON.stringify(refs)) {
    return previous.cardObservedAt ?? previous.updateTime ?? previous.observedAt;
  }
  return observedAt;
}
