/** Cross-device protocol capabilities advertised by a botmux deployment. */
export const A2A_CAPABILITY_DELIVERY_V1 = 'delivery-envelope:v1';
export const A2A_CAPABILITY_DISPATCH_REPO_V1 = 'dispatch-repo:v1';
export const A2A_CAPABILITY_TEAM_SYNC_V1 = 'team-sync:v1';

export const CURRENT_A2A_CAPABILITIES = Object.freeze([
  A2A_CAPABILITY_DELIVERY_V1,
  A2A_CAPABILITY_DISPATCH_REPO_V1,
  A2A_CAPABILITY_TEAM_SYNC_V1,
]);

export interface A2APeerCapability {
  larkAppId?: string;
  unionId?: string;
  name?: string;
  cliId?: string;
  botmuxVersion?: string;
  a2aCapabilities?: string[];
}

export interface DispatchReadinessWorker {
  openId: string;
  name: string;
  larkAppId?: string;
  cliId?: string;
  unionId?: string;
  local: boolean;
}

export interface ChatBotMembershipFact {
  openId: string;
  name: string;
}

export type ChatBotMembershipProbe =
  | { known: true; members: ChatBotMembershipFact[] }
  | { known: false; members: []; reason: string };

export type DispatchReadinessIssueCode =
  | 'membership_unavailable'
  | 'worker_not_in_chat'
  | 'mention_identity_unavailable'
  | 'mention_identity_ambiguous'
  | 'mention_identity_mismatch'
  | 'capability_unknown'
  | 'capability_incompatible';

export interface DispatchReadinessIssue {
  severity: 'warning' | 'error';
  code: DispatchReadinessIssueCode;
  workerName?: string;
  detail: string;
}

export interface DispatchReadinessResult {
  ok: boolean;
  issues: DispatchReadinessIssue[];
}

export interface DispatchMentionResolution {
  workers: DispatchReadinessWorker[];
  matches: Array<{ openId: string; memberName?: string }>;
  issues: DispatchReadinessIssue[];
}

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function mergePeerFacts(peers: A2APeerCapability[]): A2APeerCapability | undefined {
  if (peers.length === 0) return undefined;
  const first = peers[0]!;
  const capabilities = [...new Set(peers.flatMap((peer) => peer.a2aCapabilities ?? []))];
  return {
    larkAppId: peers.find((peer) => peer.larkAppId)?.larkAppId ?? first.larkAppId,
    unionId: peers.find((peer) => peer.unionId)?.unionId ?? first.unionId,
    name: peers.find((peer) => peer.name)?.name ?? first.name,
    cliId: peers.find((peer) => peer.cliId)?.cliId ?? first.cliId,
    botmuxVersion: peers.find((peer) => peer.botmuxVersion)?.botmuxVersion ?? first.botmuxVersion,
    a2aCapabilities: capabilities.length > 0
      ? capabilities
      : peers.some((peer) => Array.isArray(peer.a2aCapabilities)) ? [] : undefined,
  };
}

function peerForWorker(worker: DispatchReadinessWorker, peers: A2APeerCapability[]): A2APeerCapability | undefined {
  if (worker.larkAppId) {
    const byApp = peers.filter((peer) => peer.larkAppId === worker.larkAppId);
    if (byApp.length > 0) return mergePeerFacts(byApp);
  }
  if (worker.unionId) {
    const byUnion = peers.filter((peer) => peer.unionId === worker.unionId);
    if (byUnion.length > 0) return mergePeerFacts(byUnion);
  }

  const labels = new Set([worker.name, worker.cliId, worker.openId].map(norm).filter(Boolean));
  const matches = peers.filter((peer) => labels.has(norm(peer.name)) || labels.has(norm(peer.cliId)));
  return matches.length === 1 ? matches[0] : undefined;
}

export function isMentionableBotOpenId(openId: string | undefined): boolean {
  return !!openId?.trim().startsWith('ou_') && openId.trim().length > 3;
}

function membershipCandidates(
  worker: DispatchReadinessWorker,
  peer: A2APeerCapability | undefined,
  members: ChatBotMembershipFact[],
): ChatBotMembershipFact[] {
  const exact = members.find((member) => member.openId === worker.openId);
  if (exact) return [exact];
  const labels = new Set([
    worker.name,
    worker.cliId,
    peer?.name,
    peer?.cliId,
  ].map(norm).filter(Boolean));
  if (labels.size === 0) return [];
  const unique = new Map<string, ChatBotMembershipFact>();
  for (const member of members) {
    if (labels.has(norm(member.name))) unique.set(member.openId, member);
  }
  return [...unique.values()];
}

/**
 * Resolve each worker to the observer-scoped bot_id returned by
 * `/members/bots`. A Lark app_id (`cli_*`) identifies a botmux deployment but
 * cannot be placed in an `<at user_id>` tag; only the observing app's `ou_*`
 * handle is mentionable.
 */
