/**
 * Tests for the card structured-data export + render fixes
 * (quoted --raw / history --with-card-json / a-node URL dedup /
 *  button open_url / img alt).
 *
 * Shapes mirror REAL Argos alarm cards captured live (2026-07-15):
 *  - Format A `a` nodes for bare long URLs come back with text === href, both
 *    cut at the same offset, remainder spilling into following text nodes.
 *  - v2 buttons carry behaviors [{type:'open_url', default_url}]; callback
 *    buttons have no URL.
 *  - v1 img elements carry alt: {tag:'plain_text', content:'报警前30分钟…'}.
 *
 * Run:  pnpm vitest run test/card-json-export.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseApiMessage,
  createImgNumberer,
  resolveMergedCardContent,
} from '../src/im/lark/message-parser.js';
import { renderQuotedMessage } from '../src/cli/quoted-render.js';
import { cleanPromptText } from '../src/dashboard/web/insights.js';
import { BUILTIN_SKILLS } from '../src/skills/definitions.js';

vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: vi.fn(),
}));
import { getMessageDetail } from '../src/im/lark/client.js';

function makeMsg(msgType: string, content: object | string) {
  return {
    message_id: 'om_test',
    msg_type: msgType,
    create_time: '1000',
    sender: { id: 'ou_sender', sender_type: 'user' },
    body: { content: typeof content === 'string' ? content : JSON.stringify(content) },
  };
}

// ─── Format A: bare long URL split across a-node + text remainders ────────

describe('Format A a-node: text === href dedup (Argos Kibana 处理建议 URL)', () => {
  const HEAD = "https://kibana.example.net/app/discover#/?_g=(filters:!(),index:'system_east-";
  const REST1 = "*',key:service,negate:!f),query:(match_phrase:(service:gateway)))";

  it('emits a single copy so join() reconstructs the full URL from remainder nodes', () => {
    const card = {
      title: 'alarm',
      elements: [[
        { tag: 'text', text: '[ 处理建议 ]：' },
        { tag: 'a', text: HEAD, href: HEAD },
        { tag: 'text', text: REST1 },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain(`[ 处理建议 ]：${HEAD}${REST1}`);
    // The doubled `url(url)` form must be gone.
    expect(result.content).not.toContain(`${HEAD}(${HEAD}`);
  });

  it('keeps text(href) for genuine labeled links', () => {
    const card = {
      title: 'alarm',
      elements: [[
        { tag: 'a', text: '[点击查看详情]', href: 'https://argos.example.net/detail/1' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[点击查看详情](https://argos.example.net/detail/1)');
  });
});

// ─── Format B: button open_url across schema generations ──────────────────

describe('Format B button: jump URL is kept, callback buttons stay bare', () => {
  it('v2 behaviors open_url → [text](url); callback → [text]', () => {
    const card = {
      config: {},
      elements: [
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '深度分析' }, behaviors: [{ type: 'callback' }] },
          { tag: 'button', text: { tag: 'plain_text', content: '分析报告' }, behaviors: [{ type: 'open_url', default_url: 'http://argos.example.net/report/1' }] },
        ] },
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[深度分析]');
    expect(result.content).not.toContain('[深度分析](');
    expect(result.content).toContain('[分析报告](http://argos.example.net/report/1)');
  });

  it('v1 url and multi_url variants are honored', () => {
    const card = {
      config: {},
      elements: [
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '打开终端' }, multi_url: { url: 'https://t.example.com/x', pc_url: '' } },
          { tag: 'button', text: { tag: 'plain_text', content: '查看文档' }, url: 'https://doc.example.com/y' },
        ] },
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[打开终端](https://t.example.com/x)');
    expect(result.content).toContain('[查看文档](https://doc.example.com/y)');
  });

  it('empty-string URLs fall through to the next platform URL (not ??-swallowed)', () => {
    const card = {
      config: {},
      elements: [
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '多端' }, multi_url: { url: '', pc_url: 'https://pc.example/x' } },
          { tag: 'button', text: { tag: 'plain_text', content: '行为' }, behaviors: [{ type: 'open_url', default_url: '', pc_url: 'https://pc.example/y' }] },
          { tag: 'button', text: { tag: 'plain_text', content: '全空' }, multi_url: { url: '', pc_url: '' } },
        ] },
      ],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[多端](https://pc.example/x)');
    expect(result.content).toContain('[行为](https://pc.example/y)');
    expect(result.content).toContain('[全空]');
    expect(result.content).not.toContain('[全空](');
  });
});

// ─── Format A button: url/multi_url on the message.list main path ─────────

describe('Format A button: jump URL survives the un-resolved list view', () => {
  it('v1 url / multi_url render as [text](url); bare buttons stay bare', () => {
    // Simple cards (no upgrade fallback) reach `botmux history` straight from
    // im.v1.message.list Format A without a resolve pass — the URL must
    // survive HERE, not only in the Format B path.
    const card = {
      title: 'x',
      elements: [[
        { tag: 'button', text: '查看', url: 'https://example.com/report' },
        { tag: 'button', text: '多端', multi_url: { url: '', pc_url: 'https://pc.example/z' } },
        { tag: 'button', text: '回调', type: 'default' },
      ]],
    };
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[查看](https://example.com/report)');
    expect(result.content).toContain('[多端](https://pc.example/z)');
    expect(result.content).toContain('[回调]');
    expect(result.content).not.toContain('[回调](');
  });
});

// ─── Format B: img alt carried into the placeholder ───────────────────────

describe('Format B img alt: chart description survives into the placeholder', () => {
  const card = {
    config: {},
    elements: [
      { tag: 'img', img_key: 'img_chart_1', alt: { tag: 'plain_text', content: '报警前30分钟今(红)昨(蓝)同比' } },
      { tag: 'img', img_key: 'img_plain_2', alt: { tag: 'plain_text', content: '' } },
    ],
  };

  it('with numberer: [图片 N: alt]; empty alt keeps the bare placeholder', () => {
    const numberer = createImgNumberer();
    const result = parseApiMessage(makeMsg('interactive', card), numberer);
    expect(result.content).toContain('[图片 1: 报警前30分钟今(红)昨(蓝)同比]');
    expect(result.content).toContain('[图片 2]');
    expect(result.content).not.toContain('[图片 2:');
  });

  it('without numberer: [图片: alt]', () => {
    const result = parseApiMessage(makeMsg('interactive', card));
    expect(result.content).toContain('[图片: 报警前30分钟今(红)昨(蓝)同比]');
  });
});

// ─── resolveMergedCardContent: resources surfaced, numbered before text ───

describe('resolveMergedCardContent: returns resources aligned with [图片 N]', () => {
  beforeEach(() => {
    vi.mocked(getMessageDetail).mockReset();
  });

  const structuredB = JSON.stringify({
    config: {},
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**分析结论**' } },
      { tag: 'img', img_key: 'img_curve', alt: { tag: 'plain_text', content: '同比曲线' } },
    ],
  });
  const simplifiedA = JSON.stringify({
    title: 'alarm',
    elements: [[{ tag: 'text', text: '分析结论' }], [{ tag: 'img', image_key: 'img_curve' }]],
  });

  it('exposes structuredContent + resources; shared numberer keeps text/resource numbers aligned', async () => {
    vi.mocked(getMessageDetail).mockImplementation(async (_app: string, _id: string, opts?: { userCardContent?: boolean }) => ({
      items: [{ body: { content: opts?.userCardContent === false ? simplifiedA : structuredB } }],
    }));
    const numberer = createImgNumberer();
    const merged = await resolveMergedCardContent('app', 'om_card', numberer);
    expect(merged).not.toBeNull();
    expect(merged!.structuredContent).toBe(structuredB);
    expect(merged!.resources).toEqual([{ type: 'image', key: 'img_curve', name: 'img_curve.jpg' }]);
    // Resources were numbered BEFORE text extraction → placeholder is [图片 1].
    expect(merged!.text).toContain('[图片 1: 同比曲线]');
  });

  it('returns null when both representations fail', async () => {
    vi.mocked(getMessageDetail).mockRejectedValue(new Error('boom'));
    expect(await resolveMergedCardContent('app', 'om_card')).toBeNull();
  });
});

// ─── quoted pipeline: merge replaces content + resources wholesale ────────

describe('renderQuotedMessage: interactive merge replaces content AND resources', () => {
  // List/API view carries the upgrade-fallback shell: a phantom img + "请升级"
  // text. The merge pass must drop that shell resource and renumber from 1.
  const shellMsg = {
    message_id: 'om_card',
    msg_type: 'interactive',
    create_time: '1000',
    sender: { id: 'ou_bot', sender_type: 'app' },
    body: { content: JSON.stringify({
      title: 'alarm',
      elements: [[{ tag: 'img', image_key: 'img_shell' }, { tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
    }) },
  };
  const noExpand = async () => ({ extraResources: [] });

  it('numbered [图片 N] aligns with merged.resources; shell image is dropped; structured JSON surfaced', async () => {
    const structured = JSON.stringify({
      config: {},
      elements: [
        { tag: 'img', img_key: 'img_curve_a', alt: { tag: 'plain_text', content: '同比A' } },
        { tag: 'img', img_key: 'img_curve_b', alt: { tag: 'plain_text', content: '同比B' } },
      ],
    });
    const resolveStub = async (_app: string, _id: string, numberer: ReturnType<typeof createImgNumberer>) => {
      // Mirror resolveMergedCardContent's ordering contract: resources first,
      // then text reuses the numbers.
      const resources = [
        { type: 'image' as const, key: 'img_curve_a', name: 'img_curve_a.jpg' },
        { type: 'image' as const, key: 'img_curve_b', name: 'img_curve_b.jpg' },
      ];
      for (const r of resources) numberer.assign(`image:${r.key}`);
      const text = `[图片 ${numberer.assign('image:img_curve_a').num}: 同比A]\n[图片 ${numberer.assign('image:img_curve_b').num}: 同比B]`;
      return { text, structuredContent: structured, resources };
    };

    const rendered = await renderQuotedMessage('app', shellMsg, noExpand, resolveStub);
    expect(rendered.content).toBe('[图片 1: 同比A]\n[图片 2: 同比B]');
    expect(rendered.resources).toEqual([
      { type: 'image', key: 'img_curve_a', name: 'img_curve_a.jpg' },
      { type: 'image', key: 'img_curve_b', name: 'img_curve_b.jpg' },
    ]);
    expect(rendered.resources.map(r => r.key)).not.toContain('img_shell');
    expect(rendered.mergedStructuredContent).toBe(structured);
  });

  it('merge failure keeps the pre-merge render and resources (no structured JSON)', async () => {
    const rendered = await renderQuotedMessage('app', shellMsg, noExpand, async () => null);
    expect(rendered.resources).toEqual([{ type: 'image', key: 'img_shell', name: 'img_shell.jpg' }]);
    expect(rendered.mergedStructuredContent).toBeUndefined();
  });

  it('end-to-end with the real resolver: numbering restarts at 1 aligned with resources', async () => {
    const structuredB = JSON.stringify({
      config: {},
      elements: [{ tag: 'img', img_key: 'img_real', alt: { tag: 'plain_text', content: '曲线' } }],
    });
    vi.mocked(getMessageDetail).mockImplementation(async (_app: string, _id: string, opts?: { userCardContent?: boolean }) => ({
      items: [{ body: { content: opts?.userCardContent === false ? shellMsg.body.content : structuredB } }],
    }));
    const rendered = await renderQuotedMessage('app', shellMsg, noExpand, resolveMergedCardContent);
    expect(rendered.content).toContain('[图片 1: 曲线]');
    expect(rendered.resources).toEqual([{ type: 'image', key: 'img_real', name: 'img_real.jpg' }]);
    expect(rendered.mergedStructuredContent).toBe(structuredB);
  });
});

// ─── insights cleanPromptText tolerates the alt suffix ────────────────────

describe('cleanPromptText: strips [图片 N: alt] placeholder lines', () => {
  it('placeholder with alt suffix is removed like the bare form', () => {
    const out = cleanPromptText('看这个\n[图片 1: 报警前30分钟今(红)昨(蓝)同比] 其余\n[文件 2: spec.pdf] x\n正文');
    expect(out).not.toContain('图片 1');
    expect(out).not.toContain('文件 2');
    expect(out).toContain('正文');
  });
});

// ─── skill docs teach the new flags ───────────────────────────────────────

describe('builtin skill docs: card JSON export + attachment guidance', () => {
  it('botmux-history documents --with-card-json, resources and the quoted handoff', () => {
    const history = BUILTIN_SKILLS.find(s => s.name === 'botmux-history')!;
    expect(history.content).toContain('--with-card-json');
    expect(history.content).toContain('resources');
    expect(history.content).toContain('botmux quoted <messageId>');
  });

  it('botmux-quoted documents --raw, auto-download and any-message-id usage', () => {
    const quoted = BUILTIN_SKILLS.find(s => s.name === 'botmux-quoted')!;
    expect(quoted.content).toContain('--raw');
    expect(quoted.content).toContain('cardJson');
    expect(quoted.content).toContain('附件会自动下载到本地');
    expect(quoted.content).toContain('任意');
    expect(quoted.content).not.toContain('当前不支持自动下载');
  });
});
