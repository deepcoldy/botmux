import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { underReadIsolation } from './adapters/cli/read-isolation.js';
import type { BackendType } from './adapters/backend/types.js';
import { normalizeMojoConfig, type MojoConfig } from './adapters/backend/mojo-types.js';
import type { RiffBackendConfig } from './adapters/backend/riff-backend.js';
import type { CliId } from './adapters/cli/types.js';
import {
  normalizeCliRuntimeConfig,
  type CliRuntimeConfig,
} from './adapters/cli/runtime.js';
import { logger } from './utils/logger.js';
import { isLocale, setBotLookup, type Locale } from './i18n/index.js';
import type { VoiceConfig } from './services/voice/types.js';
import type { PricingOverrides } from './services/model-pricing.js';
import type { BudgetConfig } from './services/budget-tracker.js';
import { normalizePricingOverrides } from './services/model-pricing.js';
import { parseBudgetConfig } from './services/budget-tracker.js';
import { type Brand, sdkDomain, normalizeBrand } from './im/lark/lark-hosts.js';
import type { BotSkillPolicy, SkillSelector } from './core/skills/types.js';
import { normalizeStartupCommandList } from './core/startup-commands.js';
import { DAEMON_COMMANDS } from './core/passthrough-commands.js';
import { sanitizePerBotEnv } from './core/per-bot-env.js';
import { resolveBotmuxConfigDir, resolveBotsConfigFile, type BotsConfigProvenance } from './core/config-dir.js';
import { normalizeSubstituteMode } from './services/substitute-mode-normalize.js';
import { normalizePluginIdList } from './core/plugins/ids.js';
import { normalizeVcMeetingProfileInstructions } from './services/vc-meeting-profile-instructions.js';
import { isGrantDurationOption } from './services/grant-policy.js';
import {
  normalizeExistingAppServerConfig,
  type ExistingAppServerConfig,
} from './core/existing-app-server.js';
import {
  normalizeCodexBrowserConfig,
  type CodexBrowserConfig,
} from './core/codex-browser-config.js';
import type { FeedbackPolicy, FeedbackPolicyInput } from './services/feedback-policy.js';
import { normalizeFeedbackPolicyLayer } from './services/feedback-policy-resolver.js';
import type { FeedbackWebhookDestination } from './services/feedback-outbox.js';
import {
  normalizeReplyStyleConfig,
  type ReplyStyleConfig,
} from './im/lark/reply-card-style.js';
import { cliModelSupportsReasoningEffort, isConfigurableReasoningCliId, isCodexReasoningEffort } from './services/codex-reasoning-effort.js';
import {
  normalizeSessionOwnerReminderConfig,
  type SessionOwnerReminderConfig,
} from './core/session-owner-reminder.js';
import type {
  VcMeetingConsumerAgentConfig,
  VcMeetingConsumerConfig,
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileConfig,
} from './types.js';
import type { VcMeetingActivityType } from './vc-agent/types.js';

/**
 * Thrown when any Feishu client is requested for a core-only (`apiOnly`) bot.
 * Defined here (the lowest-level module that owns bot config + client) so both
 * `getBotClient` and higher layers (im/lark/client.ts primitives, doc-comment)
 * throw the SAME typed error without an import cycle. apiOnly = zero Feishu
 * network (reads AND writes); reaching a client request is genuine misuse.
 */
export class LarkTransportDisabledError extends Error {
  constructor(larkAppId: string, op: string) {
    super(`Feishu transport is disabled for core-only bot ${larkAppId} (attempted: ${op})`);
    this.name = 'LarkTransportDisabledError';
  }
}

export type {
  VcMeetingConsumerAgentConfig,
  VcMeetingConsumerConfig,
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileConfig,
} from './types.js';

/** Bound every official-SDK HTTP call so one stalled provider request cannot
 * hold a bot-turn admission or maintenance mutation indefinitely. */
export const LARK_REQUEST_TIMEOUT_MS = 15_000;

/** Media uploads (image/file) ride the same official-SDK path but move real
 * bytes: a 30 MB video on a modest uplink legitimately exceeds the interactive
 * request bound. They also run in the `botmux send` CLI subprocess, which holds
 * no daemon admission/mutation lock, so the interactive timeout's protective
 * purpose does not apply to them. Give uploads a far looser ceiling. */
export const LARK_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Upper bound for a per-bot dsh runner turn timeout. Node's `setTimeout` delay
 * is a 32-bit signed int of milliseconds; a larger value silently wraps to ~1ms
 * and emits `TimeoutOverflowWarning`, so any timeout the runner will actually
 * arm must fit here. Config parsing, the dashboard IPC, and the dashboard UI all
 * validate against this single bound.
 */
export const MAX_TURN_TIMEOUT_MS = 2_147_483_647;

/**
 * Normalize an untrusted `turnTimeoutMs` value: a positive integer within the
 * arm-able bound is kept, anything else (≤0, non-integer, over the bound,
 * non-number, absent) collapses to `undefined` (= use the runner default).
 */
export function normalizeTurnTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= MAX_TURN_TIMEOUT_MS
    ? value
    : undefined;
}

/**
 * Normalize an untrusted `dshRuntime` value: only the two known variants are
 * kept; anything else (typo, unknown string, wrong type) collapses to
 * `undefined` (= official runner). The field is dsh-only; non-dsh CLIs drop
 * it at the call site (same pattern as turnTimeoutMs).
 */
export function normalizeDshRuntime(value: unknown): 'official' | 'tui' | undefined {
  return value === 'official' || value === 'tui' ? value : undefined;
}

export function configureLarkClientHttpTimeout(client: unknown): void {
  const defaults = (client as { httpInstance?: { defaults?: { timeout?: number } } } | null)
    ?.httpInstance?.defaults;
  if (defaults) defaults.timeout = LARK_REQUEST_TIMEOUT_MS;
}

/**
 * A dedicated SDK http instance for media uploads. The official SDK shares ONE
 * module-level axios singleton across every `Client` (verified: two clients
 * report the same `httpInstance`), and its typed `image.create`/`file.create`
 * expose no per-request timeout hook — so the only knob for uploads is a
 * separate instance. `defaultHttpInstance.create()` yields an independent axios
 * (its own `defaults`, not the shared one); we copy the SDK's own request UA and
 * response-unwrap interceptors so upload responses (`res.data` → `image_key`)
 * behave identically. Falls back to leaving the client on the shared instance
 * if the SDK ever stops exporting `defaultHttpInstance`, so a future SDK bump
 * degrades to "uploads keep the interactive timeout" rather than breaking.
 */
let cachedLarkUploadHttpInstance: unknown;
export function larkUploadHttpInstance(): unknown {
  if (cachedLarkUploadHttpInstance !== undefined) return cachedLarkUploadHttpInstance;
  let base: any;
  try {
    base = (Lark as unknown as { defaultHttpInstance?: any }).defaultHttpInstance;
  } catch {
    // A stripped/mocked SDK namespace may throw on accessing an absent export.
    base = undefined;
  }
  if (!base || typeof base.create !== 'function') {
    cachedLarkUploadHttpInstance = null;
    return cachedLarkUploadHttpInstance;
  }
  const instance = base.create({ timeout: LARK_UPLOAD_TIMEOUT_MS });
  try {
    for (const handler of base.interceptors?.request?.handlers ?? []) {
      if (handler) {
        instance.interceptors.request.use(handler.fulfilled, handler.rejected, {
          synchronous: handler.synchronous,
        });
      }
    }
    for (const handler of base.interceptors?.response?.handlers ?? []) {
      if (handler) instance.interceptors.response.use(handler.fulfilled, handler.rejected);
    }
  } catch {
    // A shape change in the SDK's interceptor registry must not brick uploads;
    // an instance without the response-unwrap interceptor would misread
    // responses, so fall back to the shared instance (interactive timeout).
    cachedLarkUploadHttpInstance = null;
    return cachedLarkUploadHttpInstance;
  }
  cachedLarkUploadHttpInstance = instance;
  return cachedLarkUploadHttpInstance;
}

export type ChatReplyMode = 'chat' | 'new-topic' | 'shared' | 'chat-topic';
/** 普通群 @ 策略：always=必须 @｜topic=话题内免 @｜never=免 @｜ambient=免 @ 但 @ 别人时安静。 */
export type GroupMentionMode = 'always' | 'topic' | 'never' | 'ambient';
/** Where a bot shows native Context / Token usage on its Session cards. */
export type UsageDisplayMode = 'streaming' | 'footer' | 'off';
/** Default when a bot sets nothing: usage rides the live streaming card. */
export const DEFAULT_USAGE_DISPLAY: UsageDisplayMode = 'streaming';
export type ContentTriggerScope = 'topic' | 'regularGroup' | 'both';
export type ContentTriggerMatchType = 'keyword' | 'regex';
export type ContentTriggerActionType = 'start-or-wake-session';
export type MessageListenerSenderType = 'user' | 'bot';

export interface MessageListenerConfig {
  enabled: boolean;
  name?: string;
  replyCardTitle?: string;
  workingDir?: string;
  prompt: string;
  senderPolicy?: {
    /**
     * all_except_excluded: listen to all matching sender types except excluded ids.
     * include_only: listen only to includeSenderOpenIds; empty include means none.
     */
    mode?: 'all_except_excluded' | 'include_only';
    includeSenderOpenIds?: string[];
    excludeSenderOpenIds?: string[];
    /**
     * Persisted sender KIND for each exclude id (open_id → 'user' | 'bot'), so
     * the runtime fail-close decision (all_except_excluded + unverified bot
     * sender) can tell a muted human from a muted bot WITHOUT guessing by id
     * prefix. Absent entries fall back to a conservative "maybe a bot".
     */
    excludeSenderKinds?: Record<string, 'user' | 'bot'>;
    includeSenderTypes?: MessageListenerSenderType[];
    excludeSenderTypes?: MessageListenerSenderType[];
    /** Default true. */
    excludeSelf?: boolean;
  };
  messagePolicy?: {
    /** Defaults to text + post. */
    includeMsgTypes?: string[];
    /** V1 only supports top-level group messages. */
    scope?: 'top_level';
  };
  /**
   * Optional daemon-side keyword pre-filter. Absent or all-empty = match every
   * message (legacy behavior). When configured, a message matches the listener
   * ONLY when its text satisfies the policy, so non-matching messages never
   * wake the Agent. Keywords are case-insensitive substrings (linear-time
   * `String.includes`, safe against attacker-controlled message text).
   * `matchMode` 'any' (default) matches when at least one keyword hits; 'all'
   * requires every keyword to hit.
   *
   * V1 intentionally does NOT support regexes: the policy is evaluated on the
   * daemon main event loop for every inbound/backfilled message, and a user-
   * authored JS regex with catastrophic backtracking (e.g. `(a+)+$`, 6 chars)
   * freezes the whole multi-bot daemon for tens of seconds on a ~30-char
   * message. A regex mode can return later behind a linear-time engine (RE2).
   *
   * bots.json example:
   * `{"messageListeners":{"oc_xxx":{"enabled":true,"prompt":"...","contentPolicy":{"includeKeywords":["报错","500"],"matchMode":"any"}}}}`
   */
  contentPolicy?: {
    includeKeywords?: string[];
    matchMode?: 'any' | 'all';
  };
  replyPolicy?: {
    /** V1 always replies under the triggering message. */
    mode?: 'thread';
    /** V1 starts one session per matched message. */
    sessionMode?: 'per_message';
  };
}

export interface SummaryRangeConfig {
  /** 0 means no count limit; omitted defaults to 50. */
  limit?: number;
  /** 0 means no time limit; omitted defaults to 24 hours. */
  sinceHours?: number;
}

export interface ContentTriggerConfig {
  name: string;
  enabled: boolean;
  scope: ContentTriggerScope;
  /**
   * Default false. When true, this trigger may be matched by non-@ messages
   * authored by other bots. The current bot's own messages are still ignored.
   */
  allowBotMessages?: boolean;
  match: {
    type: ContentTriggerMatchType;
    pattern: string;
    caseSensitive: boolean;
  };
  history: {
    topic: {
      mode: 'current-thread';
    };
    regularGroup: {
      mode: 'recent-messages';
      /** 0 means no count limit; omitted defaults to 50. */
      limit?: number;
      /** 0 means no time limit; omitted means no time limit. */
      sinceHours?: number;
    };
  };
  action: {
    type: ContentTriggerActionType;
    prompt: string;
  };
}

function normalizeFeedbackWebhookConfig(raw: unknown): { destinations: FeedbackWebhookDestination[] } | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).destinations)) return undefined;
  const seen = new Set<string>();
  const destinations: FeedbackWebhookDestination[] = [];
  for (const item of (raw as any).destinations) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const secretRef = typeof item.secretRef === 'string' ? item.secretRef.trim() : '';
    const eventTypes = Array.isArray(item.eventTypes)
      ? [...new Set(item.eventTypes.filter((type: unknown) => type === 'turn.completed' || type === 'feedback.revised'))] as Array<'turn.completed' | 'feedback.revised'>
      : [];
    if (!id || seen.has(id) || !url || !secretRef || eventTypes.length === 0) continue;
    seen.add(id);
    destinations.push({ id, enabled: item.enabled !== false, url, eventTypes, secretRef,
      ...(Number.isInteger(item.timeoutMs) && item.timeoutMs > 0 ? { timeoutMs: Math.min(item.timeoutMs, 30_000) } : {}) });
  }
  return destinations.length ? { destinations } : undefined;
}

function normalizeChatReplyModeConfig(raw: unknown): ChatReplyMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'chat') return 'chat';
  if (v === 'chat-topic' || v === 'chattopic' || v === 'chat_topic') return 'chat-topic';
  if (v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'topic' || v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
  return undefined;
}

function normalizeGroupMentionModeConfig(raw: unknown): GroupMentionMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'always' || v === 'topic' || v === 'never' || v === 'ambient') return v;
  return undefined;
}

function normalizeContentTriggerScope(raw: unknown): ContentTriggerScope | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'both' || v === 'all') return 'both';
  if (v === 'topic' || v === 'thread' || v === 'topic-group' || v === 'topic_group') return 'topic';
  if (v === 'regulargroup' || v === 'regular-group' || v === 'regular_group' || v === 'group') return 'regularGroup';
  return undefined;
}

function normalizeMessageListenerSenderType(raw: unknown): MessageListenerSenderType | undefined {
  if (raw === 'user' || raw === 'human') return 'user';
  if (raw === 'bot' || raw === 'app') return 'bot';
  return undefined;
}

function normalizeNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number') return undefined;
  if (!Number.isInteger(raw) || raw < 0) return undefined;
  return raw;
}

function normalizePositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number') return undefined;
  if (!Number.isInteger(raw) || raw <= 0) return undefined;
  return raw;
}

function normalizeNonEmptyString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function normalizeTimeZone(raw: unknown): string | undefined {
  const timeZone = normalizeNonEmptyString(raw);
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    logger.warn(`vcMeetingAgent.timeZone ignored: invalid IANA time zone ${JSON.stringify(timeZone)}`);
    return undefined;
  }
}