export function resolveDispatchMentionIdentities(input: {
  workers: DispatchReadinessWorker[];
  membership: ChatBotMembershipProbe;
  peers?: A2APeerCapability[];
  /** Frozen releases cannot rewrite their kickoff text after the intent exists. */
  requireExactOpenIds?: boolean;
}): DispatchMentionResolution {
  const peers = input.peers ?? [];
  const issues: DispatchReadinessIssue[] = [];
  const matches: DispatchMentionResolution['matches'] = [];
  const workers = input.workers.map((worker) => {
    if (!input.membership.known) {
      matches.push({ openId: worker.openId });
      if (!isMentionableBotOpenId(worker.openId)) {
        issues.push({
          severity: 'error',
          code: 'mention_identity_unavailable',
          workerName: worker.name,
          detail: `执行者 ${worker.name} 只有应用标识 ${worker.openId}，暂时无法解析成群内可 @ 的身份`,
        });
      }
      return worker;
    }

    const peer = peerForWorker(worker, peers);
    const candidates = membershipCandidates(worker, peer, input.membership.members);
    if (candidates.length === 0) {
      matches.push({ openId: worker.openId });
      issues.push({
        severity: 'error',
        code: 'worker_not_in_chat',
        workerName: worker.name,
        detail: `执行者 ${worker.name} 不在目标群，无法可靠触发`,
      });
      if (!isMentionableBotOpenId(worker.openId)) {
        issues.push({
          severity: 'error',
          code: 'mention_identity_unavailable',
          workerName: worker.name,
          detail: `执行者 ${worker.name} 没有可用于群内 @ 的 open_id`,
        });
      }
      return worker;
    }
    if (candidates.length > 1) {
      matches.push({ openId: worker.openId });
      issues.push({
        severity: 'error',
        code: 'mention_identity_ambiguous',
        workerName: worker.name,
        detail: `目标群里有多个名为 ${worker.name} 的机器人，无法确定要 @ 哪一个`,
      });
      return worker;
    }

    const member = candidates[0]!;
    matches.push({ openId: member.openId, memberName: member.name });
    if (!isMentionableBotOpenId(member.openId)) {
      issues.push({
        severity: 'error',
        code: 'mention_identity_unavailable',
        workerName: worker.name,
        detail: `执行者 ${worker.name} 的群成员记录没有可用 open_id`,
      });
      return worker;
    }
    if (input.requireExactOpenIds && member.openId !== worker.openId) {
      issues.push({
        severity: 'error',
        code: 'mention_identity_mismatch',
        workerName: worker.name,
        detail: `执行者 ${worker.name} 的待派发记录使用了失效身份；请取消后重新登记依赖任务`,
      });
    }
    return { ...worker, openId: member.openId };
  });

  return { workers, matches, issues };
}

/**
 * Evaluate facts collected by the CLI before it writes TaskDispatched or sends
 * the kickoff. Unknown external state is a warning, not a false-negative block;
 * known absence or an explicitly incompatible peer is an error.
 */
export function evaluateDispatchReadiness(input: {
  workers: DispatchReadinessWorker[];
  membership: ChatBotMembershipProbe;
  peers?: A2APeerCapability[];
  requiredCapabilities?: string[];
  requireExactMentionOpenIds?: boolean;
}): DispatchReadinessResult {
  const peers = input.peers ?? [];
  const required = [...new Set(input.requiredCapabilities ?? [])];
  const mentionResolution = resolveDispatchMentionIdentities({
    workers: input.workers,
    membership: input.membership,
    peers,
    requireExactOpenIds: input.requireExactMentionOpenIds,
  });
  const issues: DispatchReadinessIssue[] = [...mentionResolution.issues];

  if (!input.membership.known) {
    issues.push({
      severity: 'warning',
      code: 'membership_unavailable',
      detail: `暂时无法读取目标群成员：${input.membership.reason}`,
    });
  }

  for (const worker of mentionResolution.workers) {
    const peer = peerForWorker(worker, peers);
    if (worker.local || required.length === 0) continue;
    const advertised = peer?.a2aCapabilities?.filter((value): value is string => typeof value === 'string');
    if (!advertised) {
      issues.push({
        severity: 'warning',
        code: 'capability_unknown',
        workerName: worker.name,
        detail: `执行者 ${worker.name} 未上报跨设备能力${peer?.botmuxVersion ? `（botmux ${peer.botmuxVersion}）` : ''}；接收端会继续做版本校验`,
      });
      continue;
    }
    const missing = required.filter((capability) => !advertised.includes(capability));
    if (missing.length > 0) {
      issues.push({
        severity: 'error',
        code: 'capability_incompatible',
        workerName: worker.name,
        detail: `执行者 ${worker.name} 缺少能力 ${missing.join(', ')}${peer?.botmuxVersion ? `（botmux ${peer.botmuxVersion}）` : ''}`,
      });
    }
  }

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}
