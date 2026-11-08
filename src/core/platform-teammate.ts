/**
 * Can the central platform issue THIS person's credentials to THIS machine?
 *
 * The platform's credential grant (botmux-platform machine-credentials-http)
 * refuses with `not_teammate` unless the sender is the machine owner or shares
 * at least one platform team with them. `/login` used to point everyone at the
 * platform page regardless, so a person outside the owner's teams authorized
 * there and still got nothing on this machine.
 *
 * This answers the same question locally, BEFORE suggesting the platform page:
 * - the owner's union_id comes from the machine token payload (`platform.json`);
 * - team membership comes from the platform's own `team-sync` push
 *   (platform-team-sync.json), which the platform builds from
 *   `listTeamsForUser(owner)` — the same source the grant check reads.
 *
 * Advisory only: it chooses which instructions `/login` shows. The platform
 * still enforces the boundary on every grant, so a stale answer can cost a
 * person one confusing message, never a credential. Anything not provable
 * (no union_id, no sync yet, unreadable token) is `unknown`, which keeps the
 * previous behavior.
 */
import type { PlatformTeamSyncTeam } from '../services/platform-team-store.js';

export type PlatformTeammateVerdict = 'owner' | 'teammate' | 'not_teammate' | 'unknown';

export function platformTeammateVerdict(input: {
  senderUnionId?: string;
  ownerUnionId?: string;
  /** Last applied team-sync; null when no sync has been received yet. */
  teams: PlatformTeamSyncTeam[] | null;
}): PlatformTeammateVerdict {
  const sender = input.senderUnionId?.trim();
  if (!sender) return 'unknown';
  const owner = input.ownerUnionId?.trim();
  if (owner && sender === owner) return 'owner';
  if (!input.teams) return 'unknown';
  if (input.teams.some(t => t.memberUnionIds.includes(sender))) return 'teammate';
  // The owner is a member of each of their own teams, so a sender missing from
  // every non-empty roster is not the owner either. With no owner id and no
  // teams at all, the sender could still be the owner: not provable.
  if (owner || input.teams.some(t => t.memberUnionIds.length > 0)) return 'not_teammate';
  return 'unknown';
}
