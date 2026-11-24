import type { ApprovalFlowPrediction } from './open-platform-automation.js';
import { larkHosts, type Brand } from '../im/lark/lark-hosts.js';

export type ScopeBucket = 'tenant' | 'user';

export interface ApprovalCandidateScope {
  bucket: ScopeBucket;
  name: string;
  id: string;
  /** Open Platform catalog sensitivity level for this (name, bucket): 3 =免审, 4 =需审. */
  level?: number;
  desc?: string;
}

export interface DeferredApprovalScope {
  bucket: ScopeBucket;
  name: string;
  desc?: string;
  /**
   * How this scope was isolated:
   * - `exact`      — proven individually by binary search to trigger human approval
   * - `group`      — deferred with its domain group after hitting probe budget
   * - `all_level4` — circuit-broken because multiple level-4 domain groups all required approval
   */
  isolation: 'exact' | 'group' | 'all_level4';
  group: string;
}

export interface ApprovalDeferredScopeBuckets {
  tenant?: string[];
  user?: string[];
}

export type ApprovalCompatibilityStopReason =
  | 'already_auto_approved'
  | 'resolved_exact'
  | 'resolved_with_group_fallback'
  | 'resolved_level3_only'
  | 'baseline_requires_approval'
  | 'probe_unavailable'
  | 'budget_exhausted'
  | 'mutation_failed';

export interface ApprovalCompatibilityOutcome {
  triggered: boolean;
  resolvedAutoApproved: boolean;
  deferredScopes: DeferredApprovalScope[];
  disabledRefreshToken: boolean;
  initialHumanApprovers: string[];
  remainingHumanApprovers: string[];
  probeCount: number;
  stopReason: ApprovalCompatibilityStopReason;
  /**
   * Present when resolution did not achieve auto-approval and attempted to restore
   * the original draft + refresh-token setting: `true` if every restore mutation
   * succeeded, `false` if any restore step failed (leaving draft state uncertain).
   */
  restored?: boolean;
}

export interface ResolveAutoApprovedScopesOptions {
  /** Approval flow prediction already fetched for the full candidate set. */
  initialPrediction: ApprovalFlowPrediction;
  /** Scopes currently staged in the draft that may be removed/re-added during probing. */
  candidates: readonly ApprovalCandidateScope[];
  /** Whether `allowRefreshToken` is currently enabled on the app and can be toggled off as a probe. */
  initialAllowRefreshToken?: boolean;
  /** Maximum `approval_nodes/get` probes allowed (excluding `initialPrediction`). Default 14. */
  maxProbes?: number;
  /** Consecutive coarse group failures (before any group succeeds) that trigger `all_level4` circuit breaker. Default 3. */
  maxConsecutiveGroupFailures?: number;
  /** Remove a batch of candidate scopes from the draft (`scope/update` `operation: 'del'`). */
  removeScopes: (scopes: readonly ApprovalCandidateScope[]) => Promise<void>;
  /** Re-add a batch of candidate scopes to the draft (`scope/update` `operation: 'add'`). */
  addScopes: (scopes: readonly ApprovalCandidateScope[]) => Promise<void>;
  /** Optional hook called after scopes are re-added (e.g. re-narrowing required privilege ranges for `vc:*`/`task:*`). */
  onScopesAdded?: (scopes: readonly ApprovalCandidateScope[]) => Promise<void>;
  /** Optional hook to toggle `allowRefreshToken` on the app (`safe_setting/update`). */
  setAllowRefreshToken?: (enabled: boolean) => Promise<void>;
  /** Query current draft's approval flow (`approval_nodes/get`). */
  probeApproval: () => Promise<ApprovalFlowPrediction>;
  /** Optional progress callback for Dashboard / CLI display. */
  onStatus?: (message: string) => void | Promise<void>;
}

/** Priority order of sensitive (non-level-3) domain groups: critical bot capabilities first. */
export const SENSITIVE_SCOPE_GROUP_ORDER = [
  'core_im',
  'offline_access',
  'im_extra',
  'contact_search',
  'docs_drive',
  'base',
  'calendar',
  'wiki_slides_board',
  'vc_task',
  'other',
] as const;

