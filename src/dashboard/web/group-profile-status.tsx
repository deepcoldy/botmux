import {
  hasExplicitChatRole,
  summarizeGroupProfileMatches,
  type EffectiveRoleValue,
  type RoleProfileEntryLike,
  type RoleProfileSummaryLike,
} from './role-profile-match.js';

/**
 * 群「角色档案匹配」状态行：群内显式设置了 chat 级角色时，提示它与哪个档案
 * 完全/部分一致。groups 页与 roles 页共用这套判定与文案，只有两处不同：
 * 根 class（各页自己的样式钩子）与「某 bot 在该群的生效角色」从各自的
 * RoleProfileContext 怎么取（`roleOf`）。
 */
export function GroupProfileStatus(props: {
  /** 根元素 class 前缀：`g-profile-status`（groups 页）/ `roles-profile-match`（roles 页）。 */
  className: string;
  memberBots: Array<{ larkAppId: string; inChat?: boolean }>;
  profiles: RoleProfileSummaryLike[];
  entriesByProfile: Map<string, RoleProfileEntryLike[]>;
  loaded: boolean;
  /** 某 bot 在该群的生效角色；取不到按 null。 */
  roleOf(larkAppId: string): EffectiveRoleValue | undefined;
  tr: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { className, memberBots, profiles, entriesByProfile, loaded, roleOf, tr } = props;
  if (!profiles.length || !loaded) return null;

  const rolesByBot = new Map<string, EffectiveRoleValue>();
  for (const bot of memberBots) {
    if (!bot?.inChat) continue;
    rolesByBot.set(bot.larkAppId, roleOf(bot.larkAppId) ?? null);
  }
  if (!hasExplicitChatRole(rolesByBot)) return null;

  const best = summarizeGroupProfileMatches(memberBots, profiles, entriesByProfile, rolesByBot)[0];
  if (!best) {
    return <div className={`${className} muted`}>{tr('groups.profileStatusUnmatched')}</div>;
  }
  const key = best.kind === 'full' ? 'groups.profileStatusFullChat' : 'groups.profileStatusPartial';
  return (
    <div className={`${className} ${best.kind}`}>
      {tr(key, {
        name: best.profileId,
        matched: best.matched,
        total: best.total,
        chat: best.chatMatched,
      })}
    </div>
  );
}
