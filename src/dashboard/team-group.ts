/**
 * Pure decision for web "create group": which bot is the group creator, and
 * whether we can auto-invite the requesting web user.
 *
 * Why this matters (Lark open_id is per-app scoped): the web user's open_id is
 * scoped to the bot they ran `/pair` with (`preferredCreator`). We may only
 * forward that open_id as an invitee if THAT bot is the creator daemon —
 * otherwise the open_id is wrong-scope and Lark rejects the invite, leaving the
 * user out of the group they just created. So: only auto-invite when the paired
 * bot is among the selection AND online (→ it becomes creator); otherwise still
 * create the group but flag `inviteUser=false` so the UI says "not auto-added".
 */
export interface GroupCreatorPlan {
  creatorLarkAppId: string | null;
  inviteUser: boolean;
}

export function planGroupCreator(
  selectedIds: string[],
  preferredCreator: string | undefined,
  isOnline: (id: string) => boolean,
  pickFallback: (ids: string[]) => string | null,
): GroupCreatorPlan {
  if (preferredCreator && selectedIds.includes(preferredCreator) && isOnline(preferredCreator)) {
    return { creatorLarkAppId: preferredCreator, inviteUser: true };
  }
  return { creatorLarkAppId: pickFallback(selectedIds), inviteUser: false };
}
