/**
 * 私聊专属群可视化协作配置（design 2026-11-20-dm-collab-group-design §4, §5.1, §8.1）。
 *
 * 挂在 `SessionGroupConfig.collaboration` 下；缺省、不存在或非 `{enabled:true}` 都
 * 完全关闭（走 legacy `maybeBirthSessionGroup`）。本模块只负责：
 *   1. 配置类型与字段冻结；
 *   2. 保存与 S0 共用的同一套结构校验（含 DAG / artifact / Profile 解析）；
 *   3. 稳定请求身份纯函数（sourceKey / initId / configVersion / createUuid）；
 *   4. per-chat gate 的 schema 与文件路径（不含写盘时序，PR-2）。
 *
 * canonical JSON 唯一来源是 `src/utils/canonical-input-hash.ts` 的 `canonicalJson`
 * （去 undefined、拒非 plain object、拒 bigint / 非有限数），**不**与
 * `src/utils/canonical-json.ts` 的 `canonicalJsonStringify` 混用。
 */
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../utils/canonical-input-hash.js';
import { isValidRoleProfileId } from './role-profile-store.js';

export const DEFAULT_ARTIFACT_MARKER = 'BOTMUX_ARTIFACT_READY';

export interface CollabAgentEntry {
  appId: string;
  roleMode?: 'profile' | 'no-chat-role';
  profileId?: string;
}

export interface CollabArtifactSpec {
  type: 'marked-url';
  /** 非空、精确 hostname（小写、无端口无路径无协议）列表。 */
  hosts: string[];
  marker?: string;
}

export interface CollabKickoffEntry {
  appId: string;
  trigger: 'immediate' | 'afterAgentTurn';
  afterAppId?: string;
  artifact?: CollabArtifactSpec;
  prompt?: string;
}

export interface SessionGroupCollaborationConfig {
  enabled: true;
  /** 整群默认 Profile，可被单 Agent 覆盖。 */
  roleProfileId?: string;
  /** 全部 participant；creator 固定占一行。 */
  agents: CollabAgentEntry[];
  /** 首期必须恰好覆盖 agents 中每个 appId 一次。 */
  kickoff: CollabKickoffEntry[];
  workingDir?: string;
  gatePolicy?: 'queue' | 'reject';
}

// ─── 稳定请求身份（§5.1，纯函数）─────────────────────────────────────────

/** sourceKey = canonicalJson([creatorAppId, dmChatId, sourceMessageId])。 */
export function collabSourceKey(creatorAppId: string, dmChatId: string, sourceMessageId: string): string {
  return canonicalJson([creatorAppId, dmChatId, sourceMessageId]);
}

/** initId = sha256(sourceKey)，不含 configVersion。 */
export function collabInitId(sourceKey: string): string {
  return sha256Hex(sourceKey);
}

/** createAttempt 初始为 0；仅人工接受超窗风险后递增。 */
export const COLLAB_CREATE_ATTEMPT_INITIAL = 0;

/** createUuid = sha256(canonicalJson([initId, createAttempt])).slice(0, 32)。 */
export function collabCreateUuid(initId: string, createAttempt: number): string {
  return sha256Hex(canonicalJson([initId, createAttempt])).slice(0, 32);
}

/** creatorAdmissionOperationId = sha256(canonicalJson([initId, 'creator-admission']))。 */
export function collabCreatorAdmissionOperationId(initId: string): string {
  return sha256Hex(canonicalJson([initId, 'creator-admission']));
}

// ─── configVersion（§4.2）─────────────────────────────────────────────────

/**
 * configVersion = sha256(canonicalJson({collaboration, resolvedProfileEntries,
 * referencedTeamRoles}))，只取确定内容，不含 mtime。
 *
 * `resolvedProfileEntries` 与 `referencedTeamRoles` 由校验阶段产出（内容快照，不含
 * 时间戳）；caller 必须只放确定字节，若塞入 mtime 即违反设计——这里不做二次清洗，
 * 由下面的校验路径保证。
 */
