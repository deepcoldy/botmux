/**
 * S2-S5 编排本体（PR-3b-2，design §7.2/§8.2/§9/§10.2）。
 *
 * 复用 PR-2a/3a 已建立的持久状态机标准：
 *   - withCollabInitIdMutex 包裹完整「判重/外部副作用」临界区；
 *   - 逐 operation 落账（writeCollabOperation）+ payloadHash 统一校验；
 *   - 活动 state 守卫（awaiting-input/cancelled/failed/done 阻止启动，仅人工推进）；
 *   - 真 DAG 拓扑序 + afterAgentTurn 绑定上游 durable receipt；
 *   - KICKOFF_TIMEOUT 落 awaiting-input + advanceCollabStep 推进 step。
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
import { runCollabRoleVerification, markGateRoleReady, type RoleVerifyDeps } from './collab-role-verify.js';
import { evaluateArtifactReady, kickoffTimedOut, KICKOFF_TIMEOUT_MS, type ArtifactReadyFacts, type CollabArtifactSatisfiedBy } from './collab-artifact-ready.js';

export interface S2S5Deps {
  dataDir: string;
  now: () => number;
  listMembers: (larkAppId: string, chatId: string) => Promise<string[]>;
  addBotToChat: (larkAppId: string, chatId: string, botAppId: string) => Promise<void>;
  triggerGrant: (targetAppId: string) => Promise<{ ok: boolean; message?: string }>;
  roleVerify: RoleVerifyDeps;
  kickoffPrepare: (appId: string, prompt: string) => Promise<{ ok: boolean; message?: string }>;
  /** 返回有效三元组；未激活返回 ok:false。 */
  kickoffStart: (appId: string) => Promise<{ ok: boolean; sessionId?: string; turnId?: string; acceptedAt?: string }>;
  /** 被依赖 kickoff 的 durable 回执 facts（含 sessionId/turnId/messageId/contentHash）。 */
  artifactFacts: (depAppId: string) => Promise<ArtifactReadyFacts & { sessionId?: string; turnId?: string; contentHash?: string }>;
}

type OpWriteCheckedResult =
  | { ok: true; existing?: CollabGroupInitEntry['operations'][string] }
  | { ok: false; reason: string };

/**
 * payloadHash 统一校验后的 operation 落账（F6）：done/unknown/attempting 分支前统一检查。
 * 冲突 → 保留旧 operation 事实，不覆盖。
 */
async function writeOpChecked(opts: {
  dataDir: string; creatorAppId: string; initId: string; opKey: string;
  payloadHash: string;
  write: () => Promise<void>;
}): Promise<OpWriteCheckedResult> {
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  if (!entry) return { ok: false, reason: 'entry_missing' };
  const existing = entry.operations[opts.opKey];
  if (existing && existing.payloadHash !== opts.payloadHash) {
    return { ok: false, reason: `payloadHash conflict on ${opts.opKey}` };
  }
  await opts.write();
  return { ok: true, existing };
}

/** 活动 state 守卫（F1）：awaiting-input/cancelled/failed/done 阻止启动。 */
function guardActiveState(entry: CollabGroupInitEntry | undefined): { ok: boolean; reason?: string } {
  if (!entry) return { ok: false, reason: 'entry_missing' };
  if (entry.state === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (entry.state === 'awaiting-input') return { ok: false, reason: 'awaiting_input' };
  if (entry.state === 'failed') return { ok: false, reason: 'failed' };
  if (entry.state === 'done') return { ok: false, reason: 'done' };
  return { ok: true };
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
  // 对待启动 target 做严格角色回读。
  const target = opts.targetAppId ?? opts.larkAppId;
  const role = runCollabRoleVerification(target, opts.chatId, opts.config, opts.roleVerify);
  if (!role.ready) return { ok: false, reason: role.conflict ?? 'role_not_ready' };
  return { ok: true };
}

/** S2 invite：逐 peer 落 operation + 缺员重发，done 校验 hash 后短路。 */
export async function runS2Invites(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string;
  peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<void> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return;
  const members = await opts.deps.listMembers(opts.creatorAppId, opts.chatId);
  for (const peer of opts.peers) {
    const opKey = `invite:${peer.appId}`;
    const payloadHash = collabPayloadHash({ chatId: opts.chatId, appId: peer.appId });
    const cur = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = cur.operations[opKey];
    if (existing?.status === 'done') {
      if (existing.payloadHash !== payloadHash) { await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'failed', payloadHash: existing.payloadHash, error: 'payloadHash conflict' } }); }
      continue;
    }
    if (existing && existing.payloadHash !== payloadHash) { continue; }
    const r = await writeOpChecked({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, payloadHash, write: async () => writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'attempting', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now } }) });
    if (!r.ok) continue;
    if (!members.includes(peer.appId)) {
      try {
        await opts.deps.addBotToChat(opts.creatorAppId, opts.chatId, peer.appId);
        await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'done', payloadHash, receipt: { chatId: opts.chatId } } });
      } catch (err) {
        await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'unknown', payloadHash, error: String((err as any)?.message ?? err) } });
      }
    } else {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'done', payloadHash, receipt: { already_member: true } } });
    }
  }
}