export type SensitiveScopeGroupId = (typeof SENSITIVE_SCOPE_GROUP_ORDER)[number];

const DEFAULT_MAX_PROBES = 14;
const DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES = 3;
const DIRECT_BISECT_THRESHOLD = 12;

export function candidateScopeKey(scope: Pick<ApprovalCandidateScope, 'bucket' | 'id'>): string {
  return `${scope.bucket}:${scope.id}`;
}

export function classifySensitiveScopeGroup(
  scope: Pick<ApprovalCandidateScope, 'bucket' | 'name'>,
): SensitiveScopeGroupId {
  const { name, bucket } = scope;
  if (
    (bucket === 'tenant' && (name === 'im:message.group_msg' || name === 'contact:user.base:readonly'))
  ) {
    return 'core_im';
  }
  if (name === 'offline_access' || name.startsWith('auth:')) return 'offline_access';
  if (name.startsWith('im:')) return 'im_extra';
  if (name.startsWith('contact:') || name.startsWith('search:')) return 'contact_search';
  if (
    name.startsWith('docs:')
    || name.startsWith('docx:')
    || name.startsWith('drive:')
    || name.startsWith('space:')
    || name.startsWith('sheets:')
  ) {
    return 'docs_drive';
  }
  if (name.startsWith('base:') || name.startsWith('bitable:')) return 'base';
  if (name.startsWith('calendar:')) return 'calendar';
  if (name.startsWith('wiki:') || name.startsWith('slides:') || name.startsWith('board:')) {
    return 'wiki_slides_board';
  }
  if (name.startsWith('vc:') || name.startsWith('task:')) return 'vc_task';
  return 'other';
}

export function describeDeferredScopeGroup(group: string, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const zh: Record<string, string> = {
    core_im: '核心群消息/用户信息（未开通时群聊需 @ 机器人回复）',
    offline_access: '离线刷新用户授权（未开通时用户授权过期需重新登录）',
    im_extra: '增强消息能力（加急消息、消息分组、读取其他机器人消息等）',
    contact_search: '通讯录与搜索（邮箱/搜索用户/搜索消息）',
    docs_drive: '云文档与云空间读写',
    base: '多维表格高级操作',
    calendar: '日历日程管理',
    wiki_slides_board: '知识库、幻灯片与画板',
    vc_task: '视频会议与任务',
    other: '其他扩展权限',
  };
  const en: Record<string, string> = {
    core_im: 'Core group messages & user profile (mentions still work)',
    offline_access: 'Refreshable user authorization (re-login required on expiry)',
    im_extra: 'Extended messaging (urgent buzz, feed groups, reading peer bots)',
    contact_search: 'Contacts & search (email, user/message search)',
    docs_drive: 'Docs & Drive read/write',
    base: 'Bitable / Base operations',
    calendar: 'Calendar & events',
    wiki_slides_board: 'Wiki, Slides & Whiteboard',
    vc_task: 'Meetings (VC) & Tasks',
    other: 'Other extended permissions',
  };
  return (locale === 'en-US' ? en : zh)[group] ?? group;
}

export function buildApprovalConsoleUrl(appId: string, brand: Brand = 'feishu'): string {
  return `${larkHosts(brand).openApi}/app/${encodeURIComponent(appId)}/auth`;
}

export function deferredScopesToBuckets(
  scopes?: readonly DeferredApprovalScope[],
): ApprovalDeferredScopeBuckets | undefined {
  if (!scopes || scopes.length === 0) return undefined;
  const tenant = [...new Set(scopes.filter(s => s.bucket === 'tenant').map(s => s.name.trim()).filter(Boolean))].sort();
  const user = [...new Set(scopes.filter(s => s.bucket === 'user').map(s => s.name.trim()).filter(Boolean))].sort();
  if (tenant.length === 0 && user.length === 0) return undefined;
  return {
    ...(tenant.length > 0 ? { tenant } : {}),
    ...(user.length > 0 ? { user } : {}),
  };
}

