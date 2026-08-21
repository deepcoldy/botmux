export type FeedbackEventType = 'turn.completed' | 'feedback.revised';

export interface FeedbackWebhookDestination {
  id: string;
  enabled: boolean;
  url: string;
  eventTypes: FeedbackEventType[];
  secretRef: string;
  timeoutMs?: number;
}

export interface FeedbackEventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  type: FeedbackEventType;
  version: 1;
  time: string;
  data: T;
}

export interface FrozenWebhookDestination {
  id: string;
  url: string;
  secretRef: string;
  timeoutMs: number;
}

export function effectiveWebhookDestinations(
  eventType: FeedbackEventType,
  groups: ReadonlyArray<ReadonlyArray<FeedbackWebhookDestination> | undefined>,
): FrozenWebhookDestination[] {
  const byId = new Map<string, FeedbackWebhookDestination>();
  for (const group of groups) {
    for (const item of group ?? []) byId.set(item.id, item);
  }
  return [...byId.values()]
    .filter(item => item.enabled && item.eventTypes.includes(eventType))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(item => ({ id: item.id, url: item.url, secretRef: item.secretRef, timeoutMs: item.timeoutMs ?? 10_000 }));
}
