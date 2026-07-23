import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { BackendType } from './adapters/backend/types.js';
import type { RiffBackendConfig } from './adapters/backend/riff-backend.js';
import type { CliId } from './adapters/cli/types.js';
import { logger } from './utils/logger.js';
import { isLocale, setBotLookup, type Locale } from './i18n/index.js';
import type { VoiceConfig } from './services/voice/types.js';
import { type Brand, sdkDomain, normalizeBrand } from './im/lark/lark-hosts.js';
import type { BotSkillPolicy, SkillSelector } from './core/skills/types.js';
import { normalizeStartupCommandList } from './core/startup-commands.js';
import { sanitizePerBotEnv } from './core/per-bot-env.js';
import { normalizeSubstituteMode } from './services/substitute-mode-normalize.js';
import { normalizePluginIdList } from './core/plugins/ids.js';
import { normalizeVcMeetingProfileInstructions } from './services/vc-meeting-profile-instructions.js';
import type {
  VcMeetingConsumerAgentConfig,
  VcMeetingConsumerConfig,
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileConfig,
} from './types.js';
import type { VcMeetingActivityType } from './vc-agent/types.js';

export type {
  VcMeetingConsumerAgentConfig,
  VcMeetingConsumerConfig,
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileConfig,
} from './types.js';

export type ChatReplyMode = 'chat' | 'new-topic' | 'shared' | 'chat-topic';
export type ContentTriggerScope = 'topic' | 'regularGroup' | 'both';
export type ContentTriggerMatchType = 'keyword' | 'regex';
export type ContentTriggerActionType = 'start-or-wake-session';

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

