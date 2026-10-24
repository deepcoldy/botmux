/**
 * 决策看板纯模型：CLI 参数解析（选项 / 关联 / 事项引用）、关联链接、侧栏 AppLink、
 * 管家配置校验、规则拼接与批次消息。
 */
import { describe, expect, it } from 'vitest';
import {
  composeStewardGuide,
  formatBatchMessage,
  formatBoardTurnId,
  linkUrl,
  normalizeStewardConfig,
  parseBoardTurnId,
  parseItemRef,
  parseLinkSpec,
  parseOptionSpec,
  renderStewardHintBlock,
  sidebarAppLink,
  stewardGuidePreset,
  stewardReady,
} from '../src/core/decision-board/model.js';

describe('CLI 参数解析', () => {
  it('事项引用：数字、#数字、key', () => {
    expect(parseItemRef('12')).toEqual({ seq: 12 });
    expect(parseItemRef('#7')).toEqual({ seq: 7 });
    expect(parseItemRef('pr:o/r#3')).toEqual({ key: 'pr:o/r#3' });
    expect(parseItemRef('  ')).toBeNull();
  });

  it('选项：键 = 做法 → 结果', () => {
    expect(parseOptionSpec('a=合并 → 老用户无影响')).toEqual({ key: 'A', label: '合并', effect: '老用户无影响' });
    expect(parseOptionSpec('B=先不合')).toEqual({ key: 'B', label: '先不合' });
    expect(parseOptionSpec('C=改 -> 要多一轮复审')).toEqual({ key: 'C', label: '改', effect: '要多一轮复审' });
    expect(parseOptionSpec('没有等号')).toHaveProperty('error');
    expect(parseOptionSpec('长长长长长长长长长=x')).toHaveProperty('error');
  });

  it('关联：各类型的格式校验与标签', () => {
    expect(parseLinkSpec('pr=deepcoldy/botmux#2195|主 PR')).toEqual({ kind: 'pr', ref: 'deepcoldy/botmux#2195', label: '主 PR' });
    expect(parseLinkSpec('chat=oc_abc')).toEqual({ kind: 'chat', ref: 'oc_abc' });
    expect(parseLinkSpec('commit=o/r@236b328')).toEqual({ kind: 'commit', ref: 'o/r@236b328' });
    expect(parseLinkSpec('url=https://example.com/a?x=1|y')).toEqual({ kind: 'url', ref: 'https://example.com/a?x=1|y' });
    expect(parseLinkSpec('url=https://example.com/a | 文档')).toEqual({ kind: 'url', ref: 'https://example.com/a', label: '文档' });
    expect(parseLinkSpec('pr=not-a-pr')).toHaveProperty('error');
    expect(parseLinkSpec('jira=ABC-1')).toHaveProperty('error');
  });
});

describe('链接', () => {
  it('PR / 提交拼 GitHub 地址；群按 brand 走对应 applink 域；会话需要 Dashboard 基址', () => {
    expect(linkUrl({ kind: 'pr', ref: 'o/r#5' }, { brand: 'feishu' })).toBe('https://github.com/o/r/pull/5');
    expect(linkUrl({ kind: 'commit', ref: 'o/r@abcdef1' }, { brand: 'feishu' })).toBe('https://github.com/o/r/commit/abcdef1');
    expect(linkUrl({ kind: 'chat', ref: 'oc_x' }, { brand: 'lark' })).toMatch(/^https:\/\/applink\.larksuite\.com\/client\/chat\/open/);
    expect(linkUrl({ kind: 'session', ref: 'abcdef12-3' }, { brand: 'feishu' })).toBeUndefined();
    expect(linkUrl({ kind: 'session', ref: 'abcdef12-3' }, { brand: 'feishu', dashboardBase: 'https://d.example' }))
      .toBe('https://d.example/#/sessions?session=abcdef12-3');
  });

  it('侧栏 AppLink：sidebar-semi，目标整体编码，按 brand 选域', () => {
    const target = 'https://m-1.example/board/cli_x/3?a=b#frag';
    const link = new URL(sidebarAppLink(target, 'feishu'));
    expect(link.host).toBe('applink.feishu.cn');
    expect(link.pathname).toBe('/client/web_url/open');
    expect(link.searchParams.get('mode')).toBe('sidebar-semi');
    expect(link.searchParams.get('url')).toBe(target);
    expect(new URL(sidebarAppLink(target, 'lark')).host).toBe('applink.larksuite.com');
  });
});