export function normalizeApprovalDeferredScopes(raw: unknown): ApprovalDeferredScopeBuckets | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const clean = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of val) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out.sort();
  };
  const tenant = clean(rec.tenant);
  const user = clean(rec.user);
  if (tenant.length === 0 && user.length === 0) return undefined;
  return {
    ...(tenant.length > 0 ? { tenant } : {}),
    ...(user.length > 0 ? { user } : {}),
  };
}

export function mergeDeferredApprovalScopes(
  ...lists: Array<readonly DeferredApprovalScope[] | undefined>
): DeferredApprovalScope[] {
  const rank: Record<DeferredApprovalScope['isolation'], number> = {
    exact: 3,
    group: 2,
    all_level4: 1,
  };
  const merged = new Map<string, DeferredApprovalScope>();
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      const key = `${item.bucket}:${item.name}`;
      const existing = merged.get(key);
      if (!existing || rank[item.isolation] > rank[existing.isolation]) {
        merged.set(key, { ...item });
      }
    }
  }
  return [...merged.values()];
}

export type PersistedDeferredScopesDecision =
  | { action: 'set'; buckets: ApprovalDeferredScopeBuckets }
  | { action: 'clear' }
  | { action: 'keep' };

/**
 * Decide how to update persisted `bot.approvalDeferredScopes` after a successful
 * `automateOpenPlatformSetup` call.
 *
 * Only clear an existing deferral list when a successful run cleanly proves the full target
 * manifest passed without warning (`ok !== false`, zero skipped scopes, no scope/version warning,
 * and confirmed auto-pass or a no-op publish skip).
 * On inconclusive/failed runs (`ok: false`, `approvalAutoPassed === undefined` / `known: false`),
 * human-review runs, skipped catalog scopes, `scopeWarning`, or `versionWarning`, never wipe
 * previously recorded deferrals — only union any newly discovered deferrals onto them.
 */
export function resolveNextPersistedApprovalDeferredScopes(
  existing: ApprovalDeferredScopeBuckets | undefined,
  result: {
    scopeWarning?: string;
    versionWarning?: string;
    versionPendingReview?: boolean;
    approvalAutoPassed?: boolean;
    publishSkipped?: boolean;
    skippedScopeCount?: number;
    ok?: boolean;
  },
  mergedDeferred: readonly DeferredApprovalScope[],
): PersistedDeferredScopesDecision {
  const nextBuckets = deferredScopesToBuckets(mergedDeferred);
  const cleanVerified = result.ok !== false
    && !result.scopeWarning
    && !result.versionWarning
    && !result.versionPendingReview
    && (result.skippedScopeCount ?? 0) === 0
    && (result.approvalAutoPassed === true || result.publishSkipped === true);

  if (cleanVerified) {
    return nextBuckets ? { action: 'set', buckets: nextBuckets } : { action: 'clear' };
  }
  if (!nextBuckets) {
    return { action: 'keep' };
  }
  const union = normalizeApprovalDeferredScopes({
    tenant: [...(existing?.tenant ?? []), ...(nextBuckets.tenant ?? [])],
    user: [...(existing?.user ?? []), ...(nextBuckets.user ?? [])],
  });
  return union ? { action: 'set', buckets: union } : { action: 'keep' };
}

interface ScopeGroup {
  id: SensitiveScopeGroupId;
  scopes: ApprovalCandidateScope[];
}

function buildSensitiveGroups(sensitive: readonly ApprovalCandidateScope[]): ScopeGroup[] {
  const map = new Map<SensitiveScopeGroupId, ApprovalCandidateScope[]>();
  for (const id of SENSITIVE_SCOPE_GROUP_ORDER) map.set(id, []);
  for (const scope of sensitive) {
    const gid = classifySensitiveScopeGroup(scope);
    map.get(gid)!.push(scope);
  }
  const groups: ScopeGroup[] = [];
  for (const id of SENSITIVE_SCOPE_GROUP_ORDER) {
    const scopes = map.get(id)!;
    if (scopes.length > 0) groups.push({ id, scopes });
  }
  return groups;
}

