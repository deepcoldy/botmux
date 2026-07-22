import { BOTMUX_BROWSER_PARTITION } from './constants'
import type { ExecutionHostId } from './execution-host'

export const BOTMUX_PROFILE_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_LOCAL_BOTMUX_PROFILE_ID = 'local-default'
export const DEFAULT_LOCAL_BOTMUX_PROFILE_NAME = 'Personal'
const LEGACY_BOTMUX_BROWSER_SESSION_PARTITION_PREFIX = 'persist:botmux-browser-session-'

export type BotmuxProfileAvatar = {
  kind: 'initials'
  initials: string
  color: 'neutral'
}

export type BotmuxProfileKind = 'local' | 'cloud-linked'

export type BotmuxProfileCloudSummary = {
  cloudProfileId: string
  userId: string
  email: string
  displayName?: string
  activeOrgId?: string
  activeOrgName?: string
  linkedAt: number
}

export type BotmuxCloudOrgSummary = {
  orgId: string
  name: string
  role?: string
}

export type BotmuxCloudCapabilityFlags = Record<string, boolean>

export type BotmuxCloudCapabilities = {
  flags: BotmuxCloudCapabilityFlags
  refreshedAt: number
}

export type BotmuxCloudSessionPersistence = 'none' | 'encrypted' | 'memory-only' | 'dev-plaintext'

export type BotmuxProfileAuthState = 'local' | 'unconfigured' | 'connected' | 'reconnect-required'

export type BotmuxProfileAuthStatus = {
  activeProfileId: string
  configured: boolean
  state: BotmuxProfileAuthState
  persistence: BotmuxCloudSessionPersistence
  cloud?: BotmuxProfileCloudSummary
  organizations?: BotmuxCloudOrgSummary[]
  capabilities?: BotmuxCloudCapabilities
  credentialError?: string
  setupMessage?: string
}

export type BotmuxProfileSummary = {
  id: string
  name: string
  avatar: BotmuxProfileAvatar
  kind: BotmuxProfileKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  cloud?: BotmuxProfileCloudSummary
}

export type BotmuxProfileIndex = {
  schemaVersion: number
  activeProfileId: string
  profiles: BotmuxProfileSummary[]
}

export type BotmuxProfileListState = {
  activeProfileId: string
  profiles: BotmuxProfileSummary[]
}

export type BotmuxProfileListResult = BotmuxProfileListState & {
  // Why: gates the full multi-profile switcher UI; default builds show a
  // single-profile account menu instead.
  multiProfileUi: boolean
}

export type CreateLocalBotmuxProfileArgs = {
  name?: string
}

export type CreateLocalBotmuxProfileResult = BotmuxProfileListState & {
  profile: BotmuxProfileSummary
}

export type CreateCloudLinkedBotmuxProfileArgs = {
  orgId?: string
  name?: string
}

export type SwitchBotmuxProfileArgs = {
  profileId: string
}

export type SwitchBotmuxProfileResult = {
  status: 'already-active' | 'relaunching'
}

export type TransferBotmuxProfileProjectMode = 'move' | 'copy'

export type TransferBotmuxProfileProjectArgs = {
  sourceProfileId: string
  targetProfileId: string
  repoId: string
  mode: TransferBotmuxProfileProjectMode
}

export type FindBotmuxProfileProjectsByPathArgs = {
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  excludeProfileId?: string | null
}

export type BotmuxProfileProjectPresence = {
  profileId: string
  profileName: string
  profileKind: BotmuxProfileKind
  repoId: string
  repoName: string
}

export type FindBotmuxProfileProjectsByPathResult = {
  projects: BotmuxProfileProjectPresence[]
}

export type TransferBotmuxProfileProjectResult =
  | {
      status: 'transferred'
      mode: TransferBotmuxProfileProjectMode
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      targetRepoId: string
      targetProjectId: string | null
      willRelaunch?: boolean
    }
  | {
      status: 'duplicate-target'
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      duplicateRepoId: string
    }

export type ConnectCurrentBotmuxProfileResult =
  | {
      status: 'connected'
      auth: BotmuxProfileAuthStatus
      activeProfileId: string
      profiles: BotmuxProfileSummary[]
    }
  | {
      status: 'unconfigured'
      auth: BotmuxProfileAuthStatus
    }
  | {
      status: 'cancelled'
      auth: BotmuxProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: BotmuxProfileAuthStatus
      error: string
    }

export type CreateCloudLinkedBotmuxProfileResult =
  | {
      status: 'created'
      auth: BotmuxProfileAuthStatus
      activeProfileId: string
      profiles: BotmuxProfileSummary[]
      profile: BotmuxProfileSummary
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: BotmuxProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: BotmuxProfileAuthStatus
      error: string
    }