function normalizeVcMeetingAgentConfig(raw: unknown): VcMeetingAgentConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const out: VcMeetingAgentConfig = {};
  // VC 默认对每个连着飞书的 bot 生效(vcMeetingAgentConfigActive:enabled!==false),
  // 所以 enabled:false 是**显式退出**,必须原样保留——只留 true 会把 false round-trip
  // 成 undefined(=默认开),让"关掉这个 bot 的会议"重载即失效。
  if (entry.enabled === true) out.enabled = true;
  else if (entry.enabled === false) out.enabled = false;
  const notificationChatId = normalizeNonEmptyString(entry.notificationChatId);
  const listenerChatId = normalizeNonEmptyString(entry.listenerChatId);
  const attentionTargetOpenId = normalizeNonEmptyString(entry.attentionTargetOpenId);
  const larkCliProfile = normalizeNonEmptyString(entry.larkCliProfile);
  const timeZone = normalizeTimeZone(entry.timeZone ?? entry.timezone);
  const inviteTtlMs = normalizePositiveInt(entry.inviteTtlMs);
  const stabilizeMs = normalizePositiveInt(entry.stabilizeMs);
  const flushIntervalMs = normalizePositiveInt(entry.flushIntervalMs);
  const realtimeVoice = normalizeVcMeetingRealtimeVoiceConfig(entry.realtimeVoice);
  const meetingConsumer = normalizeVcMeetingConsumerConfig(entry.meetingConsumer);
  if (notificationChatId) out.notificationChatId = notificationChatId;
  if (listenerChatId) out.listenerChatId = listenerChatId;
  if (attentionTargetOpenId) out.attentionTargetOpenId = attentionTargetOpenId;
  if (larkCliProfile) out.larkCliProfile = larkCliProfile;
  if (timeZone) out.timeZone = timeZone;
  if (inviteTtlMs !== undefined) out.inviteTtlMs = inviteTtlMs;
  if (stabilizeMs !== undefined) out.stabilizeMs = stabilizeMs;
  if (flushIntervalMs !== undefined) out.flushIntervalMs = flushIntervalMs;
  if (realtimeVoice) out.realtimeVoice = realtimeVoice;
  if (meetingConsumer) out.meetingConsumer = meetingConsumer;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeVcMeetingConsumerConfig(raw: unknown): VcMeetingConsumerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const out: VcMeetingConsumerConfig = {};
  if (entry.enabled === true) out.enabled = true;
  if (entry.enabled === false) out.enabled = false;
  const selectionTimeoutMs = normalizePositiveInt(entry.selectionTimeoutMs);
  const injectIntervalMs = normalizePositiveInt(entry.injectIntervalMs);
  const minBatchChars = normalizePositiveInt(entry.minBatchChars);
  const minBatchItems = normalizePositiveInt(entry.minBatchItems);
  const maxInjectIntervalMs = normalizePositiveInt(entry.maxInjectIntervalMs);
  if (selectionTimeoutMs !== undefined) out.selectionTimeoutMs = selectionTimeoutMs;
  if (injectIntervalMs !== undefined) out.injectIntervalMs = injectIntervalMs;
  if (minBatchChars !== undefined) out.minBatchChars = minBatchChars;
  if (minBatchItems !== undefined) out.minBatchItems = minBatchItems;
  if (maxInjectIntervalMs !== undefined) out.maxInjectIntervalMs = maxInjectIntervalMs;
  if (entry.textOutputPolicy === 'allow' || entry.textOutputPolicy === 'approval' || entry.textOutputPolicy === 'deny') {
    out.textOutputPolicy = entry.textOutputPolicy;
  }
  if (entry.voiceOutputPolicy === 'allow' || entry.voiceOutputPolicy === 'approval' || entry.voiceOutputPolicy === 'deny') {
    out.voiceOutputPolicy = entry.voiceOutputPolicy;
  }

  // per-bot 从共享目录挑的默认角色。与 consumerProfiles 无关(bot 继承目录、不拥有
  // 预设),故无条件归一化,不触发 legacy "consumerProfiles required" resolver 门。
  // 空串/空白 = 「跟随全局默认」,等同没配。
  const catalogDefaultConsumerId = normalizeNonEmptyString(entry.catalogDefaultConsumerId);
  if (catalogDefaultConsumerId) out.catalogDefaultConsumerId = catalogDefaultConsumerId;

  if (Object.prototype.hasOwnProperty.call(entry, 'defaultProfileBootstrap')) {
    const marker = entry.defaultProfileBootstrap;
    const path = 'vcMeetingAgent.meetingConsumer.defaultProfileBootstrap';
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      strictConfigError(path, 'must be an object');
    }
    const markerEntry = marker as Record<string, unknown>;
    const allowedKeys = new Set(['generatorVersion', 'profileId', 'configHash']);
    const unknownKeys = Object.keys(markerEntry).filter(key => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      strictConfigError(path, `unknown field(s): ${unknownKeys.join(', ')}`);
    }
    const generatorVersion = normalizePositiveInt(markerEntry.generatorVersion);
    const profileId = normalizeNonEmptyString(markerEntry.profileId);
    const configHash = normalizeNonEmptyString(markerEntry.configHash);
    if (generatorVersion === undefined) strictConfigError(`${path}.generatorVersion`, 'must be a positive integer');
    if (!profileId) strictConfigError(`${path}.profileId`, 'must be a non-empty string');
    if (!configHash || !/^sha256:[0-9a-f]{64}$/u.test(configHash)) {
      strictConfigError(`${path}.configHash`, 'must be a sha256:<64 lowercase hex> value');
    }
    out.defaultProfileBootstrap = { generatorVersion, profileId, configHash };
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'consumerProfiles')) {
    out.consumerProfiles = normalizeVcMeetingConsumerProfiles(entry.consumerProfiles);
    if (Object.prototype.hasOwnProperty.call(entry, 'defaultConsumerIds')) {
      out.defaultConsumerIds = normalizeStrictStringList(
        entry.defaultConsumerIds,
        'vcMeetingAgent.meetingConsumer.defaultConsumerIds',
      );
    }
    if (entry.defaultMode === 'listenOnly' || entry.defaultMode === 'agents') {
      out.defaultMode = entry.defaultMode;
    } else if (entry.defaultMode !== undefined && entry.defaultMode !== 'agent') {
      throw new Error(
        'vcMeetingAgent.meetingConsumer.defaultMode must be listenOnly or agents when consumerProfiles is present',
      );
    }

    const legacyFields = [
      'defaultAgentAppId',
      'defaultAgent',
      'agentCandidates',
      'agents',
      ...(entry.defaultMode === 'agent' ? ['defaultMode=agent'] : []),
    ].filter((field) => field.includes('=') || Object.prototype.hasOwnProperty.call(entry, field));
    if (legacyFields.length > 0) {
      logger.warn(
        `vcMeetingAgent.meetingConsumer.consumerProfiles is present; ignoring legacy fields: ${legacyFields.join(', ')}`,
      );
    }

    const resolution = resolveVcMeetingConsumerProfiles(out);
    if (!resolution.ok) throw new Error(resolution.errors.join('; '));
  } else {
    if (entry.defaultMode === 'listenOnly' || entry.defaultMode === 'agent') out.defaultMode = entry.defaultMode;
    const defaultAgentAppId = normalizeNonEmptyString(entry.defaultAgentAppId)
      ?? normalizeNonEmptyString(entry.defaultAgent);
    const candidates = normalizeVcMeetingConsumerCandidates(entry.agentCandidates ?? entry.agents);
    if (defaultAgentAppId) out.defaultAgentAppId = defaultAgentAppId;
    if (candidates.length > 0) out.agentCandidates = candidates;
  }
  if (out.defaultProfileBootstrap && out.consumerProfiles === undefined) {
    strictConfigError(
      'vcMeetingAgent.meetingConsumer.defaultProfileBootstrap',
      'requires consumerProfiles',
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const VC_MEETING_CONSUMER_ACTIVITY_TYPES = [
  'participant_joined',
  'participant_left',
  'chat_received',
  'transcript_received',
  'magic_share_started',
  'magic_share_ended',
] as const satisfies readonly VcMeetingActivityType[];

const VC_MEETING_CONSUMER_MANAGED_SINKS = [
  'meeting_text',
  'meeting_voice',
] as const satisfies readonly VcMeetingConsumerManagedSink[];

const VC_MEETING_LISTENER_OUTPUT_PLACEMENTS = ['auto', 'chat', 'topic'] as const;

const VC_MEETING_OUTPUT_CAPABILITY = 'meeting.output.request';
const VC_MEETING_LISTENER_OUTPUT_CAPABILITY = 'listener.output.request';
const VC_MEETING_CONSUMER_PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VC_MEETING_CONSUMER_RESERVED_PROFILE_IDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

function strictConfigError(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function validateVcMeetingConsumerProfileId(id: string, path: string): void {
  if (VC_MEETING_CONSUMER_RESERVED_PROFILE_IDS.has(id)) {
    strictConfigError(path, `${JSON.stringify(id)} is reserved`);
  }
  if (!VC_MEETING_CONSUMER_PROFILE_ID_RE.test(id)) {
    strictConfigError(path, 'must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }
}

function normalizeStrictStringList(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw)) strictConfigError(path, 'must be an array');
  const out: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const value = normalizeNonEmptyString(raw[index]);
    if (!value) strictConfigError(`${path}[${index}]`, 'must be a non-empty string');
    if (seen.has(value)) strictConfigError(`${path}[${index}]`, `duplicates ${JSON.stringify(value)}`);
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeVcMeetingConsumerProfileFilter(
  raw: unknown,
  path: string,
): VcMeetingConsumerProfileConfig['filter'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    strictConfigError(path, 'must be an object');
  }
  const entry = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(entry).filter(key => key !== 'activityTypes');
  if (unknownKeys.length > 0) {
    strictConfigError(path, `unsupported filter field(s): ${unknownKeys.join(', ')}`);
  }
  if (entry.activityTypes === undefined) return undefined;
  const activityTypes = normalizeStrictStringList(entry.activityTypes, `${path}.activityTypes`);
  for (let index = 0; index < activityTypes.length; index += 1) {
    if (!(VC_MEETING_CONSUMER_ACTIVITY_TYPES as readonly string[]).includes(activityTypes[index]!)) {
      strictConfigError(
        `${path}.activityTypes[${index}]`,
        `unsupported activity type ${JSON.stringify(activityTypes[index])}`,
      );
    }
  }
  return activityTypes.length > 0
    ? { activityTypes: activityTypes as VcMeetingActivityType[] }
    : undefined;
}

function normalizeVcMeetingConsumerOwnedSinks(
  raw: unknown,
  path: string,
  capabilities: readonly string[],
): VcMeetingConsumerManagedSink[] | undefined {
  if (raw === undefined) return undefined;
  const sinks = normalizeStrictStringList(raw, path);
  for (let index = 0; index < sinks.length; index += 1) {
    const sink = sinks[index]!;
    if (sink === 'listener_notice') {
      strictConfigError(`${path}[${index}]`, 'listener_notice is reserved for the daemon system principal');
    }
    if (!(VC_MEETING_CONSUMER_MANAGED_SINKS as readonly string[]).includes(sink)) {
      strictConfigError(`${path}[${index}]`, `unsupported owned sink ${JSON.stringify(sink)} in MA-P1 slice 1A`);
    }
    if (!capabilities.includes(VC_MEETING_OUTPUT_CAPABILITY)) {
      strictConfigError(
        `${path}[${index}]`,
        `${sink} requires capability ${VC_MEETING_OUTPUT_CAPABILITY}`,
      );
    }
  }
  return sinks.length > 0 ? sinks as VcMeetingConsumerManagedSink[] : undefined;
}

function normalizeVcMeetingListenerDelivery(
  raw: unknown,
  path: string,
): VcMeetingConsumerProfileConfig['listenerDelivery'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    strictConfigError(path, 'must be an object');
  }
  const entry = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(entry).filter(key => key !== 'placement');
  if (unknownKeys.length > 0) {
    strictConfigError(path, `unknown field(s): ${unknownKeys.join(', ')}`);
  }
  if (!(VC_MEETING_LISTENER_OUTPUT_PLACEMENTS as readonly unknown[]).includes(entry.placement)) {
    strictConfigError(`${path}.placement`, 'must be auto, chat, or topic');
  }
  return { placement: entry.placement as 'auto' | 'chat' | 'topic' };
}

export function normalizeVcMeetingConsumerProfiles(raw: unknown): VcMeetingConsumerProfileConfig[] {
  const path = 'vcMeetingAgent.meetingConsumer.consumerProfiles';
  if (!Array.isArray(raw)) strictConfigError(path, 'must be an array');
  return raw.map((value, index) => {
    const profilePath = `${path}[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      strictConfigError(profilePath, 'must be an object');
    }
    const entry = value as Record<string, unknown>;
    const allowedKeys = new Set([
      'id',
      'agentAppId',
      'label',
      'role',
      'instructions',
      'filter',
      'responseMode',
      'listenerDelivery',
      'capabilities',
      'ownedSinks',
    ]);
    const unknownKeys = Object.keys(entry).filter(key => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
      strictConfigError(profilePath, `unknown field(s): ${unknownKeys.join(', ')}`);
    }
    const id = normalizeNonEmptyString(entry.id);
    if (!id) strictConfigError(`${profilePath}.id`, 'must be a non-empty string');
    validateVcMeetingConsumerProfileId(id, `${profilePath}.id`);
    const agentAppId = normalizeNonEmptyString(entry.agentAppId);
    if (!agentAppId) strictConfigError(`${profilePath}.agentAppId`, 'must be a non-empty string');
    const role = normalizeNonEmptyString(entry.role);
    if (!role) strictConfigError(`${profilePath}.role`, 'must be a non-empty string');
    if (role.length > 256) strictConfigError(`${profilePath}.role`, 'must be at most 256 characters');
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(role)) {
      strictConfigError(`${profilePath}.role`, 'must be a single printable line');
    }
    if (role.toLowerCase().includes('botmux_role_instructions')) {
      strictConfigError(`${profilePath}.role`, 'contains a reserved botmux instruction marker');
    }
    const normalizedInstructions = normalizeVcMeetingProfileInstructions(entry.instructions);
    if (!normalizedInstructions.ok) {
      strictConfigError(`${profilePath}.instructions`, normalizedInstructions.error);
    }
    if (entry.label !== undefined && !normalizeNonEmptyString(entry.label)) {
      strictConfigError(`${profilePath}.label`, 'must be a non-empty string when present');
    }
    if (entry.responseMode !== 'silent' && entry.responseMode !== 'listener_thread') {
      strictConfigError(`${profilePath}.responseMode`, 'must be silent or listener_thread');
    }
    const capabilities = normalizeStrictStringList(entry.capabilities, `${profilePath}.capabilities`);
    const filter = normalizeVcMeetingConsumerProfileFilter(entry.filter, `${profilePath}.filter`);
    const ownedSinks = normalizeVcMeetingConsumerOwnedSinks(
      entry.ownedSinks,
      `${profilePath}.ownedSinks`,
      capabilities,
    );
    const listenerDelivery = normalizeVcMeetingListenerDelivery(
      entry.listenerDelivery,
      `${profilePath}.listenerDelivery`,
    );
    return {
      id,
      agentAppId,
      ...(normalizeNonEmptyString(entry.label) ? { label: normalizeNonEmptyString(entry.label) } : {}),
      role,
      ...(normalizedInstructions.instructions
        ? { instructions: normalizedInstructions.instructions }
        : {}),
      ...(filter ? { filter } : {}),
      responseMode: entry.responseMode,
      ...(listenerDelivery ? { listenerDelivery } : {}),
      capabilities,
      ...(ownedSinks ? { ownedSinks } : {}),
    };
  });
}

export type VcMeetingConsumerProfileResolution =
  | {
      ok: true;
      source: 'legacy';
      profiles: readonly [];
      selectedProfiles: readonly [];
    }
  | {
      ok: true;
      source: 'profiles';
      profiles: readonly VcMeetingConsumerProfileConfig[];
      selectedProfiles: readonly VcMeetingConsumerProfileConfig[];
    }
  | {
      ok: false;
      source: 'legacy' | 'profiles';
      errors: string[];
    };

/**
 * Resolve and validate a profile-mode selection. The daemon can call this again
 * for card selections; config parsing calls it for the default selection.
 * Legacy configs deliberately return `source: legacy` without synthesizing
 * profiles so the existing dynamic-candidate/single-select path stays intact.
 */
export function resolveVcMeetingConsumerProfiles(
  config: VcMeetingConsumerConfig,
  selectedConsumerIds?: readonly string[],
): VcMeetingConsumerProfileResolution {
  if (config.consumerProfiles === undefined) {
    if (config.defaultMode === 'agents' || config.defaultConsumerIds !== undefined) {
      return {
        ok: false,
        source: 'legacy',
        errors: ['consumerProfiles is required for defaultMode=agents/defaultConsumerIds'],
      };
    }
    return { ok: true, source: 'legacy', profiles: [], selectedProfiles: [] };
  }

  const errors: string[] = [];
  const profiles = config.consumerProfiles;
  const byId = new Map<string, VcMeetingConsumerProfileConfig>();
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!;
    if (VC_MEETING_CONSUMER_RESERVED_PROFILE_IDS.has(profile.id)) {
      errors.push(`consumerProfiles[${index}].id ${JSON.stringify(profile.id)} is reserved`);
    } else if (!VC_MEETING_CONSUMER_PROFILE_ID_RE.test(profile.id)) {
      errors.push(`consumerProfiles[${index}].id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`);
    }
    if (byId.has(profile.id)) {
      errors.push(`consumerProfiles[${index}].id duplicates ${JSON.stringify(profile.id)}`);
    } else {
      byId.set(profile.id, profile);
    }
    for (const sink of profile.ownedSinks ?? []) {
      if (sink === ('listener_notice' as VcMeetingConsumerManagedSink)) {
        errors.push(`consumerProfiles[${index}].ownedSinks: listener_notice is reserved`);
      } else if (!(VC_MEETING_CONSUMER_MANAGED_SINKS as readonly string[]).includes(sink)) {
        errors.push(`consumerProfiles[${index}].ownedSinks: unsupported sink ${JSON.stringify(sink)}`);
      } else if (!profile.capabilities.includes(VC_MEETING_OUTPUT_CAPABILITY)) {
        errors.push(`consumerProfiles[${index}].ownedSinks: ${sink} requires ${VC_MEETING_OUTPUT_CAPABILITY}`);
      }
    }
    if (profile.responseMode === 'listener_thread'
      && !profile.capabilities.includes(VC_MEETING_LISTENER_OUTPUT_CAPABILITY)) {
      errors.push(
        `consumerProfiles[${index}].responseMode: listener_thread requires ${VC_MEETING_LISTENER_OUTPUT_CAPABILITY}`,
      );
    }
  }

  for (const [index, id] of (config.defaultConsumerIds ?? []).entries()) {
    if (!byId.has(id)) errors.push(`defaultConsumerIds[${index}] references unknown profile ${JSON.stringify(id)}`);
  }
  const selectedIds = [...(selectedConsumerIds ?? config.defaultConsumerIds ?? [])];
  if (selectedConsumerIds === undefined && config.defaultMode === 'agents' && selectedIds.length === 0) {
    errors.push('defaultMode=agents requires at least one defaultConsumerId');
  }

  const selectedProfiles: VcMeetingConsumerProfileConfig[] = [];
  const seenIds = new Set<string>();
  const selectedByAgent = new Map<string, string>();
  const selectedBySink = new Map<VcMeetingConsumerManagedSink, string>();
  let selectedListenerThreadProfile: string | undefined;
  for (let index = 0; index < selectedIds.length; index += 1) {
    const id = selectedIds[index]!;
    if (seenIds.has(id)) {
      errors.push(`selectedConsumerIds[${index}] duplicates ${JSON.stringify(id)}`);
      continue;
    }
    seenIds.add(id);
    const profile = byId.get(id);
    if (!profile) {
      errors.push(`selectedConsumerIds[${index}] references unknown profile ${JSON.stringify(id)}`);
      continue;
    }
    selectedProfiles.push(profile);
    const priorAgentProfile = selectedByAgent.get(profile.agentAppId);
    if (priorAgentProfile) {
      errors.push(
        `selected profiles ${JSON.stringify(priorAgentProfile)} and ${JSON.stringify(profile.id)} share agentAppId ${JSON.stringify(profile.agentAppId)}`,
      );
    } else {
      selectedByAgent.set(profile.agentAppId, profile.id);
    }
    for (const sink of profile.ownedSinks ?? []) {
      const priorSinkProfile = selectedBySink.get(sink);
      if (priorSinkProfile) {
        errors.push(
          `selected profiles ${JSON.stringify(priorSinkProfile)} and ${JSON.stringify(profile.id)} both own sink ${JSON.stringify(sink)}`,
        );
      } else {
        selectedBySink.set(sink, profile.id);
      }
    }
    if (profile.responseMode === 'listener_thread') {
      if (selectedListenerThreadProfile) {
        errors.push(
          `selected profiles ${JSON.stringify(selectedListenerThreadProfile)} and ${JSON.stringify(profile.id)} both use responseMode "listener_thread"`,
        );
      } else {
        selectedListenerThreadProfile = profile.id;
      }
    }
  }

  return errors.length > 0
    ? { ok: false, source: 'profiles', errors }
    : { ok: true, source: 'profiles', profiles, selectedProfiles };
}

function normalizeVcMeetingConsumerCandidates(raw: unknown): VcMeetingConsumerAgentConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: VcMeetingConsumerAgentConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let larkAppId: string | undefined;
    let label: string | undefined;
    if (typeof item === 'string') {
      larkAppId = item.trim();
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      larkAppId = normalizeNonEmptyString(entry.larkAppId) ?? normalizeNonEmptyString(entry.appId);
      label = normalizeNonEmptyString(entry.label) ?? normalizeNonEmptyString(entry.name);
    }
    if (!larkAppId || seen.has(larkAppId)) continue;
    seen.add(larkAppId);
    out.push({
      larkAppId,
      ...(label ? { label } : {}),
    });
  }
  return out;
}

function normalizeVcMeetingRealtimeVoiceConfig(raw: unknown): VcMeetingRealtimeVoiceConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const out: VcMeetingRealtimeVoiceConfig = {};
  // 实时语音默认开启(vcMeetingRealtimeVoiceEnabled:enabled!==false),enabled:false 是
  // 显式关闭,必须保留——只留 true 会让"关掉实时语音"round-trip 成 undefined(=默认开)。
  if (entry.enabled === true) out.enabled = true;
  else if (entry.enabled === false) out.enabled = false;
  const sampleRate = normalizePositiveInt(entry.sampleRate);
  const channels = normalizePositiveInt(entry.channels);
  const frameMs = normalizePositiveInt(entry.frameMs);
  const testSpeakOnStartText = normalizeNonEmptyString(entry.testSpeakOnStartText);
  if (sampleRate !== undefined) out.sampleRate = sampleRate;
  if (channels !== undefined) out.channels = channels;
  if (frameMs !== undefined) out.frameMs = frameMs;
  if (testSpeakOnStartText) out.testSpeakOnStartText = testSpeakOnStartText;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
    .map((p) => p.trim());
}

function normalizeSummaryRange(raw: unknown): SummaryRangeConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const out: SummaryRangeConfig = {};
  const limit = normalizeNonNegativeInt(entry.limit);
  const sinceHours = normalizeNonNegativeInt(entry.sinceHours);
  if (limit !== undefined) out.limit = limit;
  if (sinceHours !== undefined) out.sinceHours = sinceHours;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeContentTriggers(raw: unknown, botIndex: number): ContentTriggerConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ContentTriggerConfig[] = [];

  raw.forEach((item, triggerIndex) => {
    const loc = `Bot config [${botIndex}] contentTriggers[${triggerIndex}]`;
    const drop = (reason: string) => logger.warn(`${loc} ignored: ${reason}`);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      drop('must be an object');
      return;
    }
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : `content-trigger-${triggerIndex + 1}`;
    const enabled = entry.enabled !== false;
    const scope = normalizeContentTriggerScope(entry.scope);
    if (!scope) {
      drop(`invalid scope ${JSON.stringify(entry.scope)}`);
      return;
    }

    const matchRaw = entry.match;
    if (!matchRaw || typeof matchRaw !== 'object' || Array.isArray(matchRaw)) {
      drop('match must be an object');
      return;
    }
    const match = matchRaw as Record<string, unknown>;
    const type = match.type === 'keyword' || match.type === 'regex' ? match.type : undefined;
    if (!type) {
      drop(`invalid match.type ${JSON.stringify(match.type)}`);
      return;
    }
    const pattern = typeof match.pattern === 'string' ? match.pattern : '';
    if (!pattern) {
      drop('match.pattern must be a non-empty string');
      return;
    }
    const caseSensitive = match.caseSensitive === true;
    if (type === 'regex') {
      try {
        // Validate only. Runtime recompiles defensively in case an in-memory
        // config is mutated after startup.
        new RegExp(pattern, caseSensitive ? 'u' : 'iu');
      } catch (err) {
        drop(`invalid regex ${JSON.stringify(pattern)} (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
    }

    const actionRaw = entry.action;
    if (!actionRaw || typeof actionRaw !== 'object' || Array.isArray(actionRaw)) {
      drop('action must be an object');
      return;
    }
    const action = actionRaw as Record<string, unknown>;
    if (action.type !== 'start-or-wake-session') {
      drop(`invalid action.type ${JSON.stringify(action.type)}`);
      return;
    }
    const prompt = typeof action.prompt === 'string' ? action.prompt.trim() : '';
    if (!prompt) {
      drop('action.prompt must be a non-empty string');
      return;
    }

    const historyRaw = entry.history && typeof entry.history === 'object' && !Array.isArray(entry.history)
      ? entry.history as Record<string, unknown>
      : {};
    const topicRaw = historyRaw.topic && typeof historyRaw.topic === 'object' && !Array.isArray(historyRaw.topic)
      ? historyRaw.topic as Record<string, unknown>
      : {};
    const regularRaw = historyRaw.regularGroup && typeof historyRaw.regularGroup === 'object' && !Array.isArray(historyRaw.regularGroup)
      ? historyRaw.regularGroup as Record<string, unknown>
      : {};
    const topicMode = topicRaw.mode === undefined || topicRaw.mode === 'current-thread'
      ? 'current-thread'
      : undefined;
    if (!topicMode) {
      drop(`invalid history.topic.mode ${JSON.stringify(topicRaw.mode)}`);
      return;
    }
    const regularMode = regularRaw.mode === undefined || regularRaw.mode === 'recent-messages'
      ? 'recent-messages'
      : undefined;
    if (!regularMode) {
      drop(`invalid history.regularGroup.mode ${JSON.stringify(regularRaw.mode)}`);
      return;
    }
    const limit = regularRaw.limit === undefined ? 50 : normalizeNonNegativeInt(regularRaw.limit);
    if (limit === undefined) {
      drop(`invalid history.regularGroup.limit ${JSON.stringify(regularRaw.limit)}`);
      return;
    }
    const sinceHours = regularRaw.sinceHours === undefined ? undefined : normalizeNonNegativeInt(regularRaw.sinceHours);
    if (regularRaw.sinceHours !== undefined && sinceHours === undefined) {
      drop(`invalid history.regularGroup.sinceHours ${JSON.stringify(regularRaw.sinceHours)}`);
      return;
    }

    out.push({
      name,
      enabled,
      scope,
      ...(entry.allowBotMessages === true ? { allowBotMessages: true } : {}),
      match: { type, pattern, caseSensitive },
      history: {
        topic: { mode: 'current-thread' },
        regularGroup: {
          mode: 'recent-messages',
          limit,
          sinceHours,
        },
      },
      action: { type: 'start-or-wake-session', prompt },
    });
  });

  return out.length > 0 ? out : undefined;
}

function normalizeMessageListenerStringList(raw: unknown): string[] | undefined {
  const values = normalizeStringList(raw);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeMessageListenerSenderKinds(
  raw: unknown,
  excludeSenderOpenIds: string[] | undefined,
): Record<string, 'user' | 'bot'> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const allowed = excludeSenderOpenIds ? new Set(excludeSenderOpenIds) : undefined;
  const out: Record<string, 'user' | 'bot'> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || (allowed && !allowed.has(key))) continue;
    if (value === 'user' || value === 'bot') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMessageListenerSenderTypes(raw: unknown): MessageListenerSenderType[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map(normalizeMessageListenerSenderType)
    .filter((value): value is MessageListenerSenderType => !!value);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeMessageListenerConfig(raw: unknown, botIndex: number, chatId: string): MessageListenerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const prompt = normalizeNonEmptyString(entry.prompt);
  const enabled = entry.enabled === true;
  if (enabled && !prompt) {
    logger.warn(`Bot config [${botIndex}] messageListeners[${chatId}] ignored: enabled listener requires prompt`);
    return undefined;
  }

  const senderRaw = entry.senderPolicy && typeof entry.senderPolicy === 'object' && !Array.isArray(entry.senderPolicy)
    ? entry.senderPolicy as Record<string, unknown>
    : {};
  const senderPolicy: NonNullable<MessageListenerConfig['senderPolicy']> = {};
  const mode = senderRaw.mode === 'include_only' ? 'include_only' : 'all_except_excluded';
  const includeSenderOpenIds = normalizeMessageListenerStringList(senderRaw.includeSenderOpenIds);
  const excludeSenderOpenIds = normalizeMessageListenerStringList(senderRaw.excludeSenderOpenIds);
  const excludeSenderKinds = normalizeMessageListenerSenderKinds(senderRaw.excludeSenderKinds, excludeSenderOpenIds);
  const includeSenderTypes = normalizeMessageListenerSenderTypes(senderRaw.includeSenderTypes);
  const excludeSenderTypes = normalizeMessageListenerSenderTypes(senderRaw.excludeSenderTypes);
  if (mode !== 'all_except_excluded') senderPolicy.mode = mode;
  if (includeSenderOpenIds) senderPolicy.includeSenderOpenIds = includeSenderOpenIds;
  if (excludeSenderOpenIds) senderPolicy.excludeSenderOpenIds = excludeSenderOpenIds;
  if (excludeSenderKinds) senderPolicy.excludeSenderKinds = excludeSenderKinds;
  if (includeSenderTypes) senderPolicy.includeSenderTypes = includeSenderTypes;
  if (excludeSenderTypes) senderPolicy.excludeSenderTypes = excludeSenderTypes;
  if (senderRaw.excludeSelf === false) senderPolicy.excludeSelf = false;

  const messageRaw = entry.messagePolicy && typeof entry.messagePolicy === 'object' && !Array.isArray(entry.messagePolicy)
    ? entry.messagePolicy as Record<string, unknown>
    : {};
  const messagePolicy: NonNullable<MessageListenerConfig['messagePolicy']> = {};
  const includeMsgTypes = normalizeMessageListenerStringList(messageRaw.includeMsgTypes);
  if (includeMsgTypes) messagePolicy.includeMsgTypes = includeMsgTypes;
  messagePolicy.scope = 'top_level';

  const contentRaw = entry.contentPolicy && typeof entry.contentPolicy === 'object' && !Array.isArray(entry.contentPolicy)
    ? entry.contentPolicy as Record<string, unknown>
    : undefined;
  let contentPolicy: MessageListenerConfig['contentPolicy'];
  if (contentRaw) {
    const includeKeywords = normalizeMessageListenerStringList(contentRaw.includeKeywords);
    // V1 is keyword-substring only (see the contentPolicy type doc for why no
    // regexes on the daemon main loop). Only persist non-default flags; an
    // all-empty policy is dropped entirely (matchesContentPolicy treats
    // absent/empty as match-all).
    if (includeKeywords) {
      contentPolicy = {
        includeKeywords,
        ...(contentRaw.matchMode === 'all' ? { matchMode: 'all' as const } : {}),
      };
    }
  }

  return {
    enabled,
    ...(normalizeNonEmptyString(entry.name) ? { name: normalizeNonEmptyString(entry.name) } : {}),
    ...(normalizeNonEmptyString(entry.replyCardTitle) ? { replyCardTitle: normalizeNonEmptyString(entry.replyCardTitle) } : {}),
    ...(normalizeNonEmptyString(entry.workingDir) ? { workingDir: normalizeNonEmptyString(entry.workingDir) } : {}),
    prompt: prompt ?? '',
    ...(Object.keys(senderPolicy).length > 0 ? { senderPolicy } : {}),
    ...(Object.keys(messagePolicy).length > 0 ? { messagePolicy } : {}),
    ...(contentPolicy ? { contentPolicy } : {}),
    replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
  };
}

function normalizeMessageListeners(raw: unknown, botIndex: number): Record<string, MessageListenerConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, MessageListenerConfig> = {};
  for (const [chatId, listenerRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof chatId !== 'string' || !chatId.trim()) continue;
    const listener = normalizeMessageListenerConfig(listenerRaw, botIndex, chatId.trim());
    if (listener) out[chatId.trim()] = listener;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A bots.json row may omit `cliId`. Historically that means claude-code, and such
 * a row can still carry a legacy `cliPathOverride`. Anything that derives a
 * selection from a RAW row must apply this same default, otherwise the selection
 * looks changed and preservation logic is skipped. Exported so there is exactly
 * one definition of the legacy default.
 */
export const LEGACY_DEFAULT_CLI_ID = 'claude-code';

export interface OncallChat {
  /** Lark chat_id (oc_xxx) the bot was pulled into. */
  chatId: string;
  /** Default working directory used for every new topic spawned in this chat. */
  workingDir: string;
}

/**
 * Per-bot default for new group chats:
 *   - `enabled`     — when true, group chats first observed after `since` are
 *                     auto-bound to oncall on their first new-topic.
 *   - `workingDir`  — the working directory used for the auto-bind. Required
 *                     when enabled (oncall semantics: chatId ↔ workingDir).
 *   - `since`       — epoch ms when the flag was switched on. Used to gate
 *                     "new vs old" against chat-first-seen-store. Chats that
 *                     existed before `since` are left untouched, matching
 *                     "新群聊生效，老群聊不变".
 */
export interface BotDefaultOncall {
  enabled: boolean;
  workingDir: string;
  since: number;
}

export interface SubstituteTarget {
  /** App-scoped open_id. Directly comparable with Lark mention payloads. */
  openId?: string;
  /** Tenant user_id. Preferred for hand-authored config when available. */
  userId?: string;
  /** Tenant-stable union_id. Used when Lark includes it in mention payloads. */
  unionId?: string;
  /** Reserved for a later resolver pass; v1 preserves it but does not match on it. */
  email?: string;
  /** Human-readable label for prompt disclosure. */
  name?: string;
  /** Cached avatar URL so the dashboard can show the resolved person's picture. */
  avatarUrl?: string;
}

export interface SubstituteModeConfig {
  enabled: boolean;
  targets: SubstituteTarget[];
  /** prefix = disclose "I will answer on behalf of X"; none = no extra disclosure instruction. */
  disclosure?: 'prefix' | 'none';
  /** Optional allow-list of chat IDs. When provided, substitute trigger only fires in these chats. */
  chats?: string[];
  /** Optional block-list of chat IDs (黑名单). When a chat is listed here the substitute
   *  trigger never fires there — deny-wins over {@link chats} (a chat in both is blocked)
   *  and hard (cannot be re-enabled by the per-chat `/substitute on` runtime toggle).
   *  Applies to regular and topic groups alike. Direct @bot mentions are unaffected. */
  excludedChats?: string[];
  /** When true, do not automatically DM the owner a control card for substitute-mode sessions. */
  disableControlCard?: boolean;
  /** How the bot replies to a substitute-mode trigger:
   *  - 'thread' (default): reply in a Lark thread under the trigger message.
   *  - 'quote': quote-reply the trigger message without creating a new topic.
   */
  replyMode?: 'thread' | 'quote';
  /** 话题群支持：在话题群（chat_mode=topic）里也响应替身触发。替身回合沿话题
   *  路由进该话题自己的会话（无会话则新开），与普通群「进群 chat-scope 会话」
   *  同构。缺省 true；显式 false 关闭。 */
  topicGroups?: boolean;
  /** 话题里已有本 bot 活跃会话时是否仍触发替身（替身回合注入该会话）。false 时
   *  回落到原让路行为（@别人=转交别人，保持沉默）。仅话题群路径生效，缺省 true。 */
  topicActiveSessionTrigger?: boolean;
}

export interface VcMeetingAgentConfig {
  enabled?: boolean;
  /** Existing chat used for meeting transcript/chat sync. If unset, confirmation creates a listener group. */
  listenerChatId?: string;
  notificationChatId?: string;
  attentionTargetOpenId?: string;
  larkCliProfile?: string;
  /** IANA time zone used when rendering listener-group timestamps. Defaults to Asia/Shanghai. */
  timeZone?: string;
  /** Pending invite confirmation TTL. Defaults to 30 minutes. */
  inviteTtlMs?: number;
  /** Transcript stability window before listener-group sync emits a sentence. */
  stabilizeMs?: number;
  /** Listener-group sync interval. */
  flushIntervalMs?: number;
  /** Realtime voice v0. Disabled by default; requires realtime scope and meeting-side AI speaking permission. */
  realtimeVoice?: VcMeetingRealtimeVoiceConfig;
  /** Optional listener-group consumer. Card choices are driven entirely by this bots.json block. */
  meetingConsumer?: VcMeetingConsumerConfig;
}

export interface VcMeetingRealtimeVoiceConfig {
  /**
   * Enables realtime voice. This opens the meeting realtime WebSocket after bot
   * join; without vc:meeting.bot.realtime:write or meeting-side speaking
   * permission it fail-closes with an explicit warning and never sends audio.
   */
  enabled?: boolean;
  /** Expected PCM sample rate for session.create, default 24000. */
  sampleRate?: number;
  /** Expected PCM channel count for session.create, default mono. */
  channels?: number;
  /** Upstream PCM frame duration, default 100ms (4800B at 24kHz mono s16le). */
  frameMs?: number;
  /** M0 dogfood only: speak this text once after realtime session.created. */
  testSpeakOnStartText?: string;
}

/**
 * Per-bot settings for p2pMode='group' session groups (each top-level DM
 * message births a dedicated 1-user+1-bot group hosting the conversation).
 * Everything is optional; effective defaults in parentheses.
 */
export interface SessionGroupConfig {
  /** Group-name generation. */
  naming?: {
    /**
     * 'ai-summary' (default): create with a truncated placeholder name, then
     * asynchronously ask the bot's own CLI (one-shot headless call) for a
     * short title and rename the chat when it lands. Falls back to the
     * placeholder on failure/timeout.
     * 'truncate': placeholder only — zero cost, zero delay.
     */
    mode?: 'ai-summary' | 'truncate';
    /** Max title length in characters for the AI summary (12). */
    maxLen?: number;
  };
  /**
   * Optional fixed group-name prefix. Empty/undefined (default) = no prefix.
   * Only needed as the match key for the rule-based feed-group mode (PR2).
   */
  namePrefix?: string;
  /** Template working dir bound to each new session group (defaultWorkingDir). */
  workingDir?: string;
  /** Send a DM receipt linking the freshly-created group (true). */
  dmReceipt?: boolean;
  /**
   * What to do with the group when its session is closed:
   * 'keep' (default) — leave the group and registry entry; a later message in
   * the group resumes the closed session (same-group resume). 'disband' /
   * 'archive' are reserved for a follow-up PR and currently behave as 'keep'.
   */
  onClose?: 'keep' | 'disband' | 'archive';
  /**
   * Session-group tagging.
   * 'feed-group' (default) — the owner's personal sidebar 消息分组 (feed
   *   group). Needs a one-time user OAuth (im:feed_group_v1), auto-refreshed
   *   afterwards; works on any tenant — no tenant scope catalog involved.
   * 'chat-tag' — tenant chat tags (企业自定义群标签): a property of the GROUP
   *   itself, applied with the bot's own tenant token. Zero user OAuth; needs
   *   the im:tag:write + im:biz_entity_tag_relation:write tenant scopes, which
   *   some tenants' scope catalogs don't offer at all (hence not the default).
   * 'off' — no tagging.
   */
  tag?: {
    mode?: 'chat-tag' | 'feed-group' | 'off';
    /**
     * Tag / feed-group display name. Empty/absent (default) = 「<bot 显示名>会话」
     * （多 bot / 多设备靠 bot 名区分；bot 显示名也拿不到时才保底成 Botmux群会话）。
     * 回落链见 services/feed-group-tagger.ts 的 resolveSessionTagName。
     */
    name?: string;
  };
  /**
   * Distinctive built-in group avatar for session groups — the zero-permission
   * visual marker (works on tenants without the chat-tag catalog).
   * 'auto' (default) applies it at birth; 'off' keeps Feishu's default avatar.
   */
  avatar?: 'auto' | 'off';
  /** Reserved (PR3): auto-dispose after N idle days; 0/undefined = off. */
  idleDays?: number;
}

export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
  /**
   * Core-only / headless 模式：该 bot 纯 HTTP 控制 API 驱动（trigger →
   * spawn → CLI → trigger-result），**不连接任何飞书**——boot 时跳过
   * open_id 探测、required-scope 校验、WSClient 事件订阅，也不投递飞书消息
   * （异步控制回路本就在 `deliverFinalOutput` 的 async 分支 early-return，
   * 运行时不触达飞书）。`larkAppId` 仍必填但用合成本地身份（如
   * `local_<slug>`，非 `cli_` 前缀）作为 daemon 标识 + dashboard 路由 key +
   * `/api/trigger` 的 cachedLarkAppId gate；`larkAppSecret` 在此模式下可缺省。
   * 缺省 / false 保持原有飞书 bot 行为字节不变。
   */
  apiOnly?: boolean;
  /** Final-answer feedback policy. Missing/disabled is intentionally inert. */
  feedback?: FeedbackPolicyInput | FeedbackPolicy;
  /** Per-chat final-answer feedback overrides, scoped to this bot app id. */
  chatFeedbackPolicies?: Record<string, FeedbackPolicyInput>;
  feedbackWebhooks?: { destinations: FeedbackWebhookDestination[] };
  /**
   * 租户品牌：`'feishu'`（中国版，open.feishu.cn）或 `'lark'`（国际版，
   * open.larksuite.com）。缺省 / 旧 bots.json 无此字段 → 视为 `'feishu'`
   * （见 {@link normalizeBrand}），向后兼容。决定 SDK Client / WSClient 的
   * domain、所有裸 fetch 的 host、OAuth / applink 深链等——全部从这一个字段
   * 派生（见 im/lark/lark-hosts.ts）。setup 时自动识别后落盘；brand 绑定到
   * 具体 app/租户，不在运行时切换（要换平台 = 重新配/加一个 bot）。
   */
  brand?: Brand;
  /** Optional process-name suffix; the daemon's process name is rendered as `botmux-<name>` (defaults to `botmux-<index>`). */
  name?: string;
  /**
   * 自定义展示名（备注名）。设置后 dashboard 全站（名册 / 会话列表 / 各 bot
   * 下拉）用它替代飞书探测到的应用名展示；未设置则跟随飞书名称。纯展示字段：
   * 不影响 pm2 进程名（那是 {@link name}）、不改飞书群内显示的应用名（开放
   * 平台无改名 API，只能在开发者后台改）、也不进跨 bot @ 路由的 bots-info
   * 名册。可从 dashboard Bot Defaults 页或 `/config displayName` 修改，热更新。
   */
  displayName?: string;
  cliId: CliId;
  /**
   * Optional distribution identity for a CLI that is protocol-compatible with
   * {@link cliId} but ships as an independent executable/release stream (for
   * example a Codex-compatible fork). The adapter remains selected by cliId;
   * this descriptor owns product identity, executable and update provenance.
   *
   * `cliPathOverride` remains readable for legacy configs. A configured runtime
   * is exposed through cliPathOverride in memory as a compatibility shadow so
   * existing adapter call sites keep launching the selected executable while
   * the runtime rollout migrates them to the structured descriptor.
   */
  cliRuntime?: CliRuntimeConfig;
  /** @deprecated Prefer cliRuntime.executable for newly configured runtimes. */
  cliPathOverride?: string;
  /**
   * 通用启动前缀（按空格拆 token）：worker spawn 时把启动命令拼成
   * `<wrapperCli> <CLI 参数>`（首 token 当 bin 走 PATH 解析），无需 wrapper 脚本、跨系统。
   * 典型值 `"aiden x claude"` / `"aiden x codex"`（企业网关 + SSO），也能
   * 承载 ccr / claude-w 等任意启动器。`cliId` 仍是底层适配器（claude→claude-code、
   * codex→codex），所有适配器机制（hook / bridge / resume）照常工作；设了 wrapperCli 后
   * 它的首 token 取代 cliId 的默认 bin（cliPathOverride 不再生效）。检测到前缀是
   * `aiden x claude` 时自动剥掉 aiden 拒收的 --settings。见 src/setup/cli-selection.ts。
   */
  wrapperCli?: string;
  /**
   * Per-bot launch-shell override for the persistent backends (tmux/zellij/zmx).
   * When set, botmux launches the CLI under this shell instead of the daemon's
   * `$SHELL`. Accepts a bare name (`zsh`/`bash`/`fish`/`sh`) or an absolute path
   * (`/usr/bin/fish`). The escape hatch for a login `$SHELL` (e.g. bash) whose
   * rcfile `exec`-trampolines into another shell: that trampoline replaces the
   * launch shell before it can `exec` the CLI, leaving a bare shell the first
   * prompt gets typed into (`zsh: parse error`). Pinning `launchShell: fish`
   * launches under fish directly and bypasses the bash `.bashrc`. CAVEAT:
   * PATH/nvm/pnpm shims must then live in the pinned shell's rcfiles (for
   * example `.zshrc`/`.zprofile` or `~/.config/fish/config.fish`), not the bypassed one. Ignored by the pty backend
   * (which `exec`s the CLI directly, no shell wrapper, so it's trampoline-immune).
   */
  launchShell?: string;
  /**
   * Optional model name passed to the CLI at spawn time (e.g. `claude --model
   * opus`). Each adapter decides how to inject it — adapters whose CLI has no
   * `--model` flag silently ignore the field. When unset, the CLI uses its own
   * default model. Multiple bots sharing the same `cliId` can therefore run
   * different models without resorting to wrapper scripts. See each adapter's
   * `modelChoices` for the curated candidates surfaced in `botmux setup`.
   */
  model?: string;
  /**
   * Per-bot dsh runner turn timeout in milliseconds. The dsh adapter forwards
   * it as `--turn-timeout-ms` to the runner, overriding the built-in 10-minute
   * default (`DEFAULT_TURN_TIMEOUT_MS` in dsh-runner.ts). Positive integer
   * only; unset/≤0/non-integer → runner default. Only affects the `dsh` CLI
   * adapter; other adapters ignore the field.
   */
  turnTimeoutMs?: number;
  /**
   * Per-bot dsh runtime variant. Only meaningful when `cliId === 'dsh'`:
   *   - `'official'` (default): the headless JSON-RPC runner (dsh-runner.ts).
   *   - `'tui'`: the interactive dsh-tui Ink TUI, driven via PTY (dsh-tui adapter).
   * Non-dsh CLIs always drop the field. Selected via the dashboard "dsh 运行时"
   * toggle; the worker resolves the effective adapter at spawn time.
   */
  dshRuntime?: 'official' | 'tui';
  /** Default reasoning effort for newly created sessions on CLIs that support it. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /**
   * If true, botmux does not add CLI-default approval/sandbox bypass flags
   * such as --yolo or --dangerously-*. Missing/false preserves legacy behavior.
   */
  disableCliBypass?: boolean;
  /** Experimental Codex App input split. When true, newly accepted turns send
   * the real user text as app-server `input` and keep Botmux metadata in
   * `additionalContext`, so the desktop user bubble stays clean. Missing/false
   * preserves the legacy XML-ish prompt byte-for-byte. Codex App only. */
  codexAppCleanInput?: boolean;
  /**
   * Codex App only, explicit opt-in: expose a restricted browser dynamic tool
   * backed by the locally installed Codex Chrome/Edge extension plugin.
   */
  codexBrowser?: CodexBrowserConfig;
  /**
   * Per-turn 上下文注入方式（#794）。`auto`：对支持的 CLI（目前仅 claude-code），
   * 把 reminder/whiteboard 从 user turn 文本挪到 UserPromptSubmit hook 注入的
   * system-reminder，终端输入框只保留消息本身；不支持的 CLI 自动回退内联。
   * 缺省/`off`：保持内联 envelope（历史行为）。从下一个 follow-up turn 生效。
   */
  envelopeInjection?: 'auto' | 'off';
  /**
   * Whether each forwarded turn carries a `<sender type=… open_id=… name=…
   * email=… />` tag naming who spoke. Default ON (ABSENT ⇒ ON — only an
   * explicit `false` disables), so existing prompts stay byte-for-byte.
   *
   * Turn it off for a bot whose model mishandles the tag (cursor-agent copies
   * `ou_xxx:名字` into its reply — see {@link renderCursorSenderNote}) or when
   * the operator does not want per-message identity in the CLI transcript.
   * The cursor anti-echo note is gated on the tag's presence, so it disappears
   * together with it. `botmux send --mention-back` is UNAFFECTED: it reads
   * `replyTargets[turnId].senderOpenId` (core/reply-target.ts), a daemon-side
   * record independent of this prompt block.
   *
   * TWO OBSERVABILITY COSTS, both measured — see the `/config senderTag` hint:
   *   1. `/adopt`'s botmux-origin filter loses one of its fingerprints. The
   *      remaining structural anchors cover the shapes we ship (see
   *      BOTMUX_INJECTION_PATTERNS in services/resumable-session-discovery.ts,
   *      whose `^<chat_context_policy>` / `^<summary_memory>` anchors exist
   *      precisely so a sender-less prompt is still recognized).
   *   2. Dashboard session insight can no longer label a turn's sender type /
   *      A2A agent name from the tag (services/insight/prompt.ts); it falls
   *      back to the `[来自 … 的 @mention]` handoff marker when present.
   *
   * This is the first member of a per-bot prompt-block toggle cluster; keep
   * future block switches (e.g. `<chat_context>`) adjacent so the gates stay
   * discoverable together.
   */
  senderTag?: boolean;
  /**
   * Codex only (opt-in, experimental): deliver user input via the app-server
   * JSON-RPC channel instead of a tmux paste. The pane runs `codex --remote`
   * attached to a botmux-owned app-server thread, so input can't be dropped by
   * codex's terminal re-init. No effect on non-codex bots.
   */
  codexRpcInput?: boolean;
  /**
   * Experimental local-only attachment mode for an already-running Codex App
   * Server. This does not make BotMux an app-server owner: after the operator
   * explicitly selects an existing thread via `/adopt`, BotMux launches the
   * official `codex --remote <endpoint> resume <thread>` TUI as a second
   * client. For the `cliId: "codex"` shared-adopt path, new remote threads are
   * deliberately not auto-created; `cliId: "codex-app"` retains its existing
   * new-session workflow until the operator explicitly selects a shared thread.
   */
  existingAppServer?: ExistingAppServerConfig;
  /**
   * Codex credential policy. Missing/`shared` preserves the historical global
   * auth refresh; `isolated` always redirects Codex into this bot's private
   * CODEX_HOME and never reads or copies global auth, with or without sandbox.
   */
  codexAuthSync?: import('./services/codex-auth-sync.js').CodexAuthSyncMode;
  /**
   * Run this bot's CLI inside a per-session file sandbox (unified three-tier
   * whitelist, deny-by-default; Linux bwrap + macOS Seatbelt with identical
   * semantics — see adapters/cli/fs-policy.ts). The agent can read/write the
   * project + its own BOT_HOME, read the system toolchain baseline, and touch
   * NOTHING else. Env BOTMUX_SANDBOX=1 forces it on regardless (testing).
   */
  sandbox?: boolean;
  /**
   * User增量 three-tier path lists layered ON TOP of the baseline preset
   * (never replacing it). Deepest matching rule wins, so nested black/white
   * lists work (readOnly a tree, deny a subdir inside it). Same semantics on
   * Linux and macOS. Absent → pure baseline.
   */
  sandboxPaths?: { readWrite?: string[]; readOnly?: string[]; deny?: string[] };
  /**
   * LEGACY (pre fs-policy, kept for downgrade only): privacy masks under the
   * old read-everything model. Auto-migrated into sandboxPaths.deny at daemon
   * startup (old fields are kept on disk so a downgraded daemon still reads
   * them); no longer consulted by the new spawn path.
   */
  sandboxHidePaths?: string[];
  /** LEGACY: extra read-only paths — auto-migrated into sandboxPaths.readOnly
   *  (see sandboxHidePaths note). */
  sandboxReadonlyPaths?: string[];
  /**
   * Whether the sandbox keeps network access. Missing/true preserves the existing
   * behavior; false adds bwrap --unshare-net for sessions that can run offline or
   * rely only on already-mounted local inputs.
   */
  sandboxNetwork?: boolean;
  /**
   * LEGACY read-isolation flag (pre fs-policy). The unified sandbox is
   * deny-by-default, so cross-bot read isolation is inherent — this flag is
   * auto-migrated to `sandbox: true` at daemon startup and kept on disk only
   * for downgrade. No longer consulted by the new spawn path.
   */
  readIsolation?: boolean;
  /** LEGACY: extra read-deny paths — auto-migrated into sandboxPaths.deny. */
  readDenyExtraPaths?: string[];
  backendType?: BackendType;
  /**
   * Configuration for the riff backend (agent-services platform). Required
   * when `backendType` is `'riff'`. Contains base URL, template ID, agent/model
   * selection, and auth settings for riff's HTTP API.
   */
  riff?: RiffBackendConfig;

  /**
   * Configuration for the mojo backend (@byted/mojo headless CLI). Optional
   * even when `backendType` is `'mojo'`: every field has a working default
   * (`mojo` on PATH + an ambient login is a valid setup). Use it to pin the
   * model, inject a JWT, or force `--cloud` execution.
   */
  mojo?: MojoConfig;
  /**
   * Max simultaneously-LIVE sessions for this bot. When the bot's live session
   * count exceeds this, the idle-worker sweeper suspends its longest-idle,
   * not-currently-busy sessions (resumable backends only) down to the cap — the
   * worker AND the CLI are killed to reclaim memory, and the session
   * cold-resumes from its on-disk transcript on the next message. Unset → the
   * built-in default {@link DEFAULT_MAX_LIVE_WORKERS} (30); an explicit positive
   * integer overrides it. Pure count-based: there is NO idle-time threshold.
   * Configured per bot from the dashboard (Groups & Bots → bot card). Adopted
   * sessions are never suspended. See core/idle-worker-sweeper.ts.
   */
  maxLiveWorkers?: number;
  /** Periodically @ the persisted Session owner while selected actionable
   * runtime states remain unchanged. Missing means disabled. */
  sessionOwnerReminder?: SessionOwnerReminderConfig;
  /**
   * When true, THIS bot's daemon watches host load/memory and DMs the bot owner
   * when the machine crosses into (and back out of) an overloaded state — a
   * heads-up that botmux session cold-starts may time out and false-die. Host
   * metrics are machine-wide, so designate ONE bot as the alerter; if several
   * have it on, a shared episode lock de-dups so the machine only DMs once per
   * edge. Missing/false = off. Hot-reloaded (no restart) once the daemon build
   * that ships the watcher is running. See core/host-overload-alert.ts and the
   * watcher in daemon.ts. BOTMUX_OVERLOAD_ALERT=0 force-disables regardless.
   */
  overloadAlert?: boolean;
  /** Native Lark VC bot meeting copilot bridge. Push is primary; polling remains gate/backfill. */
  vcMeetingAgent?: VcMeetingAgentConfig;
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
  /**
   * Owner's native app-scoped `open_id` (`ou_…`), captured at setup from the
   * device-flow scanner identity. UNLIKE `allowedUsers` (which may hold `on_`/
   * email entries needing a contact-API resolve every boot), this is stored raw
   * and never resolved — so it survives a contact-API outage. Two uses:
   *   1. a fail-safe DM recipient for allowedUsers-resolve failure notices, so
   *      the owner is reachable even when the resolve that would have produced
   *      their open_id is the very thing that failed (cold-start race);
   *   2. an always-available owner anchor for runtime permission checks.
   * Optional: bots created before this field, or via paths without a scanner
   * identity, simply have none and fall back to the resolved allowlist.
   */
  ownerOpenId?: string;
  allowedChatGroups?: string[];
  /** Oncall bindings: chat_id → default workingDir. Any group member can talk; allowedUsers still gates card buttons / daemon commands. */
  oncallChats?: OncallChat[];
  /** UI language for this bot: 'zh' or 'en'. Falls back to BOTMUX_LANG / LANG env when unset. */
  lang?: Locale;
  /** How this bot's built-in botmux bridge skills reach its CLI (only meaningful
   *  for CLIs with a global `skillsDir` — codex/gemini/opencode/…):
   *   - `global`: install into the CLI's shared global skills dir (leaks into the
   *     user's own standalone CLI). For users who never run the CLI by hand.
   *   - `prompt`: inject a session-scoped skill catalog into the prompt +
   *     `botmux skill show <name>` on demand. No leak.
   *   - `off`: routing hints + `botmux --help` only.
   *  Unset ⇒ fall back to the machine-wide `skills.builtinInjection` (default
   *  `prompt`). See services skills/injection-mode.ts. */
  skillInjection?: 'global' | 'prompt' | 'off';
  /**
   * Per-bot default working directory. When set, new topics that have no
   * oncall binding and no sibling-session inheritance skip the repo-select
   * card and spawn the CLI directly in this directory. `/cd <path>` still
   * works to switch mid-session; the next new topic falls back to this default.
   *
   * Pure runtime fallback — does NOT write any state to bots.json and does
   * NOT change the canTalk / canOperate permission model (unlike defaultOncall).
   */
  defaultWorkingDir?: string;
  /**
   * 「仅默认目录」模式下的开关：新会话启动前，先在 `defaultWorkingDir`（须是 git 仓库）
   * 基于远端默认分支自动创建一个 linked worktree，再把会话 cwd 指向该 worktree，实现
   * 每个新会话一个隔离 checkout。仅在 mode==='default'（defaultWorkingDir 有值）时有意义；
   * 非 git 仓库 / 创建失败时回退直接用 defaultWorkingDir 启动。复用 `/repo wt` 的
   * createRepoWorktree。见 services/default-worktree.ts。
   */
  defaultWorkingDirAutoWorktree?: boolean;
  /** Per-bot default: auto-bind every new group chat to oncall on first new-topic. */
  defaultOncall?: BotDefaultOncall;
  /**
   * Chat IDs that have ever been auto-bound by `defaultOncall`. Append-only.
   * Once a chat appears here, the default is permanently "spent" for it — even
   * if the user later unbinds via Groups & Bots / `/oncall unbind`, the
   * default will not re-bind it. This preserves the manual-override semantics
   * Codex flagged in review.
   */
  defaultOncallAutoboundChats?: string[];
  /** Per-chat reply mode: chat_id → 普通群 @bot 后回复形态。缺省为 chat（保持现状）。 */
  chatReplyModes?: { [chatId: string]: ChatReplyMode };
  /** Per-chat @ 策略：chat_id → 该群的 mention 模式，覆盖 per-bot `regularGroupMentionMode`。由 /mention-mode 写入。 */
  chatMentionModes?: { [chatId: string]: GroupMentionMode };
  /** Per-chat per-user grants: chat_id → 被授权的 open_id 列表。仅放行 canTalk，不给管理命令权。 */
  chatGrants?: { [chatId: string]: string[] };
  /**
   * 全局对话授权名单：被授权在**任意群**与本 bot 对话的 open_id 列表（人或 bot 通用）。
   * 与 chatGrants 同属 talk-only —— 仅放行 canTalk / bot 路由闸，**canOperate 绝不读它**
   * （敏感操作仍仅限 allowedUsers）。这是 chatGrants 的全局版：作用域升到全局，talk-only
   * 性质不变。可由 /grant 卡片「全局」按钮写入，也可在 bots.json 手配 open_id。
   */
  globalGrants?: string[];
  /** Additional plugin ids enabled only for this bot. */
  plugins?: string[];
  /**
   * 私聊对话全开（默认关闭）。开启后**任何人都能和本 bot 私聊**（talk-only），无需
   * 逐个加 globalGrants —— 谁能私聊由飞书应用的「可用范围」控制，botmux 侧不再设闸。
   *
   * **只放行 canTalk，canOperate 绝不读它**：`/restart`、`/cd`、`/repo`、卡片按钮等
   * 管理操作仍只认 allowedUsers。与 oncall（群维度的 talk-open，管理权仍限 owner）
   * 是同一个安全模型，本字段只是把它补到 p2p 维度——oncall/defaultOncall 明确不绑
   * p2p（oncall-store.ts 的 `chatType !== 'group'` 短路），故私聊此前只有「逐人白名单」
   * 与「三张名单全空 → 人人是 admin」两个极端。
   *
   * 不影响群：群里仍按 allowedUsers / allowedChatGroups / oncall / grants 判定。
   */
  p2pOpen?: boolean;
  /**
   * 是否接受**其他 bot** 通过 `botmux send --slash` 发来的原生斜杠命令
   * （/clear、/model、/close…）。默认开（undefined = 开）；只有显式 false 才关。
   *
   * 关掉后，来自 bot 发送方的 slash 命令不进 passthrough / daemon-command 路由，
   * 退化为普通消息（与任何非 bot-slash 消息一样按 talk 门处理）——给 owner 一个
   * 「不让别的 bot 清我上下文 / 敲我 CLI」的逃生阀。对**真人**发送方无影响
   * （真人在飞书直接打字发 /clear 仍照常）。
   *
   * 安全边界不变：daemon 管理命令（/close /restart 等）从 bot 来**仍只认
   * allowedUsers**（canOperate），本开关只控制「是否接受 bot 的 slash 进入路由」，
   * 不放宽任何 operate 权限。
   */
  acceptSlashFromBots?: boolean;
  /**
   * 消息额度覆盖配置：
   *   • 未配置（undefined）→ 卡片使用产品默认 3 条；oncall 不自动计数。
   *   • 配置正整数 D    → 卡片默认 D 条，同时作为 oncall 默认额度。
   * 显式 `/grant @x N` 的 N **恒生效**，与本字段是否配置无关（见 {@link quotaState}）。
   * 仅约束 chatGrants / globalGrants 这类 per-user talk 授权，绝不影响 canOperate。
   */
  messageQuota?: { defaultLimit?: number };
  /**
   * 新建 per-user 授权卡的默认有限时长（毫秒）。缺省使用产品默认 1 小时；
   * 已存在授权和已经生成的 pending 卡不受后续配置变更影响。
   */
  grantDefaultDurationMs?: number;
  /**
   * scope-aware 消息额度计数（运行时状态，随授权一起持久化进 bots.json）。
   * key = `chat:${chatId}:${openId}` | `global:${openId}`，value = { limit, used }。
   * 仅在 /grant 带额度（显式数字，或开启 default 时取 default）时建记录；
   * used 达到 limit 后自动收回**对应 scope** 的授权并删除本记录。纯 talk-only。
   */
  quotaState?: { [quotaKey: string]: { limit: number; used: number } };
  /**
   * scope-aware 授权绝对过期时间。缺少对应记录表示永久授权；旧配置因此保持兼容。
   * key 与 quotaState 相同，便于授权、撤销和到期回收在同一 scope 上原子处理。
   */
  grantExpiryState?: { [grantKey: string]: { expiresAt: number } };
  /**
   * 开启后：仅靠 per-user 授权（chatGrants / globalGrants）放行的发送者，禁止使用**任何
   * 斜杠命令**——botmux 自身的 DAEMON 命令、透传（PASSTHROUGH）命令、全部 `/workflow`
   * 子命令、已退休的 `/template` tombstone、`/introduce`、`/t`/`/topic` —— 只能普通对话。owner / allowedUsers / oncall /
   * allowedChatGroup 整群成员不受影响。判定以 slash-command invocation 命中为准（不是"凡以
   * `/` 开头的文本"，避免误伤讨论命令用法的普通对话）。默认 false（保持现状：被授权人可用透传）。
   */
  restrictGrantCommands?: boolean;
  /**
   * 自动授权申请卡开关。默认开启（undefined = on）：群里有人或外部 bot 明确 @ 本 bot
   * 但被 talk 权限闸挡住时，给 owner 弹 /grant 申请卡。显式 false 时静默丢弃，
   * 保留原来的强权限闸但不刷卡。
   */
  autoGrantRequestCards?: boolean;
  /**
   * 用户自定义、额外放行透传给 CLI 的 slash 命令 —— 在固定的 PASSTHROUGH_COMMANDS
   * 之上扩展（例如把 CLI 支持但默认不放行的 `/goal`、`/export` 加进来）。每项必须
   * `/` 开头、小写、仅含 [a-z0-9:_-]；解析时归一化（缺失的 `/` 自动补、转小写、去重、
   * 丢弃非法项与会遮蔽 botmux daemon 命令的项）。与内置白名单合并后由
   * {@link resolvePassthroughCommands} 生效；`/list-slash-command` 可查看完整放行清单。
   * 未配置（undefined）→ 仅用内置白名单（保持现状）。
   */
  customPassthroughCommands?: string[];
  /**
   * Daemon 命令的权限例外名单：列出的命令把权限闸从 canOperate（仅 allowedUsers）降到
   * canTalk（oncall 群成员 / allowedChatGroups / chatGrant / globalGrant / p2pOpen 私聊
   * 等对话放行腿）。与 passthrough 无关——命令仍由 daemon 自己处理，只是准入门槛不同。
   * 解析时归一化（转小写、自动补 `/`、去重），且**只接受 DAEMON_COMMANDS 内的命令**，
   * 其余条目丢弃并 warn。带 handler 内部第二道 owner 闸的命令（/card /term /insight）
   * 即使列入也仍会被内部闸拒绝（fail-closed，不视为本字段的适用对象）。
   * ⚠️ 与 `restrictGrantCommands` 的组合：那个开关在路由里先于本名单生效——开着时
   * chatGrant/globalGrant 被授权人发任何 slash 命令都被更早的限制闸挡下，本名单
   * 对他们不生效（oncall / allowedChatGroups / p2pOpen 等其余 canTalk 腿不受影响）。
   * 未配置（undefined）→ 全部 daemon 命令保持 owner-only（现状）。
   */
  canTalkDaemonCommands?: string[];
  /**
   * Optional per-bot startup commands: slash-command lines the worker types into
   * a freshly spawned CLI right after it's ready, BEFORE the user's first prompt
   * (e.g. `/effort ultracode`, `/model opus`). Sent in order, one submit each,
   * via the same literal-input path as a passthrough slash command (no prompt
   * wrapping). Re-applied on every fresh spawn (incl. resume) — so session-only
   * settings like `/effort ultracode` survive a resume. Skipped in adopt mode
   * (we observe the user's existing session, not drive a fresh one). Each entry
   * is trimmed and gets a leading `/` if missing; arguments (spaces) preserved.
   */
  startupCommands?: string[];
  /**
   * Optional per-bot environment variables, injected into THIS bot's CLI
   * process (e.g. `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` to run the bot
   * on GLM / a third-party Anthropic-compatible provider, an `HTTPS_PROXY`, or
   * a CLI feature flag). Sanitized at load via {@link sanitizePerBotEnv}
   * (valid env-var names + string/number/boolean values; botmux-reserved keys
   * dropped). Delivered per-session as SpawnOpts.injectEnv so it never pollutes
   * the shared tmux/zellij server env. Missing/empty → undefined.
   */
  env?: Record<string, string>;
  /**
   * Optional per-bot priority skill policy. Missing means botmux does not alter
   * the underlying CLI's native skill discovery or spawn arguments.
   */
  skills?: BotSkillPolicy;
  /**
   * Custom footer brand label for cards this bot sends. Three states:
   *   • `undefined` (unset)  → default `[botmux](github)` link
   *   • `''` (empty)         → brand suppressed (footer shows only 发送给 if any)
   *   • any other string     → rendered verbatim (markdown allowed)
   * Resolved via {@link resolveBrandLabel}. Pure cosmetic — does not affect
   * routing or permissions.
   */
  brandLabel?: string;
  /**
   * Sparse per-bot reply-writing/card-style overrides. Missing fields inherit
   * the built-in recipe and theme defaults; malformed hand-edited fields are
   * dropped independently by {@link normalizeReplyStyleConfig}.
   *
   * Workers freeze the normalized sparse object into BOTMUX_REPLY_STYLE when a
   * session starts so the guide an Agent reads and the card renderer it invokes
   * cannot drift halfway through a long-lived pane.
   */
  replyStyle?: ReplyStyleConfig;
  /**
   * Where to show native Context / Token usage for this bot's Session cards:
   *   • `'streaming'` (default / unset) → in the live streaming card body
   *   • `'footer'`                      → in the ordinary reply-card footer
   *   • `'off'`                         → nowhere
   * A missing individual metric is still omitted independently, and this only
   * controls DISPLAY — Usage Ledger accounting and other consumers are
   * unaffected. Backward compat: a legacy `showUsageInCardFooter: false` with no
   * `usageDisplay` set is read as `'off'` (see {@link resolveUsageDisplay}).
   */
  usageDisplay?: UsageDisplayMode;
  tuiSlashAllow?: string[];
  /**
   * When true, suppress the live streaming session card entirely. The web
   * terminal still runs and the final answer still arrives via `botmux send`;
   * only the auto-updating status card is never posted/patched. Default
   * (undefined) keeps the streaming card. For users who find the live card noisy.
   */
  disableStreamingCard?: boolean;
  /**
   * Pin the current public streaming card. Default false; best-effort only.
   */
  pinStreamingCard?: boolean;
  /** chat_id list: chats where streaming-card Pin is disabled even when the
   *  bot-level {@link pinStreamingCard} master switch is on. Written by
   *  `/card pin off|on`. */
  noPinStreamingCardChats?: string[];
  /**
   * Stream the model's thinking process (CoT) into a native Feishu CoT
   * message per turn: a fixed-height scrolling bubble showing thinking
   * paragraphs and tool calls as nodes, auto-collapsing when the turn settles.
   * Default ON (absent/undefined = on); only an explicit false disables.
   * Requires a transcript-backed CLI (claude-code and codex today); other
   * CLIs simply never emit the thinking channel. Per-chat opt-out via
   * {@link noCotChats} (`/cot off`).
   */
  thinkingCard?: boolean;
  /** chat_id list: chats where the CoT (thinking process) message is suppressed
   *  even when {@link thinkingCard} is on. Written by `/cot off|on`. */
  noCotChats?: string[];
  /**
   * When true, suppress the lightweight GoGoGo → DONE message reactions used as
   * progress markers in card-off sessions. Missing/false preserves the current
   * card-off reaction behavior.
   */
  silentTurnReactions?: boolean;
  /**
   * Feishu emoji_type for the "received" turn reaction in card-off sessions.
   * Undefined → default GoGoGo (冲!). Free-form string; a bad emoji_type just
   * silently fails to attach (addReaction is best-effort).
   */
  receivedReactionEmoji?: string;
  /**
   * Feishu emoji_type for the "done" turn reaction. Undefined → default DONE (✅).
   * Set this EQUAL to receivedReactionEmoji to keep the marker visually
   * unchanged on turn-end — useful for CLIs whose idle detection can fire early
   * (e.g. Pi during model-thinking gaps), where a premature ✅ would mislead.
   */
  doneReactionEmoji?: string;
  /**
   * Conversation mode for 1:1 private chats (DMs) with the bot:
   *   - 'thread' (default, stored as undefined): every top-level DM message
   *     starts a fresh thread-scoped session — the official/legacy behavior,
   *     keeps 1:1 chatter out of one long-running CLI process.
   *   - 'chat': route DMs as one flat, continuous chat-scoped session (all
   *     messages share the same context, similar to Hermes/OpenClaw).
   *   - 'group': every top-level DM message births a dedicated 1-user+1-bot
   *     "session group" that hosts the conversation (the bot keeps chat
   *     ownership; the group is registered in session-groups-store and the
   *     session lands chat-scope inside it). Falls back to 'thread' behavior
   *     when group creation fails.
   * Editable at runtime via `/botconfig p2pMode chat|thread|group` (owner/admin).
   */
  p2pMode?: 'thread' | 'chat' | 'group';
  /**
   * Settings for p2pMode='group' session groups. All fields optional; see
   * SessionGroupConfig for defaults. Ignored under other p2pModes.
   */
  sessionGroup?: SessionGroupConfig;
  /** chat_id list: chats where the live streaming card is suppressed (status falls back to master's pending-card morph). Written by `/card off|on`. */
  noCardChats?: string[];
  /**
   * When true, the streaming card embeds a directly-usable WRITABLE terminal
   * link in its body (token included → anyone who can see the card can drive
   * the terminal). Default (undefined) keeps the write link behind the
   * "get write link" button, which DMs it privately to the clicker. Moot when
   * {@link disableStreamingCard} is on (no card to embed it in).
   */
  writableTerminalLinkInCard?: boolean;
  /**
   * When true, `/card` sends a **private** static snapshot card via the ephemeral
   * API, visible only to the bot's `allowedUsers` (owner / co-owners), instead of
   * the group-visible live streaming card. Talk-only grants (globalGrants /
   * chatGrants) and a bare triggerer do NOT receive it — it's owner-only. Only
   * works in plain `group` chats (topic/thread/p2p fail closed) and cannot
   * live-update (ephemeral cards can't be patched). Scoped to the `/card` command
   * only — the auto streaming card is unaffected. Default (undefined) keeps
   * `/card` group-visible & live.
   */
  privateCard?: boolean;
  /**
   * bot@bot 同目录拉起 (cross-bot working-dir inheritance). When a bot is @-ed
   * into a chat/thread where a sibling bot already has an active session, it
   * reuses that sibling's workingDir and skips its own repo-selection card.
   * This is independent of /oncall. Default ON (undefined = on); set to false
   * to make THIS bot always fall through to its own repo card / default dir.
   * Toggled from the dashboard Bot Defaults tab; persisted via card-prefs-store.
   */
  botToBotSameDir?: boolean;
  /**
   * 平台团队页是否展示这个 bot. When false, this bot is hidden from the central
   * platform's team roster (人→机器→bot view). Default ON (undefined = shown);
   * set to false to keep an internal/utility bot off the team page.
   * Reported to the platform via the dashboard's bot-info upload.
   */
  showInTeam?: boolean;
  /**
   * 主动开工 — 场景①. When true, the bot auto-starts a session when it is added
   * to a new chat that contains at least one of its allowedUsers (see
   * docs/specs/20260529-proactive-auto-start/). Default (undefined) = passive
   * (only spawns on @mention). Requires the `im.chat.member.bot.added_v1` event
   * to be subscribed for the app in the Feishu console.
   */
  autoStartOnGroupJoin?: boolean;
  /**
   * 主动开工 — 场景① optional pre-configured first-turn prompt. When set, it
   * becomes the user_message of the auto-started session; when unset/blank the
   * session starts with an empty user_message and the bot reads the group
   * context itself. Moot when {@link autoStartOnGroupJoin} is off.
   */
  autoStartOnGroupJoinPrompt?: string;
  /**
   * 主动开工 — 场景①自定义入群 seed 消息文案（该消息同时是话题根/共享会话锚点，
   * 只在话题群 / 普通群 new-topic / shared 模式下发送；普通群顶层平铺入群静默）。
   * 缺省/空白 → 按 bot locale 回退内置 i18n 文案（daemon.auto_start_join_seed）。
   * bots.json 手配 + dashboard「Bot 默认设置」可编辑（card-prefs 链路，清空保存即
   * 恢复默认）。注意 forcePrompt（Issue Board 领取）路径会跳过
   * {@link autoStartOnGroupJoin} 开关检查，开关关闭时 seed 仍可能发出。
   */
  autoStartOnGroupJoinSeed?: string;
  /**
   * 进群自动拉 owner。Default (undefined) = ON：本 bot 被加进任何群时，自动把
   * 自己的 owner（resolvedAllowedUsers 首个 ou_ 用户）拉进群——bot 应始终处于
   *  owner 可见的群里（不打黑工）。显式 false 关闭（如告警/oncall 类 bot 被
   * 平台批量拉进大量事件群、不想打扰 owner 的场景）。仅 bots.json 文件配置。
   */
  autoInviteOwnerOnGroupAdd?: boolean;
  /**
   * 主动开工 — 场景②. When true, in a 话题群 (topic mode) every new topic's first
   * message auto-starts a session even without an @mention (the default role +
   * the user's first message form the prompt). No effect in regular groups.
   * Default (undefined) = passive.
   */
  autoStartOnNewTopic?: boolean;
  /**
   * Per-chat group message listener. Keyed by chat_id and bot-scoped so the
   * dashboard can configure it from the Roles page's natural group × bot
   * matrix. When enabled, the bot may react to non-@ top-level group messages
   * after deterministic sender/msgType filtering. V1 always replies in a
   * fresh thread under the triggering message.
   */
  messageListeners?: Record<string, MessageListenerConfig>;
  /**
   * Worktree picker mode on the repo-select card. When true, the worktree
   * control renders the multi-repo selector (pick N repos + branch) instead of
   * the single-select dropdown. Toggled from the card's 「切换多仓库选择器」button;
   * persists so all of this bot's future sessions default to it. Default false.
   */
  worktreeMultiPicker?: boolean;
  /**
   * Per-bot DEFAULT session mode for regular Lark groups (overridable per-chat
   * via `/reply-mode` → `chatReplyModes`). Resolved by
   * `chat-reply-mode-store.regularGroupDefaultMode`.
   *   • 'chat' (or undefined) — whole group shares one flat chat-scope session
   *   • 'new-topic'           — each top-level @mention forks its own thread-scope session
   *   • 'shared'              — replies fold into a topic but reuse the one chat-scope session
   */
  regularGroupReplyMode?: ChatReplyMode;
  /**
   * Per-bot (bot-global) policy for when an @mention is required to get a reply
   * in regular Lark groups — a 4-tier ladder:
   *   • 'always' (or undefined) — @ required everywhere, including inside the
   *                               bot's own shared topics (the safe default).
   *   • 'topic'                 — @ required to start / at top level, but NOT
   *                               inside the bot's shared topics (non-@ replies
   *                               there continue the session).
   *   • 'never'                 — @ never required: every non-@ message in groups
   *                               where the bot has talk access is answered too,
   *                               unconditionally. For dedicated / on-call groups.
   *   • 'ambient'               — like 'never' (non-@ messages answered), EXCEPT
   *                               when the message @mentions another specific
   *                               member (person/bot) without @ing this bot —
   *                               that is a redirect to someone else, so the bot
   *                               stays quiet (@all is not a redirect). Best for
   *                               multi-bot / multi-person groups: a default
   *                               responder that yields when you address someone
   *                               else.
   * Governs the shared-topic fold-back + the top-level @ gate. `new-topic` /
   * 话题群 topics own their own thread and continue without @ regardless (that
   * is the mode's defining behavior, not affected by this policy).
   */
  regularGroupMentionMode?: 'always' | 'topic' | 'never' | 'ambient';
  /**
   * 允许 `botmux send --mention` @ 群内任意成员（用完整邮箱 / 手机号 / union_id /
   * open_id 指定），而不仅是本轮触发者（--mention-back）。默认 false：关闭时
   * --mention 只接受字面 open_id，传入邮箱等非 open_id 标识会被拒绝，避免模型
   * 自主决定 @ 谁时“乱发”。开启后：
   *   1. --mention 的每个值先经 resolveAllowedUsersWithMap 解析成本 app open_id；
   *   2. 解析结果再与目标群的成员列表（listChatMemberOpenIds）做交集校验，
   *      只有确实在群里的人才会被 @，不在群里的直接拒绝发送。
   * 是否开放由配置该 bot 的人决定。
   */
  allowArbitraryMention?: boolean;
  /**
   * Regular-group substitute trigger. When enabled, an @mention of one of the
   * configured people is treated as an address to this bot when the sender can
   * talk to the bot. Matching currently uses mention open_id / user_id / union_id;
   * email is preserved for future resolution but is not matched directly.
   */
  substituteMode?: SubstituteModeConfig;
  /**
   * 飞书文档评论监听（/watch-comment；/subscribe-lark-doc 也复用）新绑定的默认触发范围：
   *   • 'mention-only'（或 undefined）— 仅评论里 @bot 才触发（默认，防噪声）
   *   • 'all'                        — 该文档所有新评论都触发
   * 单条订阅的触发范围之后可在 dashboard 逐文档改（doc-subscriptions 表）。
   */
  docSubscribeDefaultMode?: 'mention-only' | 'all';
  /**
   * 文档 → 本地仓库/目录映射。当文档评论触发且无活跃 session 时，auto-create
   * session 会按 fileToken 查此表确定 agent 的 workingDir。
   * 键是飞书文档的 file_token（wiki 已解析为底层 obj_token），值是本地绝对路径。
   * 例：{ "KszRdLt6MoNtBFxNjBmm3jlhyWd": "/home/me/my-repo" }
   * 也可以在 `/watch-comment <doc> --dir /path` 时逐文档指定。
   */
  docRepoMap?: Record<string, string>;
  /** Per-bot range for explicit `@bot /summary`; defaults to 50 messages / 24h. */
  summaryRange?: SummaryRangeConfig;
  /** When true, explicit `@bot /summary` records a conservative project-local summary.md. */
  summaryMemory?: boolean;
  /** Optional target path for summary memory. Relative paths are resolved by the agent against the current project root; absolute paths are used as configured. */
  summaryMemoryPath?: string;
  /**
   * Legacy content/keyword trigger config. Kept parseable for config
   * compatibility, but message routing no longer fires non-@ content triggers.
   */
  contentTriggers?: ContentTriggerConfig[];
  /**
   * Per-bot voice-engine override for the voice-summary feature. Merged OVER
   * the global `voice` block in ~/.botmux/config.json (per-bot wins field by
   * field). When this bot has usable voice creds (here or globally), its reply
   * cards render the "🔊 语音总结" button. See services/voice/types.ts.
   */
  voice?: VoiceConfig;
  /**
   * Per-bot pricing overrides for cost estimation. Merged over the built-in
   * model price table. See services/model-pricing.ts.
   */
  pricing?: PricingOverrides;
  /**
   * Per-bot monthly budget config. When set, the daemon tracks spend and
   * alerts/blocks at thresholds. See services/budget-tracker.ts.
   */
  budget?: BudgetConfig;
}

export interface BotState {
  config: BotConfig;
  /** The Lark SDK client — NULL for apiOnly (core-only) bots: they have no
   *  Feishu credential (empty appSecret), and the SDK's Client ctor throws
   *  "appSecret or clientAssertionProvider is required" on an empty secret. An
   *  apiOnly bot never needs it (getBotClient throws LarkTransportDisabledError
   *  before returning it), so we skip construction entirely rather than feed the
   *  SDK a placeholder. Every consumer reaches it via getBotClient (which gates
   *  apiOnly) or getAllBotClients (which filters apiOnly), so the null is unreachable. */
  client: Lark.Client | null;
  /** Same credentials/domain as `client`, but bound to a dedicated http
   * instance with the looser upload timeout. Only media uploads use it. NULL for
   * apiOnly bots for the same reason as `client` (no credential to construct one);
   * getBotUploadClient gates apiOnly before returning it, so the null is unreachable. */
  uploadClient: Lark.Client | null;
  botOpenId?: string;
  botName?: string;       // Lark app display name (from /bot/v3/info)
  botAvatarUrl?: string;  // Lark app avatar URL (from /bot/v3/info)
  resolvedAllowedUsers: string[];
  /** raw allowedUsers 条目 → 解析后的 open_id。供 /revoke 反查并删除 email 形式的 raw 条目。 */
  rawAllowedUserResolution: Map<string, string>;
}

const bots = new Map<string, BotState>();

export function __testOnly_resetBotRegistry(): void {
  bots.clear();
  loadedConfigPath = undefined;
  loadedConfigProvenance = undefined;
  oncallChatCache = null;
  brandLabelCache = null;
  cachedLarkUploadHttpInstance = undefined;
  usageDisplayCache = null;
  replyStyleCache = null;
}

// Wire the i18n lookup so `localeForBot()` can resolve per-bot locale without
// a hard import cycle between `i18n` and `bot-registry`.
setBotLookup((id) => bots.get(id));

/** Path of the bot config file we loaded (so `/oncall` can persist bindings back). */
let loadedConfigPath: string | undefined;
/**
 * PROVENANCE of {@link loadedConfigPath} — whether that path was actually PARSED
 * (`'loaded'`) or is only a synthetic placeholder (`'synthetic'`, core-only).
 * Tracked as its own fact because it is NOT recoverable later: the path alone
 * cannot say whether it was read, and probing the filesystem answers a different
 * question (existence), which is wrong in both directions. See
 * `core/config-dir.ts` BotsConfigProvenance for the full rationale.
 */
let loadedConfigProvenance: BotsConfigProvenance | undefined;
export function getLoadedConfigPath(): string | undefined {
  return loadedConfigPath;
}
/**
 * Provenance of `getLoadedConfigPath()`. `undefined` when nothing has been
 * resolved yet. Consumed by the worker to decide whether the path is a real
 * registry authority worth pinning onto a CLI child's `BOTS_CONFIG`.
 */
export function getLoadedConfigProvenance(): BotsConfigProvenance | undefined {
  return loadedConfigProvenance;
}

// Route Lark SDK output through our logger so it inherits the same sink
// rules (info/debug → daemon.log in daemon mode, → stderr in CLI mode,
// dropped when CLI is silent). The default SDK logger calls console.log,
// which would corrupt CLI stdout consumers.
//
// Volume control: the SDK is chatty at info/debug ("client ready", request
// traces, etc.); without DEBUG=1 those become no-ops in the CLI path and
// stay in daemon.log on the daemon path — pm2's error.log no longer sees
// "[lark:info] client ready" floods.
// Cap raw dumps so an unrecognized error shape can never flood the log the way
// the SDK's full AxiosError blob (stack + config + headers) did — that bloated
// pm2's error.log past 1GB and, worse, leaked the `Authorization: Bearer t-…`
// access token on every request failure.
const MAX_FALLBACK_LEN = 300;
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > MAX_FALLBACK_LEN ? `${s.slice(0, MAX_FALLBACK_LEN)}…(+${s.length - MAX_FALLBACK_LEN})` : s;
}

// Drop the protocol+host (and `/open-apis/` prefix) so the line shows just the
// API path that matters for triage, never the bearer token in the URL/headers.
function shortLarkPath(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/open-apis\//, '');
  return path || url;
}

/**
 * Condense a Lark SDK error into one readable line, preserving just the fields
 * needed to triage (HTTP status + business `code`/`msg`/`log_id`). Returns null
 * when the value isn't an axios-shaped error, so callers fall back to
 * length-capped stringify. Never serializes `config`/`headers`/`stack`, so the
 * access token can't leak.
 */
export function formatLarkError(v: any): string | null {
  // The SDK logger calls logger.error(formatErrors(error)), so its first
  // argument is an array containing the already-sanitized Axios shape. Accept
  // that wrapper here as well as the raw error received by CLI callers.
  if (Array.isArray(v)) {
    for (const item of v) {
      const formatted = formatLarkError(item);
      if (formatted) return formatted;
    }
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const isAxios = v.isAxiosError === true || v.name === 'AxiosError' || (v.config && (v.response || v.status != null));
  if (!isAxios) return null;
  const method = String(v.config?.method ?? '').toUpperCase();
  const path = shortLarkPath(v.config?.url);
  const httpStatus = v.response?.status ?? v.status;
  // Lark business error lives in the response body; some shapes surface it on
  // the error object directly.
  const data = v.response?.data ?? {};
  const code = data.code ?? v.code;
  const msg = data.msg ?? v.msg;
  const logId = data.log_id ?? data.logId;
  const parts: string[] = [];
  if (method) parts.push(method);
  if (path) parts.push(path);
  if (httpStatus != null || method || path) parts.push(`→ ${httpStatus ?? '?'}`);
  if (typeof code === 'number') parts.push(`code=${code}`);
  if (typeof msg === 'string' && msg) parts.push(`"${msg}"`);
  if (logId) parts.push(`log_id=${logId}`);
  // Without an HTTP response, the transport code/message is the only useful
  // signal. Keep it while still excluding config, headers, and stack.
  if (httpStatus == null && typeof code !== 'number') {
    if (typeof v.code === 'string' && v.code) parts.push(v.code);
    if (typeof v.message === 'string' && v.message) parts.push(`"${v.message}"`);
  }
  if (!parts.length) return null;
  return parts.join(' ');
}

const fmtLark = (msg: any[]) => msg.map((m) => formatLarkError(m) ?? safeStringify(m)).join(' ');
const larkLogger = {
  // SDK request failures arrive here as raw AxiosError objects — condense to a
  // single triage line (status + lark code/msg/log_id) instead of dumping the
  // stack/config blob. Demoted to warn: nearly all are environmental and already
  // handled at the call site (rate limits, bot-not-in-chat, stale threads).
  error: (...msg: any[]) => logger.warn(`[lark] ${fmtLark(msg)}`),
  warn:  (...msg: any[]) => logger.warn(`[lark] ${fmtLark(msg)}`),
  info:  (...msg: any[]) => logger.info(`[lark] ${fmtLark(msg)}`),
  debug: (...msg: any[]) => logger.debug(`[lark] ${fmtLark(msg)}`),
  trace: (..._msg: any[]) => { /* SDK trace dropped entirely — uninteresting per-byte WS frames */ },
};

/**
 * Pure predicate: is this bot's VC-meeting-agent config ACTIVE (should the daemon
 * attend meetings / restore VC runtime sessions / poll `lark-cli vc` for it)?
 *
 * Returns the config only when it is `enabled` AND the bot is NOT apiOnly. An
 * apiOnly (core-only) bot has no Feishu connection — attending a VC meeting drives
 * `lark-cli vc +meeting-events --as bot`, which categorically violates the
 * zero-Feishu-network contract. Gating here (rather than only at each call site)
 * means the daemon's central `effectiveVcMeetingAgentConfig` accessor — and every
 * one of its ~24 consumers, including the boot-time `restoreVcMeetingRuntimeSessions`
 * path that runs OUTSIDE the `!cfg.apiOnly` boot block — fail-closes for apiOnly by
 * construction. The dashboard already refuses to SET an apiOnly listener; this also
 * covers a hand-edited / migrated bots.json (a normal VC bot flipped to apiOnly with
 * `vcMeetingAgent.enabled:true` + a stale on-disk runtime record).
 */
export function vcMeetingAgentConfigActive(
  cfg: Pick<BotConfig, 'apiOnly' | 'vcMeetingAgent'> | undefined,
): VcMeetingAgentConfig | undefined {
  if (!cfg) return undefined;
  // apiOnly (core-only) bots have no Feishu transport — a VC listener drives
  // `lark-cli vc +meeting-events --as bot`, which breaks the zero-Feishu-network
  // contract. This fail-close is the load-bearing invariant and must stay first.
  if (cfg.apiOnly === true) return undefined;
  // Bot-agnostic join (2026-08): any invited bot should join, so VC is active by
  // default for every Feishu-connected bot. `vcMeetingAgent.enabled: false` is
  // the explicit per-bot opt-out; unset/absent now means active. A bot with no
  // vcMeetingAgent block at all gets an empty effective config so downstream
  // reads (listenerChatId auto-create, profile provision, consumer defaults)
  // work off their own fallbacks. Fleet-wide off remains the global switch.
  if (cfg.vcMeetingAgent?.enabled === false) return undefined;
  return cfg.vcMeetingAgent ?? {};
}

export function registerBot(cfg: BotConfig): BotState {
  // apiOnly (core-only) bots have NO Feishu credential (empty appSecret). The Lark
  // SDK Client ctor throws "appSecret or clientAssertionProvider is required" on an
  // empty secret, so constructing it would fatal the whole daemon at boot — the
  // exact failure riff hit in a clean sandbox. An apiOnly bot never uses the client
  // (getBotClient throws LarkTransportDisabledError first; getAllBotClients filters
  // apiOnly), so leave both client and uploadClient null. Zero Feishu transport is
  // the whole contract.
  let client: Lark.Client | null = null;
  let uploadClient: Lark.Client | null = null;
  if (cfg.apiOnly !== true) {
    const clientParams = {
      appId: cfg.larkAppId,
      appSecret: cfg.larkAppSecret,
      // brand → SDK domain。缺省走 feishu，国际版租户走 larksuite.com。
      // 这一行同时修好了所有经由 SDK 的调用（发消息 / 文件 / contact 等）。
      domain: sdkDomain(normalizeBrand(cfg.brand)),
      logger: larkLogger,
    };
    client = new Lark.Client(clientParams);
    configureLarkClientHttpTimeout(client);
    // Media uploads reuse the same credentials/domain but ride a dedicated http
    // instance with the looser upload timeout. When the SDK no longer exposes a
    // separable instance, fall back to the interactive client (uploads keep 15s).
    const uploadHttpInstance = larkUploadHttpInstance();
    uploadClient = uploadHttpInstance
      ? new Lark.Client({ ...clientParams, httpInstance: uploadHttpInstance as any })
      : client;
  }
  const state: BotState = {
    config: cfg,
    client,
    uploadClient,
    resolvedAllowedUsers: [...(cfg.allowedUsers ?? [])],
    rawAllowedUserResolution: new Map(),
  };
  // p2pOpen 是一次显式的权限边界声明（进入限制态），但它只授 talk。没有 allowedUsers 就
  // 没有任何人能 operate（/restart、/cd、卡片按钮全锁死），也没有 owner 可以处置授权卡 ——
  // 这几乎肯定是配错了，明确告警而不是静默把 bot 变成谁也管不了的状态。
  if (cfg.p2pOpen === true && (cfg.allowedUsers?.length ?? 0) === 0) {
    logger.warn(`[bot:${cfg.larkAppId}] p2pOpen 已开启但未配 allowedUsers：任何人都能私聊，但没有人能执行管理操作（/restart、/cd、卡片按钮）。请补上 allowedUsers。`);
  }
  bots.set(cfg.larkAppId, state);
  return state;
}

export function getBot(larkAppId: string): BotState {
  const state = bots.get(larkAppId);
  if (!state) {
    throw new Error(`Bot not registered: ${larkAppId}`);
  }
  return state;
}

export function getBotClient(larkAppId: string): Lark.Client {
  const bot = getBot(larkAppId);
  // Bot-level transport boundary at the TRUE shared base. `apiOnly` (core-only)
  // means zero Feishu network — reads AND writes — not merely "no sends". Every
  // Feishu call in the codebase resolves its client here (client.ts primitives,
  // doc-comment drive API, open-platform rename/avatar, identity cache…), so
  // throwing here is the single authoritative gate no caller can bypass. A
  // correctly-built apiOnly flow never reaches this (session/CLI gates fire
  // first); reaching it is genuine misuse and must fail loud, not silently.
  if (bot.config.apiOnly === true) {
    throw new LarkTransportDisabledError(larkAppId, 'getBotClient');
  }
  // Non-apiOnly bots always have a constructed client (registerBot builds one for
  // every non-apiOnly config). The null-guard is defensive — a null here would mean
  // a misconfigured bot slipped the apiOnly gate, which must fail loud, not NPE deep
  // in an SDK call.
  if (!bot.client) {
    throw new Error(`Bot ${larkAppId} has no Lark client (apiOnly misconfiguration)`);
  }
  return bot.client;
}

/** Client bound to the looser upload timeout. Use only for media uploads
 * (image/file); every other call uses `getBotClient` and its interactive bound. */
export function getBotUploadClient(larkAppId: string): Lark.Client {
  const bot = getBot(larkAppId);
  // Same bot-level transport boundary as getBotClient: apiOnly (core-only) bots
  // make zero Feishu network calls, so they never have an upload client. Fail
  // loud rather than NPE deep in an SDK upload call.
  if (bot.config.apiOnly === true) {
    throw new LarkTransportDisabledError(larkAppId, 'getBotUploadClient');
  }
  // Non-apiOnly bots always have a constructed upload client (registerBot builds
  // one — the dedicated-instance path or the interactive-client fallback). The
  // null-guard is defensive against an apiOnly misconfiguration slipping the gate.
  if (!bot.uploadClient) {
    throw new Error(`Bot ${larkAppId} has no Lark upload client (apiOnly misconfiguration)`);
  }
  return bot.uploadClient;
}

/** Owner = bot 首个已授权 open_id，与「缺权限警告私信对象」同口径（见 admin 解析）。 */
export function getOwnerOpenId(larkAppId: string): string | undefined {
  return bots.get(larkAppId)?.resolvedAllowedUsers.find(u => u.startsWith('ou_'));
}

/** Admins = all resolved allowedUsers, matching `/botconfig`'s permission model. */
export function getDashboardAdminOpenIds(larkAppId: string): string[] {
  return [...(bots.get(larkAppId)?.resolvedAllowedUsers ?? [])];
}

/**
 * Hook the daemon registers so runtime allowedUsers mutations (set / revoke)
 * can republish the dashboard descriptor's `resolvedAllowedUsers` without the
 * services layer importing daemon internals. No-op until the daemon registers
 * it (e.g. in one-shot CLI paths that never publish a descriptor).
 */
let republishResolvedAllowedUsersHook: ((larkAppId: string, resolved: string[]) => void) | undefined;
export function setResolvedAllowedUsersRepublishHook(
  fn: (larkAppId: string, resolved: string[]) => void,
): void {
  republishResolvedAllowedUsersHook = fn;
}
export function republishResolvedAllowedUsersDescriptor(larkAppId: string, resolved: string[]): void {
  try { republishResolvedAllowedUsersHook?.(larkAppId, resolved); } catch { /* best effort */ }
}

/**
 * Hook the daemon registers so a runtime allowedUsers mutation that hit a
 * TRANSIENT contact failure for some entry can schedule the same background
 * resolve-retry the startup path uses (heal-when-API-recovers). No-op until the
 * daemon registers it (e.g. one-shot CLI paths with no retry loop).
 */
let allowedUsersResolveRetryHook: ((larkAppId: string) => void) | undefined;
export function setAllowedUsersResolveRetryHook(fn: (larkAppId: string) => void): void {
  allowedUsersResolveRetryHook = fn;
}
export function scheduleAllowedUsersResolveRetryFromMutation(larkAppId: string): void {
  try { allowedUsersResolveRetryHook?.(larkAppId); } catch { /* best effort */ }
}

/** Bot 自身的 open_id（用于在 mention 解析时排除自己）。 */
export function getBotOpenId(larkAppId: string): string | undefined {
  return bots.get(larkAppId)?.botOpenId;
}

/**
 * 安全地按 appId 取 brand。未注册（如跨进程 dashboard 聚合到别的 daemon 的
 * 会话）→ 归一为 'feishu'。仅用于派生 applink 等 host，缺省 feishu 安全。
 */
export function getBotBrand(larkAppId: string | undefined): Brand {
  return normalizeBrand(larkAppId ? bots.get(larkAppId)?.config.brand : undefined);
}

export function getAllBots(): BotState[] {
  return Array.from(bots.values());
}

/**
 * Bot 的有效展示名：自定义 displayName > 飞书探测名 botName > larkAppId。
 * 仅用于展示面（dashboard descriptor / SessionRow）；@ 路由与 bots-info
 * 名册仍用飞书真名。
 */
export function effectiveBotDisplayName(state: BotState): string {
  return state.config.displayName || state.botName || state.config.larkAppId;
}

/** Lookup the oncall binding for a given bot+chat, if any. */
export function findOncallChat(larkAppId: string, chatId: string): OncallChat | undefined {
  const bot = bots.get(larkAppId);
  return bot?.config.oncallChats?.find(c => c.chatId === chatId);
}

/**
 * The bot's effective default working dir for a NEW session, as a raw
 * (possibly `~`-prefixed) path — the caller still expands + validates it.
 *
 * Two sources, presented as a mutually-exclusive 3-way choice in the dashboard
 * ("默认工作目录模式": 关闭 / 仅默认目录 / Oncall 模式) but if both happen to be set
 * (legacy / chat-command config) `defaultWorkingDir` wins:
 *   1) `defaultWorkingDir` — pin a dir for new sessions; no permission change.
 *   2) `defaultOncall.workingDir` when `defaultOncall.enabled` — "Oncall 模式"
 *      extends its directory to ALL of this bot's sessions (p2p / 话题 / 普通群
 *      fallback), not just the group auto-bind. The group auto-bind (which also
 *      opens talk to the whole group) still happens separately upstream; this
 *      fallback is what makes the bot's OTHER sessions land in the same dir.
 *
 * Returns undefined when neither is configured. Reading this NEVER writes state
 * or binds a chat to oncall, so the resolved session's permission model is
 * unchanged regardless of which source supplied the path.
 */
export function effectiveDefaultWorkingDir(cfg: BotConfig): string | undefined {
  return cfg.defaultWorkingDir
    || (cfg.defaultOncall?.enabled ? cfg.defaultOncall.workingDir : undefined)
    || undefined;
}

// Cross-bot oncall chat discovery — cached by config-file mtime.
//
// /oncall bind is per-bot, and so is consumption: both talk-authorization
// gates AND working-dir pinning use findOncallChat(larkAppId, chatId). This
// cross-bot lookup is now used ONLY for `botmux send` footer addressing
// (cli.ts) — replying to the last caller in the shared oncall workspace —
// NOT for dir pinning or permission gating.
//
// Multi-daemon deployments run one bot per process, so the in-memory `bots`
// map only sees this daemon's own bot — sibling bots' bindings live only on
// disk in the shared bots.json. Re-read that file lazily, keyed by mtime,
// so the hot path is a single stat() once the cache is warm.
let oncallChatCache: { mtimeMs: number; chats: Map<string, OncallChat> } | null = null;

export function findOncallChatForAnyBot(chatId: string): OncallChat | undefined {
  // Fast path: this daemon's own bot(s). Covers single-daemon setups and any
  // case where the receiving bot itself is bound.
  for (const bot of bots.values()) {
    const entry = bot.config.oncallChats?.find(c => c.chatId === chatId);
    if (entry) return entry;
  }
  // Slow path: scan the shared bots.json for sibling bots' bindings.
  const path = loadedConfigPath;
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!oncallChatCache || oncallChatCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const chats = new Map<string, OncallChat>();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!Array.isArray(entry?.oncallChats)) continue;
          for (const c of entry.oncallChats) {
            if (c && typeof c.chatId === 'string' && typeof c.workingDir === 'string') {
              chats.set(c.chatId, { chatId: c.chatId, workingDir: c.workingDir });
            }
          }
        }
      }
      oncallChatCache = { mtimeMs: stat.mtimeMs, chats };
    }
    return oncallChatCache.chats.get(chatId);
  } catch {
    return undefined;
  }
}