describe('管家配置', () => {
  it('等于默认值归一成 null（不写盘）', () => {
    expect(normalizeStewardConfig({ enabled: false })).toEqual({ ok: true, value: null });
    expect(normalizeStewardConfig({ enabled: false, guideText: '  ' })).toEqual({ ok: true, value: null });
    expect(normalizeStewardConfig(undefined)).toEqual({ ok: true, value: null });
  });

  it('追加模式是默认值，不写进字段；替换模式必须有正文', () => {
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_a', guideMode: 'append', guideText: 'x' }))
      .toEqual({ ok: true, value: { enabled: true, chatId: 'oc_a', guideText: 'x' } });
    expect(normalizeStewardConfig({ enabled: true, guideMode: 'replace' })).toMatchObject({ ok: false });
    expect(normalizeStewardConfig({ enabled: true, chatId: 'bad' })).toMatchObject({ ok: false });
    expect(normalizeStewardConfig({ enabled: true, extra: 1 })).toMatchObject({ ok: false });
  });

  it('开关开了且选了群才算就绪', () => {
    expect(stewardReady({ enabled: true })).toBe(false);
    expect(stewardReady({ enabled: true, chatId: 'oc_a' })).toBe(true);
    expect(stewardReady({ enabled: false, chatId: 'oc_a' })).toBe(false);
  });
});

describe('管家规则与提示', () => {
  it('没有自定义时就是预置；追加时自定义接在预置之后、替换掉「没写推进标准」的占位', () => {
    expect(composeStewardGuide(undefined, 'zh')).toBe(stewardGuidePreset('zh'));
    const appended = composeStewardGuide({ enabled: true, guideText: '合码按 standard.md' }, 'zh');
    expect(appended.startsWith(stewardGuidePreset('zh').slice(0, 40))).toBe(true);
    expect(appended).toContain('合码按 standard.md');
    expect(appended).not.toContain('owner 没有写');
    expect(appended.trimEnd().endsWith('合码按 standard.md')).toBe(true);
  });

  it('替换模式只输出自定义', () => {
    expect(composeStewardGuide({ enabled: true, guideMode: 'replace', guideText: '只做这些' }, 'en')).toBe('只做这些');
  });

  it('常驻提示只指向 guide，chat_id 里的特殊字符被剥掉', () => {
    const block = renderStewardHintBlock('oc_ab"c<>');
    expect(block).toContain('chat_id="oc_abc"');
    expect(block).toContain('botmux board guide');
    expect(block.length).toBeLessThan(400);
  });
});

describe('批次 turnId', () => {
  it('按 appId+批次号生成稳定 id 并可解析回来；非 board 形状返回 null', () => {
    const id = formatBoardTurnId('cli_s', 42);
    expect(id).toBe('board:cli_s:42');
    expect(parseBoardTurnId(id)).toEqual({ appId: 'cli_s', batchId: 42 });
    expect(parseBoardTurnId('om_x')).toBeNull();
    expect(parseBoardTurnId('board:cli_s:x')).toBeNull();
    expect(parseBoardTurnId('board:cli_s:1:2')).toBeNull();
  });
});

describe('批次消息', () => {
  it('带批次号、提交人、每项的选择/说明/附图数，并指向 guide', () => {
    const text = formatBatchMessage({
      batchId: 8,
      authorName: 'owner',
      createdAt: Date.UTC(2026, 9, 24, 7, 2),
      timeZone: 'UTC',
      locale: 'zh',
      entries: [
        { seq: 31, title: '授信方式', state: 'decide', stage: '在审', choice: 'A', choiceLabel: '恢复', recommended: true, text: 'A，开关放 Bot 配置页', fileCount: 2 },
        { seq: 27, title: '界面收紧', state: 'active', text: '第二行没对齐\n修完再合', fileCount: 0 },
      ],
    });
    expect(text.split('\n')[0]).toBe('【决策看板 · 批次 #8】owner 10-24 07:02 提交了 2 项决定。按 `botmux board guide` 里「执行一批决定」一节逐项执行，每项做完运行 `botmux board history <编号> --handled "做了什么、结果"`。');
    expect(text).toContain('#31 授信方式（待拍板·在审）\n  选：A 恢复（管家推荐）\n  说明：A，开关放 Bot 配置页\n  附图：2 张（已随消息附上）');
    expect(text).toContain('#27 界面收紧（进行中）\n  选：未选\n  说明：第二行没对齐\n    修完再合');
  });
});
