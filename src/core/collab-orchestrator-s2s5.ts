/**
 * S2-S5 编排本体（PR-3b-2，design §7.2/§8.2/§9/§10.2）。
 *
 * 复用 PR-2a/3a 已建立的持久状态机标准：
 *   - withCollabInitIdMutex 包裹完整「判重/外部副作用」临界区；
 *   - 逐 operation 落账（writeCollabOperation）+ payloadHash 统一校验（done/unknown/attempting 全覆盖）；
 *   - 活动 state 守卫（awaiting-input/cancelled/failed/done 阻止启动，仅人工推进），每个 await 后重读；
 *   - 真 DAG 拓扑序 + afterAgentTurn 绑定上游 durable receipt；
 *   - KICKOFF_TIMEOUT 原子推进 awaiting-input + advanceCollabStep 推进 step。
 */
import {
  collabKickoffId,
  collabPayloadHash,
  type CollabArtifactSpec,
  type SessionGroupCollaborationConfig,
} from '../services/collab-group-config.js';
import {
  patchCollabInitEntry,
  readCollabInitEntry,
  writeCollabOperation,
  advanceCollabStep,
  withCollabInitIdMutex,
  type CollabGroupInitEntry,
} from '../services/collab-init-store.js';
import { runCollabRoleVerification, markGateRoleReady, type RoleVerifyDeps, type CollabRoleSnapshot } from './collab-role-verify.js';
import { evaluateArtifactReady, kickoffTimedOut, KICKOFF_TIMEOUT_MS, type ArtifactReadyFacts, type CollabArtifactSatisfiedBy } from './collab-artifact-ready.js';

export interface S2S5Deps {
  dataDir: string;
  now: () => number;
  listMembers: (larkAppId: string, chatId: string) => Promise<string[]>;
  addBotToChat: (larkAppId: string, chatId: string, botAppId: string) => Promise<void>;
  triggerGrant: (targetAppId: string) => Promise<{ ok: boolean; message?: string }>;
  roleVerify: RoleVerifyDeps;
  kickoffPrepare: (appId: string, prompt: string) => Promise<{ ok: boolean; message?: string }>;
  kickoffStart: (appId: string) => Promise<{ ok: boolean; sessionId?: string; turnId?: string; acceptedAt?: string }>;
  /** 被依赖 kickoff 的 durable 回执 facts（sessionId/turnId/messageId/contentHash 必须非空）。 */
  artifactFacts: (depAppId: string) => Promise<ArtifactReadyFacts & { sessionId?: string; turnId?: string; contentHash?: string }>;
}

