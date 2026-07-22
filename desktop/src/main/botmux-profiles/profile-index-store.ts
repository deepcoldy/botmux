import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { GlobalSettings } from '../../shared/types'
import {
  createDefaultLocalBotmuxProfile,
  DEFAULT_LOCAL_BOTMUX_PROFILE_ID,
  DEFAULT_LOCAL_BOTMUX_PROFILE_NAME,
  BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
  type CreateLocalBotmuxProfileArgs,
  type CreateLocalBotmuxProfileResult,
  type BotmuxProfileIndex,
  type BotmuxProfileListState,
  type BotmuxProfileSummary
} from '../../shared/botmux-profiles'
import {
  getBotmuxProfileBrowserSessionMetaFile,
  getBotmuxProfileDataFile,
  getBotmuxProfileDirectory,
  getBotmuxProfileIndexPath,
  getProfileUserDataPath,
  LEGACY_BACKUP_COUNT,
  legacyBackupPath,
  legacyBrowserSessionMetaPath,
  legacyDataFilePath,
  profileBackupPath
} from './profile-storage-paths'

export {
  getBotmuxProfileBrowserSessionMetaFile,
  getBotmuxProfileDataFile,
  getBotmuxProfileDirectory,
  getBotmuxProfileIndexPath,
  getBotmuxProfilesDirectory,
  initBotmuxProfilePaths
} from './profile-storage-paths'

export type ActiveBotmuxProfileState = {
  index: BotmuxProfileIndex
  profile: BotmuxProfileSummary
  dataFile: string
  profileDirectory: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProfileSummary(value: unknown): value is BotmuxProfileSummary {
  if (!isObject(value)) {
    return false
  }
  const avatar = value.avatar
  const cloud = value.cloud
  return (
    typeof value.id === 'string' &&
    // Why: IDs from the on-disk index become filesystem path segments; a
    // tampered index must not be able to escape the profiles directory.
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.kind === 'local' || value.kind === 'cloud-linked') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastOpenedAt === 'number' &&
    isObject(avatar) &&
    avatar.kind === 'initials' &&
    typeof avatar.initials === 'string' &&
    avatar.color === 'neutral' &&
    (cloud === undefined || isObject(cloud))
  )
}

function normalizeProfileIndex(raw: unknown): BotmuxProfileIndex | null {
  if (!isObject(raw) || !Array.isArray(raw.profiles)) {
    return null
  }
  const profiles = raw.profiles.filter(isProfileSummary)
  const activeProfileId =
    typeof raw.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === raw.activeProfileId)
      ? raw.activeProfileId
      : profiles[0]?.id
  if (!activeProfileId) {
    return null
  }
  return {
    schemaVersion: BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles
  }
}

function sanitizeProfileName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'New Profile'
}

function readProfileIndexFile(indexPath: string): BotmuxProfileIndex | null {
  try {
    return normalizeProfileIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))
  } catch {
    return null
  }
}

export function readProfileIndex(indexPath: string): BotmuxProfileIndex | null {
  // Why: a torn/corrupt index must not silently reset the app to a single
  // default profile — that would orphan every other profile's data directory.
  return readProfileIndexFile(indexPath) ?? readProfileIndexFile(`${indexPath}.bak`)
}

