import type { CardActionData } from './card-handler.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return isRecord(value) ? value : undefined;
}

/**
 * Lark's SDK normally flattens the event envelope. Also accept the complete
 * card.action.trigger payload and JSON-encoded callback values. A Card 2.0
 * behavior is a fallback only when the action has no explicit value.
 * Identity and message context always come from the event, never its value.
 */
export function normalizeCardActionData(input: unknown): CardActionData {
  if (!isRecord(input)) return {};
  const wrapped = input.action === undefined && isRecord(input.event) && isRecord(input.event.action);
  const event = wrapped ? input.event as Record<string, unknown> : input;
  const action = isRecord(event.action) ? event.action : undefined;
  if (!action) return event as CardActionData;

  let rawValue = action.value;
  if (rawValue === undefined && Array.isArray(action.behaviors)) {
    rawValue = action.behaviors.find(behavior => isRecord(behavior) && behavior.type === 'callback')?.value;
  }
  const value = parseValue(rawValue);
  if (!wrapped && value === action.value) return input as CardActionData;
  return {
    ...event,
    ...(wrapped ? {
      header: input.header,
      // Mirror the normalized action back into the nested event as well:
      // downstream strict parsers (e.g. durable session control ingress) read
      // inner event.action first. Keep the inner event's own operator/context;
      // outer identity fields must never leak into the event body.
      event: { ...event, action: { ...action, value } },
      event_id: input.event_id ?? event.event_id, uuid: input.uuid ?? event.uuid,
    } : {}),
    action: { ...action, value },
  } as CardActionData;
}