/** 活动 state 守卫：awaiting-input/cancelled/failed/done 阻止启动，仅人工推进。 */
function guardActiveState(entry: CollabGroupInitEntry | undefined): { ok: boolean; reason?: string } {
  if (!entry) return { ok: false, reason: 'entry_missing' };
  if (entry.state === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (entry.state === 'awaiting-input') return { ok: false, reason: 'awaiting_input' };
  if (entry.state === 'failed') return { ok: false, reason: 'failed' };
  if (entry.state === 'done') return { ok: false, reason: 'done' };
  return { ok: true };
}

/** R1：每个 await 之后重读 entry 校验 state。返回 fresh entry，或 {ok:false}。 */
function recheckState(dataDir: string, creatorAppId: string, initId: string): { ok: true; entry: CollabGroupInitEntry } | { ok: false; reason: string } {
  const entry = readCollabInitEntry(dataDir, creatorAppId, initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return { ok: false, reason: guard.reason! };
  return { ok: true, entry: entry! };
}

function frozenRoleSnapshot(entry: CollabGroupInitEntry): CollabRoleSnapshot | undefined {
  if (entry.resolvedProfileEntries === undefined || entry.referencedTeamRoles === undefined) return undefined;
  return {
    resolvedProfileEntries: entry.resolvedProfileEntries,
    referencedTeamRoles: entry.referencedTeamRoles,
  };
}

/**
 * 每次状态迁移/kickoff 准入前：活动 state + configVersion 比对 + 目标角色重校验。
 */
export function reverifyCollabRoleAndConfig(opts: {
  dataDir: string;
  larkAppId: string;
  chatId: string;
  initId: string;
  configVersion: string;
  config: SessionGroupCollaborationConfig;
  roleVerify: RoleVerifyDeps;
  targetAppId?: string;
}): { ok: boolean; reason?: string } {
  const entry = readCollabInitEntry(opts.dataDir, opts.larkAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return guard;
  if (entry!.configVersion !== opts.configVersion) return { ok: false, reason: 'config_version_changed' };
  const target = opts.targetAppId ?? opts.larkAppId;
  const role = runCollabRoleVerification(target, opts.chatId, opts.config, opts.roleVerify, frozenRoleSnapshot(entry!));
  if (!role.ready) return { ok: false, reason: role.conflict ?? 'role_not_ready' };
  return { ok: true };
}

/**
 * payloadHash 统一校验（R4）：done/unknown/attempting 分支前统一检查。
 * 冲突 → 保留旧 operation 事实，不重写成功事实。
 */
function checkPayloadHash(existing: CollabGroupInitEntry['operations'][string] | undefined, payloadHash: string): { ok: boolean; reason?: string } {
  if (existing && existing.payloadHash !== payloadHash) return { ok: false, reason: 'payloadHash conflict' };
  return { ok: true };
}

/** S2 invite：逐 peer 落 operation + 缺员重发；每个 await 后重读 state。 */
export function runS2Invites(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string;
  peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<void> {
  return withCollabInitIdMutex(opts.initId, () => runS2InvitesCritical(opts));
}

async function runS2InvitesCritical(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string;
  peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<void> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  if (!guardActiveState(entry).ok) return;
  const members = await opts.deps.listMembers(opts.creatorAppId, opts.chatId);
  // R1：await 之后重读 state。
  if (!recheckState(opts.dataDir, opts.creatorAppId, opts.initId).ok) return;
  for (const peer of opts.peers) {
    // N1：每轮循环开头检查活动状态，非活动立即终止整个 S2。
    if (!recheckState(opts.dataDir, opts.creatorAppId, opts.initId).ok) return;
    const opKey = `invite:${peer.appId}`;
    const payloadHash = collabPayloadHash({ chatId: opts.chatId, appId: peer.appId });
    const cur = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = cur.operations[opKey];
    if (existing?.status === 'done') {
      // R4：done 分支校验 hash，冲突不重写成功事实（保留原 receipt）。
      if (!checkPayloadHash(existing, payloadHash).ok) return;
      continue;
    }
    if (!checkPayloadHash(existing, payloadHash).ok) return;
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'attempting', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now } });
    if (!recheckState(opts.dataDir, opts.creatorAppId, opts.initId).ok) return;
    if (!members.includes(peer.appId)) {
      try {
        await opts.deps.addBotToChat(opts.creatorAppId, opts.chatId, peer.appId);
        // N1/R1：await 之后重读 state，非活动立即终止整个 S2（不继续下一 peer）。
        const rc = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
        if (!rc.ok) {
          await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'unknown', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now, error: `cancelled after invite: ${rc.reason}` } });
          return;
        }
        await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'done', payloadHash, receipt: { chatId: opts.chatId } } });
      } catch (err) {
        await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'unknown', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now, error: String((err as any)?.message ?? err) } });
      }
    } else {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'done', payloadHash, receipt: { already_member: true } } });
    }
  }
}

