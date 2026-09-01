import { describe, expect, it } from 'bun:test';
import { larkConsoleUrl } from '../src/dashboard/web/ui.js';

// 飞书/Lark 开放平台后台深链的 host 必须按 bot 的 brand 派生:feishu 与国际版
// lark 是两个独立平台上的独立应用(AppID 各自独立、登录域不同),拿错 host 打不开
// 对方的应用后台。larkConsoleUrl 是工作台卡片 ↗ 按钮与 Bot 配置页链接的共用实现。
describe('larkConsoleUrl (brand-aware Feishu/Lark console deep link)', () => {
  it('feishu brand → open.feishu.cn', () => {
    expect(larkConsoleUrl('cli_abc123', 'feishu')).toBe('https://open.feishu.cn/app/cli_abc123');
  });

  it('lark (international) brand → open.larksuite.com, NOT feishu.cn', () => {
    // 回归防线:国际版 lark 租户绝不能被导到 feishu.cn(打不开对应应用后台)。
    expect(larkConsoleUrl('cli_abc123', 'lark')).toBe('https://open.larksuite.com/app/cli_abc123');
  });

  it('missing / unknown brand → feishu.cn (normalizeBrand 向后兼容旧 payload)', () => {
    expect(larkConsoleUrl('cli_abc123')).toBe('https://open.feishu.cn/app/cli_abc123');
    expect(larkConsoleUrl('cli_abc123', undefined)).toBe('https://open.feishu.cn/app/cli_abc123');
    // 非法值一律兜底 feishu,绝不拼出坏 host。
    expect(larkConsoleUrl('cli_abc123', 'bogus')).toBe('https://open.feishu.cn/app/cli_abc123');
  });

  it('non-cli_ appId (占位键 / 按名聚合历史卡 / headless local_) → null', () => {
    expect(larkConsoleUrl('local_headless', 'feishu')).toBeNull();
    expect(larkConsoleUrl('SomeBotName', 'lark')).toBeNull();
    expect(larkConsoleUrl(undefined, 'lark')).toBeNull();
    expect(larkConsoleUrl('', 'feishu')).toBeNull();
  });

  it('encodes the appId path segment', () => {
    // AppID 现实中只含 [a-z0-9_],但 helper 仍编码防御,brand 派生不影响这一点。
    expect(larkConsoleUrl('cli_a b', 'lark')).toBe('https://open.larksuite.com/app/cli_a%20b');
  });
});
