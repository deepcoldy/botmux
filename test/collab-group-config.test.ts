/**
 * 协作配置校验 + 稳定请求身份 + configVersion（design 2026-11-20 §4, §5.1）契约测试。
 *
 * 只测纯函数：不碰文件系统（结构校验走无 deps 分支；完整校验注入假 resolveProfile /
 * resolveTeamRole）。canonical JSON 来源锁定 canonical-input-hash 的 canonicalJson。
 */
import { describe, it, expect } from 'vitest';
import {
  buildCollabConfigVersion,
  collabCreateUuid,
  collabCreatorAdmissionOperationId,
  collabInitId,
  collabSourceKey,
  COLLAB_CREATE_ATTEMPT_INITIAL,
  DEFAULT_ARTIFACT_MARKER,
  isValidHostname,
  validateSessionGroupCollaborationConfig,
} from '../src/services/collab-group-config.js';
import { canonicalJson, sha256Hex } from '../src/utils/canonical-input-hash.js';

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    roleProfileId: 'group_default',
    agents: [
      { appId: 'cli_creator' },
      { appId: 'cli_builder', profileId: 'builder_profile' },
    ],
    kickoff: [
      { appId: 'cli_creator', trigger: 'immediate' },
      {
        appId: 'cli_builder',
        trigger: 'afterAgentTurn',
        afterAppId: 'cli_creator',
        artifact: { type: 'marked-url', hosts: ['example.com'] },
      },
    ],
    ...overrides,
  };
}

/** DAG 结构测试专用：agents 全用 no-chat-role 避免 Profile 解析干扰结构判定。 */
function dagAgents(appIds: string[]): Array<{ appId: string; roleMode: 'no-chat-role' }> {
  return appIds.map(appId => ({ appId, roleMode: 'no-chat-role' }));
}

const noDeps = undefined;