export function buildCollabConfigVersion(input: {
  collaboration: SessionGroupCollaborationConfig;
  resolvedProfileEntries: Record<string, string | null>;
  referencedTeamRoles: Record<string, string | null>;
}): string {
  return sha256Hex(canonicalJson({
    collaboration: input.collaboration,
    resolvedProfileEntries: input.resolvedProfileEntries,
    referencedTeamRoles: input.referencedTeamRoles,
  }));
}

// ─── 结构校验（§4.2，保存与 S0 共用）─────────────────────────────────────

export interface CollabValidationDeps {
  /** 会话数据目录（Profile / team role 解析用）。 */
  dataDir: string;
  /** 解析某 appId 在给定 Profile 下的条目内容；条目不存在返回 null。 */
  resolveProfile: (profileId: string, appId: string) => string | null;
  /** 解析某 appId 显式沿用的 team role 内容；无则 null。 */
  resolveTeamRole: (appId: string) => string | null;
}

export type CollabValidationResult =
  | {
      ok: true;
      config: SessionGroupCollaborationConfig;
      resolvedProfileEntries: Record<string, string | null>;
      referencedTeamRoles: Record<string, string | null>;
    }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 合法 hostname：小写标签段（字母数字或字母数字含中划线，不以中划线开头结尾），点分隔。 */
export function isValidHostname(host: string): boolean {
  if (typeof host !== 'string') return false;
  if (host.length === 0 || host.length > 253) return false;
  if (host !== host.toLowerCase()) return false; // 必须已小写（精确匹配）
  const labels = host.split('.');
  if (labels.length < 1) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  return true;
}

function validateArtifactSpec(artifact: unknown): { ok: true; spec: CollabArtifactSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(artifact)) return { ok: false, errors: ['artifact 必须是对象'] };
  if (artifact.type !== 'marked-url') {
    return { ok: false, errors: ['artifact.type 只能是 marked-url（首期只支持显式标记 URL）'] };
  }
  if (!Array.isArray(artifact.hosts) || artifact.hosts.length === 0) {
    return { ok: false, errors: ['artifact.hosts 必须是非空 hostname 列表'] };
  }
  const hosts: string[] = [];
  for (const h of artifact.hosts) {
    if (typeof h !== 'string' || !isValidHostname(h)) {
      errors.push(`artifact.hosts 含非法 hostname（需小写精确匹配）：${JSON.stringify(h)}`);
    } else {
      hosts.push(h);
    }
  }
  if (typeof artifact.marker !== 'undefined' && (typeof artifact.marker !== 'string' || !artifact.marker.trim())) {
    errors.push('artifact.marker 必须是非空字符串');
  }
  if (errors.length) return { ok: false, errors };
  const spec: CollabArtifactSpec = {
    type: 'marked-url',
    hosts,
    ...(typeof artifact.marker === 'string' && artifact.marker.trim() ? { marker: artifact.marker.trim() } : {}),
  };
  return { ok: true, spec };
}

/**
 * 校验一份 collaboration 配置（保存与 S0 共用）。返回结构化 {ok} | {ok:false, errors}。
 *
 * `deps` 可选：
 *  - 传入 → **完整校验**（保存 / S0）：结构 + Profile 内容解析 + team role 快照，产出
 *    resolvedProfileEntries / referencedTeamRoles 供 configVersion；
 *  - 省略 → **仅结构校验**（parse 时，纯函数不碰文件系统）：agents/kickoff/DAG/artifact/
 *    Profile id 合法性，但不解析条目内容。
 *
 * 校验点（§4.2 / Architect 字段冻结表）：
 *  - enabled 必须为字面量 true；
 *  - agents 非空、appId 不重复（除 creator 恰好一行）、roleMode='profile' 时能解析到
 *    Profile 条目（null = 失败，仅完整校验），no-chat-role 沿用 team/none；
 *  - kickoff 恰好覆盖 agents 每个 appId 一次且 appId 不重复；
 *  - immediate 不得带 afterAppId/artifact；afterAgentTurn 必须带合法 afterAppId/artifact；
 *  - DAG：依赖对象必须是 kickoff 另一行，禁止自依赖 / 环 / 重复 target / 无 immediate
 *    root / 不可达节点；
 *  - workingDir 非空时仅做非空字符串校验（真实目录校验由 PR-2 编排接 validateWorkingDir）；
 *  - gatePolicy 枚举（缺省 queue）。
 *
 * afterAgentTurn 的目标能力声明（durable-turn-output-receipt-v1）属于 peer preflight，
 * 不在此结构校验内（见 preflightCollabGroupBirth）。
 */
