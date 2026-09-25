import type { BotConfig } from '../bot-registry.js';
import { normalizeFeedbackPolicy, validateReviewerEntries, type FeedbackPolicy } from './feedback-policy.js';
import { getTeam } from './team-store.js';
import { listTeamGroups } from './team-groups-store.js';

export interface FeedbackPolicyLayer {
  enabled?: boolean;
  audience?: 'requester' | 'reviewers' | 'everyone';
  reviewers?: unknown[];
  visibleSemantics?: unknown[];
  buttons?: unknown[];
  negativeFollowup?: {
    reasons?: unknown[];
    comment?: {
      enabled?: boolean;
      required?: boolean;
      placeholder?: string;
      maxLength?: number;
    };
  };
  allowReselect?: boolean;
}

const TOP_LEVEL = new Set(['enabled', 'audience', 'reviewers', 'visibleSemantics', 'buttons', 'negativeFollowup', 'allowReselect']);
const FOLLOWUP = new Set(['reasons', 'comment']);
const COMMENT = new Set(['enabled', 'required', 'placeholder', 'maxLength']);

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is unknown`);
}

/** Validate and defensively copy a persisted policy layer without filling defaults. */
export function normalizeFeedbackPolicyLayer(raw: unknown): FeedbackPolicyLayer {
  const input = record(raw, 'feedback');
  rejectUnknown(input, TOP_LEVEL, 'feedback');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('feedback.enabled must be boolean');
  if (input.audience !== undefined && input.audience !== 'requester' && input.audience !== 'reviewers' && input.audience !== 'everyone') throw new Error('feedback.audience must be requester, reviewers or everyone');
  if (input.allowReselect !== undefined && typeof input.allowReselect !== 'boolean') throw new Error('feedback.allowReselect must be boolean');
  if (input.reviewers !== undefined && !Array.isArray(input.reviewers)) throw new Error('feedback.reviewers must be an array');
  if (input.visibleSemantics !== undefined && !Array.isArray(input.visibleSemantics)) throw new Error('feedback.visibleSemantics must be an array');
  if (input.buttons !== undefined && !Array.isArray(input.buttons)) throw new Error('feedback.buttons must be an array');

  let negativeFollowup: FeedbackPolicyLayer['negativeFollowup'];
  if (input.negativeFollowup !== undefined) {
    const followup = record(input.negativeFollowup, 'feedback.negativeFollowup');
    rejectUnknown(followup, FOLLOWUP, 'feedback.negativeFollowup');
    if (followup.reasons !== undefined && !Array.isArray(followup.reasons)) throw new Error('feedback.negativeFollowup.reasons must be an array');
    let comment: NonNullable<FeedbackPolicyLayer['negativeFollowup']>['comment'];
    if (followup.comment !== undefined) {
      const rawComment = record(followup.comment, 'feedback.negativeFollowup.comment');
      rejectUnknown(rawComment, COMMENT, 'feedback.negativeFollowup.comment');
      if (rawComment.enabled !== undefined && typeof rawComment.enabled !== 'boolean') throw new Error('feedback.negativeFollowup.comment.enabled must be boolean');
      if (rawComment.required !== undefined && typeof rawComment.required !== 'boolean') throw new Error('feedback.negativeFollowup.comment.required must be boolean');
      if (rawComment.placeholder !== undefined && typeof rawComment.placeholder !== 'string') throw new Error('feedback.negativeFollowup.comment.placeholder must be string');
      if (rawComment.maxLength !== undefined && !Number.isInteger(rawComment.maxLength)) throw new Error('feedback.negativeFollowup.comment.maxLength must be integer');
      comment = structuredClone(rawComment) as typeof comment;
    }
    negativeFollowup = {
      ...(followup.reasons !== undefined ? { reasons: structuredClone(followup.reasons) } : {}),
      ...(comment !== undefined ? { comment } : {}),
    };
  }

  const layer: FeedbackPolicyLayer = {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.audience !== undefined ? { audience: input.audience as 'requester' | 'reviewers' | 'everyone' } : {}),
    ...(input.reviewers !== undefined ? { reviewers: structuredClone(input.reviewers) } : {}),
    ...(input.visibleSemantics !== undefined ? { visibleSemantics: structuredClone(input.visibleSemantics) } : {}),
    ...(input.buttons !== undefined ? { buttons: structuredClone(input.buttons) } : {}),
    ...(negativeFollowup !== undefined ? { negativeFollowup } : {}),
    ...(input.allowReselect !== undefined ? { allowReselect: input.allowReselect } : {}),
  };

  // Validate the reviewer allowlist FORMAT here (a partial layer may carry
  // `reviewers` without `audience`, or vice-versa — the cross-field coupling is
  // enforced only on the merged effective policy). Other atomic values are
  // validated by delegating to the full normalizer below.
  if (layer.reviewers !== undefined) validateReviewerEntries(layer.reviewers);
  // Validate supplied atomic values without expanding this persisted layer with
  // defaults. Layers remain partial so a restart cannot turn inherited values
  // into stale bot/chat-owned copies.
  if (layer.visibleSemantics !== undefined || layer.buttons !== undefined || layer.negativeFollowup !== undefined) {
    normalizeFeedbackPolicy({ enabled: true, ...layer, audience: 'requester', reviewers: undefined });
  }
  return layer;
}

function mergeLayer(target: Record<string, unknown>, raw: FeedbackPolicyLayer | undefined): void {
  if (!raw) return;
  const layer = normalizeFeedbackPolicyLayer(raw);
  for (const field of ['enabled', 'audience', 'reviewers', 'visibleSemantics', 'buttons', 'allowReselect'] as const) {
    if (layer[field] !== undefined) target[field] = structuredClone(layer[field]);
  }
  if (layer.negativeFollowup) {
    const prior = (target.negativeFollowup ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...prior };
    if (layer.negativeFollowup.reasons !== undefined) next.reasons = structuredClone(layer.negativeFollowup.reasons);
    if (layer.negativeFollowup.comment !== undefined) {
      next.comment = { ...((prior.comment ?? {}) as Record<string, unknown>), ...structuredClone(layer.negativeFollowup.comment) };
    }
    target.negativeFollowup = next;
  }
}

export function resolveEffectiveFeedbackPolicy(input: {
  team?: FeedbackPolicyLayer;
  bot?: FeedbackPolicyLayer;
  chat?: FeedbackPolicyLayer;
  apiOnly?: boolean;
}): FeedbackPolicy | undefined {
  if (input.apiOnly) return undefined;
  const merged: Record<string, unknown> = { enabled: false };
  mergeLayer(merged, input.team);
  mergeLayer(merged, input.bot);
  mergeLayer(merged, input.chat);
  if (merged.enabled !== true) return undefined;
  // Individually-valid layers can still merge into an invalid whole (for
  // example, a reviewers allowlist paired with another audience). Fail closed
  // rather than letting the throw propagate to worker-spawn delivery. An empty
  // reviewers allowlist is valid and remains visible but unclickable.
  try {
    return structuredClone(normalizeFeedbackPolicy(merged));
  } catch {
    return undefined;
  }
}

/** Resolve local hosted-team, bot, and bot-scoped chat layers at delivery time. */
export function resolveFeedbackTeamId(input: { dataDir: string; chatId?: string }): string | undefined {
  if (!input.chatId) return undefined;
  const teamIds = [...new Set(listTeamGroups(input.dataDir)
    .filter(binding => binding.chatId === input.chatId && !binding.teamId.startsWith('platform:'))
    .map(binding => binding.teamId))];
  return teamIds.length === 1 ? teamIds[0] : undefined;
}

export function resolveFeedbackPolicyForDelivery(input: {
  dataDir: string;
  larkAppId: string;
  chatId?: string;
  bot: Pick<BotConfig, 'apiOnly' | 'feedback' | 'chatFeedbackPolicies'>;
}): FeedbackPolicy | undefined {
  const bindings = input.chatId
    ? listTeamGroups(input.dataDir).filter(binding => binding.chatId === input.chatId && !binding.teamId.startsWith('platform:'))
    : [];
  const teamIds = [...new Set(bindings.map(binding => binding.teamId))];
  if (teamIds.length > 1) return undefined;
  const team = teamIds.length === 1 ? getTeam(input.dataDir, teamIds[0]) : null;
  return resolveEffectiveFeedbackPolicy({
    team: team?.feedback,
    bot: input.bot.feedback as FeedbackPolicyLayer | undefined,
    chat: input.chatId ? input.bot.chatFeedbackPolicies?.[input.chatId] as FeedbackPolicyLayer | undefined : undefined,
    apiOnly: input.bot.apiOnly,
  });
}

export interface FeedbackPolicyTrace {
  teamId: string | null;
  layers: { team?: FeedbackPolicyLayer; bot?: FeedbackPolicyLayer; chat?: FeedbackPolicyLayer };
  effective: FeedbackPolicy | null;
  sources: Record<string, 'team' | 'bot' | 'chat'>;
  reason: 'enabled' | 'disabled' | 'api_only' | 'ambiguous_team';
}

/** Dashboard-safe explanation of the same delivery-time resolution contract. */
export function traceFeedbackPolicyForDelivery(input: {
  dataDir: string;
  larkAppId: string;
  chatId?: string;
  bot: Pick<BotConfig, 'apiOnly' | 'feedback' | 'chatFeedbackPolicies'>;
}): FeedbackPolicyTrace {
  const bindings = input.chatId
    ? listTeamGroups(input.dataDir).filter(binding => binding.chatId === input.chatId && !binding.teamId.startsWith('platform:'))
    : [];
  const teamIds = [...new Set(bindings.map(binding => binding.teamId))];
  if (teamIds.length > 1) return { teamId: null, layers: {}, effective: null, sources: {}, reason: 'ambiguous_team' };
  const teamId = teamIds[0] ?? null;
  const layers = {
    ...(teamId && getTeam(input.dataDir, teamId)?.feedback ? { team: normalizeFeedbackPolicyLayer(getTeam(input.dataDir, teamId)!.feedback) } : {}),
    ...(input.bot.feedback ? { bot: normalizeFeedbackPolicyLayer(input.bot.feedback) } : {}),
    ...(input.chatId && input.bot.chatFeedbackPolicies?.[input.chatId]
      ? { chat: normalizeFeedbackPolicyLayer(input.bot.chatFeedbackPolicies[input.chatId]) } : {}),
  };
  const sources: FeedbackPolicyTrace['sources'] = {};
  for (const [scope, layer] of Object.entries(layers) as Array<['team' | 'bot' | 'chat', FeedbackPolicyLayer]>) {
    for (const key of Object.keys(layer)) sources[key] = scope;
    if (layer.negativeFollowup) {
      for (const key of Object.keys(layer.negativeFollowup)) sources[`negativeFollowup.${key}`] = scope;
      if (layer.negativeFollowup.comment) for (const key of Object.keys(layer.negativeFollowup.comment)) sources[`negativeFollowup.comment.${key}`] = scope;
    }
  }
  const effective = resolveEffectiveFeedbackPolicy({ ...layers, apiOnly: input.bot.apiOnly }) ?? null;
  return { teamId, layers, effective, sources, reason: input.bot.apiOnly ? 'api_only' : effective ? 'enabled' : 'disabled' };
}