describe('validateSessionGroupCollaborationConfig（结构校验）', () => {
  it('非 {enabled:true} 一律失败（安全默认关闭）', () => {
    expect(validateSessionGroupCollaborationConfig(undefined, noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig(null, noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig({}, noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig({ enabled: false }, noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig('x', noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig([], noDeps).ok).toBe(false);
  });

  it('合法配置通过结构校验，产出规范化 config', () => {
    const v = validateSessionGroupCollaborationConfig(validConfig(), noDeps);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.config.enabled).toBe(true);
    expect(v.config.agents).toHaveLength(2);
    expect(v.config.kickoff).toHaveLength(2);
  });

  it('agents 空 / 非数组失败', () => {
    expect(validateSessionGroupCollaborationConfig(validConfig({ agents: [] }), noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig(validConfig({ agents: 'x' }), noDeps).ok).toBe(false);
  });

  it('agents appId 重复失败', () => {
    const v = validateSessionGroupCollaborationConfig(validConfig({
      agents: [{ appId: 'cli_a' }, { appId: 'cli_a' }],
      kickoff: [{ appId: 'cli_a', trigger: 'immediate' }],
    }), noDeps);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some(e => e.includes('重复'))).toBe(true);
  });

  it('kickoff 必须恰好覆盖 agents 每个 appId 一次', () => {
    // 覆盖不全
    const missing = validateSessionGroupCollaborationConfig(validConfig({
      kickoff: [{ appId: 'cli_creator', trigger: 'immediate' }],
    }), noDeps);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.errors.some(e => e.includes('未在 kickoff 覆盖'))).toBe(true);

    // 多出不在 agents 的 appId
    const extra = validateSessionGroupCollaborationConfig(validConfig({
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        { appId: 'cli_extra', trigger: 'immediate' },
      ],
    }), noDeps);
    expect(extra.ok).toBe(false);
    if (extra.ok) return;
    expect(extra.errors.some(e => e.includes('不在 agents'))).toBe(true);
  });

  it('immediate 不得带 afterAppId/artifact', () => {
    const v = validateSessionGroupCollaborationConfig(validConfig({
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate', afterAppId: 'cli_builder' },
        { appId: 'cli_builder', trigger: 'immediate' },
      ],
    }), noDeps);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some(e => e.includes('immediate 不得带'))).toBe(true);
  });

  it('afterAgentTurn 必须带合法 afterAppId/artifact，hosts 非空合法 hostname', () => {
    // 缺 afterAppId
    expect(validateSessionGroupCollaborationConfig(validConfig({
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }), noDeps).ok).toBe(false);

    // hosts 空
    expect(validateSessionGroupCollaborationConfig(validConfig({
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: [] } },
      ],
    }), noDeps).ok).toBe(false);

    // host 大写（精确匹配必须小写）
    expect(validateSessionGroupCollaborationConfig(validConfig({
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['Example.COM'] } },
      ],
    }), noDeps).ok).toBe(false);
  });

  it('DAG：自依赖失败', () => {
    const v = validateSessionGroupCollaborationConfig({
      enabled: true,
      agents: dagAgents(['cli_a']),
      kickoff: [{ appId: 'cli_a', trigger: 'afterAgentTurn', afterAppId: 'cli_a', artifact: { type: 'marked-url', hosts: ['x.com'] } }],
    }, noDeps);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some(e => e.includes('自依赖'))).toBe(true);
  });

  it('DAG：环失败', () => {
    const v = validateSessionGroupCollaborationConfig({
      enabled: true,
      agents: dagAgents(['cli_a', 'cli_b']),
      kickoff: [
        { appId: 'cli_a', trigger: 'afterAgentTurn', afterAppId: 'cli_b', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        { appId: 'cli_b', trigger: 'afterAgentTurn', afterAppId: 'cli_a', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, noDeps);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some(e => e.includes('环'))).toBe(true);
  });

  it('DAG：无 immediate root 失败', () => {
    const v = validateSessionGroupCollaborationConfig({
      enabled: true,
      agents: dagAgents(['cli_a', 'cli_b', 'cli_c']),
      kickoff: [
        { appId: 'cli_a', trigger: 'immediate' },
        { appId: 'cli_b', trigger: 'afterAgentTurn', afterAppId: 'cli_a', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        // cli_c 依赖 cli_b 但 cli_b 不是 immediate root，且没有到 immediate root 的链
        { appId: 'cli_c', trigger: 'afterAgentTurn', afterAppId: 'cli_b', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, noDeps);
    // 无 root 场景：全 afterAgentTurn 形成环
    const v2 = validateSessionGroupCollaborationConfig({
      enabled: true,
      agents: dagAgents(['cli_a', 'cli_b']),
      kickoff: [
        { appId: 'cli_a', trigger: 'afterAgentTurn', afterAppId: 'cli_b', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        { appId: 'cli_b', trigger: 'afterAgentTurn', afterAppId: 'cli_a', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, noDeps);
    expect(v2.ok).toBe(false);
    if (v2.ok) return;
    expect(v2.errors.some(e => e.includes('环') || e.includes('immediate root'))).toBe(true);
  });

  it('DAG：不可达节点失败', () => {
    // cli_c 依赖 cli_orphan（不在 kickoff）→ 依赖目标不合法，必然失败
    const v = validateSessionGroupCollaborationConfig({
      enabled: true,
      agents: dagAgents(['cli_a', 'cli_b', 'cli_c']),
      kickoff: [
        { appId: 'cli_a', trigger: 'immediate' },
        { appId: 'cli_b', trigger: 'afterAgentTurn', afterAppId: 'cli_a', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        { appId: 'cli_c', trigger: 'afterAgentTurn', afterAppId: 'cli_orphan', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, noDeps);
    expect(v.ok).toBe(false);
  });

  it('DAG：不可达（孤立 afterAgentTurn 链）失败', () => {
    // cli_c 依赖 cli_b，cli_b 依赖 cli_a，但 cli_a 不是 immediate，也没有 root 触达它
    const v = validateSessionGroupCollaborationConfig({
      enabled: true,
      agents: dagAgents(['cli_a', 'cli_b', 'cli_c', 'cli_d']),
      kickoff: [
        { appId: 'cli_d', trigger: 'immediate' },
        { appId: 'cli_a', trigger: 'afterAgentTurn', afterAppId: 'cli_b', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        { appId: 'cli_b', trigger: 'afterAgentTurn', afterAppId: 'cli_c', artifact: { type: 'marked-url', hosts: ['x.com'] } },
        { appId: 'cli_c', trigger: 'afterAgentTurn', afterAppId: 'cli_a', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, noDeps);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some(e => e.includes('环') || e.includes('不可达'))).toBe(true);
  });

  it('完整校验：profile 条目缺失（null）失败', () => {
    const v = validateSessionGroupCollaborationConfig(validConfig(), {
      dataDir: '/tmp/x',
      resolveProfile: () => null, // 条目不存在
      resolveTeamRole: () => null,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.some(e => e.includes('Profile 条目缺失'))).toBe(true);
  });

  it('完整校验：no-chat-role 记录 team role 快照（可为 null）', () => {
    const v = validateSessionGroupCollaborationConfig(validConfig({
      agents: [
        { appId: 'cli_creator' },
        { appId: 'cli_builder', roleMode: 'no-chat-role' },
      ],
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }), {
      dataDir: '/tmp/x',
      resolveProfile: () => 'creator-role',
      resolveTeamRole: (appId) => (appId === 'cli_builder' ? 'team-role' : null),
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.referencedTeamRoles['cli_builder']).toBe('team-role');
  });

  it('空 Profile 的 team fallback 也进入 S0 快照并影响 configVersion', () => {
    const cfg = validConfig({
      agents: [{ appId: 'cli_creator' }, { appId: 'cli_builder', profileId: 'builder_empty' }],
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    });
    const validate = (team: string) => validateSessionGroupCollaborationConfig(cfg, {
      dataDir: '/tmp/x',
      resolveProfile: (_pid, appId) => appId === 'cli_builder' ? '' : 'creator-role',
      resolveTeamRole: appId => appId === 'cli_builder' ? team : null,
    });
    const v1 = validate('team-v1');
    const v2 = validate('team-v2');
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    expect(v1.resolvedProfileEntries.cli_builder).toBe('');
    expect(v1.referencedTeamRoles.cli_builder).toBe('team-v1');
    expect(buildCollabConfigVersion(v1)).not.toBe(buildCollabConfigVersion(v2));
  });

  it('省略 roleMode（默认 profile）保留 profileId override，且与显式 roleMode:profile 等价（P1#2）', () => {
    const resolveProfile = (_pid: string, appId: string) => (appId === 'cli_builder' ? 'builder-override-role' : 'creator-default-role');
    const base = {
      enabled: true,
      roleProfileId: 'group_default',
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    };
    // 省略 roleMode（默认 profile）带 profileId override
    const omitted = validateSessionGroupCollaborationConfig({
      ...base,
      agents: [{ appId: 'cli_creator' }, { appId: 'cli_builder', profileId: 'builder_override' }],
    }, { dataDir: '/tmp/x', resolveProfile, resolveTeamRole: () => null });
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    // profileId 被保留在 config.agents 里
    expect(omitted.config.agents.find(a => a.appId === 'cli_builder')?.profileId).toBe('builder_override');
    // resolvedProfileEntries 用 override 的 profile 内容
    expect(omitted.resolvedProfileEntries['cli_builder']).toBe('builder-override-role');
    expect(omitted.resolvedProfileEntries['cli_creator']).toBe('creator-default-role');

    // 显式 roleMode:'profile' 等价
    const explicit = validateSessionGroupCollaborationConfig({
      ...base,
      agents: [{ appId: 'cli_creator', roleMode: 'profile' }, { appId: 'cli_builder', roleMode: 'profile', profileId: 'builder_override' }],
    }, { dataDir: '/tmp/x', resolveProfile, resolveTeamRole: () => null });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.config.agents.find(a => a.appId === 'cli_builder')?.profileId).toBe('builder_override');
    expect(explicit.resolvedProfileEntries).toEqual(omitted.resolvedProfileEntries);
  });

  it('身份校验：creator 恰好一行 / 存在性 / 非 apiOnly（P2#4）', () => {
    const resolveAgent = (appId: string) => {
      if (appId === 'cli_creator') return { exists: true, apiOnly: false };
      if (appId === 'cli_builder') return { exists: true, apiOnly: false };
      return undefined;
    };
    const baseCfg = {
      enabled: true,
      agents: [
        { appId: 'cli_creator', roleMode: 'no-chat-role' },
        { appId: 'cli_builder', roleMode: 'no-chat-role' },
      ],
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    };
    const deps = { dataDir: '/tmp/x', resolveProfile: () => 'r', resolveTeamRole: () => null, creatorAppId: 'cli_creator', resolveAgent };

    // creator 恰好一行 → ok
    const ok = validateSessionGroupCollaborationConfig(baseCfg, deps);
    expect(ok.ok).toBe(true);

    // 缺 creator
    const noCreator = validateSessionGroupCollaborationConfig({
      ...baseCfg,
      agents: [
        { appId: 'cli_other', roleMode: 'no-chat-role' },
        { appId: 'cli_builder', roleMode: 'no-chat-role' },
      ],
      kickoff: [
        { appId: 'cli_other', trigger: 'immediate' },
        { appId: 'cli_builder', trigger: 'afterAgentTurn', afterAppId: 'cli_other', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, deps);
    expect(noCreator.ok).toBe(false);
    if (noCreator.ok) return;
    expect(noCreator.errors.some(e => e.includes('恰好出现一次'))).toBe(true);

    // 未知 appId
    const unknown = validateSessionGroupCollaborationConfig({
      ...baseCfg,
      agents: [
        { appId: 'cli_creator', roleMode: 'no-chat-role' },
        { appId: 'cli_unknown', roleMode: 'no-chat-role' },
      ],
      kickoff: [
        { appId: 'cli_creator', trigger: 'immediate' },
        { appId: 'cli_unknown', trigger: 'afterAgentTurn', afterAppId: 'cli_creator', artifact: { type: 'marked-url', hosts: ['x.com'] } },
      ],
    }, deps);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.errors.some(e => e.includes('不存在'))).toBe(true);

    // apiOnly
    const apiOnlyDeps = {
      ...deps,
      resolveAgent: (appId: string) => {
        if (appId === 'cli_creator') return { exists: true, apiOnly: false };
        if (appId === 'cli_builder') return { exists: true, apiOnly: true };
        return undefined;
      },
    };
    const apiOnly = validateSessionGroupCollaborationConfig(baseCfg, apiOnlyDeps);
    expect(apiOnly.ok).toBe(false);
    if (apiOnly.ok) return;
    expect(apiOnly.errors.some(e => e.includes('apiOnly'))).toBe(true);
  });

  it('workingDir / gatePolicy 非法值失败', () => {
    expect(validateSessionGroupCollaborationConfig(validConfig({ workingDir: '  ' }), noDeps).ok).toBe(false);
    expect(validateSessionGroupCollaborationConfig(validConfig({ gatePolicy: 'banana' }), noDeps).ok).toBe(false);
  });
});

describe('稳定请求身份（§5.1 纯函数）', () => {
  it('sourceKey = canonicalJson([creatorAppId, dmChatId, sourceMessageId])', () => {
    expect(collabSourceKey('cli_a', 'oc_dm', 'om_msg')).toBe(canonicalJson(['cli_a', 'oc_dm', 'om_msg']));
  });

  it('initId = sha256(sourceKey)，不含 configVersion', () => {
    const sk = collabSourceKey('cli_a', 'oc_dm', 'om_msg');
    expect(collabInitId(sk)).toBe(sha256Hex(sk));
  });

  it('createUuid 由 [initId, createAttempt] 派生；attempt 变则变，同 initId 同 attempt 恒等', () => {
    const initId = sha256Hex('abc');
    const a0 = collabCreateUuid(initId, COLLAB_CREATE_ATTEMPT_INITIAL);
    const b0 = collabCreateUuid(initId, COLLAB_CREATE_ATTEMPT_INITIAL);
    expect(a0).toBe(b0);
    const a1 = collabCreateUuid(initId, 1);
    expect(a1).not.toBe(a0);
    expect(a0).toHaveLength(32);
  });

  it('creatorAdmissionOperationId 由 [initId, "creator-admission"] 派生且稳定', () => {
    const initId = sha256Hex('abc');
    expect(collabCreatorAdmissionOperationId(initId))
      .toBe(sha256Hex(canonicalJson([initId, 'creator-admission'])));
  });
});

describe('configVersion（§4.2）', () => {
  it('只含 canonical 内容，不含 mtime；同内容恒等', () => {
    const collab = {
      enabled: true as const,
      agents: [{ appId: 'cli_a' }],
      kickoff: [{ appId: 'cli_a', trigger: 'immediate' as const }],
    };
    const resolved = { cli_a: 'role-content' };
    const teamRoles = {};
    const v1 = buildCollabConfigVersion({ collaboration: collab, resolvedProfileEntries: resolved, referencedTeamRoles: teamRoles });
    // 模拟「改 mtime」：同一份内容再算一次（configVersion 输入不含任何时间戳字段）。
    const v2 = buildCollabConfigVersion({ collaboration: { ...collab }, resolvedProfileEntries: { ...resolved }, referencedTeamRoles: { ...teamRoles } });
    expect(v1).toBe(v2);
    // 内容变化 → 版本变化
    const v3 = buildCollabConfigVersion({ collaboration: collab, resolvedProfileEntries: { cli_a: 'role-content-v2' }, referencedTeamRoles: teamRoles });
    expect(v3).not.toBe(v1);
  });
});

describe('isValidHostname', () => {
  it('接受合法小写 hostname，拒绝大写/空/非法字符', () => {
    expect(isValidHostname('example.com')).toBe(true);
    expect(isValidHostname('sub.example.com')).toBe(true);
    expect(isValidHostname('localhost')).toBe(true);
    expect(isValidHostname('Example.com')).toBe(false); // 大写
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('has space.com')).toBe(false);
    expect(isValidHostname('-bad.com')).toBe(false);
    expect(isValidHostname('bad-.com')).toBe(false);
    expect(isValidHostname('https://example.com')).toBe(false); // 带协议
    expect(isValidHostname('example.com:8080')).toBe(false); // 带端口
  });
});

describe('DEFAULT_ARTIFACT_MARKER', () => {
  it('默认 marker 为 BOTMUX_ARTIFACT_READY', () => {
    expect(DEFAULT_ARTIFACT_MARKER).toBe('BOTMUX_ARTIFACT_READY');
  });
});