export function validateSessionGroupCollaborationConfig(
  raw: unknown,
  deps?: CollabValidationDeps,
): CollabValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['collaboration 必须是对象'] };
  }
  if (raw.enabled !== true) {
    return { ok: false, errors: ['collaboration 必须显式 {enabled:true} 才启用'] };
  }

  // ── roleProfileId（整群默认 Profile）──
  if (raw.roleProfileId !== undefined) {
    if (typeof raw.roleProfileId !== 'string' || !isValidRoleProfileId(raw.roleProfileId)) {
      errors.push(`roleProfileId 非法：${JSON.stringify(raw.roleProfileId)}`);
    }
  }

  // ── agents ──
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    errors.push('agents 必须是非空数组（至少包含 creator 一行）');
  }
  const agents: CollabAgentEntry[] = [];
  if (Array.isArray(raw.agents)) {
    const seen = new Set<string>();
    raw.agents.forEach((a, i) => {
      if (!isPlainObject(a) || typeof a.appId !== 'string' || !a.appId) {
        errors.push(`agents[${i}].appId 必须是非空字符串`);
        return;
      }
      if (seen.has(a.appId)) {
        errors.push(`agents[${i}].appId 重复：${a.appId}`);
        return;
      }
      seen.add(a.appId);
      const roleMode = a.roleMode === undefined ? 'profile' : a.roleMode;
      if (roleMode !== 'profile' && roleMode !== 'no-chat-role') {
        errors.push(`agents[${i}].roleMode 只能是 profile 或 no-chat-role：${JSON.stringify(a.roleMode)}`);
        return;
      }
      if (roleMode === 'profile') {
        const pid = a.profileId ?? raw.roleProfileId;
        if (typeof pid !== 'string' || !isValidRoleProfileId(pid)) {
          errors.push(`agents[${i}]（${a.appId}）roleMode=profile 必须解析到一个合法 Profile id`);
          return;
        }
      }
      agents.push({
        appId: a.appId,
        ...(a.roleMode === 'no-chat-role' ? { roleMode: 'no-chat-role' as const } : {}),
        ...(a.roleMode === 'profile' && typeof a.profileId === 'string' && a.profileId ? { profileId: a.profileId } : {}),
      });
    });
  }

  // ── kickoff ──
  if (!Array.isArray(raw.kickoff) || raw.kickoff.length === 0) {
    errors.push('kickoff 必须是非空数组（恰好覆盖 agents 每个 appId 一次）');
  }
  const kickoff: CollabKickoffEntry[] = [];
  const kickoffAppIds = new Set<string>();
  if (Array.isArray(raw.kickoff)) {
    raw.kickoff.forEach((k, i) => {
      if (!isPlainObject(k) || typeof k.appId !== 'string' || !k.appId) {
        errors.push(`kickoff[${i}].appId 必须是非空字符串`);
        return;
      }
      if (kickoffAppIds.has(k.appId)) {
        errors.push(`kickoff[${i}].appId 重复：${k.appId}`);
        return;
      }
      kickoffAppIds.add(k.appId);
      if (k.trigger !== 'immediate' && k.trigger !== 'afterAgentTurn') {
        errors.push(`kickoff[${i}]（${k.appId}）.trigger 只能是 immediate 或 afterAgentTurn`);
        return;
      }
      if (k.trigger === 'immediate') {
        if (k.afterAppId !== undefined || k.artifact !== undefined) {
          errors.push(`kickoff[${i}]（${k.appId}）immediate 不得带 afterAppId/artifact`);
          return;
        }
        kickoff.push({
          appId: k.appId,
          trigger: 'immediate',
          ...(typeof k.prompt === 'string' && k.prompt ? { prompt: k.prompt } : {}),
        });
      } else {
        if (typeof k.afterAppId !== 'string' || !k.afterAppId) {
          errors.push(`kickoff[${i}]（${k.appId}）afterAgentTurn 必须带合法 afterAppId`);
          return;
        }
        const art = validateArtifactSpec(k.artifact);
        if (!art.ok) {
          errors.push(`kickoff[${i}]（${k.appId}）afterAgentTurn 必须带合法 artifact：${art.errors.join('；')}`);
          return;
        }
        kickoff.push({
          appId: k.appId,
          trigger: 'afterAgentTurn',
          afterAppId: k.afterAppId as string,
          artifact: art.spec,
          ...(typeof k.prompt === 'string' && k.prompt ? { prompt: k.prompt } : {}),
        });
      }
    });
  }

  // ── 覆盖关系：kickoff 恰好覆盖 agents 每个 appId 一次 ──
  if (Array.isArray(raw.agents) && Array.isArray(raw.kickoff)) {
    const agentIds = new Set(agents.map(a => a.appId));
    for (const id of kickoffAppIds) {
      if (!agentIds.has(id)) errors.push(`kickoff 引用了不在 agents 里的 appId：${id}`);
    }
    for (const id of agentIds) {
      if (!kickoffAppIds.has(id)) errors.push(`agents 里的 appId 未在 kickoff 覆盖：${id}`);
    }
  }

  // ── DAG 校验（在覆盖关系无缺漏基础上）──
  if (!errors.some(e => e.includes('覆盖') || e.includes('不在 agents'))) {
    validateCollabDag(kickoff, errors);
  }

  // ── Profile / team role 解析（内容快照，供 configVersion）──
  const resolvedProfileEntries: Record<string, string | null> = {};
  const referencedTeamRoles: Record<string, string | null> = {};
  if (deps && errors.length === 0) {
    for (const agent of agents) {
      if (agent.roleMode === 'no-chat-role') {
        // 显式沿用 team 或 none：记录 team role 快照（可为 null）。
        referencedTeamRoles[agent.appId] = deps.resolveTeamRole(agent.appId);
        continue;
      }
      const pid = agent.profileId ?? raw.roleProfileId;
      if (typeof pid === 'string' && isValidRoleProfileId(pid)) {
        const content = deps.resolveProfile(pid, agent.appId);
        if (content === null) {
          errors.push(`agent ${agent.appId} 的 Profile 条目缺失（profile=${pid}）：null 是失败`);
        } else {
          resolvedProfileEntries[agent.appId] = content;
        }
      }
    }
  }

  // ── workingDir / gatePolicy ──
  if (raw.workingDir !== undefined && (typeof raw.workingDir !== 'string' || !raw.workingDir.trim())) {
    errors.push('workingDir 必须是非空字符串（或省略）');
  }
  if (raw.gatePolicy !== undefined && raw.gatePolicy !== 'queue' && raw.gatePolicy !== 'reject') {
    errors.push('gatePolicy 只能是 queue 或 reject');
  }

  if (errors.length) return { ok: false, errors };

  const config: SessionGroupCollaborationConfig = {
    enabled: true,
    ...(typeof raw.roleProfileId === 'string' && raw.roleProfileId ? { roleProfileId: raw.roleProfileId } : {}),
    agents,
    kickoff,
    ...(typeof raw.workingDir === 'string' && raw.workingDir.trim() ? { workingDir: raw.workingDir.trim() } : {}),
    ...(raw.gatePolicy === 'reject' ? { gatePolicy: 'reject' as const } : {}),
  };
  return { ok: true, config, resolvedProfileEntries, referencedTeamRoles };
}

