import { createHash } from 'node:crypto';
import type {
  BotConfig,
} from '../bot-registry.js';
import {
  parseBotConfigsFromText,
} from '../bot-registry.js';
import type {
  VcMeetingConsumerConfig,
  VcMeetingConsumerProfileConfig,
} from '../types.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';
import {
  readRawConfig,
  requireConfigPath,
  rmwBotEntry,
} from './config-store.js';
import { isLegacyVcMeetingDefaultConsumerSeedCandidate } from './vc-meeting-consumer-profile-bootstrap.js';

export type VcMeetingConsumerProfileFieldError = {
  path: string;
  message: string;
};

export interface VcMeetingConsumerProfilesSnapshot {
  listenerBotAppId: string;
  revision: string;
  /** Distinguishes a never-initialized catalog from an explicit empty profile
   * catalog and from the still-supported legacy single-agent policy. */
  catalogState: 'uninitialized' | 'explicit_empty' | 'legacy_or_partial' | 'profiles';
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingConsumerProfileConfig[];
  defaultProfileBootstrap?: VcMeetingConsumerConfig['defaultProfileBootstrap'];
  migrationOffer?: 'enable_seeded_minutes_default';
}

export interface UpdateVcMeetingConsumerProfilesInput {
  expectedRevision: string;
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingConsumerProfileConfig[];
}

export type UpdateVcMeetingConsumerProfilesResult =
  | { ok: true; snapshot: VcMeetingConsumerProfilesSnapshot }
  | { ok: false; reason: 'bot_not_in_config' | 'config_conflict' | 'validation_failed' | 'config_unavailable'; fieldErrors?: VcMeetingConsumerProfileFieldError[] };

function canonicalRevision(
  consumer: VcMeetingConsumerConfig | undefined,
  rawConsumer: Record<string, unknown> | undefined,
): string {
  return `sha256:${createHash('sha256')
    // Raw own-property presence is semantic for bootstrap/catalog ownership.
    // Hash the parsed raw object so a concurrent hand edit such as an empty
    // legacy alias cannot normalize away and slip past optimistic concurrency.
    .update(canonicalJson(rawConsumer ?? consumer ?? null), 'utf8')
    .digest('hex')}`;
}

function findBot(configs: readonly BotConfig[], larkAppId: string): BotConfig | undefined {
  return configs.find(config => config.larkAppId === larkAppId);
}

function rawBotEntry(raw: readonly unknown[], larkAppId: string): Record<string, unknown> | undefined {
  return raw.find((value): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).larkAppId === larkAppId);
}

function rawMeetingConsumer(entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const vcAgent = entry?.vcMeetingAgent;
  if (!vcAgent || typeof vcAgent !== 'object' || Array.isArray(vcAgent)) return undefined;
  const consumer = (vcAgent as Record<string, unknown>).meetingConsumer;
  return consumer && typeof consumer === 'object' && !Array.isArray(consumer)
    ? consumer as Record<string, unknown>
    : undefined;
}

function catalogStateFromRaw(
  entry: Record<string, unknown> | undefined,
): VcMeetingConsumerProfilesSnapshot['catalogState'] {
  const consumer = rawMeetingConsumer(entry);
  if (!consumer) return 'uninitialized';
  if (Object.prototype.hasOwnProperty.call(consumer, 'consumerProfiles')) {
    return Array.isArray(consumer.consumerProfiles) && consumer.consumerProfiles.length === 0
      ? 'explicit_empty'
      : 'profiles';
  }
  const legacyOrPartial = [
    'defaultAgentAppId',
    'defaultAgent',
    'agentCandidates',
    'agents',
    'defaultConsumerIds',
    'defaultMode',
  ].some(field => Object.prototype.hasOwnProperty.call(consumer, field))
    || consumer.defaultMode === 'agent';
  return legacyOrPartial ? 'legacy_or_partial' : 'uninitialized';
}

function snapshotFromBot(
  bot: BotConfig,
  entry?: Record<string, unknown>,
): VcMeetingConsumerProfilesSnapshot {
  const consumer = bot.vcMeetingAgent?.meetingConsumer;
  const rawConsumer = rawMeetingConsumer(entry);
  const profiles = consumer?.consumerProfiles ?? [];
  const profileIds = new Set(profiles.map(profile => profile.id));
  const defaultConsumerIds = (consumer?.defaultConsumerIds ?? []).filter(id => profileIds.has(id));
  return {
    listenerBotAppId: bot.larkAppId,
    revision: canonicalRevision(consumer, rawConsumer),
    catalogState: catalogStateFromRaw(entry),
    defaultMode: consumer?.defaultMode === 'agents' && defaultConsumerIds.length > 0
      ? 'agents'
      : 'listenOnly',
    defaultConsumerIds,
    profiles,
    ...(consumer?.defaultProfileBootstrap
      ? { defaultProfileBootstrap: consumer.defaultProfileBootstrap }
      : {}),
    ...(rawConsumer && isLegacyVcMeetingDefaultConsumerSeedCandidate(rawConsumer)
      ? { migrationOffer: 'enable_seeded_minutes_default' as const }
      : {}),
  };
}

function parseConfigs(raw: unknown[]): BotConfig[] {
  return parseBotConfigsFromText(JSON.stringify(raw));
}