export function isChatOncallBoundForAnyBot(chatId: string): boolean {
  return !!findOncallChatForAnyBot(chatId);
}

// Per-bot brand label, mtime-cached for the disk fallback. Keyed by larkAppId →
// the configured value (undefined when the bot has no brandLabel key).
let brandLabelCache: { mtimeMs: number; map: Map<string, string | undefined> } | null = null;
let usageDisplayCache: { mtimeMs: number; map: Map<string, UsageDisplayMode> } | null = null;
let replyStyleCache: { mtimeMs: number; map: Map<string, ReplyStyleConfig | undefined> } | null = null;

/** Normalize a raw bots.json entry's usage-display intent to the enum, applying
 *  backward compat: an explicit `usageDisplay` wins; otherwise a legacy
 *  `showUsageInCardFooter: false` maps to `'off'`; everything else is the
 *  default (`'streaming'`). Single source of truth for both the in-memory parse
 *  and the disk-fallback resolver so they cannot drift. */
export function normalizeUsageDisplay(entry: {
  usageDisplay?: unknown;
  showUsageInCardFooter?: unknown;
}): UsageDisplayMode {
  if (entry.usageDisplay === 'streaming' || entry.usageDisplay === 'footer' || entry.usageDisplay === 'off') {
    return entry.usageDisplay;
  }
  if (entry.showUsageInCardFooter === false) return 'off';
  return DEFAULT_USAGE_DISPLAY;
}