function normalizeChatReplyModeConfig(raw: unknown): ChatReplyMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'chat') return 'chat';
  if (v === 'chat-topic' || v === 'chattopic' || v === 'chat_topic') return 'chat-topic';
  if (v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'topic' || v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
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
  if (entry.enabled === true) out.enabled = true;
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

function normalizeVcMeetingConsumerProfiles(raw: unknown): VcMeetingConsumerProfileConfig[] {
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
  if (entry.enabled === true) out.enabled = true;
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

export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
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
   * Per-bot launch-shell override for the persistent backends (tmux/zellij).
   * When set, botmux launches the CLI under this shell instead of the daemon's
   * `$SHELL`. Accepts a bare name (`zsh`/`bash`/`sh`) or an absolute path
   * (`/usr/bin/zsh`). The escape hatch for a login `$SHELL` (e.g. bash) whose
   * rcfile `exec`-trampolines into another shell: that trampoline replaces the
   * launch shell before it can `exec` the CLI, leaving a bare shell the first
   * prompt gets typed into (`zsh: parse error`). Pinning `launchShell: zsh`
   * launches under zsh directly and bypasses the bash `.bashrc`. CAVEAT:
   * PATH/nvm/pnpm shims must then live in the pinned shell's rcfiles (e.g.
   * `.zshrc`/`.zprofile`), not the bypassed one. Ignored by the pty backend
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
   * Codex only (opt-in, experimental): deliver user input via the app-server
   * JSON-RPC channel instead of a tmux paste. The pane runs `codex --remote`
   * attached to a botmux-owned app-server thread, so input can't be dropped by
   * codex's terminal re-init. No effect on non-codex bots.
   */
  codexRpcInput?: boolean;
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
  /** Native Lark VC bot meeting copilot bridge. Push is primary; polling remains gate/backfill. */
  vcMeetingAgent?: VcMeetingAgentConfig;
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
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
   * 消息额度机制（默认关闭）。`defaultLimit` 的"是否配置"本身就是开关：
   *   • 未配置（undefined）→ 关闭：无显式数字的 /grant 仍是"无限授权"（当前行为）。
   *   • 配置正整数 D    → 开启默认额度：`/grant @x`（不带数字）套用 D 条额度。
   * 显式 `/grant @x N` 的 N **恒生效**，与本字段是否配置无关（见 {@link quotaState}）。
   * 仅约束 chatGrants / globalGrants 这类 per-user talk 授权，绝不影响 canOperate。
   */
  messageQuota?: { defaultLimit?: number };
  /**
   * scope-aware 消息额度计数（运行时状态，随授权一起持久化进 bots.json）。
   * key = `chat:${chatId}:${openId}` | `global:${openId}`，value = { limit, used }。
   * 仅在 /grant 带额度（显式数字，或开启 default 时取 default）时建记录；
   * used 达到 limit 后自动收回**对应 scope** 的授权并删除本记录。纯 talk-only。
   */
  quotaState?: { [quotaKey: string]: { limit: number; used: number } };
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
   * botmux slash 可注入的 CLI 原生斜杠命令 allowlist（如 ["/compact","/model"]）。
   * 缺省/空 = 通用注入关闭。/cd 永远被拒（见 core/slash-inject.ts）。
   */
  tuiSlashAllow?: string[];
  /**
   * When true, suppress the live streaming session card entirely. The web
   * terminal still runs and the final answer still arrives via `botmux send`;
   * only the auto-updating status card is never posted/patched. Default
   * (undefined) keeps the streaming card. For users who find the live card noisy.
   */
  disableStreamingCard?: boolean;
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
   * Editable at runtime via `/botconfig p2pMode chat|thread` (owner/admin).
   */
  p2pMode?: 'thread' | 'chat';
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
   * 主动开工 — 场景②. When true, in a 话题群 (topic mode) every new topic's first
   * message auto-starts a session even without an @mention (the default role +
   * the user's first message form the prompt). No effect in regular groups.
   * Default (undefined) = passive.
   */
  autoStartOnNewTopic?: boolean;
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
}

export interface BotState {
  config: BotConfig;
  client: Lark.Client;
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
  oncallChatCache = null;
  brandLabelCache = null;
}

// Wire the i18n lookup so `localeForBot()` can resolve per-bot locale without
// a hard import cycle between `i18n` and `bot-registry`.
setBotLookup((id) => bots.get(id));

/** Path of the bot config file we loaded (so `/oncall` can persist bindings back). */
let loadedConfigPath: string | undefined;
export function getLoadedConfigPath(): string | undefined {
  return loadedConfigPath;
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

export function registerBot(cfg: BotConfig): BotState {
  const client = new Lark.Client({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    // brand → SDK domain。缺省走 feishu，国际版租户走 larksuite.com。
    // 这一行同时修好了所有经由 SDK 的调用（发消息 / 文件 / contact 等）。
    domain: sdkDomain(normalizeBrand(cfg.brand)),
    logger: larkLogger,
  });
  const state: BotState = {
    config: cfg,
    client,
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
  return getBot(larkAppId).client;
}

/** Owner = bot 首个已授权 open_id，与「缺权限警告私信对象」同口径（见 admin 解析）。 */
export function getOwnerOpenId(larkAppId: string): string | undefined {
  return bots.get(larkAppId)?.resolvedAllowedUsers.find(u => u.startsWith('ou_'));
}

/** Admins = all resolved allowedUsers, matching `/botconfig`'s permission model. */
export function getDashboardAdminOpenIds(larkAppId: string): string[] {
  return [...(bots.get(larkAppId)?.resolvedAllowedUsers ?? [])];
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

/** Resolve the bots.json path the same way loadBotConfigs does, without
 *  requiring the registry to have been loaded (works in one-shot CLI processes
 *  like `botmux send`). Returns null when no config file exists. */
function botsConfigDiskPath(): string | null {
  const env = process.env.BOTS_CONFIG;
  if (env) { const r = resolve(env); return existsSync(r) ? r : null; }
  const d = resolve(homedir(), '.botmux', 'bots.json');
  return existsSync(d) ? d : null;
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
 * 只读 accessor：该 bot 配置的 tuiSlashAllow allowlist（TUI 通用 slash 注入用）。
 * 仅读内存态注册表，daemon 进程内使用；无需 bots.json 磁盘回退（不同于
 * resolveBrandLabel——`botmux send` 等一次性 CLI 进程不消费此 accessor）。
 */
export function getBotTuiSlashAllow(larkAppId: string): string[] | undefined {
  return bots.get(larkAppId)?.config.tuiSlashAllow;
}

/**
 * Load bot configurations from one of (in priority order):
 * 1. BOTS_CONFIG env var — path to a JSON file
 * 2. ~/.botmux/bots.json — default config path
 */
export function loadBotConfigs(): BotConfig[] {
  // 1. BOTS_CONFIG env var
  const botsConfigPath = process.env.BOTS_CONFIG;
  if (botsConfigPath) {
    const resolved = resolve(botsConfigPath);
    if (!existsSync(resolved)) {
      throw new Error(`BOTS_CONFIG file not found: ${resolved}`);
    }
    loadedConfigPath = resolved;
    return parseBotConfigFile(resolved);
  }

  // 2. ~/.botmux/bots.json
  const defaultPath = resolve(homedir(), '.botmux', 'bots.json');
  if (existsSync(defaultPath)) {
    loadedConfigPath = defaultPath;
    return parseBotConfigFile(defaultPath);
  }

  throw new Error(
    'No bot configuration found. Set BOTS_CONFIG or create ~/.botmux/bots.json.\nSee README for config format.'
  );
}

function parseBotConfigFile(filePath: string): BotConfig[] {
  const raw = readFileSync(filePath, 'utf-8');
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
    if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppSecret is required and must be a string`);
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

    // messageQuota.defaultLimit：仅保留正整数；非法/缺省 → undefined（= 默认额度关闭）。
    let messageQuota: { defaultLimit?: number } | undefined;
    const rawMq = entry.messageQuota;
    if (rawMq && typeof rawMq === 'object' && !Array.isArray(rawMq)) {
      const d = rawMq.defaultLimit;
      if (typeof d === 'number' && Number.isInteger(d) && d > 0) messageQuota = { defaultLimit: d };
    }

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

    const skills = readBotSkillPolicy(entry.skills);
    // Presence is semantic for plugins: [] is an exact "none" override, while
    // an absent field inherits the machine defaults.
    const plugins = Array.isArray(entry.plugins)
      ? normalizePluginIdList(entry.plugins) ?? []
      : undefined;
    const summaryRange = normalizeSummaryRange(entry.summaryRange ?? entry.summary);
    const contentTriggers = normalizeContentTriggers(entry.contentTriggers, i);
    const vcMeetingAgent = normalizeVcMeetingAgentConfig(entry.vcMeetingAgent);

    // voice：per-bot 语音引擎覆盖。结构化保留（engine ∈ sami|openai，sami/openai
    // 为对象，speaker/rate 透传）；非对象或 engine 非法 → undefined。深度校验
    // （凭证是否可用）在 resolveVoiceConfig 做，这里只挡明显垃圾。
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
        if (v.engine || v.sami || v.openai || v.speaker) voice = v;
      }
    }

    configs.push({
      larkAppId: entry.larkAppId,
      larkAppSecret: entry.larkAppSecret,
      // brand：只认精确的 'lark'，其余 → undefined（下游 normalizeBrand 当
      // feishu）。feishu 故意存成 undefined，保持旧 bots.json 干净、不写死字段。
      brand: entry.brand === 'lark' ? 'lark' : undefined,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : undefined,
      cliId: entry.cliId ?? 'claude-code',
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
      disableCliBypass: entry.disableCliBypass === true,
      codexAppCleanInput: entry.codexAppCleanInput === true || undefined,
      codexRpcInput: entry.codexRpcInput === true,
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
      // Positive integer only; ≤0 / non-int / absent → undefined (= no cap).
      maxLiveWorkers: typeof entry.maxLiveWorkers === 'number'
        && Number.isInteger(entry.maxLiveWorkers) && entry.maxLiveWorkers > 0
        ? entry.maxLiveWorkers
        : undefined,
      vcMeetingAgent,
      workingDir: workingDirs?.[0] ?? entry.workingDir,
      workingDirs,
      allowedUsers: entry.allowedUsers,
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
      chatGrants,
      globalGrants,
      // 只落显式 true（undefined = 关），与 restrictGrantCommands 同款，保持 bots.json 干净。
      p2pOpen: entry.p2pOpen === true || undefined,
      messageQuota,
      quotaState,
      restrictGrantCommands: entry.restrictGrantCommands === true || undefined,
      // Default is ON, so only explicit false is meaningful/persisted.
      autoGrantRequestCards: entry.autoGrantRequestCards === false ? false : undefined,
      customPassthroughCommands,
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
      disableStreamingCard: entry.disableStreamingCard === true || undefined,
      silentTurnReactions: entry.silentTurnReactions === true || undefined,
      receivedReactionEmoji: typeof entry.receivedReactionEmoji === 'string' && entry.receivedReactionEmoji.trim()
        ? entry.receivedReactionEmoji.trim() : undefined,
      doneReactionEmoji: typeof entry.doneReactionEmoji === 'string' && entry.doneReactionEmoji.trim()
        ? entry.doneReactionEmoji.trim() : undefined,
      // Only 'chat' is meaningful; 'thread' (and anything else) normalizes to
      // undefined — the legacy thread-per-message default. Keeps bots.json clean.
      p2pMode: entry.p2pMode === 'chat' ? 'chat' : undefined,
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
      // Preserve the configured prompt verbatim; trim-to-undefined when blank
      // so an empty string doesn't linger in bots.json.
      autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' && entry.autoStartOnGroupJoinPrompt.trim()
        ? entry.autoStartOnGroupJoinPrompt
        : undefined,
      autoStartOnNewTopic: entry.autoStartOnNewTopic === true || undefined,
      worktreeMultiPicker: entry.worktreeMultiPicker === true || undefined,
      // Per-bot regular-group default mode. Only the non-default modes
      // ('chat-topic' | 'new-topic' | 'shared') are meaningful; 'chat' (the flat
      // default) and anything else normalize to undefined so bots.json stays clean.
      regularGroupReplyMode: (() => {
        const mode = normalizeChatReplyModeConfig(entry.regularGroupReplyMode);
        return mode === 'new-topic' || mode === 'shared' || mode === 'chat-topic' ? mode : undefined;
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
      contentTriggers,
      voice,
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
  const selectors = values.filter((value): value is SkillSelector => /^skill:.+$/.test(value));
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