function validationError(err: unknown): VcMeetingConsumerProfileFieldError {
  const message = err instanceof Error ? err.message : String(err);
  const pathMatch = message.match(
    /vcMeetingAgent\.meetingConsumer\.(consumerProfiles(?:\[\d+\])?(?:\.[A-Za-z0-9_]+)*(?:\[\d+\])?|defaultConsumerIds(?:\[\d+\])?|defaultMode)/u,
  );
  let path = pathMatch?.[1]?.replace(/^consumerProfiles/u, 'profiles');
  if (path) {
    path = path
      .replace(/\.filter\.activityTypes/u, '.activityTypes')
      .replace(/\.(?:capabilities|ownedSinks)(?:\[\d+\])?$/u, '.permissionPreset');
  } else if (/defaultConsumerIds|defaultMode=agents|selected profiles|selectedConsumerIds/u.test(message)) {
    path = 'defaultConsumerIds';
  } else {
    path = 'profiles';
  }
  return { path, message };
}

function rawProfile(profile: VcMeetingConsumerProfileConfig): Record<string, unknown> {
  return {
    id: profile.id,
    agentAppId: profile.agentAppId,
    ...(profile.label ? { label: profile.label } : {}),
    role: profile.role,
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
    ...(profile.filter ? { filter: profile.filter } : {}),
    responseMode: profile.responseMode,
    capabilities: [...profile.capabilities],
    ...(profile.ownedSinks?.length ? { ownedSinks: [...profile.ownedSinks] } : {}),
  };
}

function applyProfilesToRawEntry(
  entry: Record<string, unknown>,
  input: UpdateVcMeetingConsumerProfilesInput,
): void {
  const vcMeetingAgent = entry.vcMeetingAgent && typeof entry.vcMeetingAgent === 'object' && !Array.isArray(entry.vcMeetingAgent)
    ? entry.vcMeetingAgent as Record<string, unknown>
    : {};
  const meetingConsumer = vcMeetingAgent.meetingConsumer && typeof vcMeetingAgent.meetingConsumer === 'object' && !Array.isArray(vcMeetingAgent.meetingConsumer)
    ? vcMeetingAgent.meetingConsumer as Record<string, unknown>
    : {};
  meetingConsumer.enabled = true;
  meetingConsumer.consumerProfiles = input.profiles.map(rawProfile);
  meetingConsumer.defaultMode = input.defaultMode;
  // Keep the submitted selection byte-for-byte (apart from JSON encoding) until
  // the shared bot-registry parser validates it below. Silently filtering
  // unknown/duplicate ids or downgrading an empty agents default would let the
  // dashboard accept a different policy than the daemon will enforce.
  if (input.defaultConsumerIds.length > 0) {
    meetingConsumer.defaultConsumerIds = [...input.defaultConsumerIds];
  }
  else delete meetingConsumer.defaultConsumerIds;
  // An explicit Dashboard/CLI save transfers ownership to the operator. Do
  // not leave generator provenance behind: future automatic migrations must
  // require both the marker and an unchanged generated fingerprint.
  delete meetingConsumer.defaultProfileBootstrap;
  // Presence of consumerProfiles is the profile-mode discriminator. Remove
  // legacy aliases so they cannot silently revive after an explicit empty save.
  delete meetingConsumer.defaultAgentAppId;
  delete meetingConsumer.defaultAgent;
  delete meetingConsumer.agentCandidates;
  delete meetingConsumer.agents;
  vcMeetingAgent.meetingConsumer = meetingConsumer;
  entry.vcMeetingAgent = vcMeetingAgent;
}

export async function readVcMeetingConsumerProfiles(
  listenerBotAppId: string,
): Promise<VcMeetingConsumerProfilesSnapshot | undefined> {
  const path = requireConfigPath();
  const raw = await readRawConfig(path);
  const bot = findBot(parseConfigs(raw), listenerBotAppId);
  return bot ? snapshotFromBot(bot, rawBotEntry(raw, listenerBotAppId)) : undefined;
}

/**
 * Optimistic, lock-protected replacement of the listener bot's preset catalog.
 * The expected revision is derived from the latest canonical on-disk config,
 * so hand edits and concurrent dashboard tabs cannot overwrite one another.
 */
export async function updateVcMeetingConsumerProfiles(
  listenerBotAppId: string,
  input: UpdateVcMeetingConsumerProfilesInput,
): Promise<UpdateVcMeetingConsumerProfilesResult> {
  try {
    const result = await rmwBotEntry<UpdateVcMeetingConsumerProfilesResult>(listenerBotAppId, (entry, raw) => {
      let current: VcMeetingConsumerProfilesSnapshot;
      try {
        const bot = findBot(parseConfigs(raw), listenerBotAppId);
        if (!bot) return { write: false, result: { ok: false, reason: 'bot_not_in_config' } };
        current = snapshotFromBot(bot, rawBotEntry(raw, listenerBotAppId));
      } catch (err) {
        return {
          write: false,
          result: { ok: false, reason: 'validation_failed', fieldErrors: [validationError(err)] },
        };
      }
      if (current.revision !== input.expectedRevision) {
        return { write: false, result: { ok: false, reason: 'config_conflict' } };
      }
      applyProfilesToRawEntry(entry as Record<string, unknown>, input);
      let updated: VcMeetingConsumerProfilesSnapshot;
      try {
        const bot = findBot(parseConfigs(raw), listenerBotAppId);
        if (!bot) return { write: false, result: { ok: false, reason: 'bot_not_in_config' } };
        updated = snapshotFromBot(bot, rawBotEntry(raw, listenerBotAppId));
      } catch (err) {
        return {
          write: false,
          result: { ok: false, reason: 'validation_failed', fieldErrors: [validationError(err)] },
        };
      }
      return { write: true, result: { ok: true, snapshot: updated } };
    });
    return result.ok ? result.result : { ok: false, reason: 'bot_not_in_config' };
  } catch {
    return { ok: false, reason: 'config_unavailable' };
  }
}
