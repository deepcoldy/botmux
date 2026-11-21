import type {
  EffectivePresentation, FeedbackPresentationConfig, FeedbackPresentationLayer,
  FeedbackPresentationRule, FeedbackScope,
} from './feedback-extension-types.js';
import { feedbackExtensionId } from './feedback-extension-id.js';

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected object`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) throw new Error(`${path}.${field}: unknown field`);
  }
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(`${path}: expected nonempty identifier`);
  }
  return value;
}

function layer(value: unknown, path: string): FeedbackPresentationLayer {
  const raw = record(value, path);
  fields(raw, ['enabled', 'rounds', 'roundScope', 'mode', 'templateId', 'actionIds'], path);
  const result: FeedbackPresentationLayer = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error(`${path}.enabled: expected boolean`);
    result.enabled = raw.enabled;
  }
  if (raw.rounds !== undefined) {
    if (!Array.isArray(raw.rounds) || !raw.rounds.length || raw.rounds.some((round, index, rounds) =>
      !Number.isSafeInteger(round) || round < 1 || (index > 0 && round <= rounds[index - 1]))) {
      throw new Error(`${path}.rounds: expected ascending unique positive integers`);
    }
    result.rounds = [...raw.rounds];
  }
  if (raw.mode !== undefined) {
    if (raw.mode !== 'separate' && raw.mode !== 'inline' && raw.mode !== 'both') throw new Error(`${path}.mode: invalid mode`);
    result.mode = raw.mode;
  }
  if (raw.roundScope !== undefined) {
    if (raw.roundScope !== 'subject' && raw.roundScope !== 'topic') throw new Error(`${path}.roundScope: invalid scope`);
    result.roundScope = raw.roundScope;
  }
  if (raw.templateId !== undefined) result.templateId = identifier(raw.templateId, `${path}.templateId`);
  if (raw.actionIds !== undefined) {
    if (!Array.isArray(raw.actionIds)) throw new Error(`${path}.actionIds: expected array`);
    result.actionIds = raw.actionIds.map((entry, index) => feedbackExtensionId(entry, `${path}.actionIds[${index}]`));
    if (new Set(result.actionIds).size !== result.actionIds.length) throw new Error(`${path}.actionIds: duplicate`);
  }
  return result;
}

export function normalizeFeedbackPresentation(input: unknown): FeedbackPresentationConfig {
  if (input === undefined) return { default: { enabled: false }, rules: [] };
  const raw = record(input, 'feedbackPresentation');
  fields(raw, ['default', 'rules'], 'feedbackPresentation');
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) throw new Error('feedbackPresentation.rules: expected array');
  const ids = new Set<string>();
  const selectors = new Set<string>();
  const rules: FeedbackPresentationRule[] = ((raw.rules ?? []) as unknown[]).map((entry, index) => {
    const path = `feedbackPresentation.rules[${index}]`;
    const item = record(entry, path);
    const { id, match, ...presentation } = item;
    const ruleId = identifier(id, `${path}.id`);
    const selector = record(match, `${path}.match`);
    fields(selector, ['chatId', 'sourceMessageId'], `${path}.match`);
    const chatId = identifier(selector.chatId, `${path}.match.chatId`);
    const sourceMessageId = selector.sourceMessageId === undefined ? undefined
      : identifier(selector.sourceMessageId, `${path}.match.sourceMessageId`);
    const selectorKey = JSON.stringify([chatId, sourceMessageId ?? null]);
    if (ids.has(ruleId) || selectors.has(selectorKey)) throw new Error(`${path}: duplicate rule id or selector`);
    ids.add(ruleId);
    selectors.add(selectorKey);
    return { id: ruleId, match: { chatId, ...(sourceMessageId === undefined ? {} : { sourceMessageId }) }, ...layer(presentation, path) };
  });
  return { default: raw.default === undefined ? {} : layer(raw.default, 'feedbackPresentation.default'), rules };
}

export function resolveFeedbackPresentation(config: FeedbackPresentationConfig, scope: FeedbackScope): EffectivePresentation {
  if (!Number.isSafeInteger(scope.round) || scope.round < 1) throw new Error('feedbackPresentation.scope.round: invalid round');
  const matching = config.rules.filter(rule => rule.match.chatId === scope.chatId
    && (rule.match.sourceMessageId === undefined || rule.match.sourceMessageId === scope.sourceMessageId))
    .sort((left, right) => Number(left.match.sourceMessageId !== undefined) - Number(right.match.sourceMessageId !== undefined));
  const merged = Object.assign(
    { enabled: false, rounds: [1], mode: 'separate' as const, templateId: 'default', actionIds: [] as string[] },
    config.default, ...matching.map(({ id, match, ...presentation }) => presentation),
  );
  return {
    enabled: merged.enabled, rounds: [...merged.rounds], mode: merged.mode,
    templateId: merged.templateId, actionIds: [...merged.actionIds],
    ...(merged.roundScope === undefined ? {} : { roundScope: merged.roundScope }),
    matched: merged.enabled && merged.rounds.includes(scope.round), ruleIds: matching.map(rule => rule.id),
  };
}
