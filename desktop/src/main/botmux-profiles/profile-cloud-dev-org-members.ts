import type {
  BotmuxOrgMember,
  BotmuxOrgMembersRoster,
  BotmuxOrgPendingInvite,
  BotmuxProfileOrgMemberChangeRoleArgs,
  BotmuxProfileOrgMemberInviteArgs,
  BotmuxProfileOrgMemberMutationResult,
  BotmuxProfileOrgMemberRemoveArgs,
  BotmuxProfileOrgInviteRevokeArgs
} from '../../shared/botmux-profiles'

// Why: dev-auth mode has no server, so the whole teammate UI is exercised
// against this in-memory per-org roster. It mirrors the shape the real client
// returns (self as owner, one signed-in teammate, one never-signed-in teammate,
// one pending invite) and the mutation endpoints' status semantics.
type DevOrgRoster = {
  members: BotmuxOrgMember[]
  pendingInvites: BotmuxOrgPendingInvite[]
}

const devRostersByOrg = new Map<string, DevOrgRoster>()

function cleanEnvString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function devSelf(): BotmuxOrgMember {
  return {
    userId: cleanEnvString(process.env.BOTMUX_CLOUD_DEV_USER_ID, 'dev-user'),
    email: cleanEnvString(process.env.BOTMUX_CLOUD_DEV_EMAIL, 'dev@botmux.local'),
    displayName: cleanEnvString(process.env.BOTMUX_CLOUD_DEV_DISPLAY_NAME, 'Botmux Dev'),
    role: 'owner'
  }
}

function seedDevRoster(): DevOrgRoster {
  return {
    members: [
      devSelf(),
      {
        userId: 'dev-teammate-1',
        email: 'teammate@botmux.local',
        displayName: 'Dev Teammate',
        role: 'admin'
      },
      // Why: userId null exercises the "hasn't signed in to Botmux yet" disabled row.
      { userId: null, email: 'invited-member@botmux.local', displayName: undefined, role: 'member' }
    ],
    pendingInvites: [{ email: 'pending@botmux.local', role: 'member', createdAt: Date.now() }]
  }
}

function getDevRoster(orgId: string): DevOrgRoster {
  const existing = devRostersByOrg.get(orgId)
  if (existing) {
    return existing
  }
  const seeded = seedDevRoster()
  devRostersByOrg.set(orgId, seeded)
  return seeded
}

export function listDevBotmuxCloudOrgMembers(orgId: string): BotmuxOrgMembersRoster {
  const roster = getDevRoster(orgId)
  return {
    members: roster.members.map((member) => ({ ...member })),
    pendingInvites: roster.pendingInvites.map((invite) => ({ ...invite })),
    viewerRole: 'owner',
    canManageMembers: true
  }
}

export function inviteDevBotmuxCloudOrgMember(
  args: BotmuxProfileOrgMemberInviteArgs
): BotmuxProfileOrgMemberMutationResult {
  const roster = getDevRoster(args.orgId)
  const email = args.email.toLowerCase()
  if (roster.members.some((member) => member.email.toLowerCase() === email)) {
    return { status: 'conflict', reason: 'already_member' }
  }
  if (roster.pendingInvites.some((invite) => invite.email.toLowerCase() === email)) {
    return { status: 'conflict', reason: 'already_invited' }
  }
  roster.pendingInvites.push({ email: args.email, role: args.role, createdAt: Date.now() })
  return { status: 'ok' }
}

export function revokeDevBotmuxCloudOrgInvite(
  args: BotmuxProfileOrgInviteRevokeArgs
): BotmuxProfileOrgMemberMutationResult {
  const roster = getDevRoster(args.orgId)
  const email = args.email.toLowerCase()
  const index = roster.pendingInvites.findIndex((invite) => invite.email.toLowerCase() === email)
  if (index === -1) {
    return { status: 'not-found' }
  }
  roster.pendingInvites.splice(index, 1)
  return { status: 'ok' }
}

export function changeDevBotmuxCloudOrgMemberRole(
  args: BotmuxProfileOrgMemberChangeRoleArgs
): BotmuxProfileOrgMemberMutationResult {
  const roster = getDevRoster(args.orgId)
  if (args.userId === devSelf().userId) {
    return { status: 'invalid', reason: 'cannot_change_own_role' }
  }
  const member = roster.members.find((candidate) => candidate.userId === args.userId)
  if (!member) {
    return { status: 'not-found' }
  }
  member.role = args.role
  return { status: 'ok' }
}

export function removeDevBotmuxCloudOrgMember(
  args: BotmuxProfileOrgMemberRemoveArgs
): BotmuxProfileOrgMemberMutationResult {
  const roster = getDevRoster(args.orgId)
  if (args.userId === devSelf().userId) {
    return { status: 'invalid', reason: 'cannot_remove_self' }
  }
  const index = roster.members.findIndex((candidate) => candidate.userId === args.userId)
  if (index === -1) {
    return { status: 'not-found' }
  }
  roster.members.splice(index, 1)
  return { status: 'ok' }
}
