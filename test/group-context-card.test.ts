import { describe, expect, it } from 'vitest';
import {
  GROUP_CONTEXT_CARD_CONTENT_VERSION, markGroupContextCardPurpose, projectGroupContextCard,
} from '../src/im/lark/group-context-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { extractCardContent, extractResources } from '../src/im/lark/message-parser.js';
import { stampBotmuxCallbackMarkers } from '../src/im/lark/callback-button-marker.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';
import type { TurnReplyCardRecord } from '../src/services/turn-reply-card.js';

const presentation = { showProcess: true, showToolResults: true, canStop: true, showLiveUsage: true };
function record(extra: Partial<TurnReplyCardRecord> = {}): TurnReplyCardRecord {
  return {
    larkAppId: 'app_test', sessionId: 'session', turnId: 'turn', mode: 'unified',
    chatId: 'chat', rootId: 'root', version: 1, phase: 'working', createdAtMs: 1,
    progress: ['PROGRESS_PRIVATE'], tools: [{ id: 'tool', name: 'Read', subject: 'TOOL_PRIVATE', result: 'RESULT_PRIVATE' }],
    activity: [{ kind: 'thinking', id: 'thought', text: 'THINKING_PRIVATE' }, { kind: 'tool', id: 'tool' },
      { kind: 'progress', id: 'progress', text: 'PROGRESS_PRIVATE' }],
    usage: { context: { usedTokens: 1234, windowTokens: 10000 }, tokens: { in: 222, out: 333 } },
    ...extra,
  };
}

/** The list API drops IDs and flattens markdown/widgets into paragraphs. */
function simplified(raw: string): string {
  const card = JSON.parse(raw);
  const elements: any[][] = [];
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.tag === 'markdown') elements.push([{ tag: 'text', text: node.content.replace(/<\/?font[^>]*>/g, '') }]);
    if (node.tag === 'button') elements.push([{ tag: 'button', text: node.text.content }]);
    if (node.tag === 'img') elements.push([{ tag: 'img', image_key: node.img_key }]);
    for (const key of ['elements', 'columns']) visit(node[key]);
  }
  visit(card.body?.elements ?? card.elements);
  return JSON.stringify({ ...(card.header?.title?.content ? { title: card.header.title.content } : {}), elements });
}

function conversation(raw: string) {
  const projected = projectGroupContextCard(raw);
  expect(projected?.kind).toBe('conversation');
  if (projected?.kind !== 'conversation') throw Error('expected a conversation projection');
  return { ...projected, text: extractCardContent(projected.content), resources: extractResources('interactive', projected.content) };
}