/** S3 grants：逐 peer 落 operation + IPC 触发，peer 离线阻塞可见；done/unknown 校验 hash。 */
export async function runS3Grants(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string;
  peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<Array<{ appId: string; ready: boolean; message?: string }>> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return opts.peers.map(p => ({ appId: p.appId, ready: false, message: guard.reason }));
  const results: Array<{ appId: string; ready: boolean; message?: string }> = [];
  for (const peer of opts.peers) {
    const opKey = `grant:${peer.appId}`;
    const payloadHash = collabPayloadHash({ chatId: opts.chatId, appId: peer.appId });
    const cur = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = cur.operations[opKey];
    if (existing?.status === 'done') {
      if (existing.payloadHash !== payloadHash) { results.push({ appId: peer.appId, ready: false, message: 'payloadHash conflict' }); continue; }
      results.push({ appId: peer.appId, ready: true }); continue;
    }
    if (existing && existing.payloadHash !== payloadHash) { results.push({ appId: peer.appId, ready: false, message: 'payloadHash conflict' }); continue; }
    const r = await writeOpChecked({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, payloadHash, write: async () => writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'attempting', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now } }) });
    if (!r.ok) { results.push({ appId: peer.appId, ready: false, message: r.reason }); continue; }
    const g = await opts.deps.triggerGrant(peer.appId);
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

/** S4 roles：逐 peer 角色校验（done 不能短路当前回读），全绿 markGateRoleReady。 */
export async function runS4Roles(opts: {
  dataDir: string; creatorAppId: string; chatId: string; initId: string; configVersion: string;
  config: SessionGroupCollaborationConfig; peers: Array<{ appId: string }>; deps: S2S5Deps;
}): Promise<{ allReady: boolean; conflict?: string }> {
  const now = opts.deps.now();
  const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
  const guard = guardActiveState(entry);
  if (!guard.ok) return { allReady: false, conflict: guard.reason };
  for (const peer of opts.peers) {
    const opKey = `role:${peer.appId}`;
    const payloadHash = collabPayloadHash({ appId: peer.appId, configVersion: opts.configVersion });
    // F2：done 只短路重复代写，不短路当前回读。
    const role = runCollabRoleVerification(peer.appId, opts.chatId, opts.config, opts.deps.roleVerify);
    if (!role.ready) {
      await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'ROLE_CONFLICT', since: now, detail: role.conflict }; e.updatedAt = now; return true; } });
      return { allReady: false, conflict: role.conflict ?? 'role_not_ready' };
    }
    const r = await writeOpChecked({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, payloadHash, write: async () => writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'role', status: 'done', payloadHash, receipt: { verified: true } } }) });
    if (!r.ok) return { allReady: false, conflict: r.reason };
    markGateRoleReady(opts.dataDir, opts.chatId, peer.appId);
  }
  return { allReady: true };
}

/** 真 DAG 拓扑序：immediate 或前驱已 started 才就绪。 */
function topologicalOrder(config: SessionGroupCollaborationConfig): string[] {
  const kickoff = config.kickoff;
  const started = new Set<string>();
  const out: string[] = [];
  let progressed = true;
  while (out.length < kickoff.length && progressed) {
    progressed = false;
    for (const k of kickoff) {
      if (out.includes(k.appId)) continue;
      if (k.trigger === 'immediate') { out.push(k.appId); started.add(k.appId); progressed = true; continue; }
      const dep = k.afterAppId!;
      if (started.has(dep)) { out.push(k.appId); started.add(k.appId); progressed = true; }
    }
  }
  return out;
}