/** DAG 结构校验：自依赖 / 环 / 重复 target / 无 immediate root / 不可达节点。 */
function validateCollabDag(kickoff: CollabKickoffEntry[], errors: string[]): void {
  const byAppId = new Map(kickoff.map(k => [k.appId, k]));
  // 依赖对象必须是 kickoff 另一行；禁止自依赖。
  for (const k of kickoff) {
    if (k.trigger !== 'afterAgentTurn') continue;
    const depId = k.afterAppId as string;
    if (!byAppId.has(depId)) {
      errors.push(`kickoff[${k.appId}] 依赖的 afterAppId 不在 kickoff 中：${depId}`);
      continue;
    }
    if (depId === k.appId) {
      errors.push(`kickoff[${k.appId}] 自依赖`);
    }
  }
  if (errors.length) return;

  // 环检测（三色 DFS）。
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const appId of byAppId.keys()) color.set(appId, WHITE);

  const visit = (appId: string, stack: string[]): void => {
    color.set(appId, GRAY);
    const k = byAppId.get(appId);
    if (k && k.trigger === 'afterAgentTurn') {
      const depId = k.afterAppId as string;
      const depColor = color.get(depId);
      if (depColor === GRAY) {
        errors.push(`kickoff 依赖图存在环：${[...stack, depId].join(' → ')}`);
        return;
      }
      if (depColor === WHITE) visit(depId, [...stack, depId]);
    }
    color.set(appId, BLACK);
  };
  for (const appId of byAppId.keys()) {
    if (color.get(appId) === WHITE) visit(appId, [appId]);
  }
  if (errors.length) return;

  // 无 immediate root / 不可达节点：从 immediate root 沿依赖正向走，未触达即不可达。
  const hasImmediate = kickoff.filter(k => k.trigger === 'immediate').map(k => k.appId);
  if (hasImmediate.length === 0) {
    errors.push('kickoff 无 immediate root（DAG 必须至少一个 immediate 起点）');
  }
  const depsOf = new Map<string, string[]>(); // appId -> 依赖它的节点
  for (const k of kickoff) {
    if (k.trigger === 'afterAgentTurn') {
      const depId = k.afterAppId as string;
      const list = depsOf.get(depId) ?? [];
      list.push(k.appId);
      depsOf.set(depId, list);
    }
  }
  const reachable = new Set<string>();
  const walk = (appId: string) => {
    if (reachable.has(appId)) return;
    reachable.add(appId);
    for (const next of depsOf.get(appId) ?? []) walk(next);
  };
  for (const root of hasImmediate) walk(root);
  for (const appId of byAppId.keys()) {
    if (!reachable.has(appId)) errors.push(`kickoff 节点不可达（无 immediate root 到它的路径）：${appId}`);
  }
}

// ─── per-chat gate schema（§8.1，仅类型 + 路径，写盘时序 PR-2）────────────

export type CollabGatePhase = 'initializing' | 'active' | 'awaiting-input' | 'failed' | 'cancelled' | 'done';
export type CollabKickoffState = 'pending' | 'prepared' | 'started' | 'failed' | 'cancelled';

export interface CollabGateParticipant {
  roleReady: boolean;
  kickoffState: CollabKickoffState;
  acceptingUserTasks: boolean;
}

export interface CollabGateFile {
  schemaVersion: number;
  initId: string;
  configVersion: string;
  creatorAppId: string;
  chatId: string;
  phase: CollabGatePhase;
  participants: Record<string, CollabGateParticipant>;
  revision: number;
}

export const COLLAB_GATE_SCHEMA_VERSION = 1;

/** `{dataDir}/collab-gates/{chatId}.json`。 */
export function collabGateFilePath(dataDir: string, chatId: string): string {
  return join(dataDir, 'collab-gates', `${chatId}.json`);
}
