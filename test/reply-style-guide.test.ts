import { describe, expect, it } from 'vitest';

import {
  parseReplyStyleGuideConfig,
  renderBotmuxSendSkill,
  SEND_SKILL_SESSION_LOADER,
} from '../src/skills/reply-style-guide.js';

function env(style: unknown): Record<string, string | undefined> {
  return { BOTMUX_REPLY_STYLE: JSON.stringify(style) };
}

describe('session-scoped botmux-send reply style guide', () => {
  it('defaults both recipes and semantic layouts on', () => {
    const guide = renderBotmuxSendSkill({});
    expect(guide).toContain('可选排版配方（参考，不是强制模板）');
    expect(guide).toContain('结果摘要');
    expect(guide).toContain('方案对比');
    expect(guide).toContain('可选语义卡头：`--layout`');
    expect(guide).toContain('`--layout result`');
    expect(guide).toContain('`--layout handoff`');
    expect(guide).toContain('单句确认、简短状态和无实质进展的消息不要加卡头');
    expect(guide).toContain('这一行只写纯文字，不放内联 @、链接或其它 Markdown 语法');
    expect(guide).toContain('--layout <result\\|progress\\|risk\\|blocked\\|handoff>');
  });

  it('removes the five-recipe section and all of its selection signals', () => {
    const guide = renderBotmuxSendSkill(env({ recipes: false }));
    for (const shippedRecipeText of [
      '可选排版配方',
      '结果摘要',
      '方案对比',
      '风险 / 待确认',
      '交接说明',
      '对不上这五类时',
    ]) {
      expect(guide).not.toContain(shippedRecipeText);
    }
    // The independently enabled layout guide remains available.
    expect(guide).toContain('可选语义卡头：`--layout`');
  });

  it('uses a nonblank recipePrompt as a replacement, not an addendum', () => {
    const guide = renderBotmuxSendSkill(env({
      recipes: true,
      recipePrompt: '### 团队写作约定\n\n先给一句结论，再列证据。',
    }));
    expect(guide).toContain('### 团队写作约定');
    expect(guide).toContain('先给一句结论，再列证据。');
    expect(guide).not.toContain('可选排版配方（参考，不是强制模板）');
    expect(guide).not.toContain('结果摘要');
    expect(guide).not.toContain('方案对比');
  });

  it('ignores recipePrompt while recipes are disabled', () => {
    const guide = renderBotmuxSendSkill(env({
      recipes: false,
      recipePrompt: 'THIS MUST NOT APPEAR',
    }));
    expect(guide).not.toContain('THIS MUST NOT APPEAR');
  });

  it('removes every factory --layout mention while layout is disabled', () => {
    const guide = renderBotmuxSendSkill(env({ layout: false }));
    expect(guide).not.toContain('--layout');
    expect(guide).toContain('可选排版配方');
  });

  it('removes conflicting custom --layout lines while preserving other custom recipes', () => {
    const guide = renderBotmuxSendSkill(env({
      layout: false,
      recipePrompt: [
        '### 团队写作约定',
        '先说结论。',
        '关键结果请用 `--layout result`。',
        '证据放在结论后。',
      ].join('\n'),
    }));
    expect(guide).not.toContain('--layout');
    expect(guide).toContain('### 团队写作约定');
    expect(guide).toContain('先说结论。');
    expect(guide).toContain('证据放在结论后。');
    expect(guide).not.toContain('关键结果请用');
  });

  it('fails soft to factory defaults for malformed JSON', () => {
    expect(parseReplyStyleGuideConfig('{oops')).toEqual({});
    const guide = renderBotmuxSendSkill({ BOTMUX_REPLY_STYLE: '{oops' });
    expect(guide).toContain('可选排版配方');
    expect(guide).toContain('--layout result');
  });

  it('ships a stable loader that delegates to the session-scoped command', () => {
    expect(SEND_SKILL_SESSION_LOADER).toContain('name: botmux-send');
    expect(SEND_SKILL_SESSION_LOADER).toContain('botmux skill show botmux-send');
    expect(SEND_SKILL_SESSION_LOADER).not.toContain('结果摘要');
    expect(SEND_SKILL_SESSION_LOADER).not.toContain('--layout result');
  });
});
