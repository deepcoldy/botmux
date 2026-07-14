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

function workerIsMember(
  worker: DispatchReadinessWorker,
  peer: A2APeerCapability | undefined,
  members: ChatBotMembershipFact[],
): boolean {
  if (members.some((member) => member.openId === worker.openId)) return true;
  const labels = new Set([
    worker.name,
    worker.cliId,
    peer?.name,
    peer?.cliId,
  ].map(norm).filter(Boolean));
  return labels.size > 0 && members.some((member) => labels.has(norm(member.name)));
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
}): DispatchReadinessResult {
  const issues: DispatchReadinessIssue[] = [];
  const peers = input.peers ?? [];
  const required = [...new Set(input.requiredCapabilities ?? [])];

  if (!input.membership.known) {
    issues.push({
      severity: 'warning',
      code: 'membership_unavailable',
      detail: `暂时无法读取目标群成员：${input.membership.reason}`,
    });
  }

  for (const worker of input.workers) {
    const peer = peerForWorker(worker, peers);
    if (input.membership.known && !workerIsMember(worker, peer, input.membership.members)) {
      issues.push({
        severity: 'error',
        code: 'worker_not_in_chat',
        workerName: worker.name,
        detail: `执行者 ${worker.name} 不在目标群，无法可靠触发`,
      });
    }

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
