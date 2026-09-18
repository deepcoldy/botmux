import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CrossPrincipalChoiceKind } from '../src/core/cross-principal-choice.js';
import {
  crossPrincipalAgentHint,
  crossPrincipalBotClassifyNotice,
  crossPrincipalClassificationOptions,
  embedCrossPrincipalAsToken,
  isCrossPrincipalChoiceOnlyText,
  parseCrossPrincipalAsFlag,
  parseCrossPrincipalChoiceText,
  stripCrossPrincipalAsToken,
} from '../src/core/cross-principal-choice.js';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('cross-principal choice vocabulary', () => {
  it('parses --as aliases for the two agent options', () => {
    expect(parseCrossPrincipalAsFlag('independent')).toBe('independent');
    expect(parseCrossPrincipalAsFlag('另开任务')).toBe('independent');
    expect(parseCrossPrincipalAsFlag('独立任务')).toBe('independent');
    expect(parseCrossPrincipalAsFlag('suggestion')).toBe('suggestion');
    expect(parseCrossPrincipalAsFlag('留给当前任务')).toBe('suggestion');
    expect(parseCrossPrincipalAsFlag('建议')).toBe('suggestion');
    expect(parseCrossPrincipalAsFlag('maybe')).toBeUndefined();
  });

  it('round-trips a hidden token without changing the visible body', () => {
    const embedded = embedCrossPrincipalAsToken('请帮我看一下这段 diff', 'independent');
    expect(embedded).toContain('请帮我看一下这段 diff');
    expect(embedded).toContain('<!--botmux-as:independent-->');

    const stripped = stripCrossPrincipalAsToken(embedded);
    expect(stripped.text).toBe('请帮我看一下这段 diff');
    expect(stripped.choice).toBe('independent');
  });

  it('treats a token-only body as a follow-up choice', () => {
    const embedded = embedCrossPrincipalAsToken('', 'suggestion');
    expect(isCrossPrincipalChoiceOnlyText(embedded, 'classification')).toBe(true);
    expect(parseCrossPrincipalChoiceText(embedded, 'classification')).toBe('suggestion');
  });

  it('accepts the human card labels as free-text answers', () => {
    expect(parseCrossPrincipalChoiceText('另开任务', 'classification')).toBe('independent');
    expect(parseCrossPrincipalChoiceText('留给当前任务', 'classification')).toBe('suggestion');
    expect(parseCrossPrincipalChoiceText('独立任务', 'classification')).toBe('independent');
    expect(parseCrossPrincipalChoiceText('建议', 'classification')).toBe('suggestion');
    expect(isCrossPrincipalChoiceOnlyText('请帮我看一下这段 diff', 'classification')).toBe(false);
  });

  it('does not treat arbitrary business text as a host-ask answer', () => {
    expect(parseCrossPrincipalChoiceText('建议先把测试补上再合', 'classification')).toBeUndefined();
    expect(isCrossPrincipalChoiceOnlyText('建议先把测试补上再合', 'classification')).toBe(false);
  });

  // The gate decides whether an ordinary chat message is swallowed as a card
  // answer. Its name promises "only text", and these inputs are the ones that
  // can actually break that promise: each one DOES parse as a leading keyword,
  // so nothing but the stricter whole-body check stands between the sender and
  // a card click they never made.
  it('rejects business text that merely starts with a choice keyword', () => {
    const swallowed: Array<[string, CrossPrincipalChoiceKind]> = [
      ['ok 那我先去忙别的了', 'owner'],
      ['是 这样的，我先看下日志', 'owner'],
      ['执行 完记得同步一下结论', 'owner'],
      ['n 个测试没跑', 'owner'],
      ['y 轴的刻度不对', 'owner'],
      ['否，这条先不改', 'owner'],
      ['独立任务，这个说法我不太确定', 'classification'],
      ['另开任务 之前先确认下影响面', 'classification'],
      ['建议 先把测试补上', 'classification'],
      ['继续等待 对方回复就行', 'wait'],
    ];
    for (const [text, kind] of swallowed) {
      // Guards the guard: if a rewrite stops these parsing, this case would
      // pass for the wrong reason and cover nothing.
      expect(parseCrossPrincipalChoiceText(text, kind)).toBeDefined();
      expect(isCrossPrincipalChoiceOnlyText(text, kind)).toBe(false);
    }
  });

  it('accepts a bare choice however the proposer punctuates or spaces it', () => {
    const answers: Array<[string, CrossPrincipalChoiceKind]> = [
      ['独立任务', 'classification'],
      ['独立任务。', 'classification'],
      ['独立任务！', 'classification'],
      ['  另开任务  ', 'classification'],
      ['留给当前任务', 'classification'],
      // Wording older builds printed in their own staged notice; a bot that
      // answers with the text it was shown must still be understood.
      ['对当前任务的建议', 'classification'],
      ['继续等', 'wait'],
      ['ok', 'owner'],
      ['采纳并重新执行', 'owner'],
    ];
    for (const [text, kind] of answers) {
      expect(isCrossPrincipalChoiceOnlyText(text, kind)).toBe(true);
    }
  });

  // `botmux send --as independent -- "<prose>"` is a deliberate answer to this
  // card, so the prose must not disqualify it — otherwise the documented way for
  // a bot to answer fails exactly when the bot also explains itself.
  it('honours an --as marker even when the visible body is business text', () => {
    const marked = embedCrossPrincipalAsToken('顺带说一句，这条我想单独做', 'independent');
    expect(isCrossPrincipalChoiceOnlyText(marked, 'classification')).toBe(true);
    expect(parseCrossPrincipalChoiceText(marked, 'classification')).toBe('independent');
    expect(isCrossPrincipalChoiceOnlyText(marked, 'wait')).toBe(true);
    // An owner card only takes accept/reject; an independent/suggestion marker
    // is not an answer to it, with or without a body.
    expect(isCrossPrincipalChoiceOnlyText(marked, 'owner')).toBe(false);
    expect(isCrossPrincipalChoiceOnlyText(embedCrossPrincipalAsToken('', 'independent'), 'owner')).toBe(false);
  });
});

