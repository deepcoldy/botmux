/**
 * What the「本轮回顾」panel says, from real CLI samples
 * (test/fixtures/turn-recap/README.md): the CLI's own recap (Claude Code's
 * transcript away summary), the turn's edits and commands, and the optional
 * model recap's prompt and answer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCotEntries, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { codexCotEntriesFromResponseItem } from '../src/services/codex-transcript.js';
import {
  claudeAwaySummaryText,
  CliRecapObserver,
  parseRecapModelOutput,
  RECAP_MODEL_INPUT_MAX_CHARS,
  RecapRecorder,
  recapModelPrompt,
  renderRecapMarkdown,
  TurnRecapRecorder,
} from '../src/services/turn-recap.js';
import type { CotEntry } from '../src/types.js';

const fixture = (name: string) => readFileSync(resolve('test/fixtures/turn-recap', name), 'utf8');
const jsonl = (name: string) => fixture(name).trim().split('\n').map(line => JSON.parse(line));

const [awayWithHint, awayPlain] = jsonl('claude-away-summary.jsonl');

describe('Claude Code away summary', () => {
  it('reads the summary text without the hint Claude Code appends to its first ones', () => {
    expect(awayWithHint.content).toMatch(/\(disable recaps in \/config\)$/);
    const text = claudeAwaySummaryText(awayWithHint)!;
    expect(text.startsWith('你在确认 hub 自动更新情况')).toBe(true);
    expect(text).not.toContain('disable recaps');
    expect(claudeAwaySummaryText(awayPlain)).toBe(awayPlain.content);
  });

  it('ignores every other record', () => {
    for (const record of jsonl('claude-tool-calls.jsonl')) expect(claudeAwaySummaryText(record)).toBeUndefined();
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

const claudeEntries = (): CotEntry[] =>
  jsonl('claude-tool-calls.jsonl').flatMap(record => extractCotEntries(record as TranscriptEvent) as CotEntry[]);

const recorded = (entries: CotEntry[], workingDir?: string) => {
  const recorder = new RecapRecorder();
  recorder.observe(entries);
  return recorder.input(workingDir);
};

describe('turn facts', () => {
  it('lists the files a Claude Code turn edited and its commands', () => {
    expect(recorded(claudeEntries(), '/work/app').facts).toEqual({
      files: ['src/utils/terminal-cells.ts', 'src/im/lark/client.ts'],
      commands: 3,
      lastCommand: 'git log --oneline -1 HEAD; ls -la node_modules 2>&1 | head -2',
    });
  });

  it('counts a file edited twice once and keeps paths outside the session directory whole', () => {
    const entries = claudeEntries();
    const edit = entries.find(entry => entry.kind === 'tool_call' && entry.name === 'Edit')!;
    expect(recorded([...entries, edit], '/work/app').facts.files).toHaveLength(2);
    expect(recorded(entries, '/elsewhere').facts.files).toEqual(['/work/app/src/utils/terminal-cells.ts', '/work/app/src/im/lark/client.ts']);
  });

  it('reads Codex commands too', () => {
    const entries = jsonl('codex-exec-command.jsonl').flatMap(record => codexCotEntriesFromResponseItem(record.payload) as CotEntry[]);
    const { facts } = recorded(entries);
    expect(facts.files).toEqual([]);
    expect(facts.commands).toBe(2);
    expect(facts.lastCommand).toMatch(/^printf '%s\\n' '--- Sending skill/);
  });

  it('keeps a long turn\'s last edits and commands, and its latest activity for the model', () => {
    // Far past the reply card's 60k-character activity buffer: 800 reads with
    // their output, then the edits and commands the turn is actually about.
    const entries: CotEntry[] = [];
    for (let index = 0; index < 800; index++) {
      entries.push({ kind: 'tool_call', id: `r${index}`, name: 'Read', args: '{}', subject: `/work/app/src/mod${index}.ts` });
      entries.push({ kind: 'tool_result', id: `r${index}`, result: 'x'.repeat(800) });
    }
    entries.push(
      { kind: 'tool_call', id: 'e1', name: 'Edit', args: '{}', subject: '/work/app/src/feature.ts' },
      { kind: 'tool_call', id: 'b1', name: 'Bash', args: '{}', subject: 'git push origin feat/x' },
      { kind: 'text', text: '已推送。' },
    );
    const input = recorded(entries, '/work/app');
    expect(input.facts).toEqual({ files: ['src/feature.ts'], commands: 1, lastCommand: 'git push origin feat/x' });
    expect(input.activity.at(-1)).toBe('Assistant: 已推送。');
    expect(input.activity).toContain('Tool Bash: git push origin feat/x');
    expect(input.omitted).toBeGreaterThan(0);
    expect(input.activity.join('\n').length).toBeLessThanOrEqual(RECAP_MODEL_INPUT_MAX_CHARS);
  });

  it('keeps one turn\'s report bounded', () => {
    const entries: CotEntry[] = Array.from({ length: 150 }, (_, index) =>
      ({ kind: 'tool_call', id: `e${index}`, name: 'Write', args: '{}', subject: `/work/app/gen/file${index}.ts` }));
    entries.push({ kind: 'tool_call', id: 'b', name: 'Bash', args: '{}', subject: `echo ${'y'.repeat(3_000)}` });
    const { facts } = recorded(entries, '/work/app');
    expect(facts.files).toHaveLength(100);
    expect(facts.files[0]).toBe('gen/file0.ts');
    expect(facts.lastCommand!.length).toBeLessThanOrEqual(500);
  });

  it('starts over for each turn and answers only for the turn it recorded', () => {
    const recorder = new TurnRecapRecorder();
    const entries = claudeEntries();
    recorder.observe({ turnId: 'om_1', dispatchAttempt: 1 }, entries);
    expect(recorder.input({ turnId: 'om_1', dispatchAttempt: 1 })?.facts.commands).toBe(3);
    expect(recorder.input({ turnId: 'om_1', dispatchAttempt: 2 })).toBeUndefined();
    recorder.observe({ turnId: 'om_2' }, entries.slice(0, 1));
    expect(recorder.input({ turnId: 'om_1', dispatchAttempt: 1 })).toBeUndefined();
    expect(recorder.input({ turnId: 'om_2' })?.facts.commands).toBe(1);
    expect(recorder.input({ turnId: 'om_3' })).toBeUndefined();
  });
});

describe('panel markdown', () => {
  const facts = recorded(claudeEntries(), '/work/app').facts;

  it('shows the CLI recap, says where it came from, then what was done', () => {
    const markdown = renderRecapMarkdown({ cli: claudeAwaySummaryText(awayWithHint), facts }, 'zh')!;
    expect(markdown.split('\n\n')).toEqual([
      claudeAwaySummaryText(awayWithHint),
      "<font color='grey'>来自 CLI 自带的离开总结</font>",
      '**做了什么**\n'
        + '- 改了 2 个文件：`src/utils/terminal-cells.ts`、`src/im/lark/client.ts`\n'
        + "- 跑了 3 条命令，最后一条：`git log --oneline -1 HEAD; ls -la node_modules 2>&1 | head -2`",
    ]);
  });

  it('names the small model as the source of a model recap, in English too', () => {
    const markdown = renderRecapMarkdown({ model: 'Merged; CI is green.', facts }, 'en')!;
    expect(markdown).toContain('Merged; CI is green.\n\n<font color=\'grey\'>Recap written by a small model</font>');
    expect(markdown).toContain('- Edited 2 files: `src/utils/terminal-cells.ts`, `src/im/lark/client.ts`');
    expect(markdown).toContain('- Ran 3 commands, the last: ');
  });

  it('prefers the CLI recap over a model one', () => {
    expect(renderRecapMarkdown({ cli: 'A', model: 'B' }, 'zh')).toMatch(/^A\n\n.*CLI/);
  });

  // Rendering rules checked on a live card: prose decodes entities once;
  // inline code shows its text literally (no entity decoding, no tags).
  it('never carries mention markup, an image or other markup from recap prose', () => {
    for (const text of [
      '<at user_id="all">所有人</at> 看图 ![x](img_v3_key) <b>粗</b>',
      '提醒 <at user_id="all"> 和 <at id=all></at> 以及 </at>',
    ]) {
      const markdown = renderRecapMarkdown({ cli: text }, 'zh')!;
      expect(markdown).not.toMatch(/<\/?at\b|&lt;\/?at\b/i);
      expect(markdown).not.toContain('![');
    }
    expect(renderRecapMarkdown({ cli: '<b>粗</b> a && b' }, 'zh')).toContain('&lt;b&gt;粗&lt;/b&gt; a &amp;&amp; b');
    // An entity-encoded tag stays text: the card decodes it once, to the entity.
    expect(renderRecapMarkdown({ cli: '&lt;at id=ou_x&gt;&lt;/at&gt;' }, 'zh')).toContain('&amp;lt;at id=ou_x&amp;gt;');
  });

  it('shows commands and paths as written, minus mention markup', () => {
    const markdown = renderRecapMarkdown({ facts: { files: ['src/a&b.ts'], commands: 1, lastCommand: 'echo "<x>" 2>&1 <at id=ou_x></at>' } }, 'zh')!;
    expect(markdown).toContain('`src/a&b.ts`');
    expect(markdown).toContain('`echo "<x>" 2>&1 [mention][mention]`');
  });

  it('shortens a long file list and inline code cannot be broken out of', () => {
    const files = Array.from({ length: 8 }, (_, index) => `src/f${index}.ts`);
    const markdown = renderRecapMarkdown({ facts: { files, commands: 1, lastCommand: 'echo `id`' } }, 'zh')!;
    expect(markdown).toContain('改了 8 个文件：');
    expect(markdown).toContain('`src/f5.ts` 等');
    expect(markdown).not.toContain('src/f6.ts');
    expect(markdown).toContain("`echo 'id'`");
  });

  it('is empty when nothing is known', () => {
    expect(renderRecapMarkdown({}, 'zh')).toBeUndefined();
    expect(renderRecapMarkdown({ facts: { files: [], commands: 0 } }, 'zh')).toBeUndefined();
  });
});

describe('model recap prompt', () => {
  it('names the language and carries the request, the reply text and tool-call titles only', () => {
    const entries: CotEntry[] = [
      ...claudeEntries(),
      { kind: 'tool_result', id: 'x', result: 'SECRET TOOL OUTPUT' },
      { kind: 'thinking', text: 'private reasoning' },
      { kind: 'text', text: '改好了。' },
    ];
    const prompt = recapModelPrompt({ userPrompt: '修一下', turn: recorded(entries), locale: 'zh' })!;
    expect(prompt.startsWith('Language: Simplified Chinese\n\nUser request:\n修一下\n\nTurn record:\n')).toBe(true);
    expect(prompt).toContain('Tool Edit: /work/app/src/im/lark/client.ts');
    expect(prompt).toContain('Assistant: 改好了。');
    expect(prompt).not.toContain('SECRET TOOL OUTPUT');
    expect(prompt).not.toContain('private reasoning');
    expect(recapModelPrompt({ turn: recorded(entries), locale: 'en' })!.startsWith('Language: English\n\nTurn record:')).toBe(true);
  });

  it('says how much earlier activity was left out, and is not made for a turn without activity', () => {
    const entries: CotEntry[] = Array.from({ length: 400 }, (_, index) => ({ kind: 'text', text: `step ${index} ${'x'.repeat(100)}` }));
    const prompt = recapModelPrompt({ userPrompt: 'q', turn: recorded(entries), locale: 'zh' })!;
    expect(prompt.length).toBeLessThanOrEqual(RECAP_MODEL_INPUT_MAX_CHARS);
    expect(prompt).toContain('step 399 ');
    expect(prompt).not.toContain('step 0 ');
    expect(prompt).toMatch(/Turn record \(earliest \d+ entries omitted\):/);
    expect(recapModelPrompt({ userPrompt: '只有请求', turn: recorded([]), locale: 'zh' })).toBeUndefined();
  });
});

describe('model recap answer', () => {
  it('reads the recap and what it cost', () => {
    expect(parseRecapModelOutput(fixture('claude-p-recap.json'))).toEqual({
      text: expect.stringMatching(/^PR #3489（botmux post 主动发送）首审已完成/),
      costUsd: 0.0014919,
      inputTokens: 10724,
      outputTokens: 839,
    });
  });

  it('drops a heading the model opened with despite the instructions', () => {
    const { text } = parseRecapModelOutput(fixture('claude-p-recap-heading.json')) as { text: string };
    expect(text).toMatch(/^PR #3456 已于/);
    expect(text).not.toMatch(/^#/m);
  });

  it('reports why there is none', () => {
    expect(parseRecapModelOutput(fixture('claude-p-model-error.json')))
      .toEqual({ error: expect.stringMatching(/^There's an issue with the selected model/) });
    expect(parseRecapModelOutput('')).toEqual({ error: 'no output' });
    expect(parseRecapModelOutput('Error: unknown option')).toEqual({ error: 'output is not JSON' });
  });
});