export type SignOutCurrentBotmuxProfileResult = {
  status: 'signed-out'
  auth: BotmuxProfileAuthStatus
  activeProfileId: string
  profiles: BotmuxProfileSummary[]
}

export type SelectBotmuxProfileOrgArgs = {
  orgId: string
}

export type SelectBotmuxProfileOrgResult =
  | {
      status: 'selected'
      auth: BotmuxProfileAuthStatus
      activeProfileId: string
      profiles: BotmuxProfileSummary[]
    }
  | {
      status: 'unconfigured' | 'reconnect-required'
      auth: BotmuxProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: BotmuxProfileAuthStatus
      error: string
    }

export type RefreshCurrentBotmuxProfileAuthResult =
  | {
      status: 'refreshed'
      auth: BotmuxProfileAuthStatus
      activeProfileId: string
      profiles: BotmuxProfileSummary[]
    }
  | {
      status: 'local' | 'unconfigured' | 'reconnect-required'
      auth: BotmuxProfileAuthStatus
    }
  | {
      status: 'failed'
      auth: BotmuxProfileAuthStatus
      error: string
    }

// Why: organization roles are a fixed server-side enum; the desktop UI mirrors
// exactly these three so role selects can't drift from what the API accepts.
export type BotmuxOrgRole = 'owner' | 'admin' | 'member'

export type BotmuxOrgMember = {
  // Why: null for teammates provisioned server-side who never signed into Botmux;
  // mutation actions are disabled for them since the API keys on a real userId.
  userId: string | null
  email: string
  displayName?: string
  role: BotmuxOrgRole
}

export type BotmuxOrgPendingInvite = {
  email: string
  role: BotmuxOrgRole
  createdAt: number
}

export type BotmuxOrgMembersRoster = {
  members: BotmuxOrgMember[]
  pendingInvites: BotmuxOrgPendingInvite[]
  viewerRole: BotmuxOrgRole
  canManageMembers: boolean
}

export type BotmuxProfileOrgMembersListArgs = {
  orgId: string
}

export type BotmuxProfileOrgMemberInviteArgs = {
  orgId: string
  email: string
  role: BotmuxOrgRole
}

export type BotmuxProfileOrgInviteRevokeArgs = {
  orgId: string
  email: string
}

export type BotmuxProfileOrgMemberChangeRoleArgs = {
  orgId: string
  userId: string
  role: BotmuxOrgRole
}

export type BotmuxProfileOrgMemberRemoveArgs = {
  orgId: string
  userId: string
}

export type BotmuxProfileOrgMembersListResult =
  | { status: 'ok'; roster: BotmuxOrgMembersRoster }
  | { status: 'unconfigured' | 'reconnect-required' }
  | { status: 'failed'; error: string }

export type BotmuxOrgInviteConflictReason = 'already_member' | 'already_invited'
export type BotmuxOrgMutationInvalidReason = 'cannot_change_own_role' | 'cannot_remove_self'

export type BotmuxProfileOrgMemberMutationResult =
  | { status: 'ok' }
  | { status: 'unconfigured' | 'reconnect-required' | 'forbidden' | 'not-found' }
  | { status: 'conflict'; reason: BotmuxOrgInviteConflictReason }
  | { status: 'invalid'; reason: BotmuxOrgMutationInvalidReason }
  | { status: 'failed'; error: string }

export function createDefaultLocalBotmuxProfile(now: number): BotmuxProfileSummary {
  return {
    id: DEFAULT_LOCAL_BOTMUX_PROFILE_ID,
    name: DEFAULT_LOCAL_BOTMUX_PROFILE_NAME,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function profilePartitionHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getBotmuxProfileBrowserPartitionSegment(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'profile'
  return `${safe}-${profilePartitionHash(profileId)}`
}

export function getBotmuxProfileBrowserDefaultPartition(profileId: string): string {
  if (profileId === DEFAULT_LOCAL_BOTMUX_PROFILE_ID) {
    return BOTMUX_BROWSER_PARTITION
  }
  return `persist:botmux-profile-${getBotmuxProfileBrowserPartitionSegment(profileId)}-browser-default`
}

export function getBotmuxProfileBrowserSessionPartition(
  profileId: string,
  browserSessionProfileId: string
): string {
  if (profileId === DEFAULT_LOCAL_BOTMUX_PROFILE_ID) {
    return `${LEGACY_BOTMUX_BROWSER_SESSION_PARTITION_PREFIX}${browserSessionProfileId}`
  }
  return `persist:botmux-profile-${getBotmuxProfileBrowserPartitionSegment(
    profileId
  )}-browser-session-${browserSessionProfileId}`
}