/**
 * S5 kickoff 依赖启动（F3：withCollabInitIdMutex 包裹；F4：真拓扑序 + satisfiedBy 绑定上游；
 * F5：KICKOFF_TIMEOUT + advanceCollabStep）。
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
  const startedSet = new Set<string>();

  for (const appId of order) {
    // 每个 await 之后、尤其 start 前重新读 entry 校验 state。
    const reEntry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId);
    const reGuard = guardActiveState(reEntry);
    if (!reGuard.ok) return { done: false, awaitingInput: reGuard.reason };
    const reverify = reverifyCollabRoleAndConfig({
      dataDir: opts.dataDir, larkAppId: opts.creatorAppId, chatId: opts.chatId, initId: opts.initId,
      configVersion: opts.configVersion, config: opts.config, roleVerify: opts.deps.roleVerify, targetAppId: appId,
    });
    if (!reverify.ok) return { done: false, awaitingInput: reverify.reason };

    const k = opts.config.kickoff.find(k => k.appId === appId)!;
    const kickoffId = collabKickoffId(opts.initId, appId, opts.configVersion);
    const payloadHash = collabPayloadHash({ initId: opts.initId, appId, configVersion: opts.configVersion, trigger: k.trigger, afterAppId: k.afterAppId });

    // 逐 target operation 幂等。
    const opKey = `kickoff:${appId}`;
    const curOp = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!.operations[opKey];
    if (curOp?.status === 'done') { startedSet.add(appId); continue; }
    if (curOp && curOp.payloadHash !== payloadHash) return { done: false, awaitingInput: `kickoff payloadHash conflict: ${appId}` };

    // afterAgentTurn：等依赖满足（绑定上游 durable 回执）。
    let satisfiedBy: CollabArtifactSatisfiedBy | undefined;
    if (k.trigger === 'afterAgentTurn') {
      const depAppId = k.afterAppId!;
      const facts = await opts.deps.artifactFacts(depAppId);
      // F5：超窗。
      if (kickoffTimedOut((reEntry?.awaiting?.since ?? 0) || now, now, KICKOFF_TIMEOUT_MS) && reEntry?.awaiting?.reason === 'KICKOFF_TIMEOUT') {
        return { done: false, awaitingInput: 'KICKOFF_TIMEOUT' };
      }
      const artifact = (k.artifact ?? { type: 'marked-url', hosts: [] }) as CollabArtifactSpec;
      const evalResult = evaluateArtifactReady({
        facts,
        artifact,
        receiptId: `kick_${kickoffId}`,
        kickoffId,
        sessionId: facts.sessionId ?? '',
        turnId: facts.turnId ?? '',
        contentHash: facts.contentHash ?? '',
      });
      if (!evalResult.ready) {
        // 首次等待持久 since（F5）。
        if (!reEntry?.awaiting) {
          await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.awaiting = { reason: 'KICKOFF_TIMEOUT', since: now }; e.updatedAt = now; return true; } });
        }
        return { done: false, awaitingInput: `artifact not ready: ${evalResult.reason}` };
      }
      satisfiedBy = evalResult.satisfiedBy;
    }

    // 先落 attempting，再 prepare。
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'kickoff', status: 'attempting', uuid: kickoffId, payloadHash, firstAttemptAt: curOp?.firstAttemptAt ?? now } });
    const prep = await opts.deps.kickoffPrepare(appId, k.prompt ?? '');
    if (!prep.ok) return { done: false, awaitingInput: `kickoff prepare failed: ${prep.message}` };
    const started = await opts.deps.kickoffStart(appId);
    if (!started.ok || !started.sessionId || !started.turnId || !started.acceptedAt) {
      return { done: false, awaitingInput: 'kickoff start not ready (missing session/turn/acceptedAt)' };
    }
    // 持久三元组 + done。
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'kickoff', status: 'done', uuid: kickoffId, payloadHash, receipt: { sessionId: started.sessionId, turnId: started.turnId, acceptedAt: started.acceptedAt } } });
    await patchCollabInitEntry({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, mutate: (e) => { e.kickoffPending = { ...(e.kickoffPending ?? {}), [appId]: { appId, ...(satisfiedBy ? { satisfiedBy } : {}) } }; e.updatedAt = now; return true; } });
    startedSet.add(appId);
  }

  // F5：完成后推进 kickoff step。
  await advanceCollabStep({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, step: 'kickoff', status: 'done', now });
  return { done: true };
}