/** S3 grants：逐 peer 落 operation + IPC 触发；每个 await 后重读 state。 */
export function runS3Grants(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string;
  peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<Array<{ appId: string; ready: boolean; message?: string }>> {
  return withCollabInitIdMutex(opts.initId, () => runS3GrantsCritical(opts));
}

async function runS3GrantsCritical(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string;
  peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<Array<{ appId: string; ready: boolean; message?: string }>> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return opts.peers.map(p => ({ appId: p.appId, ready: false, message: guard.reason }));
  const results: Array<{ appId: string; ready: boolean; message?: string }> = [];
  for (const peer of opts.peers) {
    // R1：每个 peer 循环开头重读 state。
    const rc0 = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rc0.ok) { results.push({ appId: peer.appId, ready: false, message: rc0.reason }); continue; }
    const opKey = `grant:${peer.appId}`;
    const payloadHash = collabPayloadHash({ chatId: opts.chatId, appId: peer.appId });
    const cur = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = cur.operations[opKey];
    if (existing?.status === 'done') {
      if (!checkPayloadHash(existing, payloadHash).ok) { results.push({ appId: peer.appId, ready: false, message: 'payloadHash conflict' }); continue; }
      results.push({ appId: peer.appId, ready: true }); continue;
    }
    if (!checkPayloadHash(existing, payloadHash).ok) { results.push({ appId: peer.appId, ready: false, message: 'payloadHash conflict' }); continue; }
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'attempting', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now } });
    const rcBeforeGrant = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rcBeforeGrant.ok) {
      results.push({ appId: peer.appId, ready: false, message: rcBeforeGrant.reason });
      continue;
    }
    const g = await opts.deps.triggerGrant(peer.appId);
    // R1：await 之后重读 state。
    const rc = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rc.ok) {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'unknown', payloadHash, error: `cancelled after grant: ${rc.reason}` } });
      results.push({ appId: peer.appId, ready: false, message: rc.reason });
      continue;
    }
    if (g.ok) {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'done', payloadHash, receipt: { chatId: opts.chatId } } });
      results.push({ appId: peer.appId, ready: true });
    } else {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'unknown', payloadHash, error: g.message ?? 'peer offline' } });
      results.push({ appId: peer.appId, ready: false, message: g.message ?? 'peer offline' });
    }
  }
  return results;
}

/** S4 roles：逐 peer 角色校验（done 只短路重复代写不短路回读），全绿 markGateRoleReady。 */
export function runS4Roles(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string; configVersion: string;
  config: SessionGroupCollaborationConfig; peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<{ allReady: boolean; conflict?: string }> {
  return withCollabInitIdMutex(opts.initId, () => runS4RolesCritical(opts));
}

async function runS4RolesCritical(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string; configVersion: string;
  config: SessionGroupCollaborationConfig; peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<{ allReady: boolean; conflict?: string }> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return { allReady: false, conflict: guard.reason };
  for (const peer of opts.peers) {
    const rcLoop = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rcLoop.ok) return { allReady: false, conflict: rcLoop.reason };
    const opKey = `role:${peer.appId}`;
    const payloadHash = collabPayloadHash({ appId: peer.appId, configVersion: opts.configVersion });
    // F2：done 只短路重复代写，不短路当前回读；expected 内容只来自 S0 冻结快照。
    const role = runCollabRoleVerification(peer.appId, opts.chatId, opts.config, opts.deps.roleVerify, frozenRoleSnapshot(rcLoop.entry));
    if (!role.ready) {
      await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'ROLE_CONFLICT', since: now, detail: role.conflict }; e.updatedAt = now; return true; } });
      return { allReady: false, conflict: role.conflict ?? 'role_not_ready' };
    }
    const cur = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = cur.operations[opKey];
    if (!checkPayloadHash(existing, payloadHash).ok) return { allReady: false, conflict: 'payloadHash conflict' };
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'role', status: 'done', payloadHash, receipt: { verified: true } } });
    const rcBeforeGate = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rcBeforeGate.ok) return { allReady: false, conflict: rcBeforeGate.reason };
    markGateRoleReady(opts.dataDir, opts.chatId, peer.appId);
  }
  return { allReady: true };
}