export function writeProfileIndex(indexPath: string, index: BotmuxProfileIndex): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  // Why: only a still-parseable current index may refresh the backup;
  // copying a corrupt file over the backup would destroy the recovery copy.
  if (existsSync(indexPath) && readProfileIndexFile(indexPath)) {
    try {
      copyFileSync(indexPath, `${indexPath}.bak`)
    } catch {
      // Best-effort backup; the primary write below still proceeds.
    }
  }
  const tmpPath = `${indexPath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8')
  renameSync(tmpPath, indexPath)
}

function copyIfPresent(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) {
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  // Why: tmp+rename so a crash mid-copy cannot leave a truncated target that
  // the exists() guard above would then treat as a completed migration.
  const tmpTarget = `${target}.tmp`
  copyFileSync(source, tmpTarget)
  renameSync(tmpTarget, target)
}

function copyLegacyStateToProfile(userDataPath: string, profileId: string): void {
  const profileDataFile = getBotmuxProfileDataFile(profileId, userDataPath)
  copyIfPresent(legacyDataFilePath(userDataPath), profileDataFile)
  copyIfPresent(
    legacyBrowserSessionMetaPath(userDataPath),
    getBotmuxProfileBrowserSessionMetaFile(profileId, userDataPath)
  )
  for (let i = 0; i < LEGACY_BACKUP_COUNT; i++) {
    copyIfPresent(legacyBackupPath(userDataPath, i), profileBackupPath(profileDataFile, i))
  }
}

// Why: a brand-new profile has no data file, which the telemetry cohort
// migration reads as a fresh install and defaults to opted-in. Copying the
// active profile's consent block keeps an opted-out user opted out (and keeps
// one installId per install) when they create additional profiles.
export function seedNewBotmuxProfileTelemetryConsent(
  profileId: string,
  telemetry: GlobalSettings['telemetry'],
  userDataPath = getProfileUserDataPath()
): void {
  if (!telemetry) {
    return
  }
  const dataFile = getBotmuxProfileDataFile(profileId, userDataPath)
  if (existsSync(dataFile)) {
    return
  }
  mkdirSync(dirname(dataFile), { recursive: true })
  const tmpPath = `${dataFile}.tmp`
  writeFileSync(tmpPath, JSON.stringify({ settings: { telemetry } }, null, 2), 'utf-8')
  renameSync(tmpPath, dataFile)
}

function createInitialProfileIndex(now = Date.now()): BotmuxProfileIndex {
  const profile = createDefaultLocalBotmuxProfile(now)
  return {
    schemaVersion: BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId: profile.id,
    profiles: [profile]
  }
}

export function loadOrCreateProfileIndex(userDataPath: string): BotmuxProfileIndex {
  const indexPath = getBotmuxProfileIndexPath(userDataPath)
  const index = existsSync(indexPath) ? readProfileIndex(indexPath) : null
  if (index) {
    return index
  }
  const nextIndex = createInitialProfileIndex()
  writeProfileIndex(indexPath, nextIndex)
  return nextIndex
}

function getActiveProfile(index: BotmuxProfileIndex): BotmuxProfileSummary {
  return (
    index.profiles.find((profile) => profile.id === index.activeProfileId) ??
    index.profiles[0] ??
    createDefaultLocalBotmuxProfile(Date.now())
  )
}

export function ensureActiveBotmuxProfile(
  userDataPath = getProfileUserDataPath()
): ActiveBotmuxProfileState {
  const indexPath = getBotmuxProfileIndexPath(userDataPath)
  let index = existsSync(indexPath) ? readProfileIndex(indexPath) : null
  let shouldWriteIndex = false

  if (!index) {
    index = createInitialProfileIndex()
    shouldWriteIndex = true
  }

  const activeProfile = getActiveProfile(index)
  if (activeProfile.id !== index.activeProfileId) {
    index = { ...index, activeProfileId: activeProfile.id }
    shouldWriteIndex = true
  }

  const profileDirectory = getBotmuxProfileDirectory(activeProfile.id, userDataPath)
  mkdirSync(profileDirectory, { recursive: true })
  if (activeProfile.id === DEFAULT_LOCAL_BOTMUX_PROFILE_ID) {
    copyLegacyStateToProfile(userDataPath, activeProfile.id)
  }

  if (shouldWriteIndex) {
    writeProfileIndex(indexPath, index)
  }

  return {
    index,
    profile: activeProfile,
    dataFile: getBotmuxProfileDataFile(activeProfile.id, userDataPath),
    profileDirectory
  }
}

export function isDefaultLocalBotmuxProfileId(profileId: string): boolean {
  return profileId === DEFAULT_LOCAL_BOTMUX_PROFILE_ID
}

export function getBotmuxProfileListState(
  userDataPath = getProfileUserDataPath()
): BotmuxProfileListState {
  const { index } = ensureActiveBotmuxProfile(userDataPath)
  return {
    activeProfileId: index.activeProfileId,
    profiles: index.profiles
  }
}

export function createLocalBotmuxProfile(
  args: CreateLocalBotmuxProfileArgs = {},
  userDataPath = getProfileUserDataPath()
): CreateLocalBotmuxProfileResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const name = sanitizeProfileName(args.name)
  const profile: BotmuxProfileSummary = {
    id: `local-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: (
        name.match(/[A-Za-z0-9]/)?.[0] ?? DEFAULT_LOCAL_BOTMUX_PROFILE_NAME[0]
      ).toUpperCase(),
      color: 'neutral'
    },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
  const nextIndex: BotmuxProfileIndex = {
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

export function setActiveBotmuxProfile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): BotmuxProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return {
      ...profile,
      updatedAt: now,
      lastOpenedAt: now
    }
  })
  if (!found) {
    throw new Error('unknown_botmux_profile')
  }
  const nextIndex: BotmuxProfileIndex = {
    ...index,
    activeProfileId: profileId,
    profiles
  }
  mkdirSync(getBotmuxProfileDirectory(profileId, userDataPath), { recursive: true })
  writeProfileIndex(getBotmuxProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
