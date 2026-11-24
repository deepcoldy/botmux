/**
 * S4 角色严格回读（design 2026-11-20-dm-collab-group §6）。
 *
 * 对每个 participant 做三类动作（§6.2 产物 4c）：
 *   - profile + 非空条目：写本群角色文件，严格回读，hash 一致才就绪；
 *   - profile + ''：显式清空，核对实际 team/none；
 *   - no-chat-role：不写本群覆盖，核对 team/none；
 *   - profile + null：S0/S4 失败（校验阶段已拦）。
 *
 * 代写前先 readRoleFileStrict 严格回读：无冲突才执行；已是期望状态幂等成功；不同内容
 * 停 S4 进 awaiting-input('ROLE_CONFLICT')。全绿才把 gate.roleReady 置 true。
 */
import {
  normalizeRoleContent,
  roleContentHash,
  type StrictRoleRead,
} from './role-resolver.js';
import {
  readCollabGate,
  patchCollabGate,
} from '../services/collab-gate-store.js';
import type { CollabGateFile } from '../services/collab-group-config.js';
import type { SessionGroupCollaborationConfig } from '../services/collab-group-config.js';

export interface RoleVerifyDeps {
  dataDir: string;
  now: () => number;
  /** 解析 profile 条目内容（真实 readRoleProfileEntry 或替身）。null = 条目不存在，'' = 显式清空。 */
  readProfile: (profileId: string, appId: string) => string | null;
  /** 写本群角色文件（真实 writeRoleFile 或替身）。 */
  writeRole: (larkAppId: string, chatId: string, content: string) => void;
  /** 严格回读（真实 readRoleFileStrict 或替身）。 */
  readRole: (larkAppId: string, chatId: string) => StrictRoleRead;
}

export interface RoleVerifyOutcome {
  /** 是否全绿（所有 participant roleReady）。 */
  ready: boolean;
  /** 记录 S4 逐 agent 回执（§6.1）。 */
  records: Array<{
    appId: string;
    expectedSource: 'chat' | 'team' | 'none';
    expectedHash?: string;
    actualHash?: string;
    verified: boolean;
    conflict?: boolean;
  }>;
  /** 冲突原因（有则进 ROLE_CONFLICT）。 */
  conflict?: string;
}

/**
 * 对单 daemon（creator 自己的 participant）做 S4。peer 的 S4 由各自 daemon 独立执行，
 * 本函数只处理同一 larkAppId 的 participant（creator）。返回值可扩展为多 appId 时逐个。
 */
export function runCollabRoleVerification(
  larkAppId: string,
  chatId: string,
  config: SessionGroupCollaborationConfig,
  deps: RoleVerifyDeps,
): RoleVerifyOutcome {
  const records: RoleVerifyOutcome['records'] = [];
  for (const agent of config.agents) {
    // 只验本 daemon 自己的 participant；peer 由各自 daemon 验。
    if (agent.appId !== larkAppId) continue;
    if (agent.roleMode === 'no-chat-role') {
      // 核对 team/none：本群无覆盖即符合。
      const strict = deps.readRole(larkAppId, chatId);
      const verified = strict.kind === 'missing' || strict.kind === 'empty';
      records.push({ appId: agent.appId, expectedSource: 'team', verified, conflict: false });
      continue;
    }
    // roleMode profile（默认）：解析 profile 条目。
    const profileId = agent.profileId ?? config.roleProfileId;
    if (!profileId) {
      records.push({ appId: agent.appId, expectedSource: 'none', verified: false });
      return { ready: false, records, conflict: `agent ${agent.appId} 缺 profileId` };
    }
    const entryContent = deps.readProfile(profileId, agent.appId);
    if (entryContent === null) {
      // profile + null：S0/S4 失败。
      records.push({ appId: agent.appId, expectedSource: 'none', verified: false });
      return { ready: false, records, conflict: `agent ${agent.appId} 的 Profile 条目缺失（profile=${profileId}）` };
    }
    if (entryContent === '') {
      // profile + ''：显式清空本群覆盖，核对 team/none。
      const strict = deps.readRole(larkAppId, chatId);
      const verified = strict.kind === 'missing' || strict.kind === 'empty';
      records.push({ appId: agent.appId, expectedSource: 'team', verified, conflict: false });
      continue;
    }
    // profile + 非空：代写前先严格回读，无冲突才写。
    const expectedHash = roleContentHash(entryContent);
    const strictBefore = deps.readRole(larkAppId, chatId);
    if (strictBefore.kind === 'readable') {
      const actualHash = roleContentHash(strictBefore.content);
      if (actualHash === expectedHash) {
        // 已是期望状态：幂等成功。
        records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, actualHash, verified: true });
        continue;
      }
      if (strictBefore.content !== normalizeRoleContent(entryContent)) {
        // 不同内容 → ROLE_CONFLICT。
        records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, actualHash, verified: false, conflict: true });
        return { ready: false, records, conflict: `agent ${agent.appId} 角色冲突` };
      }
    }
    // 写 + 严格回读。
    deps.writeRole(larkAppId, chatId, entryContent);
    const strictAfter = deps.readRole(larkAppId, chatId);
    if (strictAfter.kind !== 'readable') {
      records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, verified: false });
      return { ready: false, records, conflict: `agent ${agent.appId} 角色回读失败` };
    }
    const actualHash = roleContentHash(strictAfter.content);
    if (actualHash !== expectedHash) {
      records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, actualHash, verified: false, conflict: true });
      return { ready: false, records, conflict: `agent ${agent.appId} 角色哈希不一致` };
    }
    records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, actualHash, verified: true });
  }
  return { ready: true, records };
}

/** S4 全绿后把 gate 的 participant roleReady 置 true（§8.2，不对用户开放）。 */
export function markGateRoleReady(dataDir: string, chatId: string, appId: string): CollabGateFile | undefined {
  return patchCollabGate(dataDir, chatId, (gate) => {
    const participants = { ...gate.participants };
    participants[appId] = { ...(participants[appId] ?? { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false }), roleReady: true };
    return { ...gate, participants };
  });
}

export function gateReadyFor(dataDir: string, chatId: string): CollabGateFile | undefined {
  return readCollabGate(dataDir, chatId);
}