/** Resolve the bots.json path the same way loadBotConfigs does, without
 *  requiring the registry to have been loaded (works in one-shot CLI processes
 *  like `botmux send`). Returns null when no config file exists. */
function botsConfigDiskPath(): string | null {
  const r = resolveBotsConfigFile();
  return existsSync(r) ? r : null;
}

/**
 * The configured brand label for a bot, or `undefined` when unset (`''` = off
 * is preserved). Prefers the in-memory registry (daemon hot path); falls back
 * to a mtime-cached read of bots.json so the CLI process — which never loads
 * the registry — still resolves the sending bot's brand. Callers feed the
 * result into {@link brandFooterSegment} for the unset→default / ''→off rule.
 */
export function resolveBrandLabel(larkAppId: string): string | undefined {
  // A sandboxed one-shot `botmux send` can't read bots.json (deny-by-default),
  // so it has no in-memory registry and would fall through to a bots.json read
  // that EPERMs → role footer lost. The worker injects THIS bot's resolved
  // brandLabel via env; honour it first (gated on the own appId). Present-but-
  // empty ('') = suppress; absent → fall through. brandLabel is a cosmetic
  // markdown template, not a secret, so env-passing is safe.
  if (process.env.BOTMUX_LARK_APP_ID === larkAppId && 'BOTMUX_BRAND_LABEL' in process.env) {
    return process.env.BOTMUX_BRAND_LABEL;
  }
  const inMem = bots.get(larkAppId);
  if (inMem) return inMem.config.brandLabel;
  const path = loadedConfigPath ?? botsConfigDiskPath();
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!brandLabelCache || brandLabelCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const map = new Map<string, string | undefined>();
      if (Array.isArray(raw)) {
        for (const e of raw) {
          if (e && typeof e.larkAppId === 'string') {
            map.set(e.larkAppId, typeof e.brandLabel === 'string' ? e.brandLabel : undefined);
          }
        }
      }
      brandLabelCache = { mtimeMs: stat.mtimeMs, map };
    }
    return brandLabelCache.map.get(larkAppId);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the per-bot usage-display mode (default `'streaming'`). A freshly
 * loaded registry wins over the spawn-time env so long-lived panes observe
 * `/botconfig` hot updates; sandboxed/env-only processes carry the value in
 * their synthetic registered bot and otherwise fall back to the injected env.
 */
