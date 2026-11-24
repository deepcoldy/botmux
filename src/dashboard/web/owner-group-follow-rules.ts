import type { OwnerGroupFollowRule } from '../../services/owner-group-follow-policy.js';

export const OWNER_GROUP_FOLLOW_PRESETS: ReadonlyArray<{
  id: string;
  labelKey: string;
  list: 'includeRules' | 'excludeRules';
  rules: readonly OwnerGroupFollowRule[];
}> = [
  {
    id: 'defect-sync', labelKey: 'botDefaults.ownerGroupFollowPresetDefect', list: 'includeRules',
    rules: [{ field: 'name', op: 'endsWith', pattern: '[缺陷同步群]' }],
  },
  {
    id: 'alert-description', labelKey: 'botDefaults.ownerGroupFollowPresetAlertDesc', list: 'includeRules',
    rules: [{ field: 'description', op: 'regex', pattern: '报警处理群|告警处理|值班处理|alarm group|incident triage' }],
  },
  {
    id: 'generic-alert', labelKey: 'botDefaults.ownerGroupFollowPresetAlert', list: 'includeRules',
    rules: [{ field: 'any', op: 'regex', pattern: '告警|报警|故障|oncall|incident|🚨' }],
  },
  {
    id: 'exclude-closed', labelKey: 'botDefaults.ownerGroupFollowPresetClosed', list: 'excludeRules',
    rules: [{ field: 'name', op: 'contains', pattern: '[已关单]' }],
  },
];

export function missingOwnerGroupFollowRules(existing: readonly OwnerGroupFollowRule[], additions: readonly OwnerGroupFollowRule[]) {
  return additions.filter(rule => !existing.some(other => other.field === rule.field && other.op === rule.op
    && other.pattern === rule.pattern && Boolean(other.caseSensitive) === Boolean(rule.caseSensitive)));
}
