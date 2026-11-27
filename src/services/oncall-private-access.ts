import type { OncallGroupPolicy } from './oncall-group-policy.js';
import type { OncallPrivateIntake } from './oncall-private-intake.js';

export interface PrivateOncallAccessSubject {
  openId: string;
  unionId?: string;
}

export interface PrivateOncallAccessDeps {
  policy: OncallGroupPolicy | undefined;
  evaluateTalk: (
    appId: string,
    chatId: string,
    openId: string,
    senderUnionId: undefined,
    memberUnionId: string | undefined,
    chatType: 'group' | 'p2p',
  ) => { allowed: boolean; reason: string };
  findCurrentChatUserMembers: (appId: string, chatId: string, openIds: string[]) => Promise<Set<string>>;
}

export type PrivateOncallAccessResult =
  | { allowed: true }
  | { allowed: false; reason: 'identity' | 'policy' | 'group_talk' | 'membership' };

/**
 * Shared live authorization for private consultations and their card callbacks.
 * Group-only grants need a fresh roster check; existing admin/open-mode talk
 * exemptions intentionally retain the message path's established semantics.
 */
export async function evaluatePrivateOncallAccess(
  source: { appId: string; chatId: string; privateIntake: OncallPrivateIntake },
  subject: PrivateOncallAccessSubject,
  deps: PrivateOncallAccessDeps,
): Promise<PrivateOncallAccessResult> {
  const intake = source.privateIntake;
  if (intake.appId !== source.appId || intake.chatId !== source.chatId || subject.openId !== intake.ownerOpenId) {
    return { allowed: false, reason: 'identity' };
  }
  const group = intake.groupChatId;
  if (!deps.policy?.chatIds.includes(group)) return { allowed: false, reason: 'policy' };
  const groupTalk = deps.evaluateTalk(source.appId, group, subject.openId, undefined, subject.unionId, 'group');
  if (!groupTalk.allowed) return { allowed: false, reason: 'group_talk' };
  const dmTalk = deps.evaluateTalk(source.appId, source.chatId, subject.openId, undefined, subject.unionId, 'p2p');
  const needsMembership = !dmTalk.allowed || groupTalk.reason === 'allowedChatGroup'
    || groupTalk.reason === 'oncall' || groupTalk.reason === 'chatGrant';
  if (!needsMembership) return { allowed: true };
  try {
    const members = await deps.findCurrentChatUserMembers(source.appId, group, [subject.openId]);
    return members.has(subject.openId) ? { allowed: true } : { allowed: false, reason: 'membership' };
  } catch {
    return { allowed: false, reason: 'membership' };
  }
}
