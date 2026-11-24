/**
 * S4 角色严格回读（design 2026-11-20-dm-collab-group §6）。
 *
 * 对每个 participant 做三类动作（§6.2 产物 4c）：
 *   - profile + 非空条目：写本群角色文件，严格回读，hash 一致才就绪；
 *   - profile + ''：显式清空本群覆盖，回读核对实际 team/none 内容；
 *   - no-chat-role：不写本群覆盖，核对 team/none 及期望 hash；
 *   - profile + null：S0/S4 失败（校验阶段已拦）。
 *
 * 不变量：
 *   - ready 必须由所有适用 participant 的 verified 事实推导，任一未 verified → ready:false；
 *   - 代写前 readRoleFileStrict 严格回读，read-error 在任何代写前 fail-closed；
 *   - 无冲突才执行，已是期望状态幂等成功，不同内容停 S4 进 awaiting-input('ROLE_CONFLICT')。
 */
import {
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
  /** 解析 team role 内容（无则 null）。 */
  readTeamRole: (appId: string) => string | null;
  /** 写本群角色文件（真实 writeRoleFile 或替身）。 */
  writeRole: (larkAppId: string, chatId: string, content: string) => void;
  /** 删除本群角色文件（显式清空用，真实 deleteRoleFile 或替身）。 */
  deleteRole: (larkAppId: string, chatId: string) => void;
  /** 严格回读（真实 readRoleFileStrict 或替身）。 */
  readRole: (larkAppId: string, chatId: string) => StrictRoleRead;
}

export interface RoleVerifyOutcome {
  /** 是否全绿（所有适用 participant verified）。 */
  ready: boolean;
  records: Array<{
    appId: string;
    expectedSource: 'chat' | 'team' | 'none';
    expectedHash?: string;
    actualHash?: string;
    verified: boolean;
    conflict?: boolean;
  }>;
  conflict?: string;
}

/** 是否「本群无覆盖」（missing 或 empty）。 */
function isNoChatOverride(strict: StrictRoleRead): boolean {
  return strict.kind === 'missing' || strict.kind === 'empty';
}

/**
 * 对单 daemon 的 participant 做 S4。peer 的 S4 由各自 daemon 独立执行。
 * ready 由所有适用 participant 的 verified 事实推导；任一未 verified → ready:false。
 */
export function runCollabRoleVerification(
  larkAppId: string,
  chatId: string,
  config: SessionGroupCollaborationConfig,
  deps: RoleVerifyDeps,
): RoleVerifyOutcome {
  const records: RoleVerifyOutcome['records'] = [];
  const applicable = config.agents.filter(a => a.appId === larkAppId);

  for (const agent of applicable) {
    if (agent.roleMode === 'no-chat-role') {
      // 不写本群覆盖；核对 team/none 及期望 hash。
      const strict = deps.readRole(larkAppId, chatId);
      if (strict.kind === 'read-error') {
        records.push({ appId: agent.appId, expectedSource: 'team', verified: false, conflict: true });
        return { ready: false, records, conflict: `agent ${agent.appId} 角色回读失败（read-error）` };
      }
      if (!isNoChatOverride(strict)) {
        // 本群有覆盖，但 no-chat-role 期望沿用 team/none → 冲突。
        records.push({ appId: agent.appId, expectedSource: 'team', verified: false, conflict: true });
        return { ready: false, records, conflict: `agent ${agent.appId} 期望 no-chat-role 但本群有覆盖` };
      }
      const teamContent = deps.readTeamRole(agent.appId);
      const expectedHash = teamContent === null ? undefined : roleContentHash(teamContent);
      records.push({ appId: agent.appId, expectedSource: 'team', expectedHash, verified: true });
      continue;
    }

    // roleMode profile（默认）。
    const profileId = agent.profileId ?? config.roleProfileId;
    if (!profileId) {
      records.push({ appId: agent.appId, expectedSource: 'none', verified: false });
      return { ready: false, records, conflict: `agent ${agent.appId} 缺 profileId` };
    }
    const entryContent = deps.readProfile(profileId, agent.appId);
    if (entryContent === null) {
      records.push({ appId: agent.appId, expectedSource: 'none', verified: false });
      return { ready: false, records, conflict: `agent ${agent.appId} 的 Profile 条目缺失（profile=${profileId}）` };
    }
    if (entryContent === '') {
      // profile + ''：显式清空本群覆盖，回读核对 team/none。
      deps.deleteRole(larkAppId, chatId);
      const strictAfter = deps.readRole(larkAppId, chatId);
      if (strictAfter.kind === 'read-error') {
        records.push({ appId: agent.appId, expectedSource: 'team', verified: false });
        return { ready: false, records, conflict: `agent ${agent.appId} 清空后回读失败` };
      }
      if (!isNoChatOverride(strictAfter)) {
        records.push({ appId: agent.appId, expectedSource: 'team', verified: false, conflict: true });
        return { ready: false, records, conflict: `agent ${agent.appId} 清空后仍有本群覆盖` };
      }
      const teamContent = deps.readTeamRole(agent.appId);
      const expectedHash = teamContent === null ? undefined : roleContentHash(teamContent);
      records.push({ appId: agent.appId, expectedSource: 'team', expectedHash, verified: true });
      continue;
    }

    // profile + 非空：代写前先严格回读，无冲突才写。
    const expectedHash = roleContentHash(entryContent);
    const strictBefore = deps.readRole(larkAppId, chatId);
    if (strictBefore.kind === 'read-error') {
      // R3：read-error 在任何代写前 fail-closed，不覆盖无法检查的旧角色。
      records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, verified: false, conflict: true });
      return { ready: false, records, conflict: `agent ${agent.appId} 角色回读失败（read-error），不代写` };
    }
    if (strictBefore.kind === 'readable') {
      const actualHash = roleContentHash(strictBefore.content);
      if (actualHash === expectedHash) {
        records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, actualHash, verified: true });
        continue;
      }
      // 不同内容 → ROLE_CONFLICT。
      records.push({ appId: agent.appId, expectedSource: 'chat', expectedHash, actualHash, verified: false, conflict: true });
      return { ready: false, records, conflict: `agent ${agent.appId} 角色冲突` };
    }
    // missing / empty → 写 + 严格回读。
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

  // ready 必须由所有 applicable participant 的 verified 事实推导。
  const ready = applicable.length > 0 && records.every(r => r.verified);
  return { ready, records };
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
