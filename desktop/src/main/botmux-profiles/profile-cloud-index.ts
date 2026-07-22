import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type {
  BotmuxProfileCloudSummary,
  BotmuxProfileListState,
  BotmuxProfileSummary
} from '../../shared/botmux-profiles'
import {
  getBotmuxProfileDirectory,
  getBotmuxProfileIndexPath,
  loadOrCreateProfileIndex,
  writeProfileIndex
} from './profile-index-store'

export type CreateCloudLinkedBotmuxProfileRecordResult = BotmuxProfileListState & {
  profile: BotmuxProfileSummary
}

function sanitizeProfileName(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return (trimmed || fallback).slice(0, 80)
}

function profileInitial(name: string): string {
  return (name.match(/[A-Za-z0-9]/)?.[0] ?? 'C').toUpperCase()
}

function toCloudLinkedProfile(
  profile: BotmuxProfileSummary,
  cloud: BotmuxProfileCloudSummary,
  now: number
): BotmuxProfileSummary {
  return {
    ...profile,
    kind: 'cloud-linked',
    cloud,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function toLocalProfile(profile: BotmuxProfileSummary, now: number): BotmuxProfileSummary {
  const { cloud: _cloud, ...localProfile } = profile
  return {
    ...localProfile,
    kind: 'local',
    updatedAt: now,
    lastOpenedAt: now
  }
}

export function createCloudLinkedBotmuxProfileRecord(
  cloud: BotmuxProfileCloudSummary,
  args: { name?: string },
  userDataPath: string
): CreateCloudLinkedBotmuxProfileRecordResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const fallbackName = cloud.activeOrgName ?? cloud.displayName ?? cloud.email
  const name = sanitizeProfileName(args.name, fallbackName)
  const profile: BotmuxProfileSummary = {
    id: `cloud-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: profileInitial(name),
      color: 'neutral'
    },
    kind: 'cloud-linked',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    cloud
  }
  const nextIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getBotmuxProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getBotmuxProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

export function linkBotmuxProfileToCloud(
  profileId: string,
  cloud: BotmuxProfileCloudSummary,
  userDataPath: string
): BotmuxProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return toCloudLinkedProfile(profile, cloud, now)
  })
  if (!found) {
    throw new Error('unknown_botmux_profile')
  }
  const nextIndex = {
    ...index,
    profiles
  }
  writeProfileIndex(getBotmuxProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}

export function unlinkBotmuxProfileFromCloud(
  profileId: string,
  userDataPath: string
): BotmuxProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return toLocalProfile(profile, now)
  })
  if (!found) {
    throw new Error('unknown_botmux_profile')
  }
  const nextIndex = {
    ...index,
    profiles
  }
  writeProfileIndex(getBotmuxProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