function toDeferred(
  scope: ApprovalCandidateScope,
  isolation: DeferredApprovalScope['isolation'],
): DeferredApprovalScope {
  return {
    bucket: scope.bucket,
    name: scope.name,
    ...(scope.desc ? { desc: scope.desc } : {}),
    isolation,
    group: classifySensitiveScopeGroup(scope),
  };
}

/**
 * Draft-time approval compatibility resolver:
 *
 * When `approval_nodes/get` predicts human approval on a draft version BEFORE
 * `publish/commit`, this resolver identifies and removes the minimal set of
 * approval-triggering scopes (and optionally `allowRefreshToken`) so the bot
 * can publish automatically without blocking new-user registration.
 *
 * Invariants:
 * 1. Fast path: if `initialPrediction` is already `autoApproved: true`, or
 *    `known: false`, zero mutations and zero extra probes are performed.
 * 2. Draft safety: never commits or withdraws a version; only mutates the
 *    uncommitted draft via `scope/update` (`del`/`add`).
 * 3. Completeness on unresolvable baseline: if even the level-3-only baseline
 *    still requires human approval, the full original draft is restored before
 *    returning so the user does not waste an admin approval cycle on a crippled
 *    version.
 * 4. Witnessed safety: whenever `resolvedAutoApproved: true` is returned, the
 *    final synced draft matches a scope subset directly observed as
 *    `autoApproved: true` by a real `probeApproval()` call.
 */
