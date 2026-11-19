import { logger } from '../../utils/logger.js';
import type { CardActionData } from './card-handler.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function fieldTypes(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [
    key,
    /token|(?:open|union|user|app|chat|message|event)_id|tenant_key|uuid/i.test(key)
      ? '<redacted>'
      : item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item,
  ]));
}

function actionLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && /^[a-z][a-z0-9_.:-]{0,127}$/.test(value)
    && !/^(?:ou_|on_|om_|oc_|cli_|ghp_|github_pat_)/.test(value)
    ? value : '<redacted>';
}

/** Opt-in shape diagnostics; never serialize the payload or form contents. */
export function logCardActionDiagnostics(
  stage: 'dispatcher' | 'handler', input: unknown, normalized: CardActionData,
): void {
  if (process.env.BOTMUX_CARD_ACTION_DIAGNOSTICS !== '1') return;
  const outer = record(input);
  const event = record(outer.event);
  const source = outer.action === undefined && event.action !== undefined ? event : outer;
  const action = record(source.action);
  const value = normalized.action?.value;
  logger.info('[card-action-diagnostics]', {
    stage,
    hasEvent: Object.hasOwn(outer, 'event'),
    outer: fieldTypes(outer), event: fieldTypes(outer.event),
    action: fieldTypes(source.action), actionKeys: Object.keys(action),
    actionValueType: typeof action.value,
    behaviorValueTypes: Array.isArray(action.behaviors)
      ? action.behaviors.map(behavior => ({
        type: actionLabel(record(behavior).type), valueType: typeof record(behavior).value,
      })) : undefined,
    context: fieldTypes(source.context), operator: fieldTypes(source.operator),
    parsed: {
      action: actionLabel(value?.action), result: actionLabel(value?.result),
      expected_feedback_id: value?.expected_feedback_id === undefined ? undefined
        : typeof value.expected_feedback_id === 'string' && /^fb_[a-f0-9]{32}$/.test(value.expected_feedback_id)
          ? value.expected_feedback_id : '<redacted>',
    },
  });
}