describe('cross-principal choice wiring', () => {
  it('shows humans a two-option Feishu card and tells agents to use botmux send --as', () => {
    expect(daemonSource).toContain('crossPrincipalClassificationOptions');
    expect(daemonSource).toContain('crossPrincipalBotClassifyNotice');
    expect(daemonSource).toContain("record.proposer.senderType === 'bot'");
    expect(cliSource).toContain("argValue(rest, '--as')");
    expect(cliSource).toContain('embedCrossPrincipalAsToken');
    expect(cliSource).toContain('xpi.send.as_needed_hint');
  });
});

describe('cross-principal choice copy', () => {
  it('keeps the human card to exactly two short options', () => {
    const zh = crossPrincipalClassificationOptions('zh');
    expect(zh).toEqual([
      { key: 'independent', label: '另开任务' },
      { key: 'suggestion', label: '留给当前任务' },
    ]);

    const en = crossPrincipalClassificationOptions('en');
    expect(en).toEqual([
      { key: 'independent', label: 'Start a new task' },
      { key: 'suggestion', label: 'Leave it for the current task' },
    ]);
  });

  it('tells agents to choose with botmux send --as, not a card', () => {
    const zhHint = crossPrincipalAgentHint('zh');
    expect(zhHint).toContain('botmux send --as independent');
    expect(zhHint).toContain('botmux send --as suggestion');
    expect(zhHint).toContain('另开任务');
    expect(zhHint).toContain('留给当前任务');

    const notice = crossPrincipalBotClassifyNotice('ou_bot', 'zh');
    expect(notice).toContain('<at id=ou_bot></at>');
    expect(notice).toContain(zhHint);
    expect(notice).not.toContain('请选一种处理方式');
  });

  it('keeps zh/en send-hint keys aligned', () => {
    for (const key of [
      'xpi.card.classify.independent',
      'xpi.card.classify.suggestion',
      'xpi.agent.hint',
      'xpi.send.as_needed_hint',
      'ai.routing.xpi_as_hint',
      'ai.shell.xpi_as_hint',
    ] as const) {
      expect(zhMessages[key]).toBeTruthy();
      expect(enMessages[key]).toBeTruthy();
    }
    expect(zhMessages['xpi.send.as_needed_hint']).toContain('--as independent');
    expect(zhMessages['xpi.send.as_needed_hint']).toContain('--as suggestion');
    expect(enMessages['xpi.send.as_needed_hint']).toContain('--as independent');
    expect(enMessages['xpi.send.as_needed_hint']).toContain('--as suggestion');
  });
});