export function resolveUsageDisplay(larkAppId: string): UsageDisplayMode {
  const inMem = bots.get(larkAppId);
  if (inMem) return normalizeUsageDisplay(inMem.config);
  if (process.env.BOTMUX_LARK_APP_ID === larkAppId
    && 'BOTMUX_USAGE_DISPLAY' in process.env) {
    const env = process.env.BOTMUX_USAGE_DISPLAY;
    if (env === 'streaming' || env === 'footer' || env === 'off') return env;
    return DEFAULT_USAGE_DISPLAY;
  }
  const path = loadedConfigPath ?? botsConfigDiskPath();
  if (!path) return DEFAULT_USAGE_DISPLAY;
  try {
    const stat = statSync(path);
    if (!usageDisplayCache || usageDisplayCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const map = new Map<string, UsageDisplayMode>();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (entry && typeof entry.larkAppId === 'string') {
            map.set(entry.larkAppId, normalizeUsageDisplay(entry));
          }
        }
      }
      usageDisplayCache = { mtimeMs: stat.mtimeMs, map };
    }
    return usageDisplayCache.map.get(larkAppId) ?? DEFAULT_USAGE_DISPLAY;
  } catch {
    return DEFAULT_USAGE_DISPLAY;
  }
}

/**
 * Resolve the normalized sparse reply-style snapshot for a bot.
 *
 * Unlike hot display-only settings, a running CLI pane must keep the same
 * replyStyle it learned through the botmux-send guide when it later invokes
 * `botmux send`. Therefore the spawn-time env snapshot intentionally wins for
 * the current app; daemon callers without that snapshot use the loaded registry,
 * and one-shot host CLIs fall back to an mtime-cached bots.json read.
 */
