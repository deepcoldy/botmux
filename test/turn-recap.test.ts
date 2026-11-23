/**
 * What the「本轮回顾」panel says, from real CLI samples
 * (test/fixtures/turn-recap/README.md): the CLI's own recap (Claude Code's
 * transcript away summary), and nothing else.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAwaySummaryText, CliRecapObserver, renderRecapMarkdown } from '../src/services/turn-recap.js';

const fixture = (name: string) => readFileSync(resolve('test/fixtures/turn-recap', name), 'utf8');
const jsonl = (name: string) => fixture(name).trim().split('\n').map(line => JSON.parse(line));

const [awayWithHint, awayPlain] = jsonl('claude-away-summary.jsonl');
const [awayNewHint] = jsonl('claude-away-summary-2.1.326.jsonl');

describe('Claude Code away summary', () => {
  it('reads the summary text without the hint Claude Code appends to its first ones', () => {
    expect(awayWithHint.content).toMatch(/\(disable recaps in \/config\)$/);
    const text = claudeAwaySummaryText(awayWithHint)!;
    expect(text.startsWith('你在确认 hub 自动更新情况')).toBe(true);
    expect(text).not.toContain('recaps');
    expect(claudeAwaySummaryText(awayPlain)).toBe(awayPlain.content);
  });

  it('drops the hint in its 2.1.326 wording as well', () => {
    expect(awayNewHint.content).toMatch(/\(turn off recaps in \/config\)$/);
    const text = claudeAwaySummaryText(awayNewHint)!;
    expect(text.endsWith('等你提供 GitHub 用户名和选择档位后再动手改权限。')).toBe(true);
    expect(text).not.toContain('recaps');
  });

  it('ignores every other record', () => {
    for (const record of jsonl('claude-tool-calls.jsonl')) expect(claudeAwaySummaryText(record)).toBeUndefined();
    // The output of a /recap typed into the terminal (Claude Code 2.1.329) is
    // not an away summary: botmux never asks for a recap, and does not take
    // one somebody else asked for.
    expect(claudeAwaySummaryText({
      ...awayPlain, subtype: 'local_command', content: `<local-command-stdout>${awayPlain.content}</local-command-stdout>`,
      commandRun: { command: 'recap', args: '' },
    })).toBeUndefined();
    expect(claudeAwaySummaryText({ ...awayPlain, isSidechain: true })).toBeUndefined();
    expect(claudeAwaySummaryText({ ...awayPlain, subtype: 'turn_duration' })).toBeUndefined();
    expect(claudeAwaySummaryText({ ...awayPlain, content: '  ' })).toBeUndefined();
  });
});

describe('CliRecapObserver', () => {
  const writtenAt = Date.parse(awayPlain.timestamp);

  it('reports a summary written after the turn reached the CLI, once', () => {
    const observer = new CliRecapObserver();
    expect(observer.observe([], { turnId: 'om_turn', dispatchAttempt: 2 }, writtenAt - 60_000)).toBeUndefined();
    expect(observer.observe([awayPlain], { turnId: 'om_turn', dispatchAttempt: 2 }, writtenAt + 1_000))
      .toEqual({ text: awayPlain.content, turnId: 'om_turn', dispatchAttempt: 2 });
    // A re-read of the same record (offset reset, rotation) reports nothing new.
    expect(observer.observe([awayPlain], { turnId: 'om_turn', dispatchAttempt: 2 }, writtenAt + 2_000)).toBeUndefined();
  });

  it('drops a summary written before the current turn reached the CLI', () => {
    const observer = new CliRecapObserver();
    observer.observe([], { turnId: 'om_old' }, writtenAt - 60_000);
    // The next turn's input lands; the old turn's summary is drained with it.
    expect(observer.observe([awayPlain], { turnId: 'om_new' }, writtenAt + 500)).toBeUndefined();
    // ...and stays consumed for the old turn's sake as well.
    expect(observer.observe([awayPlain], { turnId: 'om_old' }, writtenAt + 600)).toBeUndefined();
  });

  it('attributes no record that does not say when it was written', () => {
    const observer = new CliRecapObserver();
    observer.observe([], { turnId: 'om_turn' }, writtenAt - 60_000);
    const { timestamp: _timestamp, ...undated } = awayPlain;
    expect(observer.observe([undated], { turnId: 'om_turn' }, writtenAt + 1)).toBeUndefined();
  });

  it('reports nothing without a turn', () => {
    expect(new CliRecapObserver().observe([awayPlain], {}, writtenAt + 1)).toBeUndefined();
  });

  it('keeps the latest summary of one drain', () => {
    const observer = new CliRecapObserver();
    observer.observe([], { turnId: 'om_turn' }, Date.parse(awayWithHint.timestamp) - 1);
    expect(observer.observe([awayWithHint, awayPlain], { turnId: 'om_turn' }, writtenAt + 1)?.text).toBe(awayPlain.content);
  });
});

describe('panel markdown', () => {
  it('is the CLI recap alone, with no line after it saying where it came from', () => {
    expect(renderRecapMarkdown(claudeAwaySummaryText(awayWithHint))).toBe(claudeAwaySummaryText(awayWithHint));
    expect(renderRecapMarkdown('Merged; CI is green.')).toBe('Merged; CI is green.');
  });

  // Rendering rules checked on a live card: prose decodes entities once.
  it('never carries mention markup, an image or other markup from recap prose', () => {
    for (const text of [
      '<at user_id="all">所有人</at> 看图 ![x](img_v3_key) <b>粗</b>',
      '提醒 <at user_id="all"> 和 <at id=all></at> 以及 </at>',
    ]) {
      const markdown = renderRecapMarkdown(text)!;
      expect(markdown).not.toMatch(/<\/?at\b|&lt;\/?at\b/i);
      expect(markdown).not.toContain('![');
    }
    expect(renderRecapMarkdown('<b>粗</b> a && b')).toContain('&lt;b&gt;粗&lt;/b&gt; a &amp;&amp; b');
    // An entity-encoded tag stays text: the card decodes it once, to the entity.
    expect(renderRecapMarkdown('&lt;at id=ou_x&gt;&lt;/at&gt;')).toContain('&amp;lt;at id=ou_x&amp;gt;');
  });

  it('is empty without recap text', () => {
    expect(renderRecapMarkdown(undefined)).toBeUndefined();
    expect(renderRecapMarkdown('  \n ')).toBeUndefined();
  });
});