/** 真 DAG 拓扑序：这里只计算依赖顺序，不把“已入列”误当成“已启动”。 */
function topologicalOrder(config: SessionGroupCollaborationConfig): string[] {
  const kickoff = config.kickoff;
  const ordered = new Set<string>();
  const out: string[] = [];
  let progressed = true;
  while (out.length < kickoff.length && progressed) {
    progressed = false;
    for (const k of kickoff) {
      if (out.includes(k.appId)) continue;
      if (k.trigger === 'immediate') { out.push(k.appId); ordered.add(k.appId); progressed = true; continue; }
      const dep = k.afterAppId!;
      if (ordered.has(dep)) { out.push(k.appId); ordered.add(k.appId); progressed = true; }
    }
  }
  return out;
}

/**
 * S5 kickoff 依赖启动（F3 mutex；F4 真拓扑 + satisfiedBy 绑定上游；F5 超窗 + step；
 * R1 await 后重读；R2 完整证明；R4 done 校验 hash；R5 done 分支重建投影）。
 */
export async function runS5Kickoff(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string; configVersion: string;
  config: SessionGroupCollaborationConfig; deps: S2S5Deps;
}): Promise<{ done: boolean; awaitingInput?: string }> {
  return withCollabInitIdMutex(opts.initId, () => runS5Critical(opts));
}

