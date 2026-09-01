import { describe, expect, it } from 'vitest';
import {
  buildDefaultReplyLayoutHeader,
  buildReplyLayoutHeader,
  DEFAULT_REPLY_LAYOUT_COLORS,
  DEFAULT_REPLY_LAYOUT_TAGS,
  DEFAULT_REPLY_LAYOUT_TITLES,
  normalizeReplyStyleConfig,
  parseReplyLayoutRequest,
  REPLY_LAYOUT_TAG_MAX_CODEPOINTS,
  REPLY_LAYOUT_TAG_COLORS,
  REPLY_LAYOUTS,
  REPLY_RECIPE_PROMPT_MAX_CODEPOINTS,
  resolveReplyStyle,
} from '../src/im/lark/reply-card-style.js';

describe('reply-card layout request', () => {
  it('accepts both flag spellings for every supported layout', () => {
    for (const layout of REPLY_LAYOUTS) {
      expect(parseReplyLayoutRequest(['正文', '--layout', layout])).toEqual({
        present: true,
        layout,
      });
      expect(parseReplyLayoutRequest([`--layout=${layout}`, '正文'])).toEqual({
        present: true,
        layout,
      });
    }
  });

  it('distinguishes an absent request from fail-soft invalid requests', () => {
    expect(parseReplyLayoutRequest(['正文'])).toEqual({ present: false });

    for (const args of [
      ['--layout'],
      ['--layout', '--no-mention'],
      ['--layout='],
      ['--layout', 'diff'],
      ['--layout=compare'],
      ['--layout', 'result', '--layout', 'risk'],
    ]) {
      const parsed = parseReplyLayoutRequest(args);
      expect(parsed.present).toBe(true);
      expect(parsed.layout).toBeUndefined();
      expect(parsed.warning).toMatch(/已忽略并按普通回复卡发送/);
    }
  });
});

describe('default reply-card layout headers', () => {
  it('keeps the finalised five prefixes and official color mapping', () => {
    expect(DEFAULT_REPLY_LAYOUT_TITLES).toEqual({
      result: '结果',
      progress: '进度',
      risk: '需要确认',
      blocked: '受阻',
      handoff: '交接',
    });
    expect(DEFAULT_REPLY_LAYOUT_COLORS).toEqual({
      result: 'green',
      progress: 'blue',
      risk: 'orange',
      blocked: 'red',
      handoff: 'indigo',
    });
  });

  it('adds a red “需要你” tag only to risk and blocked', () => {
    expect(DEFAULT_REPLY_LAYOUT_TAGS).toEqual({
      result: '',
      progress: '',
      risk: '需要你',
      blocked: '需要你',
      handoff: '',
    });

    for (const layout of REPLY_LAYOUTS) {
      const header = buildDefaultReplyLayoutHeader(layout);
      expect(header.template).toBe(DEFAULT_REPLY_LAYOUT_COLORS[layout]);
      expect(header.title.content).toBe(DEFAULT_REPLY_LAYOUT_TITLES[layout]);
      if (layout === 'risk' || layout === 'blocked') {
        expect(header.text_tag_list).toEqual([{
          tag: 'text_tag',
          color: 'red',
          text: { tag: 'plain_text', content: '需要你' },
        }]);
      } else {
        expect(header).not.toHaveProperty('text_tag_list');
      }
    }
  });

  it('derives a personalised title without duplicating its semantic prefix', () => {
    expect(buildDefaultReplyLayoutHeader('result', '依赖升级完成').title.content)
      .toBe('结果 · 依赖升级完成');
    expect(buildDefaultReplyLayoutHeader('result', '结果').title.content).toBe('结果');
    expect(buildDefaultReplyLayoutHeader('result', ' 结果： ').title.content).toBe('结果');
    expect(buildDefaultReplyLayoutHeader('result', '结果 · 结果').title.content).toBe('结果');
    expect(buildDefaultReplyLayoutHeader('blocked', '生产验证受阻').title.content)
      .toBe('受阻 · 生产验证受阻');
  });
});

