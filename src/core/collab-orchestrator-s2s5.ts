/**
 * S2-S5 编排本体（PR-3b-2，design §7.2/§8.2/§9/§10.2）。
 *
 * S2 invite：逐 peer appId 落 invite operation，回读缺员才重发，done 不重复，unknown 重读对账。
 * S3 grants：逐 peer appId 落 grant operation，经 IPC 触发接收方 daemon 自己写 talk-only matrix。
 * S4 roles：逐 peer runCollabRoleVerification，全绿 markGateRoleReady；冲突 awaiting-input('ROLE_CONFLICT')。
 * S5 kickoff：immediate 按 DAG 拓扑序 prepare→start；afterAgentTurn 等 evaluateArtifactReady 五条件；
 *   satisfiedBy 写 entry.kickoffPending[appId]；30min KICKOFF_TIMEOUT → awaiting-input。
 *
 * 每次状态迁移/kickoff 准入前调 reverifyCollabRoleAndConfig（角色重校验 + configVersion 比对）。
 * 沿用 withCollabInitIdMutex / patchCollabInitEntry / advanceCollabStep / writeCollabOperation。
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
} from '../services/collab-init-store.js';
import { runCollabRoleVerification, markGateRoleReady, type RoleVerifyDeps } from './collab-role-verify.js';
import { evaluateArtifactReady, type ArtifactReadyFacts, type CollabArtifactSatisfiedBy } from './collab-artifact-ready.js';

export interface S2S5Deps {
  dataDir: string;
  now: () => number;
  /** S2：读群成员（缺员重发）。 */
  listMembers: (larkAppId: string, chatId: string) => Promise<string[]>;
  /** S2：加 bot 进群。 */
  addBotToChat: (larkAppId: string, chatId: string, botAppId: string) => Promise<void>;
  /** S3：经 IPC 触发接收方 daemon 写 talk-only grant matrix。返回 ok/未就绪。 */
  triggerGrant: (targetAppId: string) => Promise<{ ok: boolean; message?: string }>;
  /** S4：角色校验 deps。 */
  roleVerify: RoleVerifyDeps;
  /** S5：kickoff prepare。 */
  kickoffPrepare: (appId: string, prompt: string) => Promise<{ ok: boolean; message?: string }>;
  /** S5：kickoff start（目标持久三元组后才 started）。 */
  kickoffStart: (appId: string) => Promise<{ ok: boolean; sessionId?: string; turnId?: string; acceptedAt?: string }>;
  /** S5：查询依赖 kickoff 是否满足 artifact-ready（返回 facts）。 */
  artifactFacts: (depAppId: string) => Promise<ArtifactReadyFacts>;
}

/**
 * 每次状态迁移/kickoff 准入前：角色重校验 + configVersion 比对。
 * 返回 false 表示配置已变或角色校验失败（不得启动）。
 */
export function reverifyCollabRoleAndConfig(opts: {
  dataDir: string;
  larkAppId: string;
  chatId: string;
  initId: string;
  configVersion: string;
  config: SessionGroupCollaborationConfig;
  roleVerify: RoleVerifyDeps;
}): { ok: boolean; reason?: string } {
  const entry = readCollabInitEntry(opts.dataDir, opts.larkAppId, opts.initId);
  if (!entry) return { ok: false, reason: 'entry_missing' };
  if (entry.configVersion !== opts.configVersion) return { ok: false, reason: 'config_version_changed' };
  const role = runCollabRoleVerification(opts.larkAppId, opts.chatId, opts.config, opts.roleVerify);
  if (!role.ready) return { ok: false, reason: role.conflict ?? 'role_not_ready' };
  return { ok: true };
}

/** S2 invite：逐 peer 落 operation + 缺员重发。 */
export async function runS2Invites(opts: {
  dataDir: string;
  creatorAppId: string;
  chatId: string;
  initId: string;
  peers: Array<{ appId: string }>;
  deps: S2S5Deps;
}): Promise<void> {
  const now = opts.deps.now();
  const members = await opts.deps.listMembers(opts.creatorAppId, opts.chatId);
  for (const peer of opts.peers) {
    const opKey = `invite:${peer.appId}`;
    const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = entry.operations[opKey];
    if (existing?.status === 'done') continue;
    const payloadHash = collabPayloadHash({ chatId: opts.chatId, appId: peer.appId });
    if (existing && existing.payloadHash !== payloadHash) {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'failed', payloadHash, error: 'payloadHash conflict' } });
      continue;
    }
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'invite', status: 'attempting', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now } });
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

/** S3 grants：逐 peer 落 operation + IPC 触发接收方写 talk-only matrix。 */
export async function runS3Grants(opts: {
  dataDir: string;
  creatorAppId: string;
  chatId: string;
  initId: string;
  peers: Array<{ appId: string }>;
  deps: S2S5Deps;
}): Promise<Array<{ appId: string; ready: boolean; message?: string }>> {
  const now = opts.deps.now();
  const results: Array<{ appId: string; ready: boolean; message?: string }> = [];
  for (const peer of opts.peers) {
    const opKey = `grant:${peer.appId}`;
    const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = entry.operations[opKey];
    if (existing?.status === 'done') { results.push({ appId: peer.appId, ready: true }); continue; }
    const payloadHash = collabPayloadHash({ chatId: opts.chatId, appId: peer.appId });
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'attempting', payloadHash, firstAttemptAt: existing?.firstAttemptAt ?? now } });
    const r = await opts.deps.triggerGrant(peer.appId);
    if (r.ok) {
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'done', payloadHash, receipt: { chatId: opts.chatId } } });
      results.push({ appId: peer.appId, ready: true });
    } else {
      // peer 离线阻塞可见：step 保持 running/unknown。
      await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'grant', status: 'unknown', payloadHash, error: r.message ?? 'peer offline' } });
      results.push({ appId: peer.appId, ready: false, message: r.message ?? 'peer offline' });
    }
  }
  return results;
}