export function resolveReplyStyleConfig(larkAppId: string): ReplyStyleConfig | undefined {
  if (process.env.BOTMUX_SESSION_ID
    && process.env.BOTMUX_LARK_APP_ID === larkAppId
    && 'BOTMUX_REPLY_STYLE' in process.env) {
    try {
      const parsed = JSON.parse(process.env.BOTMUX_REPLY_STYLE || '{}');
      return normalizeReplyStyleConfig(parsed).config;
    } catch {
      return undefined;
    }
  }

  const inMem = bots.get(larkAppId);
  if (inMem) return inMem.config.replyStyle;

  const path = loadedConfigPath ?? botsConfigDiskPath();
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!replyStyleCache || replyStyleCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const map = new Map<string, ReplyStyleConfig | undefined>();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (entry && typeof entry.larkAppId === 'string') {
            map.set(entry.larkAppId, normalizeReplyStyleConfig(entry.replyStyle).config);
          }
        }
      }
      replyStyleCache = { mtimeMs: stat.mtimeMs, map };
    }
    return replyStyleCache.map.get(larkAppId);
  } catch {
    return undefined;
  }
}

/**
 * 只读 accessor：该 bot 配置的 tuiSlashAllow allowlist（TUI 通用 slash 注入用）。
 * 仅读内存态注册表，daemon 进程内使用；无需 bots.json 磁盘回退（不同于
 * resolveBrandLabel——`botmux send` 等一次性 CLI 进程不消费此 accessor）。
 */
export function getBotTuiSlashAllow(larkAppId: string): string[] | undefined {
  return bots.get(larkAppId)?.config.tuiSlashAllow;
}

/**
 * 该 bot 是否接受**其他 bot** 发来的原生斜杠命令（--slash）。默认开：只有
 * 配置里显式 `acceptSlashFromBots: false` 才关。未知 bot（无注册项）→ 默认开
 * （与其它 default-on 开关一致，缺配置不 fail-closed 成"全拒"）。
 */
export function botAcceptsSlashFromBots(larkAppId: string): boolean {
  return bots.get(larkAppId)?.config.acceptSlashFromBots !== false;
}

/**
 * Load bot configurations from one of (in priority order):
 * 1. BOTS_CONFIG env var — path to a JSON file
 * 2. ~/.botmux/bots.json — default config path
 * 3. Core-only (BOTMUX_CORE_ONLY=1) with NEITHER of the above present:
 *    synthesize a single apiOnly bot from env — no bots.json / no Feishu creds
 *    (riff's in-sandbox headless service).
 */
export function loadBotConfigs(): BotConfig[] {
  const synthetic = maybeSynthesizeCoreOnlyConfig();
  if (synthetic) return synthetic;
  return parseBotConfigFile(resolveBotConfigPath());
}

/**
 * Core-only headless config: when BOTMUX_CORE_ONLY=1, synthesize ONE apiOnly bot
 * from env so the daemon boots with zero Feishu credentials and no on-disk config.
 *
 * Core-only is AUTHORITATIVE about identity and IGNORES all ambient config inputs
 * — both ~/.botmux/bots.json AND the BOTS_CONFIG env (codex P1-2). Otherwise a
 * core-only service started on a host that happens to have a real fleet config —
 * or with an inherited/leaked BOTS_CONFIG — would silently boot a REAL,
 * transport-enabled Feishu bot (WSClient, real credentials, `--bot` ignored)
 * instead of the headless apiOnly one, the exact opposite of "no Feishu". There
 * is deliberately NO file-based override in this mode: the identity is exactly the
 * one synthesized here (frozen: apiOnly, `local_<slug>`, no secret). Returns null
 * only when not in core-only mode.
 *
 * The synthesized `loadedConfigPath` is pinned to the DEFAULT ~/.botmux/bots.json
 * path (even though the file is absent/ignored) so the no-transport fs-policy sees
 * the config as living INSIDE the default botmux authority root — never an external
 * path or a carve-out, which would trip buildFsPolicy's fail-closed checks.
 */
