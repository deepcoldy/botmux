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
});
