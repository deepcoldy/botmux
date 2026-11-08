import { createHash } from 'node:crypto';
import type { CompatibleFeedbackStore } from './feedback-storage-types.js';

type Delivery = NonNullable<Awaited<ReturnType<CompatibleFeedbackStore['findDeliveryById']>>>;
export interface FeedbackAnswerGroup { id: string; delivery: Delivery; messageIds: string[]; round: number }

export function feedbackAnswerGroups(deliveries: Delivery[]): FeedbackAnswerGroup[] {
  const groups = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    if (!delivery.botAppId || !delivery.sessionId || !delivery.turnId) continue;
    const id = createHash('sha256').update(JSON.stringify([
      delivery.botAppId, delivery.sessionId, delivery.turnId, delivery.nativeSessionId ?? '', delivery.dispatchAttempt ?? 0,
    ])).digest('hex');
    const group = groups.get(id) ?? [];
    group.push(delivery); groups.set(id, group);
  }
  const result: FeedbackAnswerGroup[] = [];
  for (const [id, group] of groups) {
    if (group.some(delivery => delivery.status === 'delivered')) break;
    if (group.some(delivery => delivery.status !== 'completed')) continue;
    if (group.some(delivery => delivery.context?.answerKind === 'clarification' || delivery.context?.answerKind === 'progress')) continue;
    const delivery = group[group.length - 1];
    result.push({ id, delivery, messageIds: group.map(item => item.platformMessageId), round: result.length + 1 });
  }
  return result;
}
