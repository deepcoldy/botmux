/**
 * SessionGroupConfig.collaboration 的 parse 校验（design §4.2 / Architect 冲突点 2）：
 * 非 {enabled:true} 或结构非法都在 parse 处丢弃（安全默认关闭），不被 `as` 断言绕过。
 */
import { describe, it, expect } from 'vitest';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

function entry(sessionGroup: unknown): unknown {
  return {
    larkAppId: 'cli_collab_parse',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    p2pMode: 'group',
    sessionGroup,
  };
}

const validCollab = {
  enabled: true,
  agents: [{ appId: 'cli_creator', roleMode: 'no-chat-role' }],
  kickoff: [{ appId: 'cli_creator', trigger: 'immediate' }],
};

describe('collaboration 配置在 parse 处显式校验', () => {
  it('合法 {enabled:true} 保留', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({ collaboration: validCollab })]));
    expect(cfg.sessionGroup?.collaboration?.enabled).toBe(true);
  });

  it('缺省 / 非 {enabled:true} 丢弃 collaboration（安全默认关闭）', () => {
    // 无 sessionGroup
    expect(parseBotConfigsFromText(JSON.stringify([entry(undefined)]))[0].sessionGroup?.collaboration).toBeUndefined();
    // sessionGroup 无 collaboration
    expect(parseBotConfigsFromText(JSON.stringify([entry({})]))[0].sessionGroup?.collaboration).toBeUndefined();
    // collaboration 非 enabled:true
    expect(parseBotConfigsFromText(JSON.stringify([entry({ collaboration: { enabled: false } })]))[0].sessionGroup?.collaboration).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([entry({ collaboration: {} })]))[0].sessionGroup?.collaboration).toBeUndefined();
    expect(parseBotConfigsFromText(JSON.stringify([entry({ collaboration: 'x' })]))[0].sessionGroup?.collaboration).toBeUndefined();
  });

  it('结构非法（agents 空）但显式 enabled:true → 保留 collaboration + 标记 disabledReason（fail-closed）', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({ collaboration: { enabled: true, agents: [], kickoff: [] } })]));
    // 不擦除：preflight 要能认出「坏配置」返回 failed，而不是当未启用走 legacy。
    expect(cfg.sessionGroup?.collaboration?.enabled).toBe(true);
    expect(cfg.sessionGroup?.collaborationDisabledReason).toBeTruthy();
  });

  it('显式 enabled:true 但结构非法（agents 非数组）→ 保留 + disabledReason', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({ collaboration: { enabled: true, agents: 'nope', kickoff: 'nope' } })]));
    expect(cfg.sessionGroup?.collaboration?.enabled).toBe(true);
    expect(cfg.sessionGroup?.collaborationDisabledReason).toBeTruthy();
  });

  it('sessionGroup 其它字段（naming 等）在 collaboration 非 enabled:true 归一化关闭时仍保留', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({
      naming: { mode: 'truncate' },
      collaboration: { enabled: false },
    })]));
    expect(cfg.sessionGroup?.naming?.mode).toBe('truncate');
    expect(cfg.sessionGroup?.collaboration).toBeUndefined();
    expect(cfg.sessionGroup?.collaborationDisabledReason).toBeUndefined();
  });

  it('collaborationDisabledReason 不泄漏到 JSON.stringify（non-enumerable）', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({ collaboration: { enabled: true, agents: [], kickoff: [] } })]));
    const sg = cfg.sessionGroup! as Record<string, unknown>;
    expect(sg.collaborationDisabledReason).toBeTruthy(); // 可读
    expect(JSON.stringify(sg)).not.toContain('collaborationDisabledReason'); // 不序列化
  });
});

describe('R2：旧标记残留不误判', () => {
  it('旧标记 + 改 enabled:false → 丢弃 collaboration 与旧标记（归一化关闭）', () => {
    // 第一次 parse 得到带标记的坏配置，序列化后改 enabled:false 再 parse
    const [first] = parseBotConfigsFromText(JSON.stringify([entry({ collaboration: { enabled: true, agents: [], kickoff: [] } })]));
    const sg1 = first.sessionGroup! as Record<string, unknown>;
    expect(sg1.collaborationDisabledReason).toBeTruthy();
    // 序列化不会带上标记（non-enumerable），手动构造「旧标记 + enabled:false」输入
    const [second] = parseBotConfigsFromText(JSON.stringify([entry({
      collaboration: { enabled: false },
      collaborationDisabledReason: '旧 agents 错误',
    })]));
    expect(second.sessionGroup?.collaboration).toBeUndefined();
    expect(second.sessionGroup?.collaborationDisabledReason).toBeUndefined();
  });

  it('旧标记 + 删除 collaboration → 归一化关闭（无 collaboration 无标记）', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({
      collaborationDisabledReason: '旧 agents 错误',
    })]));
    expect(cfg.sessionGroup?.collaboration).toBeUndefined();
    expect(cfg.sessionGroup?.collaborationDisabledReason).toBeUndefined();
  });

  it('旧标记 + 修成合法 → 走正常校验（保留合法 config，无旧标记）', () => {
    const [cfg] = parseBotConfigsFromText(JSON.stringify([entry({
      collaboration: validCollab,
      collaborationDisabledReason: '旧 agents 错误',
    })]));
    expect(cfg.sessionGroup?.collaboration?.enabled).toBe(true);
    expect(cfg.sessionGroup?.collaboration?.agents).toHaveLength(1);
    expect(cfg.sessionGroup?.collaborationDisabledReason).toBeUndefined();
  });
});