async function runS5Critical(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string; configVersion: string;
  config: SessionGroupCollaborationConfig; deps: S2S5Deps;
}): Promise<{ done: boolean; awaitingInput?: string }> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return { done: false, awaitingInput: guard.reason };

  const order = topologicalOrder(opts.config);
  let sawPending = false;
  let pendingReason: string | undefined;

  for (const appId of order) {
    // 循环开头重读 state + 角色/config。
    const reEntry = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!reEntry.ok) return { done: false, awaitingInput: reEntry.reason };
    const reverify = reverifyCollabRoleAndConfig({
      dataDir: opts.dataDir, larkAppId: opts.creatorAppId, chatId: opts.chatId, initId: opts.initId,
      configVersion: opts.configVersion, config: opts.config, roleVerify: opts.deps.roleVerify, targetAppId: appId,
    });
    if (!reverify.ok) return { done: false, awaitingInput: reverify.reason };

    const k = opts.config.kickoff.find(k => k.appId === appId)!;
    const kickoffId = collabKickoffId(opts.initId, appId, opts.configVersion);
    const payloadHash = collabPayloadHash({ initId: opts.initId, appId, configVersion: opts.configVersion, trigger: k.trigger, afterAppId: k.afterAppId });

    const opKey = `kickoff:${appId}`;
    const curOp = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!.operations[opKey];
    // R4：done 分支先校验 hash；冲突拒绝不重写成功事实。
    if (curOp?.status === 'done') {
      if (!checkPayloadHash(curOp, payloadHash).ok) return { done: false, awaitingInput: `kickoff payloadHash conflict: ${appId}` };
      // N3/R5：done 分支从 durable operation 的 receipt 重建 kickoffPending（含 satisfiedBy）。
      const curEntry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
      const receipt = curOp.receipt as { sessionId?: string; turnId?: string; acceptedAt?: string; satisfiedBy?: CollabArtifactSatisfiedBy } | undefined;
      if (!curEntry.kickoffPending?.[appId] || !curEntry.kickoffPending[appId].satisfiedBy) {
        const pending: { appId: string; satisfiedBy?: CollabArtifactSatisfiedBy } = { appId };
        if (receipt?.satisfiedBy) pending.satisfiedBy = receipt.satisfiedBy;
        await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.kickoffPending = { ...(e.kickoffPending ?? {}), [appId]: pending }; e.updatedAt = now; return true; } });
      }
      continue;
    }
    if (!checkPayloadHash(curOp, payloadHash).ok) return { done: false, awaitingInput: `kickoff payloadHash conflict: ${appId}` };

    // 拓扑入列不等于上游已启动。上游尚无 durable done 时只跳过本分支，
    // 其它 immediate / 已满足依赖的独立分支仍须继续调度。
    if (k.trigger === 'afterAgentTurn') {
      const upstream = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!
        .operations[`kickoff:${k.afterAppId!}`];
      if (upstream?.status !== 'done') {
        sawPending = true;
        pendingReason = `dependency not started: ${k.afterAppId}`;
        continue;
      }
    }

    // afterAgentTurn：等依赖满足（R2：绑定上游完整证明）。
    let satisfiedBy: CollabArtifactSatisfiedBy | undefined;
    if (k.trigger === 'afterAgentTurn') {
      const depAppId = k.afterAppId!;
      const facts = await opts.deps.artifactFacts(depAppId);
      // R1：await 之后重读 state。
      const rc = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
      if (!rc.ok) return { done: false, awaitingInput: rc.reason };
      // N2：每个等待目标独立持久 since，避免一个分支成功/等待重置另一分支的超窗。
      const curEntry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
      const recordedSince = curEntry.kickoffPending?.[appId]?.since
        ?? (curEntry.awaiting?.reason === 'KICKOFF_PENDING' ? curEntry.awaiting.since : undefined);
      const since = recordedSince ?? now;
      if (recordedSince === undefined) {
        await patchCollabInitEntry({
          dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId,
          mutate: (e) => {
            const previous = e.kickoffPending?.[appId];
            e.kickoffPending = { ...(e.kickoffPending ?? {}), [appId]: { ...previous, appId, since } };
            e.updatedAt = opts.deps.now();
            return true;
          },
        });
        const rcPending = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
        if (!rcPending.ok) return { done: false, awaitingInput: rcPending.reason };
      }
      if (kickoffTimedOut(since, opts.deps.now(), KICKOFF_TIMEOUT_MS)) {
        await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'KICKOFF_TIMEOUT', since }; e.updatedAt = opts.deps.now(); return true; } });
        return { done: false, awaitingInput: 'KICKOFF_TIMEOUT' };
      }
      // terminal 明确 failed/cancelled → 直接 awaiting-input + 具体原因（N2）。
      if (facts.terminalStatus === 'failed' || facts.terminalStatus === 'cancelled') {
        await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: `ARTIFACT_${facts.terminalStatus.toUpperCase()}`, since }; e.updatedAt = opts.deps.now(); return true; } });
        return { done: false, awaitingInput: `artifact not ready: ${facts.terminalStatus}` };
      }
      if (facts.terminalStatus !== 'succeeded') {
        // waiting_input/blocked/reconciling：只保留本分支 pending，不饿死独立分支。
        sawPending = true;
        pendingReason = `artifact not ready: ${facts.terminalStatus}`;
        continue;
      }
      // R2：完整证明才启动——缺三元组/hash → awaiting-input（N2）。
      if (!facts.sessionId || !facts.turnId || !facts.messageId || !facts.contentHash) {
        await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'ARTIFACT_PROOF_INCOMPLETE', since }; e.updatedAt = opts.deps.now(); return true; } });
        return { done: false, awaitingInput: 'artifact proof incomplete (missing session/turn/message/hash)' };
      }
      const artifact = (k.artifact ?? { type: 'marked-url', hosts: [] }) as CollabArtifactSpec;
      // satisfiedBy 用上游 afterAppId 的 kickoffId/receiptId（R2）。
      const upstreamKickoffId = collabKickoffId(opts.initId, depAppId, opts.configVersion);
      const evalResult = evaluateArtifactReady({
        facts,
        artifact,
        receiptId: `kick_${upstreamKickoffId}`,
        kickoffId: upstreamKickoffId,
        sessionId: facts.sessionId,
        turnId: facts.turnId,
        contentHash: facts.contentHash,
      });
      if (!evalResult.ready) {
        // F2：NO_MARKER/HOST_NOT_ALLOWED/MISSING_URL 是终态失败 → awaiting-input（人工推进）；
        // NOT_DELIVERED 是真正等投递 → KICKOFF_PENDING。
        if (evalResult.reason === 'NO_MARKER' || evalResult.reason === 'HOST_NOT_ALLOWED' || evalResult.reason === 'MISSING_URL') {
          await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: `ARTIFACT_${evalResult.reason}`, since }; e.updatedAt = opts.deps.now(); return true; } });
          return { done: false, awaitingInput: `artifact not ready: ${evalResult.reason}` };
        }
        sawPending = true;
        pendingReason = `artifact not ready: ${evalResult.reason}`;
        continue;
      }
      satisfiedBy = evalResult.satisfiedBy;
    }

    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'kickoff', status: 'attempting', uuid: kickoffId, payloadHash, firstAttemptAt: curOp?.firstAttemptAt ?? now } });
    const rcBeforePrepare = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rcBeforePrepare.ok) return { done: false, awaitingInput: rcBeforePrepare.reason };
    const prep = await opts.deps.kickoffPrepare(appId, k.prompt ?? '');
    // R1：await 之后重读 state。
    const rcPrep = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rcPrep.ok) { await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'kickoff', status: 'unknown', payloadHash, error: `cancelled after prepare: ${rcPrep.reason}` } }); return { done: false, awaitingInput: rcPrep.reason }; }
    if (!prep.ok) return { done: false, awaitingInput: `kickoff prepare failed: ${prep.message}` };
    const started = await opts.deps.kickoffStart(appId);
    // R1：await 之后重读 state。
    const rcStart = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
    if (!rcStart.ok) {
      // N4：取消后的已知 start 成功保留有效三元组（审计），不降成无凭据 unknown。
      const lateReceipt = (started.ok && started.sessionId && started.turnId && started.acceptedAt)
        ? { sessionId: started.sessionId, turnId: started.turnId, acceptedAt: started.acceptedAt }
        : undefined;
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'kickoff', status: 'unknown', uuid: kickoffId, firstAttemptAt: curOp?.firstAttemptAt ?? now, payloadHash, error: `cancelled after start: ${rcStart.reason}`, ...(lateReceipt ? { receipt: lateReceipt } : {}) } });
      return { done: false, awaitingInput: rcStart.reason };
    }
    if (!started.ok || !started.sessionId || !started.turnId || !started.acceptedAt) {
      return { done: false, awaitingInput: 'kickoff start not ready (missing session/turn/acceptedAt)' };
    }
    // N3/R5/F1：三元组 + satisfiedBy + done + kickoffPending 投影在同次 entry 原子写提交；
    // 成功提交后清理旧 pending 计时，下一跳建立新 since。
    await patchCollabInitEntry({
      dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId,
      mutate: (e) => {
        e.operations[opKey] = { kind: 'kickoff', status: 'done', uuid: kickoffId, firstAttemptAt: curOp?.firstAttemptAt ?? now, payloadHash, receipt: { sessionId: started.sessionId, turnId: started.turnId, acceptedAt: started.acceptedAt, ...(satisfiedBy ? { satisfiedBy } : {}) } };
        e.kickoffPending = { ...(e.kickoffPending ?? {}), [appId]: { appId, ...(satisfiedBy ? { satisfiedBy } : {}) } };
        if (e.awaiting?.reason === 'KICKOFF_PENDING') delete e.awaiting; // 兼容旧共享 pending 投影
        e.updatedAt = now;
        return true;
      },
    });
  }

  if (sawPending) return { done: false, awaitingInput: pendingReason ?? 'dependency pending' };
  const finalState = recheckState(opts.dataDir, opts.creatorAppId, opts.initId);
  if (!finalState.ok) return { done: false, awaitingInput: finalState.reason };
  await advanceCollabStep({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, step: 'kickoff', status: 'done', now });
  return { done: true };
}