/** S4 roles：逐 peer 角色校验，全绿 markGateRoleReady。 */
export async function runS4Roles(opts: {
  dataDir: string;
  creatorAppId: string;
  chatId: string;
  initId: string;
  configVersion: string;
  config: SessionGroupCollaborationConfig;
  peers: Array<{ appId: string }>;
  deps: S2S5Deps;
}): Promise<{ allReady: boolean; conflict?: string }> {
  const now = opts.deps.now();
  for (const peer of opts.peers) {
    const opKey = `role:${peer.appId}`;
    const entry = readCollabInitEntry(opts.dataDir, opts.creatorAppId, opts.initId)!;
    const existing = entry.operations[opKey];
    if (existing?.status === 'done') continue;
    const role = runCollabRoleVerification(peer.appId, opts.chatId, opts.config, opts.deps.roleVerify);
    if (!role.ready) {
      await patchCollabInitEntry({
        dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId,
        mutate: (e) => { e.state = 'awaiting-input'; e.awaiting = { reason: 'ROLE_CONFLICT', since: now, detail: role.conflict }; e.updatedAt = now; return true; },
      });
      return { allReady: false, conflict: role.conflict ?? 'role_not_ready' };
    }
    await writeCollabOperation({ dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId, opKey, now, op: { kind: 'role', status: 'done', payloadHash: collabPayloadHash({ appId: peer.appId, configVersion: opts.configVersion }), receipt: { verified: true } } });
    markGateRoleReady(opts.dataDir, opts.chatId, peer.appId);
  }
  return { allReady: true };
}

/**
 * S5 kickoff 依赖启动：按 kickoff 顺序执行 immediate；afterAgentTurn 等 artifact-ready。
 * 每次准入前 reverifyCollabRoleAndConfig。
 */
export async function runS5Kickoff(opts: {
  dataDir: string;
  creatorAppId: string;
  chatId: string;
  initId: string;
  configVersion: string;
  config: SessionGroupCollaborationConfig;
  deps: S2S5Deps;
}): Promise<{ done: boolean; awaitingInput?: string }> {
  const now = opts.deps.now();
  // 拓扑序：immediate 在前，afterAgentTurn 依赖其 afterAppId。
  const ordered = [...opts.config.kickoff].sort((a, b) => (a.trigger === 'immediate' ? -1 : 1) - (b.trigger === 'immediate' ? -1 : 1));

  for (const k of ordered) {
    // 每次准入前重校验。
    const reverify = reverifyCollabRoleAndConfig({
      dataDir: opts.dataDir, larkAppId: opts.creatorAppId, chatId: opts.chatId, initId: opts.initId,
      configVersion: opts.configVersion, config: opts.config, roleVerify: opts.deps.roleVerify,
    });
    if (!reverify.ok) return { done: false, awaitingInput: reverify.reason };

    const kickoffId = collabKickoffId(opts.initId, k.appId, opts.configVersion);
    if (k.trigger === 'immediate') {
      const prep = await opts.deps.kickoffPrepare(k.appId, k.prompt ?? '');
      if (!prep.ok) return { done: false, awaitingInput: `kickoff prepare failed: ${prep.message}` };
      const started = await opts.deps.kickoffStart(k.appId);
      if (!started.ok) return { done: false, awaitingInput: 'kickoff start not ready' };
      // 记录 kickoffPending 三元组。
      await patchCollabInitEntry({
        dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId,
        mutate: (e) => { e.kickoffPending = { ...(e.kickoffPending ?? {}), [k.appId]: { appId: k.appId } }; e.updatedAt = now; return true; },
      });
      continue;
    }
    // afterAgentTurn：等依赖满足。
    const depAppId = k.afterAppId!;
    const facts = await opts.deps.artifactFacts(depAppId);
    const artifact = (k.artifact ?? { type: 'marked-url', hosts: [] }) as CollabArtifactSpec;
    const evalResult = evaluateArtifactReady({
      facts,
      artifact,
      receiptId: `kick_${kickoffId}`,
      kickoffId,
      sessionId: '',
      turnId: '',
      contentHash: '',
    });
    if (!evalResult.ready) {
      return { done: false, awaitingInput: `artifact not ready: ${evalResult.reason}` };
    }
    // 依赖满足，写 satisfiedBy 并 prepare/start。
    const satisfiedBy: CollabArtifactSatisfiedBy = evalResult.satisfiedBy;
    await patchCollabInitEntry({
      dataDir: opts.dataDir, creatorAppId: opts.creatorAppId, initId: opts.initId,
      mutate: (e) => { e.kickoffPending = { ...(e.kickoffPending ?? {}), [k.appId]: { appId: k.appId, satisfiedBy } }; e.updatedAt = now; return true; },
    });
    const prep = await opts.deps.kickoffPrepare(k.appId, k.prompt ?? '');
    if (!prep.ok) return { done: false, awaitingInput: `kickoff prepare failed: ${prep.message}` };
    const started = await opts.deps.kickoffStart(k.appId);
    if (!started.ok) return { done: false, awaitingInput: 'kickoff start not ready' };
  }
  return { done: true };
}