function maybeSynthesizeCoreOnlyConfig(): BotConfig[] | null {
  if (process.env.BOTMUX_CORE_ONLY !== '1') return null;

  const larkAppId = process.env.BOTMUX_API_ONLY_BOT || 'local_riff';
  if (!/^local_[A-Za-z0-9._-]+$/.test(larkAppId)) {
    throw new Error(
      `Core-only BOTMUX_API_ONLY_BOT must match local_<slug> (letters/digits/._-), got: ${larkAppId}`,
    );
  }
  const cliId = process.env.BOTMUX_CORE_CLI || 'codex-app';
  const entry: Record<string, unknown> = { larkAppId, apiOnly: true, cliId };
  if (process.env.BOTMUX_CORE_WORKING_DIR) entry.workingDir = process.env.BOTMUX_CORE_WORKING_DIR;
  if (process.env.BOTMUX_CORE_MODEL) entry.model = process.env.BOTMUX_CORE_MODEL;
  // Route through the normal parser so the synthesized entry gets identical
  // validation + normalization as a file-loaded one (apiOnly secret exemption,
  // cliId check, defaults). Pin loadedConfigPath to the default in-root path.
  const configs = parseBotConfigsFromText(JSON.stringify([entry]));
  loadedConfigPath = resolve(resolveBotmuxConfigDir(), 'bots.json');
  // SYNTHETIC, emphatically not 'loaded': nothing was parsed from that path (it
  // is ignored by design here and may not exist). Recording this keeps the
  // placeholder from being propagated to CLI children as a registry authority —
  // the fs-policy still gets the in-root path it needs.
  loadedConfigProvenance = 'synthetic';
  return configs;
}

function resolveBotConfigPath(): string {
  // 1. BOTS_CONFIG env var — an EXACT file, and the top of the chain. For a
  //    daemon-spawned CLI child this is the path the daemon pinned (its own
  //    getLoadedConfigPath), which is what makes child and daemon agree under a
  //    non-default HOME. See core/config-dir.ts for the full rationale.
  const botsConfigPath = process.env.BOTS_CONFIG;
  if (botsConfigPath) {
    const resolved = resolve(botsConfigPath);
    if (!existsSync(resolved)) {
      // FAIL CLOSED, and deliberately so. For a daemon-spawned CLI child this
      // path is the registry the daemon actually parsed (pinned by spawnCli), so
      // "it is gone now" must NOT degrade into "resolve my own HOME's default
      // bots.json" — under a multi-fleet non-default HOME that default is a
      // DIFFERENT fleet's registry, and quietly switching authority would run
      // this bot against another fleet's secret and routing. Losing the file is
      // an operator-visible fault; changing registries behind their back is worse.
      throw new Error(
        `BOTS_CONFIG file not found: ${resolved}`
        + ` — refusing to fall back to a different registry.`
        + ` (For a botmux-spawned CLI this is the exact bots.json the daemon loaded;`
        + ` if it was moved or unmounted, restore it or restart the daemon.)`,
      );
    }
    loadedConfigPath = resolved;
    loadedConfigProvenance = 'loaded';
    return resolved;
  }

  // 2. <config dir>/bots.json (i.e. os.homedir()/.botmux/bots.json)
  const defaultPath = resolveBotsConfigFile();
  if (existsSync(defaultPath)) {
    loadedConfigPath = defaultPath;
    loadedConfigProvenance = 'loaded';
    return defaultPath;
  }

  throw new Error(
    'No bot configuration found. Set BOTS_CONFIG or create ~/.botmux/bots.json.\nSee README for config format.'
  );
}

/**
 * Resolve one daemon's exact raw bots.json slot without compacting earlier
 * activation-pending entries. PM2 assigns BOTMUX_BOT_INDEX from the durable
 * array index; filtering the array first would make a later ready bot load a
 * different App whenever concurrent onboarding left an earlier slot pending.
 */