describe('replyStyle normalisation and theme resolution', () => {
  it('keeps the config sparse while preserving explicit hidden tags', () => {
    expect(normalizeReplyStyleConfig(undefined)).toEqual({ warnings: [] });
    expect(normalizeReplyStyleConfig({
      recipes: false,
      layout: true,
      theme: 'minimal',
      recipePrompt: '  用自定义配方写作  ',
      layoutColors: { risk: 'purple' },
      layoutTags: { result: '', risk: '请确认' },
    })).toEqual({
      config: {
        recipes: false,
        layout: true,
        theme: 'minimal',
        recipePrompt: '用自定义配方写作',
        layoutColors: { risk: 'purple' },
        layoutTags: { result: '', risk: '请确认' },
      },
      warnings: [],
    });
  });

  it('drops malformed fields one by one and reports every fallback', () => {
    const normalized = normalizeReplyStyleConfig({
      recipes: 'yes',
      layout: 1,
      theme: 'loud',
      recipePrompt: 42,
      layoutColors: {
        risk: 'pink',
        handoff: 'grey',
        result: 'green',
        compare: 'blue',
      },
      layoutTags: { risk: 42, blocked: ' 需要你 ', diff: 'no' },
    });

    expect(normalized.config).toEqual({
      layoutColors: { result: 'green' },
      layoutTags: { blocked: '需要你' },
    });
    expect(normalized.warnings).toHaveLength(9);
    expect(normalized.warnings.join('\n')).toContain('handoff 不允许 grey');
    expect(normalized.warnings.join('\n')).toContain('layoutColors.compare');
    expect(normalized.warnings.join('\n')).toContain('layoutTags.diff');
  });

  it('accepts exact Unicode limits and drops only fields that exceed them', () => {
    const promptAtLimit = '🧪'.repeat(REPLY_RECIPE_PROMPT_MAX_CODEPOINTS);
    const tagAtLimit = '✅'.repeat(REPLY_LAYOUT_TAG_MAX_CODEPOINTS);
    expect(normalizeReplyStyleConfig({
      recipePrompt: promptAtLimit,
      layoutTags: { risk: tagAtLimit },
    })).toEqual({
      config: { recipePrompt: promptAtLimit, layoutTags: { risk: tagAtLimit } },
      warnings: [],
    });

    const over = normalizeReplyStyleConfig({
      recipes: false,
      recipePrompt: `${promptAtLimit}超`,
      layoutTags: {
        risk: `${tagAtLimit}长`,
        blocked: '请处理',
      },
    });
    expect(over.config).toEqual({
      recipes: false,
      layoutTags: { blocked: '请处理' },
    });
    expect(over.warnings).toHaveLength(2);
    expect(over.warnings.join('\n')).toContain(`${REPLY_RECIPE_PROMPT_MAX_CODEPOINTS} 个 Unicode 字符`);
    expect(over.warnings.join('\n')).toContain(`layoutTags.risk 不能超过 ${REPLY_LAYOUT_TAG_MAX_CODEPOINTS}`);
  });

  it('drops environment-breaking or non-label control characters field by field', () => {
    const normalized = normalizeReplyStyleConfig({
      recipePrompt: '不能进入环境\0尾部',
      layoutTags: {
        risk: '第一行\n第二行',
        progress: '进度\u0085标签',
        blocked: '需要你',
      },
    });
    expect(normalized.config).toEqual({ layoutTags: { blocked: '需要你' } });
    expect(normalized.warnings).toHaveLength(3);
    expect(normalized.warnings.join('\n')).toContain('recipePrompt 不能包含 NUL');
    expect(normalized.warnings.join('\n')).toContain('layoutTags.risk 不能包含控制字符');
    expect(normalized.warnings.join('\n')).toContain('layoutTags.progress 不能包含控制字符');
  });

  it('falls back to the default block when the entire value is malformed', () => {
    expect(normalizeReplyStyleConfig('default')).toEqual({
      warnings: ['replyStyle 必须是对象，已忽略并使用缺省回复风格'],
    });
    expect(resolveReplyStyle()).toMatchObject({
      recipes: true,
      layout: true,
      theme: 'default',
    });
  });

  it('resolves default, minimal, and vivid without changing layout semantics', () => {
    const defaultStyle = resolveReplyStyle();
    expect(defaultStyle.layouts.result).toEqual({ template: 'green', tagColor: 'green' });
    expect(defaultStyle.layouts.risk).toEqual({ template: 'orange', tag: '需要你', tagColor: 'red' });

    const minimal = resolveReplyStyle({ theme: 'minimal' });
    expect(minimal.layouts.result).toEqual({ tagColor: 'green' });
    expect(minimal.layouts.blocked).toEqual({ tag: '需要你', tagColor: 'red' });

    const vivid = resolveReplyStyle({ theme: 'vivid' });
    expect(vivid.layouts).toMatchObject({
      result: { template: 'green', tag: '完成', tagColor: 'green' },
      progress: { template: 'blue', tag: '进行中', tagColor: 'blue' },
      risk: { template: 'orange', tag: '需要你', tagColor: 'red' },
      blocked: { template: 'red', tag: '需要你', tagColor: 'red' },
      handoff: { template: 'indigo', tag: '交接', tagColor: 'indigo' },
    });
    expect(REPLY_LAYOUT_TAG_COLORS).toEqual({
      result: 'green', progress: 'blue', risk: 'red', blocked: 'red', handoff: 'indigo',
    });
  });

  it('applies sparse color/tag overrides after the theme defaults', () => {
    const style = resolveReplyStyle({
      theme: 'minimal',
      layoutColors: { progress: 'wathet' },
      layoutTags: { risk: '', handoff: '交给你' },
    });
    expect(style.layouts.progress.template).toBe('wathet');
    expect(style.layouts.result.template).toBeUndefined();
    expect(style.layouts.risk.tag).toBeUndefined();
    expect(style.layouts.handoff).toMatchObject({ tag: '交给你', tagColor: 'indigo' });
  });

  it('builds themed headers and fail-softs a forged non-tag color to neutral', () => {
    const vivid = resolveReplyStyle({ theme: 'vivid', layoutColors: { result: 'purple' } });
    expect(buildReplyLayoutHeader('result', '发布完成', vivid)).toEqual({
      template: 'purple',
      title: { tag: 'plain_text', content: '结果 · 发布完成' },
      text_tag_list: [{
        tag: 'text_tag',
        color: 'green',
        text: { tag: 'plain_text', content: '完成' },
      }],
    });

    const forged = resolveReplyStyle({ layoutTags: { risk: '请确认' } });
    (forged.layouts.risk as any).tagColor = 'grey';
    expect(buildReplyLayoutHeader('risk', undefined, forged).text_tag_list?.[0].color)
      .toBe('neutral');
  });
});
