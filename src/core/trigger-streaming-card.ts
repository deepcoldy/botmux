import type { DaemonSession } from './types.js';
import type { TriggerRequest } from '../services/trigger-types.js';
import { larkTransportEnabled } from './types.js';

// Presentation follows the exact committed input, not an HTTP enqueue result,
// group chatter, model output, or the lifetime of a reused CLI session.
const pending = new WeakMap<DaemonSession, Map<string, string>>();
export function armTriggerStreamingCard(ds: DaemonSession, req: TriggerRequest, turnId: string): void {
  if (req.presentation?.liveCard !== 'on-start' || ds.scope !== 'chat'
    || ds.chatType !== 'group' || !larkTransportEnabled({ chatId: ds.chatId })) return;
  const turns = pending.get(ds) ?? new Map<string, string>();
  turns.set(turnId, (req.presentation.title?.trim() || ds.session.title || '任务执行').slice(0, 50));
  pending.set(ds, turns);
}
export function hasPendingTriggerStreamingCard(ds: DaemonSession, turnId?: string): boolean {
  return !!turnId && !!pending.get(ds)?.has(turnId);
}
export function discardTriggerStreamingCard(ds: DaemonSession, turnId: string): void {
  const turns = pending.get(ds);
  turns?.delete(turnId);
  if (!turns?.size) pending.delete(ds);
}
export function commitTriggerStreamingCard(
  ds: DaemonSession, turnId: string,
  start: (ds: DaemonSession, title: string, turnId: string) => void,
): boolean {
  const title = pending.get(ds)?.get(turnId);
  if (title === undefined) return false;
  discardTriggerStreamingCard(ds, turnId);
  if (ds.session.status !== 'active') return false;
  ds.session.handoffLiveCard = { turnId, sequence: 0, title };
  start(ds, title, turnId);
  return true;
}