export function loadBotConfigAtIndex(index: number): BotConfig {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid bot config index: ${index}`);
  }
  const filePath = resolveBotConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Invalid JSON in bot config file (file: ${filePath}): ${err?.message ?? String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Bot config file must contain a JSON array (file: ${filePath})`);
  }
  const entry = parsed[index];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Bot config [${index}] does not exist (file: ${filePath})`);
  }
  if ((entry as Record<string, unknown>).activationPending === true) {
    throw new Error(`Bot config [${index}] activation pending (file: ${filePath})`);
  }
  if ((entry as Record<string, unknown>).activationDeactivating !== undefined) {
    throw new Error(`Bot config [${index}] activation pending (file: ${filePath})`);
  }
  const activationStarting = (entry as Record<string, unknown>).activationStarting;
  const activationCommitted = (entry as Record<string, unknown>).activationCommitted;
  if (activationStarting !== undefined && activationCommitted !== undefined) {
    throw new Error(`Bot config [${index}] has conflicting managed activation markers (file: ${filePath})`);
  }
  const managedActivation = activationStarting ?? activationCommitted;
  if (managedActivation !== undefined) {
    if (
      !managedActivation
      || typeof managedActivation !== 'object'
      || Array.isArray(managedActivation)
      || typeof (managedActivation as Record<string, unknown>).appId !== 'string'
      || (managedActivation as Record<string, unknown>).appId !== (entry as Record<string, unknown>).larkAppId
      || typeof (managedActivation as Record<string, unknown>).jobId !== 'string'
      || !(managedActivation as Record<string, unknown>).jobId
    ) {
      throw new Error(`Bot config [${index}] has an invalid managed activation marker (file: ${filePath})`);
    }
    if (process.env.BOTMUX_MANAGED_ACTIVATION_APP_ID !== (entry as Record<string, unknown>).larkAppId) {
      throw new Error(`Bot config [${index}] activation pending (file: ${filePath})`);
    }
    if (
      process.env.BOTMUX_MANAGED_ACTIVATION_JOB_ID
      !== (managedActivation as Record<string, unknown>).jobId
    ) {
      throw new Error(`Bot config [${index}] activation pending (file: ${filePath})`);
    }
  }
  const entryForDaemon = { ...(entry as Record<string, unknown>) };
  delete entryForDaemon.activationStarting;
  delete entryForDaemon.activationCommitted;
  const exact = parseBotConfigsFromText(JSON.stringify([entryForDaemon]));
  if (exact.length !== 1) {
    throw new Error(`Bot config [${index}] could not be resolved exactly (file: ${filePath})`);
  }
  return exact[0];
}

/**
 * Direct managed activation daemons are allowed to boot only while their
 * exact raw config row carries a matching startup marker. They wait before
 * registering until the dashboard records the exact PM2 identity ACK.
 */
export function isManagedActivationStartingAtIndex(
  index: number,
  appId: string,
  jobId: string,
): boolean {
  if (!Number.isInteger(index) || index < 0 || !appId || !jobId) {
    throw new Error('Invalid managed activation lookup');
  }
  const filePath = resolveBotConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Invalid JSON in bot config file (file: ${filePath}): ${err?.message ?? String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Bot config file must contain a JSON array (file: ${filePath})`);
  }
  const entry = parsed[index];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Bot config [${index}] does not exist (file: ${filePath})`);
  }
  const record = entry as Record<string, unknown>;
  const marker = record.activationStarting;
  if (marker === undefined) return false;
  if (
    record.activationPending === true
    || !marker
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || record.larkAppId !== appId
    || (marker as Record<string, unknown>).appId !== appId
    || typeof (marker as Record<string, unknown>).jobId !== 'string'
    || (marker as Record<string, unknown>).jobId !== jobId
  ) {
    throw new Error(`Bot config [${index}] managed activation marker drifted (file: ${filePath})`);
  }
  return true;
}

function parseBotConfigFile(filePath: string): BotConfig[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    // A sandboxed CLI is denied bots.json ON PURPOSE (it holds every sibling's
    // secret). Seatbelt allows the METADATA read but denies the CONTENT read, so
    // resolveBotConfigPath()'s existsSync() passes and we land here with
    // EPERM/EACCES — the "no config file" branch that would have degraded
    // gracefully is never reached. Callers then die with a raw
    // `EPERM … open '~/.botmux/bots.json'`, which is why EVERY botmux subcommand
    // (not just send) breaks inside the sandbox.
    //
    // Under isolation the bot's identity comes from registerSelfFromCredFile()
    // instead, so "disk gave us nothing" is the correct, complete answer here.
    //
    // Outside isolation an unreadable bots.json is a REAL fault and must still
    // throw: swallowing it would silently boot a zero-bot process (no bots
    // respond, no error anywhere) — strictly worse than crashing loudly.
    if ((err?.code === 'EPERM' || err?.code === 'EACCES') && underReadIsolation()) return [];
    throw err;
  }
  try {
    return parseBotConfigsFromText(raw);
  } catch (err: any) {
    // Preserve the file path in JSON-parse / shape errors for easier debugging.
    throw new Error(`${err?.message ?? err} (file: ${filePath})`);
  }
}

/** Pure parser: bots.json text → BotConfig[]. Exported for testing & reuse. */
export function parseBotConfigsFromText(jsonText: string): BotConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Invalid JSON in bot config file`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Bot config file must contain a JSON array`);
  }

  const configs: BotConfig[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry.larkAppId || typeof entry.larkAppId !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppId is required and must be a string`);
    }
    // Validate the `mojo` block through the SHARED normalizer, so a hand-edited
    // bots.json is held to exactly the same rules as `/config set mojo`.
    //
    // Fail CLOSED, and on types as well as names: `localDaemon: "false"` used to
    // satisfy the sandbox check's `!== true` (bypassing local isolation) while
    // being truthy in buildEnv (enabling host execution) — isolation off AND
    // local execution on. A typo like `cluod: true` would likewise leave the
    // cloud sandbox silently disabled.
    if (entry.mojo !== undefined) {
      const normalized = normalizeMojoConfig(entry.mojo);
      if (!normalized.ok) {
        throw new Error(`Bot config [${i}]: ${normalized.errors.join('; ')}`);
      }
    }
    // apiOnly (core-only) bots drive purely over the HTTP control API and never
    // connect to Feishu, so a real app secret is not required. larkAppId is still
    // mandatory (daemon identity + dashboard routing + cachedLarkAppId gate); use
    // a synthetic local id like `local_<slug>`. Normal Feishu bots keep the hard
    // requirement — a missing secret there is a misconfig, not a headless bot.
    // The rule for apiOnly is "may be omitted; if present it must still be a
    // string" — a number/object/array/false must NOT slip into a string field.
    if (entry.apiOnly === true) {
      if (entry.larkAppSecret !== undefined && typeof entry.larkAppSecret !== 'string') {
        throw new Error(`Bot config [${i}]: larkAppSecret must be a string when provided (apiOnly bots may omit it)`);
      }
    } else if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppSecret is required and must be a string`);
    }
    // MOSA-managed onboarding persists the exact App/secret/owner binding so
    // the same App can resume permission recovery, but a daemon must not load
    // it before the recovery job has read back every critical scope.
    if (
      entry.activationPending === true
      || entry.activationDeactivating !== undefined
      || entry.activationStarting !== undefined
      || entry.activationCommitted !== undefined
    ) {
      continue;
    }

    // cliRuntime is the canonical successor to cliPathOverride. New writers
    // also persist an exactly-equal path shadow so a rollback to an older
    // BotMux still launches the same distribution. Any unequal pair would make
    // old and new versions disagree, so it fails closed below.
    const entryCliId = entry.cliId ?? LEGACY_DEFAULT_CLI_ID;
    if (entry.cliRuntime !== undefined && entryCliId !== 'codex') {
      throw new Error(`Bot config [${i}]: cliRuntime is currently supported only for cliId "codex"`);
    }
    if (entry.cliRuntime !== undefined && typeof entry.wrapperCli === 'string' && entry.wrapperCli.trim()) {
      throw new Error(`Bot config [${i}]: cliRuntime cannot be combined with wrapperCli`);
    }
    const cliRuntime = entry.cliRuntime === undefined
      ? undefined
      : normalizeCliRuntimeConfig(entry.cliRuntime, `Bot config [${i}].cliRuntime`);
    if (cliRuntime && entry.cliPathOverride === undefined) {
      throw new Error(`Bot config [${i}]: cliPathOverride is required as an exact downgrade shadow of cliRuntime.executable`);
    }
    if (cliRuntime && entry.cliPathOverride !== cliRuntime.executable) {
      throw new Error(`Bot config [${i}]: cliPathOverride must exactly match cliRuntime.executable`);
    }
    const existingAppServer = normalizeExistingAppServerConfig(
      entry.existingAppServer,
      `Bot config [${i}].existingAppServer`,
    );
    const codexBrowser = normalizeCodexBrowserConfig(
      entry.codexBrowser,
      `Bot config [${i}].codexBrowser`,
    );
    if (codexBrowser) {
      if (entryCliId !== 'codex-app') {
        throw new Error(`Bot config [${i}]: codexBrowser is supported only for cliId "codex-app"`);
      }
      if (existingAppServer) {
        throw new Error(`Bot config [${i}]: codexBrowser cannot be combined with existingAppServer`);
      }
      if (entry.sandbox === true || entry.readIsolation === true) {
        throw new Error(`Bot config [${i}]: codexBrowser cannot be combined with sandbox or readIsolation`);
      }
    }
    if (existingAppServer) {
      if (entryCliId !== 'codex' && entryCliId !== 'codex-app') {
        throw new Error(`Bot config [${i}]: existingAppServer is supported only for cliId "codex" or "codex-app"`);
      }
      if (entry.codexRpcInput === true) {
        throw new Error(`Bot config [${i}]: existingAppServer cannot be combined with codexRpcInput`);
      }
      if (typeof entry.wrapperCli === 'string' && entry.wrapperCli.trim()) {
        throw new Error(`Bot config [${i}]: existingAppServer cannot be combined with wrapperCli`);
      }
      if (entry.sandbox === true || entry.readIsolation === true) {
        throw new Error(`Bot config [${i}]: existingAppServer cannot be combined with sandbox or readIsolation`);
      }
    }

    // Parse workingDirs from comma-separated workingDir if workingDirs not explicitly set
    let workingDirs = entry.workingDirs;
    if (!workingDirs && entry.workingDir) {
      workingDirs = String(entry.workingDir).split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    let oncallChats: OncallChat[] | undefined;
    if (Array.isArray(entry.oncallChats)) {
      oncallChats = entry.oncallChats
        .filter((c: any) => c && typeof c.chatId === 'string' && typeof c.workingDir === 'string')
        .map((c: any) => ({
          chatId: c.chatId,
          workingDir: c.workingDir,
        }));
    }

    let allowedChatGroups: string[] | undefined;
    if (Array.isArray(entry.allowedChatGroups)) {
      allowedChatGroups = entry.allowedChatGroups
        .filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x: string) => x.trim());
    }

    // defaultOncall: per-bot default for auto-binding new group chats.
    // Tolerate missing fields: an entry with `enabled:true` but no workingDir
    // is treated as disabled (dashboard PUT enforces workingDir on save, but
    // hand-edited bots.json could be inconsistent — never crash on parse).
    let defaultOncall: BotDefaultOncall | undefined;
    const rawDefault = entry.defaultOncall;
    if (rawDefault && typeof rawDefault === 'object') {
      const enabled = rawDefault.enabled === true;
      const workingDir = typeof rawDefault.workingDir === 'string' ? rawDefault.workingDir : '';
      const since = typeof rawDefault.since === 'number' && Number.isFinite(rawDefault.since)
        ? rawDefault.since
        : 0;
      defaultOncall = { enabled: enabled && !!workingDir, workingDir, since };
    }

    let defaultOncallAutoboundChats: string[] | undefined;
    if (Array.isArray(entry.defaultOncallAutoboundChats)) {
      defaultOncallAutoboundChats = entry.defaultOncallAutoboundChats
        .filter((x: any): x is string => typeof x === 'string');
    }

    // Shared normalizer (with substitute-mode-store): keeps a disabled config's
    // target list so the dashboard toggle can flip without re-entering everyone;
    // only an enabled-but-unmatchable config collapses to undefined.
    const substituteMode: SubstituteModeConfig | undefined = normalizeSubstituteMode(entry.substituteMode);

    // chatReplyModes：只保留每群显式设置，非法值丢弃。四态 chat｜chat-topic｜
    // new-topic｜shared 都保留解析；写入路径会删除「与 per-bot 默认相同」的条目
    // 以保持 bots.json 干净（见 chat-reply-mode-store.setChatReplyMode）。
    let chatReplyModes: { [chatId: string]: ChatReplyMode } | undefined;
    if (entry.chatReplyModes && typeof entry.chatReplyModes === 'object' && !Array.isArray(entry.chatReplyModes)) {
      const out: { [chatId: string]: ChatReplyMode } = {};
      for (const [cid, mode] of Object.entries(entry.chatReplyModes)) {
        if (typeof cid !== 'string' || !cid.trim()) continue;
        const normalizedMode = normalizeChatReplyModeConfig(mode);
        if (normalizedMode) out[cid] = normalizedMode;
      }
      if (Object.keys(out).length > 0) chatReplyModes = out;
    }

    // chatMentionModes：只保留每群显式设置，非法值丢弃。四态 always｜topic｜
    // never｜ambient 都保留解析；写入路径会删除「与 per-bot 默认相同」的条目
    // 以保持 bots.json 干净（见 chat-reply-mode-store.setChatMentionMode）。
    let chatMentionModes: { [chatId: string]: GroupMentionMode } | undefined;
    if (entry.chatMentionModes && typeof entry.chatMentionModes === 'object' && !Array.isArray(entry.chatMentionModes)) {
      const out: { [chatId: string]: GroupMentionMode } = {};
      for (const [cid, mode] of Object.entries(entry.chatMentionModes)) {
        if (typeof cid !== 'string' || !cid.trim()) continue;
        const normalizedMode = normalizeGroupMentionModeConfig(mode);
        if (normalizedMode) out[cid] = normalizedMode;
      }
      if (Object.keys(out).length > 0) chatMentionModes = out;
    }

    // chatGrants：只保留 { [chatId:string]: string[] }，逐项校验 typeof === 'string'，
    // 丢弃空列表。未配置或全部非法 → undefined。
    let chatGrants: { [chatId: string]: string[] } | undefined;
    if (entry.chatGrants && typeof entry.chatGrants === 'object' && !Array.isArray(entry.chatGrants)) {
      const out: { [chatId: string]: string[] } = {};
      for (const [cid, arr] of Object.entries(entry.chatGrants)) {
        if (!Array.isArray(arr)) continue;
        const ids = (arr as any[]).filter((x): x is string => typeof x === 'string');
        if (ids.length > 0) out[cid] = ids;
      }
      if (Object.keys(out).length > 0) chatGrants = out;
    }

    // globalGrants：只保留非空 string[]（open_id 列表），逐项校验 typeof === 'string'。
    // 未配置或全部非法 → undefined。
    let globalGrants: string[] | undefined;
    if (Array.isArray(entry.globalGrants)) {
      const ids = (entry.globalGrants as any[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (ids.length > 0) globalGrants = ids;
    }

    // messageQuota.defaultLimit：仅保留正整数；非法/缺省 → undefined（卡片用产品默认 3 条）。
    let messageQuota: { defaultLimit?: number } | undefined;
    const rawMq = entry.messageQuota;
    if (rawMq && typeof rawMq === 'object' && !Array.isArray(rawMq)) {
      const d = rawMq.defaultLimit;
      if (typeof d === 'number' && Number.isInteger(d) && d > 0) messageQuota = { defaultLimit: d };
    }

    // 新授权默认有效期：只接受授权卡已有的四个有限选项；非法/缺省回落产品默认 1 小时。
    const grantDefaultDurationMs = isGrantDurationOption(entry.grantDefaultDurationMs)
      ? entry.grantDefaultDurationMs
      : undefined;

    // quotaState：scope-aware 计数。逐项校验 key 形如 `chat:*:*` / `global:*`，
    // value 为 { limit, used } 正整数（used 允许 0）。非法项丢弃；全空 → undefined。
    let quotaState: { [k: string]: { limit: number; used: number } } | undefined;
    if (entry.quotaState && typeof entry.quotaState === 'object' && !Array.isArray(entry.quotaState)) {
      const out: { [k: string]: { limit: number; used: number } } = {};
      for (const [k, v] of Object.entries(entry.quotaState)) {
        if (!/^(chat:.+:.+|global:.+)$/.test(k)) continue;
        if (!v || typeof v !== 'object') continue;
        const limit = (v as any).limit, used = (v as any).used;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) continue;
        if (typeof used !== 'number' || !Number.isInteger(used) || used < 0) continue;
        out[k] = { limit, used };
      }
      if (Object.keys(out).length > 0) quotaState = out;
    }

    let grantExpiryState: { [k: string]: { expiresAt: number } } | undefined;
    if (entry.grantExpiryState && typeof entry.grantExpiryState === 'object' && !Array.isArray(entry.grantExpiryState)) {
      const out: { [k: string]: { expiresAt: number } } = {};
      for (const [k, v] of Object.entries(entry.grantExpiryState)) {
        if (!/^(chat:.+:.+|global:.+)$/.test(k)) continue;
        if (!v || typeof v !== 'object') continue;
        const expiresAt = (v as any).expiresAt;
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;
        out[k] = { expiresAt };
      }
      if (Object.keys(out).length > 0) grantExpiryState = out;
    }

    // customPassthroughCommands：用户额外放行透传的 slash 命令。归一化：转小写、
    // 自动补前导 `/`、按 /^\/[a-z0-9][a-z0-9:_-]*$/ 过滤、去重。非法/缺省 → undefined。
    // 注意：与 daemon 命令的冲突过滤放在 resolvePassthroughCommands（运行时合并）做，
    // 这里只保证条目本身格式合法，避免在解析期耦合 command-handler 的命令清单。
    let customPassthroughCommands: string[] | undefined;
    if (Array.isArray(entry.customPassthroughCommands)) {
      const normalized = entry.customPassthroughCommands
        .filter((x: any): x is string => typeof x === 'string')
        .map((x: string) => x.trim().toLowerCase())
        .map((x: string) => (x.startsWith('/') ? x : `/${x}`))
        .filter((x: string) => /^\/[a-z0-9][a-z0-9:_-]*$/.test(x));
      const uniq = [...new Set<string>(normalized)];
      if (uniq.length > 0) customPassthroughCommands = uniq;
    }

    // canTalkDaemonCommands：daemon 命令的权限例外名单（canOperate → canTalk）。
    // 归一化同 customPassthroughCommands（小写、补 `/`、去重），但语义相反——
    // **只接受 DAEMON_COMMANDS 内的命令**（这里列的是 daemon 自己处理的命令，
    // 不是透传）；不在集合内的条目（passthrough、拼错的）丢弃并 warn——丢弃是
    // fail-closed 安全的，但静默会让配错的 owner 以为已生效。
    let canTalkDaemonCommands: string[] | undefined;
    if (Array.isArray(entry.canTalkDaemonCommands)) {
      const strs = entry.canTalkDaemonCommands
        .filter((x: any): x is string => typeof x === 'string')
        .map((x: string) => x.trim().toLowerCase())
        .map((x: string) => (x.startsWith('/') ? x : `/${x}`));
      const dropped = strs.filter((x: string) => !DAEMON_COMMANDS.has(x));
      if (dropped.length > 0) {
        logger.warn(`[bot-registry:${entry.larkAppId}] canTalkDaemonCommands 丢弃非 daemon 命令条目: ${[...new Set(dropped)].join(' ')}（仅接受 daemon 命令，透传命令写 customPassthroughCommands）`);
      }
      const uniq = [...new Set<string>(strs.filter((x: string) => DAEMON_COMMANDS.has(x)))];
      if (uniq.length > 0) canTalkDaemonCommands = uniq;
    }

    // tuiSlashAllow：botmux 通用 slash 注入通道（inject_command，见
    // core/slash-inject.ts）的 CLI 原生命令 allowlist。归一化规则与
    // customPassthroughCommands 同款：转小写、自动补前导 `/`、按
    // /^\/[a-z0-9][a-z0-9:_-]*$/ 过滤非法项、去重。非法/缺省/空 → undefined
    // （= 通用注入关闭，默认拒绝）。/cd 即使写在这里也会被
    // validateSlashInjection 的固定黑名单挡住，这里不重复过滤。
    let tuiSlashAllow: string[] | undefined;
    if (Array.isArray(entry.tuiSlashAllow)) {
      const normalized = entry.tuiSlashAllow
        .filter((x: any): x is string => typeof x === 'string')
        .map((x: string) => x.trim().toLowerCase())
        .map((x: string) => (x.startsWith('/') ? x : `/${x}`))
        .filter((x: string) => /^\/[a-z0-9][a-z0-9:_-]*$/.test(x));
      const uniq = [...new Set<string>(normalized)];
      if (uniq.length > 0) tuiSlashAllow = uniq;
    }

    // startupCommands：开会话后、首条 prompt 前自动敲进 CLI 的 slash 命令行（可带
    // 参数，如 `/effort ultracode`）。归一化：去多余空白、补前导 `/`、去重；空 →
    // undefined（与 customPassthroughCommands 同款"不写空数组保持干净"）。
    const startupCommandsList = normalizeStartupCommandList(entry.startupCommands);
    const startupCommands = startupCommandsList.length > 0 ? startupCommandsList : undefined;

    // env：per-bot 环境变量（如代理 / 第三方服务商端点 ANTHROPIC_BASE_URL+AUTH_TOKEN）。
    // sanitizePerBotEnv 过滤非法/保留键、字符串化基本类型；空 → undefined（保持 bots.json 干净）。
    const sanitizedEnv = sanitizePerBotEnv(entry.env);
    const env = Object.keys(sanitizedEnv).length > 0 ? sanitizedEnv : undefined;

    const normalizedReplyStyle = normalizeReplyStyleConfig(entry.replyStyle);
    for (const warning of normalizedReplyStyle.warnings) {
      logger.warn(`[bot-registry:${entry.larkAppId}] ${warning}`);
    }

    const skills = readBotSkillPolicy(entry.skills);
    // Presence is semantic for plugins: [] is an exact "none" override, while
    // an absent field inherits the machine defaults.
    const plugins = Array.isArray(entry.plugins)
      ? normalizePluginIdList(entry.plugins) ?? []
      : undefined;
    const summaryRange = normalizeSummaryRange(entry.summaryRange ?? entry.summary);
    const summaryMemory = entry.summaryMemory === true ? true : undefined;
    const summaryMemoryPath = normalizeNonEmptyString(entry.summaryMemoryPath);
    const contentTriggers = normalizeContentTriggers(entry.contentTriggers, i);
    const messageListeners = normalizeMessageListeners(entry.messageListeners, i);
    const vcMeetingAgent = normalizeVcMeetingAgentConfig(entry.vcMeetingAgent);

    // voice：per-bot 语音引擎覆盖。结构化保留（engine ∈ sami|openai，sami/openai
    // 为对象，speaker/rate 透传，asr 为对象）；非对象或 engine 非法 → undefined。
    // 深度校验（凭证是否可用 / asr 是否 enabled）在 resolveVoiceConfig /
    // resolveAsrConfig 做，这里只挡明显垃圾。
    let voice: VoiceConfig | undefined;
    const rawVoice = entry.voice;
    if (rawVoice && typeof rawVoice === 'object' && !Array.isArray(rawVoice)) {
      const eng = (rawVoice as any).engine;
      if (eng === undefined || eng === 'sami' || eng === 'openai') {
        const v: VoiceConfig = {};
        if (eng) v.engine = eng;
        if (typeof (rawVoice as any).speaker === 'string') v.speaker = (rawVoice as any).speaker;
        if (typeof (rawVoice as any).rate === 'number') v.rate = (rawVoice as any).rate;
        const s = (rawVoice as any).sami;
        if (s && typeof s === 'object') v.sami = { accessKey: s.accessKey, secretKey: s.secretKey, appkey: s.appkey, tokenUrl: s.tokenUrl, wsUrl: s.wsUrl };
        const o = (rawVoice as any).openai;
        if (o && typeof o === 'object') v.openai = { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model };
        const a = (rawVoice as any).asr;
        if (a && typeof a === 'object') v.asr = {
          enabled: a.enabled === true,
          baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl : undefined,
          apiKey: typeof a.apiKey === 'string' ? a.apiKey : undefined,
          model: typeof a.model === 'string' ? a.model : undefined,
          ...(typeof a.timeoutMs === 'number' ? { timeoutMs: a.timeoutMs } : {}),
          ...(typeof a.language === 'string' ? { language: a.language } : {}),
        };
        if (v.engine || v.sami || v.openai || v.speaker || v.asr) voice = v;
      }
    }

    // pricing：per-bot 定价覆盖。normalizePricingOverrides 做宽松校验，
    // 非法项丢弃，全空返回 undefined。
    const pricing = normalizePricingOverrides(entry.pricing);

    // budget：per-bot 月度预算。parseBudgetConfig 做宽松校验，
    // 非法/缺字段返回 null。
    const budget = parseBudgetConfig(entry.budget);

    configs.push({
      larkAppId: entry.larkAppId,
      // apiOnly bots may omit the secret (never used — no Feishu connection);
      // fall back to '' so downstream env plumbing stays a string. Feishu image
      // upload etc. already degrade gracefully on an empty secret.
      larkAppSecret: entry.larkAppSecret ?? '',
      apiOnly: entry.apiOnly === true || undefined,
      feedback: entry.feedback === undefined
        ? undefined
        : normalizeFeedbackPolicyLayer(entry.feedback),
      chatFeedbackPolicies: entry.chatFeedbackPolicies && typeof entry.chatFeedbackPolicies === 'object' && !Array.isArray(entry.chatFeedbackPolicies)
        ? Object.fromEntries(Object.entries(entry.chatFeedbackPolicies).map(([chatId, layer]) => [chatId, normalizeFeedbackPolicyLayer(layer)]))
        : undefined,
      feedbackWebhooks: normalizeFeedbackWebhookConfig(entry.feedbackWebhooks),
      // brand：只认精确的 'lark'，其余 → undefined（下游 normalizeBrand 当
      // feishu）。feishu 故意存成 undefined，保持旧 bots.json 干净、不写死字段。
      brand: entry.brand === 'lark' ? 'lark' : undefined,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : undefined,
      cliId: entryCliId,
      cliRuntime,
      // Compatibility shadow: writers persist it for downgrade safety and the
      // loader requires an exact match so every accepted config is rollback-safe.
      cliPathOverride: entry.cliPathOverride,
      wrapperCli: typeof entry.wrapperCli === 'string' && entry.wrapperCli.trim()
        ? entry.wrapperCli.trim()
        : undefined,
      launchShell: typeof entry.launchShell === 'string' && entry.launchShell.trim()
        ? entry.launchShell.trim()
        : undefined,
      model: typeof entry.model === 'string' && entry.model.trim()
        ? entry.model.trim()
        : undefined,
      // Positive integer within the arm-able bound only; anything else → undefined
      // (= runner default). See normalizeTurnTimeoutMs / MAX_TURN_TIMEOUT_MS.
      turnTimeoutMs: normalizeTurnTimeoutMs(entry.turnTimeoutMs),
      // dsh-only runtime variant; non-dsh CLIs drop it (same pattern as turnTimeoutMs).
      dshRuntime: entryCliId === 'dsh' ? normalizeDshRuntime(entry.dshRuntime) : undefined,
      reasoningEffort: isConfigurableReasoningCliId(entryCliId)
        && isCodexReasoningEffort(entry.reasoningEffort)
        && cliModelSupportsReasoningEffort(
          entryCliId,
          typeof entry.model === 'string' ? entry.model : undefined,
          entry.reasoningEffort,
        )
        ? entry.reasoningEffort : undefined,
      disableCliBypass: entry.disableCliBypass === true,
      codexAppCleanInput: entry.codexAppCleanInput === true || undefined,
      codexBrowser,
      codexRpcInput: entry.codexRpcInput === true,
      existingAppServer,
      // Missing keeps the historical every-cold-spawn global auth refresh.
      codexAuthSync: entry.codexAuthSync === 'isolated' ? 'isolated' : 'shared',
      sandbox: entry.sandbox === true,
      sandboxPaths: entry.sandboxPaths && typeof entry.sandboxPaths === 'object' && !Array.isArray(entry.sandboxPaths)
        ? {
            readWrite: normalizeStringList(entry.sandboxPaths.readWrite),
            readOnly: normalizeStringList(entry.sandboxPaths.readOnly),
            deny: normalizeStringList(entry.sandboxPaths.deny),
          }
        : undefined,
      sandboxHidePaths: normalizeStringList(entry.sandboxHidePaths),
      sandboxReadonlyPaths: normalizeStringList(entry.sandboxReadonlyPaths),
      sandboxNetwork: typeof entry.sandboxNetwork === 'boolean' ? entry.sandboxNetwork : undefined,
      readIsolation: entry.readIsolation === true,
      readDenyExtraPaths: normalizeStringList(entry.readDenyExtraPaths),
      backendType: entry.backendType,
      riff: entry.riff && typeof entry.riff === 'object' ? entry.riff : undefined,
      mojo: entry.mojo && typeof entry.mojo === 'object' ? entry.mojo : undefined,
      // Positive integer only; ≤0 / non-int / absent → undefined (= no cap).
      maxLiveWorkers: typeof entry.maxLiveWorkers === 'number'
        && Number.isInteger(entry.maxLiveWorkers) && entry.maxLiveWorkers > 0
        ? entry.maxLiveWorkers
        : undefined,
      sessionOwnerReminder: normalizeSessionOwnerReminderConfig(entry.sessionOwnerReminder),
      // Only explicit true persisted (undefined = off), same as restrictGrantCommands.
      overloadAlert: entry.overloadAlert === true || undefined,
      vcMeetingAgent,
      workingDir: workingDirs?.[0] ?? entry.workingDir,
      workingDirs,
      allowedUsers: entry.allowedUsers,
      // Only a well-formed native open_id is trusted; anything else (stray on_/
      // email/garbage) is dropped so the fail-safe recipient can never be a
      // value that itself needs resolving.
      ownerOpenId: typeof entry.ownerOpenId === 'string' && entry.ownerOpenId.startsWith('ou_')
        ? entry.ownerOpenId
        : undefined,
      allowedChatGroups,
      oncallChats,
      defaultOncall,
      defaultOncallAutoboundChats,
      defaultWorkingDir: typeof entry.defaultWorkingDir === 'string' && entry.defaultWorkingDir.trim()
        ? entry.defaultWorkingDir.trim()
        : undefined,
      // Only meaningful alongside defaultWorkingDir (仅默认目录 mode); only explicit
      // true is persisted (undefined = off) so bots.json stays clean.
      defaultWorkingDirAutoWorktree: entry.defaultWorkingDirAutoWorktree === true || undefined,
      chatReplyModes,
      chatMentionModes,
      chatGrants,
      globalGrants,
      // 只落显式 true（undefined = 关），与 restrictGrantCommands 同款，保持 bots.json 干净。
      p2pOpen: entry.p2pOpen === true || undefined,
      messageQuota,
      grantDefaultDurationMs,
      quotaState,
      grantExpiryState,
      restrictGrantCommands: entry.restrictGrantCommands === true || undefined,
      // Default is ON, so only explicit false is meaningful/persisted.
      autoGrantRequestCards: entry.autoGrantRequestCards === false ? false : undefined,
      // Default is ON (accept bot-sent slash), so only explicit false persists.
      acceptSlashFromBots: entry.acceptSlashFromBots === false ? false : undefined,
      customPassthroughCommands,
      canTalkDaemonCommands,
      tuiSlashAllow,
      startupCommands,
      env,
      skills,
      plugins,
      lang: isLocale(entry.lang) ? entry.lang : undefined,
      skillInjection: entry.skillInjection === 'global' || entry.skillInjection === 'prompt' || entry.skillInjection === 'off'
        ? entry.skillInjection : undefined,
      // Preserve '' distinctly from undefined: '' means "brand off", undefined
      // means "use default botmux brand". Don't trim-to-undefined here.
      brandLabel: typeof entry.brandLabel === 'string' ? entry.brandLabel : undefined,
      replyStyle: normalizedReplyStyle.config,
      // Persist only a non-default usage-display mode; 'streaming' (default) and
      // an absent key both mean streaming. Legacy showUsageInCardFooter:false is
      // still honored on read (see normalizeUsageDisplay) but never re-emitted.
      usageDisplay: normalizeUsageDisplay(entry) === DEFAULT_USAGE_DISPLAY
        ? undefined
        : normalizeUsageDisplay(entry),
      disableStreamingCard: entry.disableStreamingCard === true || undefined,
      pinStreamingCard: entry.pinStreamingCard === true || undefined,
      // Default ON: only an explicit false is meaningful/persisted (undefined = on).
      thinkingCard: entry.thinkingCard === false ? false : undefined,
      // Default ON, same convention as thinkingCard: an absent key means the
      // <sender> tag is injected, so existing prompts are unchanged.
      senderTag: entry.senderTag === false ? false : undefined,
      noPinStreamingCardChats: Array.isArray(entry.noPinStreamingCardChats)
        ? (() => {
          const filtered = entry.noPinStreamingCardChats
            .filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0)
            .map((x: string) => x.trim());
          const normalized = Array.from(new Set<string>(filtered));
          return normalized.length > 0 ? normalized : undefined;
        })()
        : undefined,
      noCotChats: Array.isArray(entry.noCotChats)
        ? entry.noCotChats.filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0).map((x: string) => x.trim())
        : undefined,
      silentTurnReactions: entry.silentTurnReactions === true || undefined,
      receivedReactionEmoji: typeof entry.receivedReactionEmoji === 'string' && entry.receivedReactionEmoji.trim()
        ? entry.receivedReactionEmoji.trim() : undefined,
      doneReactionEmoji: typeof entry.doneReactionEmoji === 'string' && entry.doneReactionEmoji.trim()
        ? entry.doneReactionEmoji.trim() : undefined,
      // Default is now 'chat' (flat continuous DM session). Only 'thread' and
      // 'group' are meaningful and persist; 'chat' (and anything else)
      // normalizes to undefined so bots.json stays clean.
      p2pMode: entry.p2pMode === 'thread' ? 'thread' : entry.p2pMode === 'group' ? 'group' : undefined,
      sessionGroup: entry.sessionGroup && typeof entry.sessionGroup === 'object'
        ? entry.sessionGroup as SessionGroupConfig
        : undefined,
      noCardChats: Array.isArray(entry.noCardChats)
        ? entry.noCardChats.filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0).map((x: string) => x.trim())
        : undefined,
      writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true || undefined,
      privateCard: entry.privateCard === true || undefined,
      // Default ON: only an explicit false is meaningful/persisted (undefined = on).
      botToBotSameDir: entry.botToBotSameDir === false ? false : undefined,
      // 平台团队展示默认 ON：只有显式 false 有意义/落盘（undefined = 展示）。
      showInTeam: entry.showInTeam === false ? false : undefined,
      autoStartOnGroupJoin: entry.autoStartOnGroupJoin === true || undefined,
      // Default ON: only an explicit false is meaningful/persisted (undefined = on).
      autoInviteOwnerOnGroupAdd: entry.autoInviteOwnerOnGroupAdd === false ? false : undefined,
      // Preserve the configured prompt verbatim; trim-to-undefined when blank
      // so an empty string doesn't linger in bots.json.
      autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' && entry.autoStartOnGroupJoinPrompt.trim()
        ? entry.autoStartOnGroupJoinPrompt
        : undefined,
      // Preserve the configured seed verbatim; trim-to-undefined when blank
      // so an empty string doesn't linger in bots.json.
      autoStartOnGroupJoinSeed: typeof entry.autoStartOnGroupJoinSeed === 'string' && entry.autoStartOnGroupJoinSeed.trim()
        ? entry.autoStartOnGroupJoinSeed
        : undefined,
      autoStartOnNewTopic: entry.autoStartOnNewTopic === true || undefined,
      // 默认 OFF：只有显式 true 有意义/落盘。开启后 `botmux send --mention`
      // 才能用完整邮箱/手机号等标识 @ 群内任意成员（见 BotConfig 上的说明）。
      allowArbitraryMention: entry.allowArbitraryMention === true || undefined,
      messageListeners,
      worktreeMultiPicker: entry.worktreeMultiPicker === true || undefined,
      // Per-bot regular-group default mode. Default is 'chat-topic' (顶层平铺
      // 连续会话；群内原生话题各自独立会话), so only the NON-default modes
      // ('chat' | 'new-topic' | 'shared') are meaningful and persist; 'chat-topic'
      // and anything else normalize to undefined so bots.json stays clean.
      regularGroupReplyMode: (() => {
        const mode = normalizeChatReplyModeConfig(entry.regularGroupReplyMode);
        return mode === 'chat' || mode === 'new-topic' || mode === 'shared' ? mode : undefined;
      })(),
      // 4-tier @ policy. Only 'topic' | 'never' | 'ambient' are meaningful;
      // 'always' (the default) and anything else normalize to undefined so
      // bots.json stays clean.
      regularGroupMentionMode: entry.regularGroupMentionMode === 'topic'
        || entry.regularGroupMentionMode === 'never'
        || entry.regularGroupMentionMode === 'ambient'
        ? entry.regularGroupMentionMode
        : undefined,
      substituteMode,
      // 文档订阅默认触发范围。只 'all' 有意义；'mention-only'（默认）归一化为
      // undefined 让 bots.json 保持干净。
      docSubscribeDefaultMode: entry.docSubscribeDefaultMode === 'all' ? 'all' : undefined,
      // 文档 → 本地仓库映射。file_token → 绝对路径。
      docRepoMap: entry.docRepoMap && typeof entry.docRepoMap === 'object' && !Array.isArray(entry.docRepoMap)
        ? Object.fromEntries(
            Object.entries(entry.docRepoMap as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string' && v.trim())
              .map(([k, v]) => [k, (v as string).trim()])
          )
        : undefined,
      summaryRange,
      summaryMemory,
      summaryMemoryPath,
      contentTriggers,
      voice,
      pricing,
      budget: budget ?? undefined,
    });
  }

  return configs;
}

function readStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((v) => typeof v === 'string' ? v.trim() : '')
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function readDirectSkillSelectors(raw: unknown): SkillSelector[] | undefined {
  const values = readStringArray(raw);
  if (!values) return undefined;
  // Accept both `skill:<name>` and `pack:<id>` selectors. Malformed values
  // (e.g. `skill:` with an empty body, or unknown prefixes) are dropped so a
  // bot config never carries garbage into the resolver.
  const selectors = values.filter((value): value is SkillSelector => /^(skill|pack):.+$/.test(value));
  return selectors.length > 0 ? selectors : undefined;
}

export function readBotSkillPolicy(raw: unknown): BotSkillPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: BotSkillPolicy = {};
  const include = readDirectSkillSelectors(r.include);
  if (include) out.include = include;
  return Object.keys(out).length > 0 ? out : undefined;
}