describe('group-context card projection', () => {
  it.each(['queued', 'working', 'failed', 'completed', 'cancelled'] as const)(
    'excludes actual %s producer cards without a formal answer, in both API representations', phase => {
      const raw = buildTurnReplyCard(record({ phase }), presentation);
      expect(projectGroupContextCard(raw)).toEqual({ kind: 'runtime' });
      expect(projectGroupContextCard(simplified(raw))).toEqual({ kind: 'runtime' });
    },
  );

  it('shares a final published while working and retains custom body IDs, layout, and images', () => {
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'FINAL_PUBLIC' }));
    final.header = { title: { tag: 'plain_text', content: 'Custom title' }, template: 'green' };
    final.body.elements.unshift({ tag: 'column_set', element_id: 'author_layout', columns: [{ tag: 'column', width: 'weighted', elements: [
      { tag: 'markdown', element_id: 'author_text', content: 'FINAL_CUSTOM' },
      { tag: 'img', element_id: 'author_image', img_key: 'img_final', alt: { tag: 'plain_text', content: 'Final image' } },
    ] }] });
    const raw = buildTurnReplyCard(record({ finalCard: JSON.stringify(final) }), presentation);
    const projected = conversation(raw);
    expect(projected.turnReply).toBe(true);
    expect(projected.text).toContain('FINAL_PUBLIC');
    expect(projected.text).toContain('FINAL_CUSTOM');
    expect(projected.text).not.toMatch(/PRIVATE|处理中|1234|222|333|停止/);
    expect(projected.resources.map(resource => resource.key)).toEqual(['img_final']);
    expect(JSON.parse(projected.content).header).toEqual(final.header);
    expect(JSON.parse(projected.content).body.elements[0]).toEqual(final.body.elements[0]);
    expect(JSON.parse(raw).body.elements).toContainEqual(final.body.elements[0]);
    expect(projectGroupContextCard(simplified(raw))).toEqual({ kind: 'unresolved' });
  });

  it('removes runtime images and any premerged text before generic text/resource extraction', () => {
    const raw = JSON.parse(buildTurnReplyCard(record({ finalCard: buildCanonicalFinalReplyCard({ markdown: 'FINAL_PUBLIC' }) }), presentation));
    const process = raw.body.elements.find((element: any) => element.element_id === 'botmux_turn_process');
    expect(process).toBeDefined();
    process.elements.push({ tag: 'img', img_key: 'img_tool_private' });
    raw.__botmux_card_text__ = 'STALE_MERGED_PRIVATE';
    const projected = conversation(JSON.stringify(raw));
    expect(projected.text).toContain('FINAL_PUBLIC');
    expect(projected.text).not.toContain('PRIVATE');
    expect(projected.resources).toEqual([]);
    expect(projected.content).not.toContain('__botmux_card_text__');
  });

  it('retains question prompts and option labels after callback stamping without controls or process', () => {
    const raw = buildTurnReplyCard(record({ asks: [{ ask: {
      askId: 'ask', nonce: 'SECRET_NONCE', larkAppId: 'app_test', chatId: 'chat', rootMessageId: 'root', sessionId: 'session',
      createdAt: 1, deadlineAt: 100000, settled: false,
      questions: [{ prompt: 'PUBLIC_QUESTION?', multiSelect: true, options: [{ key: 'yes', label: 'PUBLIC_YES' }, { key: 'no', label: 'PUBLIC_NO' }] }],
    } }] }), presentation);
    const projected = conversation(stampBotmuxCallbackMarkers(raw));
    expect(projected.text).toContain('PUBLIC_QUESTION?');
    expect(projected.text).toContain('PUBLIC_YES');
    expect(projected.text).toContain('PUBLIC_NO');
    expect(projected.content).not.toMatch(/PRIVATE|SECRET_NONCE|ask_submit|ask_toggle|stop_turn|button|deadline/);
    expect(projected.text).not.toMatch(/提交|截止|等待你确认/);
    expect(projectGroupContextCard(simplified(raw))).toEqual({ kind: 'unresolved' });
  });

  it('stamps standalone progress and messages with an invisible purpose that survives Format A', () => {
    const raw = buildCanonicalFinalReplyCard({ markdown: 'Completed is an ordinary answer' });
    expect(GROUP_CONTEXT_CARD_CONTENT_VERSION).toBe(1);
    const runtime = markGroupContextCardPurpose(raw, 'runtime');
    expect(projectGroupContextCard(runtime)).toEqual({ kind: 'runtime' });
    expect(projectGroupContextCard(simplified(runtime))).toEqual({ kind: 'runtime' });
    const message = markGroupContextCardPurpose(raw, 'message');
    expect(conversation(message).turnReply).toBe(false);
    expect(conversation(simplified(message)).text).toBe('Completed is an ordinary answer');
    expect(extractCardContent(message)).toBe('Completed is an ordinary answer');
    const parsed = JSON.parse(raw);
    const copy = structuredClone(parsed);
    markGroupContextCardPurpose(parsed, 'runtime');
    expect(parsed).toEqual(copy);
    expect(markGroupContextCardPurpose(message, 'message')).toBe(message);
    expect(projectGroupContextCard(markGroupContextCardPurpose(runtime, 'message'))?.kind).toBe('conversation');
  });

  it('leaves ordinary author and third-party cards unclassified even when they contain status words', () => {
    for (const raw of [buildCanonicalFinalReplyCard({ markdown: 'Working; Completed; 正在处理' }),
      JSON.stringify({ title: 'Working', elements: [[{ tag: 'text', text: 'Completed' }]] }), '{']) {
      expect(projectGroupContextCard(raw)).toBeUndefined();
    }
  });

  it('extracts legacy final bodies only when their canonical footer establishes the final-card boundary', () => {
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'LEGACY_FINAL' }));
    final.body.elements.unshift({ tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中**' });
    final.body.elements.splice(2, 0, { tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '📋 执行过程' } },
      elements: [{ tag: 'markdown', content: 'LEGACY_PRIVATE' }, { tag: 'img', img_key: 'img_tool' }] });
    const projected = conversation(JSON.stringify(final));
    expect(projected.text).toBe('LEGACY_FINAL');
    expect(projected.resources).toEqual([]);
    expect(projected.turnReply).toBe(true);
  });

  it('treats uncertain legacy status bodies as unresolved instead of sharing progress', () => {
    const raw = JSON.stringify({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成**' },
      { tag: 'markdown', content: 'May be progress, may be a final' },
    ] } });
    expect(projectGroupContextCard(raw)).toEqual({ kind: 'unresolved' });
  });

  it('retains a verified legacy question prefix and options while excluding deadline and tool output', () => {
    const ask = { ask: {
      askId: 'legacy_ask', nonce: 'NONCE', larkAppId: 'app_test', chatId: 'chat', rootMessageId: 'root', sessionId: 'session',
      createdAt: 1, deadlineAt: 100000, settled: false,
      questions: [
        { prompt: 'LEGACY_QUESTION_ONE?', multiSelect: false, options: [{ key: 'a', label: 'ONE_A' }, { key: 'b', label: 'ONE_B' }] },
        { prompt: 'LEGACY_QUESTION_TWO?', multiSelect: true, options: [{ key: 'a', label: 'TWO_A' }, { key: 'b', label: 'TWO_B' }] },
      ],
    } };
    const raw = JSON.stringify({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '🙋 **等待你确认**' },
      ...buildTurnReplyAskElements(ask),
      { tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '📋 执行过程' } },
        elements: [{ tag: 'markdown', content: 'TOOL_PRIVATE' }] },
    ] } });
    const projected = conversation(stampBotmuxCallbackMarkers(raw));
    for (const text of ['LEGACY_QUESTION_ONE?', 'LEGACY_QUESTION_TWO?', 'ONE_A', 'ONE_B', 'TWO_A', 'TWO_B']) expect(projected.text).toContain(text);
    expect(projected.content).not.toMatch(/PRIVATE|NONCE|button|ask_submit|截止/);
    const withFinal = JSON.parse(raw);
    withFinal.body.elements.push(...JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'SEPARATE_FINAL' })).body.elements);
    const both = conversation(JSON.stringify(withFinal));
    expect(both.text).toContain('SEPARATE_FINAL');
    expect(both.text).toContain('LEGACY_QUESTION_TWO?');
    expect(both.content).not.toMatch(/PRIVATE|NONCE|button|ask_submit|截止/);
  });

  it('does not infer a legacy final from a malformed status identity or marker-only footer', () => {
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'Could be anything' }));
    final.body.elements.unshift({ tag: 'markdown', element_id: 'botmux_turn_status', content: 'My custom title' });
    expect(projectGroupContextCard(JSON.stringify(final))).toEqual({ kind: 'unresolved' });
    final.body.elements[0].content = '✅ **已完成**';
    final.body.elements.at(-1).content = "<font color='grey'>\u2063\u2063\u2063\u2063</font>";
    expect(projectGroupContextCard(JSON.stringify(final))).toEqual({ kind: 'unresolved' });
  });

  it('does not remove meaningful author field values from a formal answer', () => {
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'Answer' }));
    final.body.elements.unshift({ tag: 'markdown', element_id: 'custom', property: { value: 'author-value', content: 'PUBLIC_FIELD' } });
    const raw = buildTurnReplyCard(record({ finalCard: JSON.stringify(final) }), presentation);
    expect(JSON.parse(conversation(raw).content).body.elements[0]).toEqual(final.body.elements[0]);
  });

  it('projects the actual card inside a user_dsl wrapper before the generic parser unwraps it', () => {
    const runtime = buildTurnReplyCard(record(), presentation);
    const wrap = (raw: string) => JSON.stringify({ user_dsl: raw, elements: [[{ tag: 'text', text: 'OUTER_PRIVATE' }]], __botmux_card_text__: 'MERGED_PRIVATE' });
    expect(projectGroupContextCard(wrap(runtime))).toEqual({ kind: 'runtime' });
    const raw = buildTurnReplyCard(record({ finalCard: buildCanonicalFinalReplyCard({ markdown: 'INNER_FINAL' }) }), presentation);
    const projected = conversation(wrap(raw));
    expect(projected.text).toBe('INNER_FINAL');
    expect(projected.content).not.toMatch(/PRIVATE|user_dsl/);
  });

  it('retains a final answer after Lark normalizes markdown into property trees', () => {
    const card = JSON.parse(buildTurnReplyCard(record({ finalCard: buildCanonicalFinalReplyCard({ markdown: 'NORMALIZED_FINAL' }) }), presentation));
    for (const element of card.body.elements) {
      if (element.tag !== 'markdown') continue;
      element.property = { elements: [{ tag: 'plain_text', property: { content: element.content, textAlign: 'left' } }], markdownElements: [], originTag: 'lark_md' };
      delete element.content;
    }
    expect(conversation(JSON.stringify(card)).text).toBe('NORMALIZED_FINAL');
  });

  it.each([false, true])('retains legacy final text after status/footer normalization with plain rendered text=%s', plain => {
    const card = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'LEGACY_NORMALIZED_FINAL' }));
    card.body.elements.unshift({ tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中 · 1.0s**' });
    card.body.elements.push({ tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: '📋 Activity (1 tool call)' } },
      elements: [{ tag: 'markdown', content: 'PRIVATE_PROCESS' }, { tag: 'img', img_key: 'img_tool' }] });
    for (const element of card.body.elements) {
      if (element.tag !== 'markdown') continue;
      const text = plain ? element.content.replace(/<[^>]+>/g, '').replace(/\*\*/g, '') : element.content;
      element.property = { elements: [{ tag: 'plain_text', property: { content: text } }], markdownElements: [], originTag: 'lark_md' };
      delete element.content;
      delete element.text_size;
    }
    const projected = conversation(JSON.stringify(card));
    expect(projected.text).toBe('LEGACY_NORMALIZED_FINAL');
    expect(projected.resources).toEqual([]);
    expect(projected.turnReply).toBe(true);
    const footer = card.body.elements.find((element: any) => element.element_id === 'botmux_reply_footer');
    footer.property.elements[0].property.content = '\u2063'.repeat(4);
    expect(projectGroupContextCard(JSON.stringify(card))).toEqual({ kind: 'unresolved' });
  });

  it.each([false, true])('excludes legacy English counted activity panels with normalized title=%s', normalized => {
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'PUBLIC_FINAL' }));
    final.body.elements.unshift({ tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **Completed**' });
    final.body.elements.push({ tag: 'collapsible_panel', header: { title: { tag: 'plain_text',
      ...(normalized ? { property: { content: '📋 Activity (1 tool call)' } } : { content: '📋 Activity (1 tool call)' }) } },
      elements: [{ tag: 'markdown', content: 'PRIVATE_OUTPUT' }, { tag: 'img', img_key: 'img_tool' }] });
    const projected = conversation(JSON.stringify(final));
    expect(projected.text).toBe('PUBLIC_FINAL');
    expect(projected.resources).toEqual([]);
  });

  it('retains an author link-button destination as text while excluding its interactive control', () => {
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'PUBLIC_FINAL' }));
    final.body.elements.push({ tag: 'button', element_id: 'author_link', text: { tag: 'plain_text', content: 'Read the report' },
      behaviors: [{ type: 'open_url', default_url: 'https://example.com/report' }] });
    const raw = buildTurnReplyCard(record({ finalCard: JSON.stringify(final) }), presentation);
    const projected = conversation(raw);
    expect(projected.text).toContain('[Read the report](https://example.com/report)');
    expect(projected.content).not.toContain('"tag":"button"');
  });

  it('does not interpret callback payload text as a rendered purpose marker', () => {
    const plain = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'AUTHOR_TEXT' }));
    plain.body.elements.push({ tag: 'button', text: { tag: 'plain_text', content: 'Action' },
      behaviors: [{ type: 'callback', value: { text: '\u2063'.repeat(12) } }] });
    expect(projectGroupContextCard(JSON.stringify(plain))).toBeUndefined();
  });

  it('tolerates malformed JSON values and callback shapes', () => {
    for (const raw of ['null', '[]', '1', '{']) {
      expect(markGroupContextCardPurpose(raw, 'runtime')).toBe(raw);
      expect(projectGroupContextCard(raw)).toBeUndefined();
    }
    const final = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'PUBLIC_FINAL' }));
    final.body.elements.push({ tag: 'button', text: 'Malformed', behaviors: {} });
    const raw = buildTurnReplyCard(record({ finalCard: JSON.stringify(final) }), presentation);
    expect(conversation(raw).text).toBe('PUBLIC_FINAL');
  });

  it('uses the explicit options region after normalized B strips callback metadata', () => {
    const card = JSON.parse(buildTurnReplyCard(record({ asks: [{ ask: {
      askId: 'ask', nonce: 'NONCE', larkAppId: 'app_test', chatId: 'chat', rootMessageId: 'root', sessionId: 'session',
      createdAt: 1, deadlineAt: 100000, settled: false,
      questions: [{ prompt: 'PUBLIC_QUESTION?', multiSelect: false, options: [{ key: 'yes', label: 'PUBLIC_YES' }, { key: 'no', label: 'PUBLIC_NO' }] }],
    } }] }), presentation));
    for (const element of card.body.elements) {
      if (!element.element_id?.startsWith('botmux_turn_options_')) continue;
      for (const column of element.columns) for (const button of column.elements) {
        button.text = { tag: 'plain_text', property: { content: button.text.content } };
        delete button.behaviors;
      }
    }
    const projected = conversation(JSON.stringify(card));
    expect(projected.text).toContain('PUBLIC_YES');
    expect(projected.text).toContain('PUBLIC_NO');
  });

  it('keeps progress heading hierarchy in ordinary history while excluding it from shared context', () => {
    const raw = buildTurnReplyCard(record({ progress: ['# Checking the build'], activity: [], tools: [] }), presentation);
    expect(extractCardContent(raw)).toContain('# Checking the build');
    expect(projectGroupContextCard(raw)).toEqual({ kind: 'runtime' });
  });
});