export async function resolveAutoApprovedScopes(
  opts: ResolveAutoApprovedScopesOptions,
): Promise<ApprovalCompatibilityOutcome> {
  const initialApprovers = [...opts.initialPrediction.humanApprovers];
  if (!opts.initialPrediction.known) {
    return {
      triggered: false,
      resolvedAutoApproved: false,
      deferredScopes: [],
      disabledRefreshToken: false,
      initialHumanApprovers: initialApprovers,
      remainingHumanApprovers: initialApprovers,
      probeCount: 0,
      stopReason: 'probe_unavailable',
    };
  }
  if (opts.initialPrediction.autoApproved) {
    return {
      triggered: false,
      resolvedAutoApproved: true,
      deferredScopes: [],
      disabledRefreshToken: false,
      initialHumanApprovers: [],
      remainingHumanApprovers: [],
      probeCount: 0,
      stopReason: 'already_auto_approved',
    };
  }

  // Deduplicate candidates by (bucket, id) while preserving order.
  const allCandidates: ApprovalCandidateScope[] = [];
  const byKey = new Map<string, ApprovalCandidateScope>();
  for (const c of opts.candidates) {
    const key = candidateScopeKey(c);
    if (byKey.has(key)) continue;
    byKey.set(key, c);
    allCandidates.push(c);
  }

  const maxProbes = Math.max(1, opts.maxProbes ?? DEFAULT_MAX_PROBES);
  const maxConsecutiveGroupFailures = Math.max(
    1,
    opts.maxConsecutiveGroupFailures ?? DEFAULT_MAX_CONSECUTIVE_GROUP_FAILURES,
  );
  const canToggleRefreshToken =
    opts.initialAllowRefreshToken === true && typeof opts.setAllowRefreshToken === 'function';

  // Live draft tracker, updated only after acknowledged API calls. A rejected write may
  // still have reached Feishu, so the restore path separately tracks uncertain mutations.
  const currentlyApplied = new Set<string>(allCandidates.map(candidateScopeKey));
  let currentRefreshToken = opts.initialAllowRefreshToken;
  let draftMutationUncertain = false;
  let refreshTokenMutationUncertain = false;
  let probeCount = 0;
  let lastHumanApprovers = initialApprovers;
  let probeUnavailableHit = false;
  let budgetExhaustedHit = false;

  const syncDraft = async (desiredKeys: ReadonlySet<string>): Promise<void> => {
    const toRemove: ApprovalCandidateScope[] = [];
    for (const key of currentlyApplied) {
      if (!desiredKeys.has(key)) {
        const entry = byKey.get(key);
        if (entry) toRemove.push(entry);
      }
    }
    const toAdd: ApprovalCandidateScope[] = [];
    for (const key of desiredKeys) {
      if (!currentlyApplied.has(key)) {
        const entry = byKey.get(key);
        if (entry) toAdd.push(entry);
      }
    }
    if (toRemove.length > 0) {
      try {
        await opts.removeScopes(toRemove);
      } catch (err) {
        // The server may have applied the deletion before the response was lost.
        draftMutationUncertain = true;
        throw err;
      }
      for (const s of toRemove) currentlyApplied.delete(candidateScopeKey(s));
    }
    if (toAdd.length > 0) {
      try {
        await opts.addScopes(toAdd);
      } catch (err) {
        draftMutationUncertain = true;
        throw err;
      }
      for (const s of toAdd) currentlyApplied.add(candidateScopeKey(s));
      if (opts.onScopesAdded) await opts.onScopesAdded(toAdd);
    }
  };

  const setRefreshToken = async (enabled: boolean): Promise<void> => {
    if (!opts.setAllowRefreshToken || currentRefreshToken === enabled) return;
    try {
      await opts.setAllowRefreshToken(enabled);
    } catch (err) {
      refreshTokenMutationUncertain = true;
      throw err;
    }
    currentRefreshToken = enabled;
  };

  const restoreOriginalBestEffort = async (): Promise<boolean> => {
    let restored = true;
    if (
      opts.setAllowRefreshToken
      && opts.initialAllowRefreshToken !== undefined
      && (refreshTokenMutationUncertain || currentRefreshToken !== opts.initialAllowRefreshToken)
    ) {
      try {
        // Do not use the tracked value as a precondition after an ambiguous write:
        // the live setting may already differ from the last acknowledged snapshot.
        await opts.setAllowRefreshToken(opts.initialAllowRefreshToken);
        currentRefreshToken = opts.initialAllowRefreshToken;
        refreshTokenMutationUncertain = false;
      } catch {
        restored = false;
      }
    }
    try {
      if (draftMutationUncertain) {
        // scope/update add is idempotent. Re-add every original candidate rather than
        // trusting a local diff after a delete may have succeeded without a response.
        await opts.addScopes(allCandidates);
        for (const scope of allCandidates) currentlyApplied.add(candidateScopeKey(scope));
        if (opts.onScopesAdded) await opts.onScopesAdded(allCandidates);
        draftMutationUncertain = false;
      } else {
        await syncDraft(new Set(allCandidates.map(candidateScopeKey)));
      }
    } catch {
      restored = false;
    }
    return restored;
  };

  const probeDesired = async (
    desiredKeys: ReadonlySet<string>,
  ): Promise<'auto' | 'manual' | 'unknown' | 'budget'> => {
    if (probeCount >= maxProbes) {
      budgetExhaustedHit = true;
      return 'budget';
    }
    await syncDraft(desiredKeys);
    probeCount += 1;
    const pred = await opts.probeApproval();
    if (!pred.known) {
      probeUnavailableHit = true;
      return 'unknown';
    }
    lastHumanApprovers = pred.humanApprovers;
    return pred.autoApproved ? 'auto' : 'manual';
  };

  const level3 = allCandidates.filter(c => c.level === 3);
  const sensitive = allCandidates.filter(c => c.level !== 3);
  const level3Keys = new Set(level3.map(candidateScopeKey));
  const allKeys = new Set(allCandidates.map(candidateScopeKey));

  try {
    await opts.onStatus?.(
      `检测到当前配置可能触发人工审批${initialApprovers.length ? `（${initialApprovers.join('、')}）` : ''}，正在草稿态自动排查需审批权限…`,
    );

    // Case A: No sensitive scopes at all — only refresh-token toggle could unblock.
    if (sensitive.length === 0) {
      if (!canToggleRefreshToken) {
        return {
          triggered: true,
          resolvedAutoApproved: false,
          deferredScopes: [],
          disabledRefreshToken: false,
          initialHumanApprovers: initialApprovers,
          remainingHumanApprovers: initialApprovers,
          probeCount: 0,
          stopReason: 'baseline_requires_approval',
        };
      }
      await setRefreshToken(false);
      const res = await probeDesired(allKeys);
      if (res === 'auto') {
        return {
          triggered: true,
          resolvedAutoApproved: true,
          deferredScopes: [],
          disabledRefreshToken: true,
          initialHumanApprovers: initialApprovers,
          remainingHumanApprovers: [],
          probeCount,
          stopReason: 'resolved_exact',
        };
      }
      const restored = await restoreOriginalBestEffort();
      return {
        triggered: true,
        resolvedAutoApproved: false,
        deferredScopes: [],
        disabledRefreshToken: false,
        initialHumanApprovers: initialApprovers,
        remainingHumanApprovers: lastHumanApprovers,
        probeCount,
        stopReason: res === 'unknown' ? 'probe_unavailable' : 'baseline_requires_approval',
        restored,
      };
    }

    // Step 1: Baseline check — level-3 (免审) scopes only.
    let disabledRefreshToken = false;
    let baselineRes = await probeDesired(level3Keys);
    if (baselineRes === 'unknown') {
      const restored = await restoreOriginalBestEffort();
      return {
        triggered: true,
        resolvedAutoApproved: false,
        deferredScopes: [],
        disabledRefreshToken: false,
        initialHumanApprovers: initialApprovers,
        remainingHumanApprovers: lastHumanApprovers,
        probeCount,
        stopReason: 'probe_unavailable',
        restored,
      };
    }
    if (baselineRes !== 'auto') {
      if (canToggleRefreshToken && probeCount < maxProbes) {
        await setRefreshToken(false);
        baselineRes = await probeDesired(level3Keys);
        if (baselineRes === 'auto') {
          disabledRefreshToken = true;
          // Maybe refresh token alone caused approval — test full scope set once!
          const fullWithNoRefresh = await probeDesired(allKeys);
          if (fullWithNoRefresh === 'auto') {
            return {
              triggered: true,
              resolvedAutoApproved: true,
              deferredScopes: [],
              disabledRefreshToken: true,
              initialHumanApprovers: initialApprovers,
              remainingHumanApprovers: [],
              probeCount,
              stopReason: 'resolved_exact',
            };
          }
          if (fullWithNoRefresh === 'unknown' || fullWithNoRefresh === 'budget') {
            await syncDraft(level3Keys);
            return {
              triggered: true,
              resolvedAutoApproved: true,
              deferredScopes: sensitive.map(s => toDeferred(s, 'group')),
              disabledRefreshToken: true,
              initialHumanApprovers: initialApprovers,
              remainingHumanApprovers: [],
              probeCount,
              stopReason: fullWithNoRefresh === 'budget' ? 'budget_exhausted' : 'probe_unavailable',
            };
          }
        }
      }
      if (baselineRes !== 'auto') {
        const restored = await restoreOriginalBestEffort();
        return {
          triggered: true,
          resolvedAutoApproved: false,
          deferredScopes: [],
          disabledRefreshToken: false,
          initialHumanApprovers: initialApprovers,
          remainingHumanApprovers: lastHumanApprovers,
          probeCount,
          stopReason: baselineRes === 'unknown' ? 'probe_unavailable' : 'baseline_requires_approval',
          restored,
        };
      }
    }

    // Invariant: `accepted` is ALWAYS witnessed as auto-approved!
    const accepted = new Set<string>(level3Keys);
    const deferred: DeferredApprovalScope[] = [];
    const unionWith = (items: readonly ApprovalCandidateScope[]): Set<string> => {
      const next = new Set(accepted);
      for (const s of items) next.add(candidateScopeKey(s));
      return next;
    };

    // Bounded divide-and-conquer binary search on a flat list of scopes.
    const bisectScopes = async (
      scopes: readonly ApprovalCandidateScope[],
      knownFailing: boolean,
    ): Promise<void> => {
      if (scopes.length === 0) return;
      if (scopes.length === 1) {
        if (knownFailing) {
          deferred.push(toDeferred(scopes[0]!, 'exact'));
          return;
        }
        const res = await probeDesired(unionWith(scopes));
        if (res === 'auto') {
          accepted.add(candidateScopeKey(scopes[0]!));
        } else if (res === 'manual') {
          deferred.push(toDeferred(scopes[0]!, 'exact'));
        } else {
          deferred.push(toDeferred(scopes[0]!, 'group'));
        }
        return;
      }

      if (probeCount >= maxProbes || probeUnavailableHit) {
        budgetExhaustedHit = budgetExhaustedHit || probeCount >= maxProbes;
        for (const s of scopes) deferred.push(toDeferred(s, 'group'));
        return;
      }

      const mid = Math.ceil(scopes.length / 2);
      const left = scopes.slice(0, mid);
      const right = scopes.slice(mid);

      const leftRes = await probeDesired(unionWith(left));
      if (leftRes === 'auto') {
        for (const s of left) accepted.add(candidateScopeKey(s));
        // Parent invariant: if oldAccepted ∪ (left ∪ right) failed, then
        // (oldAccepted ∪ left) ∪ right STILL fails!
        await bisectScopes(right, knownFailing);
        return;
      }
      if (leftRes === 'manual') {
        await bisectScopes(left, true);
        // Right half has NOT been tested yet; test it as a batch first!
        if (right.length === 0) return;
        if (probeCount >= maxProbes || probeUnavailableHit) {
          budgetExhaustedHit = budgetExhaustedHit || probeCount >= maxProbes;
          for (const s of right) deferred.push(toDeferred(s, 'group'));
          return;
        }
        const rightRes = await probeDesired(unionWith(right));
        if (rightRes === 'auto') {
          for (const s of right) accepted.add(candidateScopeKey(s));
        } else if (rightRes === 'manual') {
          await bisectScopes(right, true);
        } else {
          for (const s of right) deferred.push(toDeferred(s, 'group'));
        }
        return;
      }
      // budget or unknown
      for (const s of scopes) deferred.push(toDeferred(s, 'group'));
    };

    const groups = buildSensitiveGroups(sensitive);
    let circuitBrokenAllLevel4 = false;

    if (sensitive.length <= DIRECT_BISECT_THRESHOLD) {
      // Small sensitive set (e.g. 1.0.0 template's 8 level-4 scopes): bisect directly in priority order!
      const ordered = groups.flatMap(g => g.scopes);
      await bisectScopes(ordered, true);
    } else {
      // Large sensitive set (e.g. 1.0.1's 164 level-4 scopes):
      // Phase A: binary search across domain groups with circuit breaker for "all level-4 blocked".
      const failingGroups: ScopeGroup[] = [];
      let anyGroupPassed = false;

      const recordFailingGroup = (g: ScopeGroup): void => {
        failingGroups.push(g);
        // Circuit breaker counts DISTINCT isolated failing groups (not nested
        // prefixes that all share the same single failing group like G0!).
        if (!anyGroupPassed && failingGroups.length >= maxConsecutiveGroupFailures) {
          circuitBrokenAllLevel4 = true;
        }
      };

      const flattenGroups = (gs: readonly ScopeGroup[]): ApprovalCandidateScope[] =>
        gs.flatMap(g => g.scopes);

      const deferUntestedGroups = (gs: readonly ScopeGroup[], iso: 'group' | 'all_level4'): void => {
        for (const g of gs) {
          for (const s of g.scopes) deferred.push(toDeferred(s, iso));
        }
      };

      const partitionGroups = async (
        gs: readonly ScopeGroup[],
        knownFailing: boolean,
      ): Promise<void> => {
        if (gs.length === 0) return;
        if (circuitBrokenAllLevel4) {
          deferUntestedGroups(gs, 'all_level4');
          return;
        }
        if (gs.length === 1) {
          if (knownFailing) {
            recordFailingGroup(gs[0]!);
            return;
          }
          const res = await probeDesired(unionWith(gs[0]!.scopes));
          if (res === 'auto') {
            anyGroupPassed = true;
            for (const s of gs[0]!.scopes) accepted.add(candidateScopeKey(s));
          } else if (res === 'manual') {
            recordFailingGroup(gs[0]!);
          } else {
            deferUntestedGroups(gs, 'group');
          }
          return;
        }

        if (probeCount >= maxProbes || probeUnavailableHit) {
          budgetExhaustedHit = budgetExhaustedHit || probeCount >= maxProbes;
          deferUntestedGroups(gs, 'group');
          return;
        }

        const mid = Math.ceil(gs.length / 2);
        const left = gs.slice(0, mid);
        const right = gs.slice(mid);
        const leftScopes = flattenGroups(left);

        const leftRes = await probeDesired(unionWith(leftScopes));
        if (leftRes === 'auto') {
          anyGroupPassed = true;
          for (const s of leftScopes) accepted.add(candidateScopeKey(s));
          await partitionGroups(right, knownFailing);
          return;
        }
        if (leftRes === 'manual') {
          await partitionGroups(left, true);
          if (circuitBrokenAllLevel4) {
            deferUntestedGroups(right, 'all_level4');
            return;
          }
          if (right.length === 0) return;
          if (probeCount >= maxProbes || probeUnavailableHit) {
            budgetExhaustedHit = budgetExhaustedHit || probeCount >= maxProbes;
            deferUntestedGroups(right, 'group');
            return;
          }
          const rightScopes = flattenGroups(right);
          const rightRes = await probeDesired(unionWith(rightScopes));
          if (rightRes === 'auto') {
            anyGroupPassed = true;
            for (const s of rightScopes) accepted.add(candidateScopeKey(s));
          } else if (rightRes === 'manual') {
            await partitionGroups(right, true);
          } else {
            deferUntestedGroups(right, 'group');
          }
          return;
        }
        deferUntestedGroups(gs, 'group');
      };

      await partitionGroups(groups, true);

      if (circuitBrokenAllLevel4) {
        // Any previously recorded failingGroups also collapse cleanly into all_level4.
        for (const g of failingGroups) {
          for (const s of g.scopes) deferred.push(toDeferred(s, 'all_level4'));
        }
      } else {
        // Phase B: intra-group bounded binary search on isolated failing groups (priority order).
        for (const g of failingGroups) {
          await bisectScopes(g.scopes, true);
        }
      }
    }

    // Final sync: guarantee Feishu's draft matches the exact witnessed `accepted` set!
    await syncDraft(accepted);

    const hasGroupFallback = deferred.some(d => d.isolation === 'group');
    const stopReason: ApprovalCompatibilityStopReason = circuitBrokenAllLevel4
      ? 'resolved_level3_only'
      : probeUnavailableHit
        ? 'probe_unavailable'
        : hasGroupFallback
          ? (budgetExhaustedHit ? 'budget_exhausted' : 'resolved_with_group_fallback')
          : 'resolved_exact';

    await opts.onStatus?.(
      deferred.length > 0
        ? `已自动避开 ${deferred.length} 项需审批权限${disabledRefreshToken ? '（并关闭刷新 user_access_token）' : ''}，当前版本可自动发布`
        : disabledRefreshToken
          ? '已关闭刷新 user_access_token，当前版本可自动发布'
          : '审批预检已完成',
    );

    return {
      triggered: true,
      resolvedAutoApproved: true,
      deferredScopes: mergeDeferredApprovalScopes(deferred),
      disabledRefreshToken,
      initialHumanApprovers: initialApprovers,
      remainingHumanApprovers: [],
      probeCount,
      stopReason,
    };
  } catch {
    const restored = await restoreOriginalBestEffort();
    return {
      triggered: true,
      resolvedAutoApproved: false,
      deferredScopes: [],
      disabledRefreshToken: false,
      initialHumanApprovers: initialApprovers,
      remainingHumanApprovers: lastHumanApprovers,
      probeCount,
      stopReason: 'mutation_failed',
      restored,
    };
  }
}
