import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverClaudeFamilySessions,
  discoverRolloutSessions,
  discoverAntigravitySessions,
  isBotmuxInjectedPrompt,
} from '../src/services/resumable-session-discovery.js';
import { traexRolloutUserInputs, traexSessionIdFromRolloutPath } from '../src/services/traex-transcript.js';
import { GOAL_COMMAND, GOAL_COMMAND_OBJECTIVE } from '../src/workflows/v3/contract.js';

/** What the TraeX adapter passes: verified user inputs decide origin, raw model
 *  items are weak, filename ids group resume segments. */
const TRAEX = {
  dialect: 'traex' as const,
  userInputTexts: traexRolloutUserInputs,
  sessionIdFromPath: traexSessionIdFromRolloutPath,
};

/** TraeX 0.208+ user turn: the model-visible item plus its validated display
 *  completion (same turn id, same thread id). */
function traexUserTurn(sessionId: string, text: string, turnId = 'turn-1', threadId = sessionId) {
  return { type: 'history_mutation', payload: {
    operation: 'append',
    turn_id: turnId,
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    display_completions: [{
      thread_id: threadId, turn_id: turnId,
      item: { type: 'UserMessage', content: [{ type: 'text', text }] },
    }],
  } };
}

/**
 * Unit coverage for the on-disk session discovery that powers /adopt's second
 * filter (paseo-style resume import). Each parser is fed a temp fixture shaped
 * like the real CLI store (verified against live ~/.claude, ~/.codex, ~/.trae,
 * ~/.gemini data during development) so a format regression fails loudly.
 */

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('discoverClaudeFamilySessions (Claude-family / Genius)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = tmp('bmx-claude-'); });

  function writeSession(projectHash: string, sessionId: string, lines: unknown[]): void {
    const dir = join(dataDir, 'projects', projectHash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(...lines));
  }

  it('extracts sessionId (from filename), cwd and first user prompt', async () => {
    writeSession('-root-proj', 'aaaa1111-0000-0000-0000-000000000001', [
      { type: 'mode', mode: 'normal', sessionId: 'aaaa1111-0000-0000-0000-000000000001' },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'fix the parser bug' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cliSessionId: 'aaaa1111-0000-0000-0000-000000000001',
      cwd: '/root/proj',
      title: 'fix the parser bug',
    });
  });

  it('prefers a customTitle that appears after the first user prompt', async () => {
    writeSession('-root-proj', 'rename-after-prompt', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'fix the parser bug' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
      { type: 'custom-title', customTitle: '  Parser reliability  ' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('Parser reliability');
  });

  it('uses the latest valid customTitle across multiple renames', async () => {
    writeSession('-root-proj', 'multiple-renames', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'initial prompt' } },
      { type: 'custom-title', customTitle: 'First name' },
      { type: 'custom-title', customTitle: 'Latest name' },
      { type: 'custom-title', customTitle: '   ' },
      { type: 'custom-title', customTitle: null },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('Latest name');
  });

  // Regression: Claude-family / Genius append `custom-title` records after
  // the transcript's initial metadata. The bounded head scan must not hide a
  // valid rename that lands beyond its 5,000-line safety window.
  it('finds a customTitle appended after line 5000', async () => {
    const lines: unknown[] = [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'initial prompt' } },
    ];
    for (let i = 0; i < 5_001; i++) {
      lines.push({ type: 'assistant', message: { role: 'assistant', content: `filler ${i}` } });
    }
    lines.push({ type: 'custom-title', customTitle: 'Late parser title' });
    writeSession('-root-proj', 'rename-after-head-cap', lines);

    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('Late parser title');
  });

  it('does not skip a customTitle that starts exactly at the tail boundary', async () => {
    const tailBytes = 4 * 1024 * 1024;
    const assistantLine = (content: string): string => JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content },
    }) + '\n';
    const prefix = JSON.stringify({
      type: 'user',
      cwd: '/root/boundary',
      message: { role: 'user', content: 'initial prompt' },
    }) + '\n';
    const customTitleLine = JSON.stringify({
      type: 'custom-title',
      customTitle: 'Boundary title',
    }) + '\n';
    const fillerBytes = tailBytes - Buffer.byteLength(customTitleLine);
    const emptyAssistantBytes = Buffer.byteLength(assistantLine(''));
    expect(fillerBytes).toBeGreaterThanOrEqual(emptyAssistantBytes);
    const fillerLine = assistantLine('x'.repeat(fillerBytes - emptyAssistantBytes));
    expect(Buffer.byteLength(customTitleLine + fillerLine)).toBe(tailBytes);

    const dir = join(dataDir, 'projects', '-root-boundary');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tail-boundary.jsonl'), prefix + customTitleLine + fillerLine);

    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('Boundary title');
  });

  it('skips a genuinely truncated tail line before reading the next title', async () => {
    const dir = join(dataDir, 'projects', '-root-truncated');
    mkdirSync(dir, { recursive: true });
    const oversizedAssistant = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'x'.repeat(4 * 1024 * 1024) },
    });
    writeFileSync(join(dir, 'truncated-tail.jsonl'), [
      JSON.stringify({ type: 'user', cwd: '/root/truncated', message: { role: 'user', content: 'prompt' } }),
      oversizedAssistant,
      JSON.stringify({ type: 'custom-title', customTitle: 'After truncated line' }),
      '',
    ].join('\n'));

    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('After truncated line');
  });

  it('falls back to the first real user prompt when customTitle is absent or invalid', async () => {
    writeSession('-root-proj', 'rename-fallback', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'the fallback prompt' } },
      { type: 'custom-title', customTitle: '' },
      { type: 'custom-title', customTitle: 123 },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('the fallback prompt');
  });

  it('skips sidechain entries and slash-command meta lines when picking a title', async () => {
    writeSession('-root-proj', 'bbbb2222-0000-0000-0000-000000000002', [
      { type: 'user', cwd: '/root/proj', isSidechain: true, message: { role: 'user', content: 'subagent noise' } },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'the real first question' } },
      { type: 'custom-title', isSidechain: true, customTitle: 'subagent title noise' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('the real first question');
  });

  // Option B: sessions botmux itself spawned (their user turns carry botmux's
  // injected wrapper) are hidden — the picker is for external sessions only.
  it('drops botmux-origin sessions (user turn carries the injected wrapper)', async () => {
    writeSession('-root-proj', 'cccc3333-0000-0000-0000-000000000003', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: '<user_message>\n@Claude do the thing\n</user_message>\n<sender type="user" open_id="ou_x" />' } },
    ]);
    // A standalone session in the same project survives.
    writeSession('-root-proj', 'eeee5555-0000-0000-0000-000000000005', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'just a normal prompt I typed' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['eeee5555-0000-0000-0000-000000000005']);
  });

  // Regression (Codex): an EXTERNAL session whose prompt merely *discusses*
  // botmux's XML must NOT be mis-flagged — detection is structural (leading
  // envelope / full footer), not bare tag-name substring.
  it('keeps external sessions that only mention botmux tags in prose', async () => {
    writeSession('-root-p', 'ext-discuss-1', [
      { type: 'user', cwd: '/root/p', message: { role: 'user', content: 'I am debugging botmux and the <user_message> tag behavior, and why does <sender type= show up?' } },
    ]);
    writeSession('-root-p', 'ext-discuss-2', [
      { type: 'user', cwd: '/root/p', message: { role: 'user', content: 'Please explain <botmux_routing> in our docs' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out.map((s) => s.cliSessionId).sort()).toEqual(['ext-discuss-1', 'ext-discuss-2']);
  });

  // Regression (whiteboard /adopt leak): Claude-family / Genius CLIs with
  // injectsSessionContext=true get routing/identity/session_id via system
  // prompt, so when no team/group role is configured the botmux prompt STARTS
  // with the <whiteboard> block directly. No ^-anchored pattern matched that
  // opening (they only allowed <whiteboard> as a middle element), so such
  // botmux-origin Claude sessions leaked into /adopt as if external.
  it('drops botmux-origin Claude sessions whose prompt opens with <whiteboard>', async () => {
    writeSession('-root-wb', 'wb-open-1', [
      { type: 'user', cwd: '/root/wb', message: { role: 'user', content: '<whiteboard id="wb_abc123def45678">\n本地项目上下文；需要时读取：`botmux whiteboard read --id wb_abc123def45678`。\n更新状态：`botmux whiteboard update --id wb_abc123def45678`。\n</whiteboard>\n\n<user_message>\n@Claude do the thing\n</user_message>' } },
    ]);
    // A standalone session in the same project survives.
    writeSession('-root-wb', 'wb-open-ext', [
      { type: 'user', cwd: '/root/wb', message: { role: 'user', content: 'just a normal prompt I typed' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['wb-open-ext']);
  });

  // The ^<whiteboard>-opening pattern matches ANY board id (id="[^"]+"), not
  // just the default `wb_` prefix — a user-created board (`create --id
  // <custom>`) bound to a Claude-family / Genius + role-less session also opens with
  // <whiteboard id="<custom>"> and must be dropped from /adopt.
  it('drops botmux-origin Claude sessions opening with a custom-id <whiteboard>', async () => {
    writeSession('-root-wb', 'wb-custom-1', [
      { type: 'user', cwd: '/root/wb', message: { role: 'user', content: '<whiteboard id="my-custom-board">\n本地项目上下文\n</whiteboard>\n\n<user_message>\ndo the thing\n</user_message>' } },
    ]);
    writeSession('-root-wb', 'wb-custom-ext', [
      { type: 'user', cwd: '/root/wb', message: { role: 'user', content: 'just a normal prompt I typed' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['wb-custom-ext']);
  });

  // The <whiteboard>-opening pattern is structural (^-anchored + id="wb_…" +
  // <user_message> adjacency), so an external session that merely DISCUSSES a
  // whiteboard tag in prose (mid-sentence, no envelope) must NOT be mis-flagged.
  it('keeps external Claude sessions that only mention <whiteboard> in prose', async () => {
    writeSession('-root-wb', 'wb-prose-1', [
      { type: 'user', cwd: '/root/wb', message: { role: 'user', content: 'I am documenting the <whiteboard id="wb_x"> block that botmux injects; how should I describe it?' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['wb-prose-1']);
  });

  it('drops empty / command-only sessions (no real user prompt)', async () => {
    writeSession('-root-proj', 'ffff6666-0000-0000-0000-000000000006', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: '<local-command-caveat>...</local-command-caveat>' } },
    ]);
    expect(await discoverClaudeFamilySessions(dataDir, 10)).toEqual([]);
  });

  it('drops transcripts with no cwd, returns most-recent first within limit', async () => {
    writeSession('-a', 'no-cwd-session', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    writeSession('-b', 'has-cwd-session', [{ type: 'user', cwd: '/root/b', message: { role: 'user', content: 'hi b' } }]);
    const out = await discoverClaudeFamilySessions(dataDir, 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.cliSessionId).toBe('has-cwd-session');
  });

  it('returns [] when the projects dir is absent', async () => {
    expect(await discoverClaudeFamilySessions(join(dataDir, 'nope'), 10)).toEqual([]);
  });

  // Regression: a host with many live sessions must not starve the picker. The
  // `exclude` set (currently-live cliSessionIds) is applied BEFORE the limit
  // slice, so excluded sessions never crowd out resumable ones.
  it('excludes live session ids before the limit slice (no starvation)', async () => {
    for (let i = 0; i < 6; i++) {
      writeSession('-root-p', `live-or-not-${i}`, [
        { type: 'user', cwd: '/root/p', message: { role: 'user', content: `session ${i}` } },
      ]);
    }
    // Exclude 4 of the 6; asking for 2 must still return 2 (the non-excluded).
    const exclude = new Set(['live-or-not-0', 'live-or-not-1', 'live-or-not-2', 'live-or-not-3']);
    const out = await discoverClaudeFamilySessions(dataDir, 2, exclude);
    expect(out).toHaveLength(2);
    expect(out.every((s) => !exclude.has(s.cliSessionId))).toBe(true);
  });

  // Regression (Codex blocker 2): a first user record larger than any fixed
  // read-prefix must NOT be truncated mid-line and dropped — streaming reads
  // the complete line so cwd is still recovered.
  it('handles an oversized (>200KiB) first user record without dropping the session', async () => {
    const huge = 'x'.repeat(220 * 1024);
    writeSession('-root-big', 'dddd4444-0000-0000-0000-000000000004', [
      { type: 'user', cwd: '/root/big', message: { role: 'user', content: huge } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cliSessionId: 'dddd4444-0000-0000-0000-000000000004', cwd: '/root/big' });
    expect(out[0]!.title.length).toBeLessThanOrEqual(80);
  });

  // Skill-opening sessions: Claude writes the `<command-message>` turn, then an
  // isMeta:true user turn holding the expanded skill body ("Base directory for
  // this skill: …"). That expansion is Claude's own record, not something the
  // user typed, so it must never become the title. Real transcripts store it in
  // both content shapes (text-part array and plain string).
  const skillCommand = {
    type: 'user',
    cwd: '/work/demo',
    message: { role: 'user', content: '<command-message>demo-skill is running…</command-message>\n<command-name>/demo-skill</command-name>' },
  };
  const skillBody = 'Base directory for this skill: /work/demo/.claude/skills/demo-skill\n\n# Demo skill';
  const skillExpansion = (content: unknown) => ({ type: 'user', isMeta: true, cwd: '/work/demo', message: { role: 'user', content } });
  const toolResult = {
    type: 'user',
    cwd: '/work/demo',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_demo', content: 'ok' }] },
  };

  it('skips an isMeta skill expansion (array content) when picking the first prompt', async () => {
    writeSession('-work-demo', 'skill-open-array', [
      skillCommand,
      skillExpansion([{ type: 'text', text: skillBody }]),
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: '修复登录页样式' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]).toMatchObject({ cliSessionId: 'skill-open-array', cwd: '/work/demo', title: '修复登录页样式' });
  });

  it('skips an isMeta skill expansion (string content) when picking the first prompt', async () => {
    writeSession('-work-demo', 'skill-open-string', [
      skillCommand,
      skillExpansion(skillBody),
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: '修复登录页样式' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]).toMatchObject({ cliSessionId: 'skill-open-string', cwd: '/work/demo', title: '修复登录页样式' });
  });

  it('uses aiTitle when there is no customTitle', async () => {
    writeSession('-work-demo', 'ai-title-only', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'the login page css is broken' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
      { type: 'ai-title', aiTitle: '  修复登录页样式  ', sessionId: 'ai-title-only' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('修复登录页样式');
  });

  it('prefers customTitle over aiTitle regardless of record order', async () => {
    writeSession('-work-demo', 'custom-then-ai', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'initial prompt' } },
      { type: 'custom-title', customTitle: 'demo-task · 示例', sessionId: 'custom-then-ai' },
      { type: 'ai-title', aiTitle: '修复登录页样式', sessionId: 'custom-then-ai' },
    ]);
    writeSession('-work-demo', 'ai-then-custom', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'initial prompt' } },
      { type: 'ai-title', aiTitle: '修复登录页样式', sessionId: 'ai-then-custom' },
      { type: 'custom-title', customTitle: 'demo-task · 示例', sessionId: 'ai-then-custom' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    const titles = new Map(out.map((s) => [s.cliSessionId, s.title]));
    expect(titles.size).toBe(2);
    expect(titles.get('custom-then-ai')).toBe('demo-task · 示例');
    expect(titles.get('ai-then-custom')).toBe('demo-task · 示例');
  });

  it('falls back to the first real user prompt when every aiTitle is blank or not a string', async () => {
    writeSession('-work-demo', 'ai-title-invalid', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'the fallback prompt' } },
      { type: 'ai-title', aiTitle: '   ' },
      { type: 'ai-title', aiTitle: '' },
      { type: 'ai-title', aiTitle: null },
      { type: 'ai-title', aiTitle: 123 },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('the fallback prompt');
  });

  it('keeps the latest valid aiTitle when a later aiTitle is blank', async () => {
    writeSession('-work-demo', 'ai-title-then-blank', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'initial prompt' } },
      { type: 'ai-title', aiTitle: 'First ai title' },
      { type: 'ai-title', aiTitle: 'Latest ai title' },
      { type: 'ai-title', aiTitle: '   ' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('Latest ai title');
  });

  it('truncates an aiTitle longer than 80 characters', async () => {
    const long = '修复登录页样式'.repeat(15);
    writeSession('-work-demo', 'ai-title-long', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'initial prompt' } },
      { type: 'ai-title', aiTitle: long },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe(`${long.slice(0, 79)}…`);
    expect(out[0]?.title).toHaveLength(80);
  });

  it('finds an aiTitle appended after line 5000', async () => {
    const lines: unknown[] = [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'initial prompt' } },
    ];
    for (let i = 0; i < 5_001; i++) {
      lines.push({ type: 'assistant', message: { role: 'assistant', content: `filler ${i}` } });
    }
    lines.push({ type: 'ai-title', aiTitle: 'Late ai title' });
    writeSession('-work-demo', 'ai-title-after-head-cap', lines);

    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('Late ai title');
  });

  it('ignores sidechain ai-title records', async () => {
    writeSession('-work-demo', 'sidechain-ai-only', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'the real first question' } },
      { type: 'ai-title', isSidechain: true, aiTitle: 'subagent title noise' },
    ]);
    writeSession('-work-demo', 'sidechain-ai-after-main', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'the real first question' } },
      { type: 'ai-title', aiTitle: '修复登录页样式' },
      { type: 'ai-title', isSidechain: true, aiTitle: 'subagent title noise' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    const titles = new Map(out.map((s) => [s.cliSessionId, s.title]));
    expect(titles.get('sidechain-ai-only')).toBe('the real first question');
    expect(titles.get('sidechain-ai-after-main')).toBe('修复登录页样式');
  });

  it('ignores aiTitle keys on records whose type is not ai-title', async () => {
    writeSession('-work-demo', 'stray-ai-only', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'the fallback prompt' } },
      { type: 'summary', aiTitle: 'not a title record' },
      { aiTitle: 'record without a type' },
    ]);
    writeSession('-work-demo', 'stray-ai-after-main', [
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: 'the fallback prompt' } },
      { type: 'ai-title', aiTitle: '修复登录页样式' },
      { type: 'summary', aiTitle: 'not a title record' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    const titles = new Map(out.map((s) => [s.cliSessionId, s.title]));
    expect(titles.get('stray-ai-only')).toBe('the fallback prompt');
    expect(titles.get('stray-ai-after-main')).toBe('修复登录页样式');
  });

  // A session driven only by slash commands has no typed prompt once isMeta is
  // skipped; without a customTitle / aiTitle it has nothing to show and is
  // dropped like the other command-only sessions.
  it('drops skill-only sessions with no typed prompt and no custom/ai title', async () => {
    writeSession('-work-demo', 'skill-only-untitled', [
      skillCommand,
      skillExpansion([{ type: 'text', text: skillBody }]),
      toolResult,
      { type: 'assistant', message: { role: 'assistant', content: 'done' } },
    ]);
    expect(await discoverClaudeFamilySessions(dataDir, 10)).toEqual([]);
  });

  // isMeta turns are skipped only for the title: they still pass through the
  // botmux-origin check, and the envelope that follows them is still seen.
  it('still drops a botmux-origin session whose first user turn is an isMeta skill expansion', async () => {
    writeSession('-work-demo', 'meta-then-botmux', [
      skillExpansion([{ type: 'text', text: skillBody }]),
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: '<user_message>\n修复登录页样式\n</user_message>\n<sender type="user" open_id="ou_x" />' } },
    ]);
    // A standalone session with the same opening survives.
    writeSession('-work-demo', 'meta-then-typed', [
      skillExpansion([{ type: 'text', text: skillBody }]),
      { type: 'user', cwd: '/work/demo', message: { role: 'user', content: '修复登录页样式' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['meta-then-typed']);
  });

  it('keeps a skill-only session that has a customTitle', async () => {
    writeSession('-work-demo', 'skill-only-custom', [
      skillCommand,
      skillExpansion([{ type: 'text', text: skillBody }]),
      toolResult,
      { type: 'custom-title', customTitle: 'demo-task · 示例', sessionId: 'skill-only-custom' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cliSessionId: 'skill-only-custom', cwd: '/work/demo', title: 'demo-task · 示例' });
  });

  it('keeps a skill-only session that has an aiTitle', async () => {
    writeSession('-work-demo', 'skill-only-ai', [
      skillCommand,
      skillExpansion([{ type: 'text', text: skillBody }]),
      toolResult,
      { type: 'ai-title', aiTitle: '修复登录页样式', sessionId: 'skill-only-ai' },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cliSessionId: 'skill-only-ai', cwd: '/work/demo', title: '修复登录页样式' });
  });
});

describe('discoverRolloutSessions (codex / traex)', () => {
  let sessionsRoot: string;
  beforeEach(() => { sessionsRoot = tmp('bmx-rollout-'); });

  function writeRollout(relDir: string, name: string, lines: unknown[]): void {
    const dir = join(sessionsRoot, relDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), jsonl(...lines));
  }

  it('reads resume id + cwd from session_meta and title from the first user_message event', async () => {
    writeRollout('2026/06/13', 'rollout-2026-06-13T07-02-46-019ebfca.jsonl', [
      { timestamp: '2026-06-13T07:02:46Z', type: 'session_meta', payload: { id: '019ebfca-4b59-7131-a924-440904afaff1', cwd: '/root/iserver/botmux' } },
      // Synthetic preamble (response_item role:user) must NOT become the title.
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root</cwd>\n</environment_context>' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'refactor the rollout parser' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cliSessionId: '019ebfca-4b59-7131-a924-440904afaff1',
      cwd: '/root/iserver/botmux',
      title: 'refactor the rollout parser',
    });
  });

  it('drops botmux-origin rollouts (user_message carries the injected wrapper)', async () => {
    writeRollout('2026/06/12', 'rollout-bmx.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-bmx', cwd: '/root/x' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '用户发送了：\n---\nactual prompt\n---\n\nSession ID: zzz' } },
    ]);
    writeRollout('2026/06/13', 'rollout-ext.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-ext', cwd: '/root/y' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'a prompt typed straight into codex' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['sid-ext']);
  });

  it('drops botmux-origin rollouts with stable metadata before user_message', async () => {
    writeRollout('2026/06/14', 'rollout-bmx-prefix.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-bmx-prefix', cwd: '/root/x' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<botmux_routing>\nuse botmux send\n</botmux_routing>\n\n<identity>\n  <name>Codex Bot</name>\n  <open_id>ou_bot</open_id>\n</identity>\n\n<session_id>sess-123</session_id>\n\n<role context="team" chat_id="oc_team">\nreviewer\n</role>\n\n<user_message>\nactual prompt\n</user_message>',
        },
      },
    ]);
    writeRollout('2026/06/15', 'rollout-ext-prefix-discuss.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-ext-prefix-discuss', cwd: '/root/y' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Please explain why botmux may place <botmux_routing> before <user_message>.' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['sid-ext-prefix-discuss']);
  });

  it('drops botmux-origin rollouts with reminder before user_message', async () => {
    writeRollout('2026/06/14', 'rollout-bmx-reminder-prefix.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-bmx-reminder-prefix', cwd: '/root/x' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<session_id>sess-123</session_id>\n\n<role context="team" chat_id="oc_team">\nreviewer\n</role>\n\n<botmux_reminder>reply via botmux send</botmux_reminder>\n\n<user_message>\nactual prompt\n</user_message>',
        },
      },
    ]);
    writeRollout('2026/06/15', 'rollout-ext-reminder-discuss.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-ext-reminder-discuss', cwd: '/root/y' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Please explain what <botmux_reminder> means.' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['sid-ext-reminder-discuss']);
  });

  // Whiteboard now sits between <botmux_reminder> and <user_message>; a
  // botmux-generated rollout carrying it must still be dropped (structural
  // match), not adopted as external.
  it('drops botmux-origin rollouts with whiteboard between reminder and user_message (new-topic shape)', async () => {
    writeRollout('2026/06/16', 'rollout-bmx-wb-newtopic.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-bmx-wb-newtopic', cwd: '/root/x' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<botmux_routing>\nuse botmux send\n</botmux_routing>\n\n<identity>\n  <name>Codex Bot</name>\n  <open_id>ou_bot</open_id>\n</identity>\n\n<session_id>sess-wb</session_id>\n\n<role context="team" chat_id="oc_team">\nreviewer\n</role>\n\n<whiteboard id="wb_x">\nread/update via botmux whiteboard\n</whiteboard>\n\n<user_message>\nactual prompt\n</user_message>',
        },
      },
    ]);
    writeRollout('2026/06/17', 'rollout-ext-wb-newtopic.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-ext-wb-newtopic', cwd: '/root/y' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'a prompt typed straight into codex' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['sid-ext-wb-newtopic']);
  });

  it('drops botmux-origin rollouts with whiteboard between reminder and user_message (follow-up shape)', async () => {
    writeRollout('2026/06/18', 'rollout-bmx-wb-followup.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-bmx-wb-followup', cwd: '/root/x' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<session_id>sess-wb2</session_id>\n\n<role context="team" chat_id="oc_team">\nreviewer\n</role>\n\n<botmux_reminder>reply via botmux send</botmux_reminder>\n\n<whiteboard id="wb_y">\nread/update via botmux whiteboard\n</whiteboard>\n\n<user_message>\nactual prompt\n</user_message>',
        },
      },
    ]);
    writeRollout('2026/06/19', 'rollout-ext-wb-followup.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-ext-wb-followup', cwd: '/root/y' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'a prompt typed straight into codex' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['sid-ext-wb-followup']);
  });

  // Regression (Codex blocker 2): legacy botmux rollouts may carry a
  // "你已连接到飞书话题，" preamble before "用户发送了：", which an anchored ^ match
  // missed. The envelope-paired-with-"Session ID:" combo catches it regardless.
  it('drops legacy botmux rollouts even with a preamble before 用户发送了', async () => {
    writeRollout('2026/04/22', 'rollout-legacy.jsonl', [
      { type: 'session_meta', payload: { id: 'legacy-bmx', cwd: '/root/x' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '你已连接到飞书话题，用户发送了：\n---\nhello\n---\n\nSession ID: 4e336606-0db6-4a7e-95a0-13e8685712bb' } },
    ]);
    writeRollout('2026/04/23', 'rollout-ext2.jsonl', [
      { type: 'session_meta', payload: { id: 'ext2', cwd: '/root/y' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'a normal codex prompt' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['ext2']);
  });

  it('excludes live rollout ids and keeps collecting until limit is met', async () => {
    for (let i = 0; i < 5; i++) {
      writeRollout(`2026/06/${10 + i}`, `rollout-${i}.jsonl`, [
        { type: 'session_meta', payload: { id: `roll-${i}`, cwd: `/root/r${i}` } },
        { type: 'event_msg', payload: { type: 'user_message', message: `prompt ${i}` } },
      ]);
    }
    const exclude = new Set(['roll-4', 'roll-3', 'roll-2']); // newest 3 are "live"
    const out = await discoverRolloutSessions(sessionsRoot, 2, exclude);
    expect(out).toHaveLength(2);
    expect(out.every((s) => !exclude.has(s.cliSessionId))).toBe(true);
  });

  it('drops rollouts missing session_meta id/cwd', async () => {
    writeRollout('2026/06/01', 'rollout-bad.jsonl', [
      { type: 'session_meta', payload: { id: 'only-id' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'orphan' } },
    ]);
    expect(await discoverRolloutSessions(sessionsRoot, 10)).toEqual([]);
  });

  // Codex >=0.147 no longer writes event_msg/user_message; user turns live in
  // response_item message role:user entries. The first is a synthetic preamble
  // (here AGENTS.md instructions + environment_context in ONE message's two
  // input_text blocks — the real rollout shape), the second is the real prompt.
  it('falls back to the first real response_item user message when event_msg/user_message is absent (Codex >=0.147)', async () => {
    writeRollout('2026/08/19', 'rollout-2026-08-19-newformat.jsonl', [
      { timestamp: '2026-08-19T22:41:43Z', type: 'session_meta', payload: { id: '01a01a78-8d40-7a80-a7c0-8b467bb31779', cwd: '/root/iserver/botmux' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /root/iserver/botmux\n\n<INSTRUCTIONS>\nrepo guide\n</INSTRUCTIONS>\n\n' },
        { type: 'input_text', text: '<environment_context>\n  <cwd>/root/iserver/botmux</cwd>\n  <shell>zsh</shell>\n</environment_context>' },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'refactor the rollout parser for the new format' }] } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cliSessionId: '01a01a78-8d40-7a80-a7c0-8b467bb31779',
      cwd: '/root/iserver/botmux',
      title: 'refactor the rollout parser for the new format',
    });
  });

  // Every observed synthetic preamble shape must be skipped before the real
  // prompt is taken as the title (verified against ~80 live ~/.codex rollouts).
  it('skips each synthetic preamble shape before taking the response_item title', async () => {
    writeRollout('2026/08/13', 'rollout-envctx.jsonl', [
      { type: 'session_meta', payload: { id: 'envctx-sid', cwd: '/root/p' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root/p</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-08-13</current_date>\n</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the real prompt after env context' }] } },
    ]);
    writeRollout('2026/08/02', 'rollout-plugins.jsonl', [
      { type: 'session_meta', payload: { id: 'plugins-sid', cwd: '/root/q' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n</recommended_plugins>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the real prompt after plugins' }] } },
    ]);
    writeRollout('2026/08/01', 'rollout-perms.jsonl', [
      { type: 'session_meta', payload: { id: 'perms-sid', cwd: '/root/r' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<permissions>\nread-only sandbox\n</permissions>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the real prompt after permissions' }] } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId).sort()).toEqual(['envctx-sid', 'perms-sid', 'plugins-sid']);
    expect(out.find((s) => s.cliSessionId === 'envctx-sid')?.title).toBe('the real prompt after env context');
    expect(out.find((s) => s.cliSessionId === 'plugins-sid')?.title).toBe('the real prompt after plugins');
    expect(out.find((s) => s.cliSessionId === 'perms-sid')?.title).toBe('the real prompt after permissions');
  });

  // 散文中提及 preamble 标签不是合成 preamble——锚定行首避免误杀真实 prompt。
  it('does not skip a real prompt that mentions preamble tags in prose', async () => {
    writeRollout('2026/08/14', 'rollout-prose-tags.jsonl', [
      { type: 'session_meta', payload: { id: 'prose-sid', cwd: '/root/s' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what does <environment_context> mean in codex rollouts? also <permissions> docs' }] } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cliSessionId: 'prose-sid', title: 'what does <environment_context> mean in codex rollouts? also <permissions> docs' });
  });

  // A new-format rollout whose first real user turn carries botmux's injected
  // wrapper is botmux-origin and must be dropped — skipping the message and
  // taking a later turn would leak botmux sessions into the /adopt picker.
  it('drops botmux-origin rollouts whose response_item user turn carries the injected wrapper (new format)', async () => {
    writeRollout('2026/08/20', 'rollout-bmx-newfmt.jsonl', [
      { type: 'session_meta', payload: { id: 'bmx-newfmt', cwd: '/root/x' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root/x</cwd>\n</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_message>\n@Codex do the thing\n</user_message>\n<sender type="user" open_id="ou_abcdefghijklmnop" />' }] } },
    ]);
    writeRollout('2026/08/21', 'rollout-ext-newfmt.jsonl', [
      { type: 'session_meta', payload: { id: 'ext-newfmt', cwd: '/root/y' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root/y</cwd>\n</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a prompt typed straight into codex' }] } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['ext-newfmt']);
  });

  // Detection is structural: an external new-format session whose prompt merely
  // discusses botmux's XML in prose must NOT be mis-flagged (mirrors the
  // event_msg/user_message regression coverage above).
  it('keeps external new-format sessions that only mention botmux tags in prose', async () => {
    writeRollout('2026/08/22', 'rollout-ext-discuss.jsonl', [
      { type: 'session_meta', payload: { id: 'ext-discuss', cwd: '/root/z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root/z</cwd>\n</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'I am debugging botmux and the <user_message> tag behavior, and why does <sender type= show up?' }] } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['ext-discuss']);
  });

  // A rollout whose only user turns are synthetic preambles (no real prompt)
  // has no meaningful title and is dropped, not adopted with the preamble.
  it('drops new-format rollouts with only a synthetic preamble and no real prompt', async () => {
    writeRollout('2026/08/23', 'rollout-preamble-only.jsonl', [
      { type: 'session_meta', payload: { id: 'preamble-only', cwd: '/root/p' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root/p</cwd>\n</environment_context>' }] } },
    ]);
    expect(await discoverRolloutSessions(sessionsRoot, 10)).toEqual([]);
  });

  it('reads TraeX 0.201.7 user messages from history_mutation records', async () => {
    writeRollout('2026/08/29', 'rollout-traex-history-mutation.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-history-mutation', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...</permissions instructions>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /root/traex\n\n<INSTRUCTIONS>repo guide</INSTRUCTIONS>' }] },
      ] } },
      { type: 'history_mutation', payload: { operation: 'append', items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'show the native TraeX title' }] },
      ] } },
    ]);

    const out = await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' });
    expect(out).toEqual([
      expect.objectContaining({
        cliSessionId: 'traex-history-mutation',
        cwd: '/root/traex',
        title: 'show the native TraeX title',
      }),
    ]);
  });

  it('reads compacted TraeX history from a history_mutation replace snapshot', async () => {
    writeRollout('2026/08/29', 'rollout-traex-history-replace.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-history-replace', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'replace', items: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...</permissions instructions>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /root/traex' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'resume this compacted conversation' }] },
      ] } },
    ]);

    const out = await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' });
    expect(out).toEqual([
      expect.objectContaining({
        cliSessionId: 'traex-history-replace',
        title: 'resume this compacted conversation',
      }),
    ]);
  });

  it('drops botmux-origin TraeX history_mutation sessions', async () => {
    writeRollout('2026/08/29', 'rollout-traex-botmux.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-botmux', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [
        { type: 'message', role: 'user', content: [{
          type: 'input_text',
          text: '<botmux_routing>route through Lark</botmux_routing>\n<session_id>botmux-id</session_id>\n<user_message>hello</user_message>',
        }] },
      ] } },
    ]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' })).toEqual([]);
  });

  it('prefers TraeX native index title and activity metadata over inferred rollout values', async () => {
    writeRollout('2026/08/29', 'rollout-traex-renamed.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-renamed', cwd: '/old/cwd' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'original prompt' }] },
      ] } },
    ]);
    const metadataById = new Map([['traex-renamed', {
      title: 'Renamed in TraeX',
      firstUserMessage: 'original prompt',
      cwd: '/current/cwd',
      lastActivityAt: 1_787_900_000_000,
    }]]);

    const out = await discoverRolloutSessions(sessionsRoot, 10, undefined, {
      dialect: 'traex',
      metadataById,
    });
    expect(out).toEqual([{
      cliSessionId: 'traex-renamed',
      cwd: '/current/cwd',
      title: 'Renamed in TraeX',
      lastActivityAt: 1_787_900_000_000,
    }]);
  });

  it('still drops botmux-owned TraeX sessions when the native index has a title', async () => {
    writeRollout('2026/08/29', 'rollout-traex-native-botmux.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-native-botmux', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [{
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<session_id>botmux-id</session_id>\n<user_message>hello</user_message>',
        }],
      }] } },
    ]);
    const metadataById = new Map([['traex-native-botmux', {
      title: 'Native title must not bypass ownership filtering',
      firstUserMessage: '<session_id>botmux-id</session_id>\n<user_message>hello</user_message>',
    }]]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, {
      dialect: 'traex',
      metadataById,
    })).toEqual([]);
  });

  // TraeX ≥0.208 (measured on 0.209.1 / 0.210.1) prepends a user-role item that
  // is one whole <system-reminder> block (gitStatus / currentDate) before the
  // <environment_context> item and the real prompt.
  const traexContextReminder = {
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# gitStatus\nCurrent branch: master\n</system-reminder>",
    }],
  };
  const traexEnvironmentContext = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '<environment_context>\n  <filesystem></filesystem>\n</environment_context>' }],
  };

  it('skips the TraeX 0.208+ <system-reminder> context item when inferring the title', async () => {
    writeRollout('2026/10/17', 'rollout-traex-reminder.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-reminder', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [traexContextReminder, traexEnvironmentContext] } },
      { type: 'history_mutation', payload: { operation: 'append', items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the flaky reconnect test' }] },
      ] } },
    ]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' })).toEqual([
      expect.objectContaining({ cliSessionId: 'traex-reminder', title: 'fix the flaky reconnect test' }),
    ]);
  });

  it('still drops a botmux envelope that follows the TraeX <system-reminder> context item', async () => {
    // Without the reminder skip, the reminder became the first canonical user
    // turn, decided origin as "external" and early-stopped before the envelope.
    writeRollout('2026/10/17', 'rollout-traex-reminder-botmux.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-reminder-botmux', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [traexContextReminder, traexEnvironmentContext] } },
      { type: 'history_mutation', payload: { operation: 'append', items: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<session_id>botmux-id</session_id>\n<user_message>\nhello\n</user_message>' }],
      }] } },
    ]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' })).toEqual([]);
  });

  it('drops a TraeX session the native index marks botmux-origin even when a later rollout turn is clean', async () => {
    writeRollout('2026/10/17', 'rollout-traex-index-origin.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-index-origin', cwd: '/root/traex' } },
      { type: 'history_mutation', payload: { operation: 'replace', items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a later, clean turn after compaction' }] },
      ] } },
    ]);
    const metadataById = new Map([['traex-index-origin', { title: '确认收到消息', botmuxOrigin: true }]]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex', metadataById })).toEqual([]);
  });

  it('does not list a TraeX session that has a native title but no user turn', async () => {
    // e.g. a thread renamed right after launch and closed without a prompt:
    // nothing was origin-checked and there is nothing to resume.
    writeRollout('2026/10/17', 'rollout-traex-empty.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-empty', cwd: '/tmp' } },
      { type: 'history_mutation', payload: { operation: 'append', items: [traexContextReminder, traexEnvironmentContext] } },
    ]);
    const metadataById = new Map([['traex-empty', { title: 'e2e-renamed-only' }]]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex', metadataById })).toEqual([]);
  });

  it('reads the TraeX 0.201.4 item_completed/UserMessage dialect', async () => {
    writeRollout('2026/08/29', 'rollout-traex-item-completed.jsonl', [
      { type: 'session_meta', payload: { id: 'traex-item-completed', cwd: '/root/traex' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'UserMessage', content: [{ type: 'text', text: 'summarise the release notes' }],
      } } },
    ]);

    expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
      expect.objectContaining({ cliSessionId: 'traex-item-completed', title: 'summarise the release notes' }),
    ]);
  });

  describe('TraeX canonical vs raw model items (review P2-1)', () => {
    const ENVELOPE = '<session_id>botmux-id</session_id>\n<user_message>hello</user_message>';
    const runtimeWarning = { type: 'history_mutation', payload: { operation: 'append', items: [{
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Warning: the workspace is read-only for this turn.' }],
    }] } };

    it('drops a botmux turn hidden behind a runtime-injected user item (verified display completion)', async () => {
      writeRollout('2026/10/18', 'rollout-traex-warning-dc.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-warning-dc', cwd: '/root/traex' } },
        runtimeWarning,
        traexUserTurn('traex-warning-dc', ENVELOPE),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('drops a botmux turn hidden behind a runtime-injected user item (legacy user_message event)', async () => {
      writeRollout('2026/10/18', 'rollout-traex-warning-legacy.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-warning-legacy', cwd: '/root/traex' } },
        runtimeWarning,
        { type: 'event_msg', payload: { type: 'user_message', message: ENVELOPE } },
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('titles an external session by its verified input, not the runtime item before it', async () => {
      writeRollout('2026/10/18', 'rollout-traex-warning-clean.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-warning-clean', cwd: '/root/traex' } },
        runtimeWarning,
        traexUserTurn('traex-warning-clean', 'profile the slow query'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-warning-clean', title: 'profile the slow query' }),
      ]);
    });

    it('ignores a display completion that belongs to another thread', async () => {
      writeRollout('2026/10/18', 'rollout-traex-foreign-dc.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-foreign-dc', cwd: '/root/traex' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'my own first prompt' }] } },
        traexUserTurn('traex-foreign-dc', ENVELOPE, 'turn-x', 'some-other-thread'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-foreign-dc', title: 'my own first prompt' }),
      ]);
    });

    it('stops at the end of a weak-only first turn instead of reading the whole rollout', async () => {
      writeRollout('2026/10/18', 'rollout-traex-weak-bounded.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-weak-bounded', cwd: '/root/traex' } },
        { type: 'history_mutation', payload: { operation: 'append', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first turn, 0.201.7 style' }] },
        ] } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
        // Never reached: the scan ends with the first turn.
        traexUserTurn('traex-weak-bounded', ENVELOPE, 'turn-2'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-weak-bounded', title: 'first turn, 0.201.7 style' }),
      ]);
    });

    it('keeps a cancelled weak-only external first turn even if a later turn pastes an envelope', async () => {
      writeRollout('2026/10/19', 'rollout-traex-aborted-external.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-aborted-external', cwd: '/root/traex' } },
        { type: 'history_mutation', payload: { operation: 'append', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'external first prompt' }] },
        ] } },
        { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' } },
        traexUserTurn('traex-aborted-external', ENVELOPE, 'turn-2'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-aborted-external', title: 'external first prompt' }),
      ]);
    });

    it('still drops a cancelled weak-only botmux first turn even if a later turn is plain text', async () => {
      writeRollout('2026/10/19', 'rollout-traex-aborted-botmux.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-aborted-botmux', cwd: '/root/traex' } },
        { type: 'history_mutation', payload: { operation: 'append', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: ENVELOPE }] },
        ] } },
        { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' } },
        traexUserTurn('traex-aborted-botmux', 'plain follow-up text', 'turn-2'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });
  });

  describe('TraeX first-turn rule (table — keep in sync with parseRolloutTranscript)', () => {
    const ENV = '<session_id>botmux-id</session_id>\n<user_message>hello</user_message>';
    const REMINDER = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n</system-reminder>";
    type Rec = (sid: string) => unknown;
    const turn = (t?: string) => (t ? { turn_id: t } : {});
    // W: weak user items
    const ri = (text: string): Rec => () => ({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const hm = (text: string, t?: string): Rec => () => ({ type: 'history_mutation', payload: {
      operation: 'append', ...turn(t), items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] } });
    // C: canonical inputs
    const dc = (text: string, t: string): Rec => sid => traexUserTurn(sid, text, t);
    const ic = (text: string, t?: string): Rec => () => ({ type: 'event_msg', payload: {
      type: 'item_completed', ...turn(t), item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
    const um = (text: string, t?: string): Rec => () => ({ type: 'event_msg', payload: { type: 'user_message', message: text, ...turn(t) } });
    // T: terminals
    const done = (t?: string): Rec => () => ({ type: 'event_msg', payload: { type: 'task_complete', ...turn(t) } });
    const aborted = (t?: string): Rec => () => ({ type: 'event_msg', payload: { type: 'turn_aborted', ...turn(t) } });

    /** [case, records, expected title — null = not listed] */
    const CASES: Array<[string, Rec[], string | null]> = [
      ['W clean only', [hm('external prompt', 't1')], 'external prompt'],
      ['W botmux only', [hm(ENV, 't1')], null],
      ['synthetic items never decide', [hm(REMINDER, 't1'), hm('external prompt', 't1')], 'external prompt'],
      ['open: T ignored', [done('t0'), hm('external prompt', 't1')], 'external prompt'],
      ['open: C decides before any W', [dc('verified prompt', 't1'), hm(ENV, 't1')], 'verified prompt'],
      ['weak: later W ignored', [hm('external prompt', 't1'), hm(ENV, 't1')], 'external prompt'],
      ['weak: same-turn C overrides botmux W', [hm(ENV, 't1'), dc('verified prompt', 't1')], 'verified prompt'],
      ['weak: same-turn C overrides clean W', [hm('runtime warning', 't1'), dc(ENV, 't1')], null],
      ['steer: next-turn clean C cannot launder', [hm(ENV, 't1'), dc('steered follow-up', 't2')], null],
      ['steer: next-turn botmux C cannot hide', [hm('external prompt', 't1'), dc(ENV, 't2')], 'external prompt'],
      ['late bind: W mirror reveals turn (botmux)', [ri(ENV), hm(ENV, 't1'), dc('steered follow-up', 't2')], null],
      ['late bind: W mirror reveals turn (clean)', [ri('external prompt'), hm('external prompt', 't1'), dc(ENV, 't2')], 'external prompt'],
      ['late bind: C mirror reveals turn', [ri(ENV), ic(ENV, 't1'), dc('steered follow-up', 't2')], null],
      ['late bind: event_msg mirror reveals turn', [ri('external prompt'), um('external prompt', 't1'), dc(ENV, 't2')], 'external prompt'],
      ['replayed T of another turn is skipped (C)', [hm('runtime warning', 't1'), done('t0'), dc(ENV, 't1')], null],
      ['replayed T of another turn is skipped (turn-less C)', [hm('runtime warning', 't1'), aborted('t0'), um(ENV)], null],
      ['first-turn T closes (complete)', [hm('external prompt', 't1'), done('t1'), dc(ENV, 't2')], 'external prompt'],
      ['first-turn T closes (aborted)', [hm(ENV, 't1'), aborted('t1'), dc('steered follow-up', 't2')], null],
      ['turn-less C inside first turn: title', [hm('runtime warning', 't1'), um('the real prompt'), done('t1')], 'the real prompt'],
      ['turn-less C inside first turn: botmux', [hm('runtime warning', 't1'), um(ENV)], null],
      ['turn-less C after first-turn T', [hm('external prompt', 't1'), aborted('t1'), um(ENV)], 'external prompt'],
      ['unknown first turn: turn-less T closes', [ri('external prompt'), done(), dc(ENV, 't2')], 'external prompt'],
      ['unknown first turn: any T closes', [ri('external prompt'), done('t9'), dc(ENV, 't2')], 'external prompt'],
      ['unknown first turn, no mirror: C overrides (legacy fallback)', [ri('external prompt'), dc(ENV, 't2')], null],
    ];

    it.each(CASES)('%s', async (_name, records, expected) => {
      const sid = 'traex-rule';
      writeRollout('2026/10/20', 'rollout-traex-rule.jsonl', [
        { type: 'session_meta', payload: { id: sid, cwd: '/root/traex' } },
        ...records.map(r => r(sid)),
      ]);
      const out = await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX);
      if (expected === null) expect(out).toEqual([]);
      else expect(out).toEqual([expect.objectContaining({ cliSessionId: sid, title: expected })]);
    });
  });

  describe('TraeX prefetch stays bounded', () => {
    const sid = (i: number) => `01a2${String(i).padStart(4, '0')}-0000-7000-8000-000000000000`;
    function seed(count: number): Map<string, { lastActivityAt: number }> {
      const light = new Map<string, { lastActivityAt: number }>();
      for (let i = 0; i < count; i++) {
        writeRollout('2026/10/20', `rollout-2026-10-20T10-00-00-${sid(i)}.jsonl`, [
          { type: 'session_meta', payload: { id: sid(i), cwd: '/root/traex' } },
        ]);
        // Higher index = more recent, so the excluded ones below come first.
        light.set(sid(i), { lastActivityAt: 1_792_000_000_000 + i * 1000 });
      }
      return light;
    }
    function countingLoader() {
      const calls: string[][] = [];
      const load = (ids: readonly string[]) => {
        calls.push([...ids]);
        return new Map(ids.map(id => [id, { firstUserMessage: `prompt ${id}` }]));
      };
      return { calls, load };
    }

    it('excluded threads ahead of eligible ones cost no detail queries', async () => {
      const light = seed(150);
      const exclude = new Set(Array.from({ length: 100 }, (_, k) => sid(149 - k))); // the 100 newest
      const { calls, load } = countingLoader();
      const out = await discoverRolloutSessions(sessionsRoot, 1, exclude, { ...TRAEX, metadataById: light, loadSessionDetails: load });

      expect(out.map(s => s.cliSessionId)).toEqual([sid(49)]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.length).toBeLessThanOrEqual(1 + 8);
      expect(calls.flat().some(id => exclude.has(id))).toBe(false);
    });

    it('an all-excluded store issues no detail query at all', async () => {
      const light = seed(60);
      const { calls, load } = countingLoader();
      const out = await discoverRolloutSessions(sessionsRoot, 5, new Set(light.keys()), { ...TRAEX, metadataById: light, loadSessionDetails: load });
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe('TraeX first-turn identity (steer / type-ahead)', () => {
    const ENVELOPE = '<session_id>botmux-id</session_id>\n<user_message>hello</user_message>';
    const rawTurnItem = (text: string, turnId: string) => ({ type: 'history_mutation', payload: {
      operation: 'append', turn_id: turnId,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    } });

    it('does not let a steered next-turn input launder a botmux first turn', async () => {
      writeRollout('2026/10/19', 'rollout-traex-steer-launder.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-steer-launder', cwd: '/root/traex' } },
        rawTurnItem(ENVELOPE, 'turn-1'),
        // Type-ahead for turn 2 lands before turn 1's terminal record.
        traexUserTurn('traex-steer-launder', 'a clean steered follow-up', 'turn-2'),
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('does not let a steered next-turn envelope hide an external first turn', async () => {
      writeRollout('2026/10/19', 'rollout-traex-steer-external.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-steer-external', cwd: '/root/traex' } },
        rawTurnItem('external first prompt', 'turn-1'),
        traexUserTurn('traex-steer-external', ENVELOPE, 'turn-2'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-steer-external', title: 'external first prompt' }),
      ]);
    });

    it('accepts a turn-less legacy user_message inside the first turn (mixed dialect): title', async () => {
      writeRollout('2026/10/19', 'rollout-traex-mixed-title.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-mixed-title', cwd: '/root/traex' } },
        rawTurnItem('Warning: the workspace is read-only for this turn.', 'turn-1'),
        { type: 'event_msg', payload: { type: 'user_message', message: 'the real external prompt' } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-mixed-title', title: 'the real external prompt' }),
      ]);
    });

    it('accepts a turn-less legacy user_message inside the first turn (mixed dialect): botmux rejected', async () => {
      writeRollout('2026/10/19', 'rollout-traex-mixed-botmux.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-mixed-botmux', cwd: '/root/traex' } },
        rawTurnItem('Warning: the workspace is read-only for this turn.', 'turn-1'),
        { type: 'event_msg', payload: { type: 'user_message', message: ENVELOPE } },
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('ignores a turn-less legacy user_message after the first turn ended', async () => {
      writeRollout('2026/10/19', 'rollout-traex-mixed-after.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-mixed-after', cwd: '/root/traex' } },
        rawTurnItem('external first prompt', 'turn-1'),
        { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' } },
        { type: 'event_msg', payload: { type: 'user_message', message: ENVELOPE } },
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-mixed-after', title: 'external first prompt' }),
      ]);
    });

    it('still lets a canonical record of the same turn override the weak verdict', async () => {
      writeRollout('2026/10/19', 'rollout-traex-same-turn.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-same-turn', cwd: '/root/traex' } },
        rawTurnItem(ENVELOPE, 'turn-1'),
        traexUserTurn('traex-same-turn', 'the verified first prompt', 'turn-1'),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-same-turn', title: 'the verified first prompt' }),
      ]);
    });
  });

  describe('TraeX lazy prompt metadata', () => {
    const sid = (i: number) => `01a1${String(i).padStart(4, '0')}-0000-7000-8000-000000000000`;

    it('loads prompt-bearing metadata only for the threads it parses (plus a small look-ahead)', async () => {
      const light = new Map<string, { lastActivityAt: number }>();
      for (let i = 0; i < 40; i++) {
        writeRollout('2026/10/19', `rollout-2026-10-19T10-00-00-${sid(i)}.jsonl`, [
          { type: 'session_meta', payload: { id: sid(i), cwd: '/root/traex' } },
        ]);
        light.set(sid(i), { lastActivityAt: 1_792_000_000_000 + i * 1000 });
      }
      const requested: string[] = [];
      const out = await discoverRolloutSessions(sessionsRoot, 3, undefined, {
        ...TRAEX,
        metadataById: light,
        loadSessionDetails: (ids) => {
          requested.push(...ids);
          return new Map(ids.map(id => [id, { title: `title ${id}`, firstUserMessage: `prompt ${id}` }]));
        },
      });

      // Newest native activity first; titles come from the lazily loaded details.
      expect(out.map(s => s.cliSessionId)).toEqual([sid(39), sid(38), sid(37)]);
      expect(out[0]!.title).toBe(`title ${sid(39)}`);
      expect(requested.length).toBeLessThanOrEqual(3 + 8);
      expect(new Set(requested).size).toBe(requested.length);
    });

    it('falls back to a per-id load when the filename carries no thread id', async () => {
      writeRollout('2026/10/19', 'rollout-unnamed.jsonl', [
        { type: 'session_meta', payload: { id: 'thread-without-filename-id', cwd: '/root/traex' } },
      ]);
      const requested: string[] = [];
      const out = await discoverRolloutSessions(sessionsRoot, 5, undefined, {
        ...TRAEX,
        loadSessionDetails: (ids) => {
          requested.push(...ids);
          return new Map(ids.map(id => [id, { firstUserMessage: 'prompt from the index' }]));
        },
      });
      expect(requested).toEqual(['thread-without-filename-id']);
      expect(out).toEqual([expect.objectContaining({ title: 'prompt from the index' })]);
    });
  });

  describe('TraeX botmux v3 goal workers', () => {
    it('rejects a goal worker whose native first input is the botmux objective (0.210 preview)', async () => {
      writeRollout('2026/10/19', 'rollout-traex-v3-goal-index.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-v3-goal-index', cwd: '/root/v3' } },
        { type: 'history_mutation', payload: { operation: 'append', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<codex_internal_context source="user_goal">\nUser set the goal: "${GOAL_COMMAND_OBJECTIVE}"\n</codex_internal_context>` }] },
        ] } },
      ]);
      const metadataById = new Map([['traex-v3-goal-index', {
        title: 'Read $BOTMUX_GOAL_PATH. Write files',
        firstUserMessage: GOAL_COMMAND_OBJECTIVE,
      }]]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { ...TRAEX, metadataById })).toEqual([]);
    });

    it('rejects a goal worker from the rollout alone (thread_goal_updated), without native metadata', async () => {
      writeRollout('2026/10/19', 'rollout-traex-v3-goal-rollout.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-v3-goal-rollout', cwd: '/root/v3' } },
        { type: 'event_msg', payload: { type: 'thread_goal_updated', threadId: 'traex-v3-goal-rollout', goal: {
          threadId: 'traex-v3-goal-rollout', objective: GOAL_COMMAND_OBJECTIVE,
        } } },
        { type: 'history_mutation', payload: { operation: 'append', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<codex_internal_context source="user_goal">\nUser set the goal: "${GOAL_COMMAND_OBJECTIVE}"\n</codex_internal_context>` }] },
        ] } },
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('rejects a goal worker whose verified first input is the /goal line', async () => {
      writeRollout('2026/10/19', 'rollout-traex-v3-goal-dc.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-v3-goal-dc', cwd: '/root/v3' } },
        traexUserTurn('traex-v3-goal-dc', `${GOAL_COMMAND} ${GOAL_COMMAND_OBJECTIVE}`),
      ]);
      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('keeps a user-run goal-mode session and an ordinary session', async () => {
      writeRollout('2026/10/19', 'rollout-traex-user-goal.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-user-goal', cwd: '/root/app' } },
        { type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { objective: 'ship the release notes' } } },
      ]);
      writeRollout('2026/10/19', 'rollout-traex-ordinary.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-ordinary', cwd: '/root/app' } },
        traexUserTurn('traex-ordinary', 'fix the login redirect'),
      ]);
      const metadataById = new Map([['traex-user-goal', { title: 'Ship release notes', firstUserMessage: 'ship the release notes' }]]);
      const out = await discoverRolloutSessions(sessionsRoot, 10, undefined, { ...TRAEX, metadataById });
      expect(out.map(s => [s.cliSessionId, s.title]).sort()).toEqual([
        ['traex-ordinary', 'fix the login redirect'],
        ['traex-user-goal', 'Ship release notes'],
      ]);
    });
  });

  describe('TraeX internal helper sessions (review P2-2)', () => {
    for (const [label, meta] of [
      ['thread_source=subagent', { thread_source: 'subagent' }],
      ['source.subagent', { source: { subagent: { kind: 'guardian' } } }],
    ] as const) {
      it(`rejects ${label} rollouts even with clean user records and native metadata`, async () => {
        writeRollout('2026/10/18', `rollout-traex-internal-${label.replace(/\W/g, '')}.jsonl`, [
          { type: 'session_meta', payload: { id: 'traex-internal', cwd: '/root/traex', ...meta } },
          traexUserTurn('traex-internal', 'review the diff for risky changes'),
        ]);
        const metadataById = new Map([['traex-internal', { title: 'Guardian review', firstUserMessage: 'review the diff' }]]);
        expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { ...TRAEX, metadataById })).toEqual([]);
      });
    }
  });

  describe('TraeX resume segments and activity order (review P2-3 / P2-4)', () => {
    const SID_A = '01a14a68-b8a9-74e0-bc4e-8ad73a773028';
    const SID_B = '01a14a6b-ace0-7080-971b-d41592af5438';
    const SID_C = '01a14a6c-0000-7000-8000-000000000003';
    const TURN = '01a14a70-0000-7000-8000-0000000000aa';
    const write = (name: string, sid: string, prompt: string, mtimeSec: number, cwd = '/root/traex'): string => {
      writeRollout('2026/10/18', name, [
        { type: 'session_meta', payload: { id: sid, cwd } },
        traexUserTurn(sid, prompt),
      ]);
      const path = join(sessionsRoot, '2026/10/18', name);
      utimesSync(path, mtimeSec, mtimeSec);
      return path;
    };

    it('lists one candidate per thread across resume segments so siblings cannot crowd out other threads', async () => {
      write(`rollout-2026-10-18T10-00-00-${SID_A}.jsonl`, SID_A, 'thread A', 1_792_300_000);
      write(`rollout-2026-10-18T11-00-00-${SID_A}_${TURN}.jsonl`, SID_A, 'thread A', 1_792_300_300);
      write(`rollout-2026-10-18T09-00-00-${SID_B}.jsonl`, SID_B, 'thread B', 1_792_299_000);
      const metadataById = new Map([[SID_A, { firstUserMessage: 'thread A' }], [SID_B, { firstUserMessage: 'thread B' }]]);

      const out = await discoverRolloutSessions(sessionsRoot, 2, undefined, { ...TRAEX, metadataById });
      expect(out.map(s => s.cliSessionId)).toEqual([SID_A, SID_B]);
      expect(out[0]!.lastActivityAt).toBe(1_792_300_300_000);
    });

    it('prefers the segment the native index points at', async () => {
      const indexed = write(`rollout-2026-10-18T10-00-00-${SID_A}.jsonl`, SID_A, 'thread A', 1_792_300_000, '/root/indexed');
      write(`rollout-2026-10-18T11-00-00-${SID_A}_${TURN}.jsonl`, SID_A, 'thread A', 1_792_300_300, '/root/stale');
      const metadataById = new Map([[SID_A, { lastActivityAt: 1_792_300_500_000, rolloutPath: indexed }]]);

      expect(await discoverRolloutSessions(sessionsRoot, 5, undefined, { ...TRAEX, metadataById })).toEqual([
        expect.objectContaining({ cliSessionId: SID_A, cwd: '/root/indexed' }),
      ]);
    });

    it('never resurrects a botmux thread through an older sibling segment', async () => {
      write(`rollout-2026-10-18T10-00-00-${SID_A}.jsonl`, SID_A, 'looks external', 1_792_300_000);
      write(`rollout-2026-10-18T11-00-00-${SID_A}_${TURN}.jsonl`, SID_A,
        '<session_id>botmux-id</session_id>\n<user_message>hi</user_message>', 1_792_300_300);

      expect(await discoverRolloutSessions(sessionsRoot, 5, undefined, TRAEX)).toEqual([]);
    });

    it('rejects a thread whose newer segment opens with a weak envelope, despite a clean older sibling', async () => {
      // No native metadata, no canonical record: the weak botmux verdict must
      // reject the thread, not just leave it untitled for a sibling to claim.
      writeRollout('2026/10/18', `rollout-2026-10-18T10-00-00-${SID_A}.jsonl`, [
        { type: 'session_meta', payload: { id: SID_A, cwd: '/root/traex' } },
        { type: 'history_mutation', payload: { operation: 'replace', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compacted, clean-looking prompt' }] },
        ] } },
      ]);
      utimesSync(join(sessionsRoot, '2026/10/18', `rollout-2026-10-18T10-00-00-${SID_A}.jsonl`), 1_792_300_000, 1_792_300_000);
      writeRollout('2026/10/18', `rollout-2026-10-18T11-00-00-${SID_A}_${TURN}.jsonl`, [
        { type: 'session_meta', payload: { id: SID_A, cwd: '/root/traex' } },
        { type: 'history_mutation', payload: { operation: 'append', items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<session_id>botmux-id</session_id>\n<user_message>hi</user_message>' }] },
        ] } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ]);
      utimesSync(join(sessionsRoot, '2026/10/18', `rollout-2026-10-18T11-00-00-${SID_A}_${TURN}.jsonl`), 1_792_300_300, 1_792_300_300);

      expect(await discoverRolloutSessions(sessionsRoot, 5, undefined, TRAEX)).toEqual([]);
    });

    it('orders and truncates by native activity, falling back to mtime without metadata', async () => {
      // A: newest file, but its native activity is the oldest.
      write(`rollout-2026-10-18T12-00-00-${SID_A}.jsonl`, SID_A, 'thread A', 1_792_300_900);
      // B: older file, most recent native activity (e.g. renamed / resumed elsewhere).
      write(`rollout-2026-10-18T08-00-00-${SID_B}.jsonl`, SID_B, 'thread B', 1_792_290_000);
      // C: no native metadata → its mtime is its activity.
      write(`rollout-2026-10-18T09-00-00-${SID_C}.jsonl`, SID_C, 'thread C', 1_792_300_500);
      const metadataById = new Map([
        [SID_A, { lastActivityAt: 1_792_100_000_000 }],
        [SID_B, { lastActivityAt: 1_792_400_000_000 }],
      ]);

      const top1 = await discoverRolloutSessions(sessionsRoot, 1, undefined, { ...TRAEX, metadataById });
      expect(top1.map(s => s.cliSessionId)).toEqual([SID_B]);
      const all = await discoverRolloutSessions(sessionsRoot, 5, undefined, { ...TRAEX, metadataById });
      expect(all.map(s => [s.cliSessionId, s.lastActivityAt])).toEqual([
        [SID_B, 1_792_400_000_000],
        [SID_C, 1_792_300_500_000],
        [SID_A, 1_792_100_000_000],
      ]);
    });
  });

  describe('TraeX response_item-only rollouts (weak origin)', () => {
    const botmuxResponseItem = { type: 'response_item', payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<session_id>botmux-id</session_id>\n<user_message>first turn</user_message>' }],
    } };

    it('drops the session when the first response_item turn is botmux even if a later one is clean', async () => {
      writeRollout('2026/10/17', 'rollout-traex-weak-later.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-weak-later', cwd: '/root/traex' } },
        botmuxResponseItem,
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second turn text' }] } },
      ]);

      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' })).toEqual([]);
    });

    it('keeps an external session whose first response_item is clean even if a later turn pastes an envelope', async () => {
      // The weak verdict belongs to the FIRST real response_item (same as
      // Codex); a later botmux-shaped paste must not hide the session.
      writeRollout('2026/10/17', 'rollout-traex-weak-paste.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-weak-paste', cwd: '/root/traex' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review my prompt template' }] } },
        botmuxResponseItem,
      ]);

      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex' })).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-weak-paste', title: 'review my prompt template' }),
      ]);
    });

    it('lets a clean canonical record override a botmux first response_item', async () => {
      writeRollout('2026/10/17', 'rollout-traex-weak-canonical-clean.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-weak-canonical-clean', cwd: '/root/traex' } },
        botmuxResponseItem,
        traexUserTurn('traex-weak-canonical-clean', 'the real first prompt'),
      ]);

      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([
        expect.objectContaining({ cliSessionId: 'traex-weak-canonical-clean', title: 'the real first prompt' }),
      ]);
    });

    it('lets a botmux canonical record override a clean first response_item', async () => {
      writeRollout('2026/10/17', 'rollout-traex-weak-canonical-botmux.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-weak-canonical-botmux', cwd: '/root/traex' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'runtime injection that looks clean' }] } },
        traexUserTurn('traex-weak-canonical-botmux', '<session_id>botmux-id</session_id>\n<user_message>hello</user_message>'),
      ]);

      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, TRAEX)).toEqual([]);
    });

    it('drops the session when a native title exists but the only user turn is botmux', async () => {
      writeRollout('2026/10/17', 'rollout-traex-weak-native.jsonl', [
        { type: 'session_meta', payload: { id: 'traex-weak-native', cwd: '/root/traex' } },
        botmuxResponseItem,
      ]);
      const metadataById = new Map([['traex-weak-native', { title: 'Renamed via /rename' }]]);

      expect(await discoverRolloutSessions(sessionsRoot, 10, undefined, { dialect: 'traex', metadataById })).toEqual([]);
    });
  });
});

describe('discoverAntigravitySessions', () => {
  let dir: string;
  let historyPath: string;
  beforeEach(() => { dir = tmp('bmx-agy-'); historyPath = join(dir, 'history.jsonl'); });

  it('dedups by conversationId, keeps the latest timestamp, first display as title', async () => {
    writeFileSync(historyPath, jsonl(
      { display: 'first turn', timestamp: 1000, workspace: '/root/p1', conversationId: 'conv-1' },
      { display: 'second turn', timestamp: 2000, workspace: '/root/p1', conversationId: 'conv-1' },
      { display: 'other convo', timestamp: 1500, workspace: '/root/p2', conversationId: 'conv-2' },
    ));
    const out = await discoverAntigravitySessions(historyPath, 10);
    expect(out).toHaveLength(2);
    // conv-1 sorts first (latest activity 2000) and keeps its first display.
    expect(out[0]).toMatchObject({ cliSessionId: 'conv-1', cwd: '/root/p1', title: 'first turn', lastActivityAt: 2000 });
    expect(out[1]).toMatchObject({ cliSessionId: 'conv-2', title: 'other convo' });
  });

  it('drops conversations with any botmux-injected submit', async () => {
    writeFileSync(historyPath, jsonl(
      { display: '<user_message>@agy hi</user_message>\n<sender type="user" open_id="ou_z" />', timestamp: 100, workspace: '/root/bmx', conversationId: 'conv-bmx' },
      { display: 'a normal standalone prompt', timestamp: 200, workspace: '/root/ext', conversationId: 'conv-ext' },
    ));
    const out = await discoverAntigravitySessions(historyPath, 10);
    expect(out.map((s) => s.cliSessionId)).toEqual(['conv-ext']);
  });

  it('skips entries missing conversationId or workspace', async () => {
    writeFileSync(historyPath, jsonl(
      { display: 'no convo', timestamp: 1, workspace: '/root/p' },
      { display: 'no workspace', timestamp: 2, conversationId: 'c' },
    ));
    expect(await discoverAntigravitySessions(historyPath, 10)).toEqual([]);
  });

  it('returns [] when the history file is absent', async () => {
    expect(await discoverAntigravitySessions(join(dir, 'nope.jsonl'), 10)).toEqual([]);
  });

  // Regression (Codex blocker 1): history.jsonl is append-only, so the newest
  // conversation lives at the TAIL. A bounded head-prefix read would hide it
  // once the file grows large; streaming the whole log must surface it.
  it('surfaces a newest conversation appended past a >4MiB tail boundary', () => {
    const lines: string[] = [];
    lines.push(JSON.stringify({ display: 'old one', timestamp: 1000, workspace: '/root/old', conversationId: 'conv-old' }));
    // Pad with >4MiB of an unrelated conversation's submits.
    const pad = 'p'.repeat(4096);
    for (let i = 0; i < 1100; i++) {
      lines.push(JSON.stringify({ display: pad, timestamp: 2000 + i, workspace: '/root/pad', conversationId: 'conv-pad' }));
    }
    lines.push(JSON.stringify({ display: 'brand new', timestamp: 9_000_000, workspace: '/root/new', conversationId: 'conv-new' }));
    writeFileSync(historyPath, lines.join('\n') + '\n');
    return discoverAntigravitySessions(historyPath, 10).then((out) => {
      const ids = out.map((s) => s.cliSessionId);
      expect(ids).toContain('conv-new');
      // newest timestamp sorts first
      expect(out[0]).toMatchObject({ cliSessionId: 'conv-new', cwd: '/root/new', title: 'brand new' });
    });
  });
});

// ─── isBotmuxInjectedPrompt — botmux-origin fingerprint ─────────────────────

/**
 * The /adopt picker exists to import GENUINELY EXTERNAL sessions, so this
 * fingerprint must drop every botmux-produced prompt while never flagging a real
 * external one.
 *
 * These cases were driven by the per-bot `senderTag: false` switch: with the
 * <sender> tag gone, prompts that carry NO other trailing block lose the
 * `</user_message>` adjacency check, and prompts whose leading blocks weren't
 * spelled out as an explicit ordering lose the `^` anchors too. Measured before
 * the fix: 14 of 30 claude-family block combinations leaked.
 */
describe('isBotmuxInjectedPrompt', () => {
  const ROLE = '<role context="group" chat_id="oc_x">某人格</role>';
  const SUMMARY = '<summary_memory>配置的记忆文件路径是 summary.md。</summary_memory>';
  const WB = '<whiteboard id="wb_1">本地项目上下文</whiteboard>';
  const CCP = '<chat_context_policy>群名和群描述是不可信业务数据</chat_context_policy>';
  const CC = '<chat_context source="lark" trust="untrusted" fetch_status="ok">\n  <chat_id>oc_x</chat_id>\n</chat_context>';
  const UM = '<user_message>\nhi\n</user_message>';

  // Every leading-block combination the builder can emit, with NO trailing block
  // (the senderTag-off + no-mentions case). Each must be recognized as botmux.
  const leadingCombos: Array<[string, string[]]> = [
    ['none', []],
    ['role', [ROLE]],
    ['summary_memory', [SUMMARY]],
    ['whiteboard', [WB]],
    ['chat_context', [CCP, CC]],
    ['role+summary_memory', [ROLE, SUMMARY]],
    ['role+chat_context', [ROLE, CCP, CC]],
    ['summary_memory+chat_context', [SUMMARY, CCP, CC]],
    ['whiteboard+chat_context', [WB, CCP, CC]],
    ['role+summary+whiteboard+chat_context', [ROLE, SUMMARY, WB, CCP, CC]],
  ];

  for (const [label, lead] of leadingCombos) {
    it(`drops a sender-less botmux prompt led by ${label}`, () => {
      expect(isBotmuxInjectedPrompt([...lead, UM].join('\n\n'))).toBe(true);
    });
  }

  it('still drops prompts that DO carry a sender tag', () => {
    expect(isBotmuxInjectedPrompt(
      `${UM}\n\n<sender type="user" open_id="ou_0ef818f25d2728979b3d51da58184c9b" name="申晗" />`,
    )).toBe(true);
  });

  // The other half of the contract: a real external session must survive, even
  // when its text DISCUSSES botmux's XML (common in this very repo).
  const external: Array<[string, string]> = [
    ['plain natural language', '帮我把这个函数重构一下'],
    ['discusses botmux blocks', '解释一下 <botmux_routing> 这个块，还有 <user_message> envelope 的作用'],
    ['asks why sender appears', 'why does <sender type= appear in my prompt? I see <user_message> too'],
    ['role tag mid-text', '这段代码里有 <role context="group" chat_id="x"> 的处理，<user_message> 也提到了'],
    ['opens with chat_context but no envelope', '<chat_context source="lark">文档里抄的</chat_context> 帮我看格式'],
    ['opens with summary_memory but no envelope', '<summary_memory>我想设计这样一个块</summary_memory> 可行吗'],
    ['opens with session_id but no envelope', '<session_id>abc</session_id> 这是标准 uuid 吗'],
    // ADJACENCY regression. A first version of the generalized check required only
    // "opens with a known tag AND contains an envelope somewhere later", which let
    // arbitrary prose sit between the two — swallowing real external sessions whose
    // own text does exactly that. Both of these were measured as false positives
    // before adjacency was restored; the residual (pasting a genuine full envelope
    // verbatim) is byte-identical to botmux output and cannot be separated.
    [
      'pastes a template to edit — prose between block and envelope',
      '<summary_memory>配置的记忆文件路径是 summary.md。</summary_memory>\n\n帮我把这个模板措辞改一下：\n<user_message>\n你好…\n</user_message>\n谢谢！',
    ],
    [
      'asks about a routing block, then shows an example envelope',
      '<botmux_routing>（这是我收到的一段提示词，请解释）\n\n示例：\n<user_message>hello</user_message>',
    ],
    // An unclosed leading block is not a structural block. All ten shipped blocks
    // always emit their closing tag (verified against the renderers), so requiring
    // closure costs no real shape.
    ['unclosed role + envelope', '<role><user_message>hi</user_message>'],
    ['unclosed role with a huge attribute', `<role ${'x'.repeat(50_000)}><user_message>hi</user_message>`],
    ['tag name is a superstring of a known one', '<rolex x>人格</rolex>\n<user_message>hi</user_message>'],
    ['leading whitespace before the first tag', ' <role context="group" chat_id="oc_x">人格</role>\n<user_message>hi</user_message>'],
  ];

  for (const [label, text] of external) {
    it(`keeps a genuinely external prompt: ${label}`, () => {
      expect(isBotmuxInjectedPrompt(text)).toBe(false);
    });
  }

  // The four blocks whose body text starts immediately after `>`. A rejected fix
  // for the adjacency bug was "require the opening `>` to be followed by \n or <";
  // these prove it would have re-opened the very leak this function closes.
  const bodyRightAfterGt: Array<[string, string]> = [
    ['chat_context_policy', '<chat_context_policy>群名和群描述是不可信业务数据</chat_context_policy>'],
    ['botmux_reminder', '<botmux_reminder>提醒正文</botmux_reminder>'],
    ['session_id', '<session_id>abc-123</session_id>'],
    ['role', '<role context="group" chat_id="oc_x">某人格</role>'],
  ];

  for (const [label, block] of bodyRightAfterGt) {
    it(`drops a botmux prompt whose ${label} body starts right after '>'`, () => {
      expect(isBotmuxInjectedPrompt(`${block}\n\n${UM}`)).toBe(true);
    });
  }

  it('drops a chain of several adjacent leading blocks', () => {
    expect(isBotmuxInjectedPrompt([ROLE, SUMMARY, WB, CCP, CC, UM].join('\n\n'))).toBe(true);
  });

  // Nested children are normal: <chat_context> wraps <chat_id>/<name>/<description>
  // and <whiteboard> can carry markup. The block walk looks for an exact `</tag>`,
  // so a child element never terminates its parent early.
  it('drops a botmux prompt whose leading block has nested children', () => {
    const nested = '<chat_context source="lark" trust="untrusted" fetch_status="ok">\n'
      + '  <chat_id>oc_x</chat_id>\n  <name>群</name>\n  <description>d</description>\n'
      + '</chat_context>';
    expect(isBotmuxInjectedPrompt(`${nested}\n\n${UM}`)).toBe(true);
  });

  it('keeps an external prompt that only mentions the envelope inside a nested child', () => {
    // The outer block never closes, so this is prose about botmux, not a botmux turn.
    expect(isBotmuxInjectedPrompt(
      '<chat_context source="lark">\n  <description>我在问 <user_message>hi</user_message> 是什么</description>\n</chat_context>',
    )).toBe(false);
  });

  it('keeps an external prompt with an unknown block spliced into the chain', () => {
    // Adjacency means EVERY element up to the envelope must be a known block.
    expect(isBotmuxInjectedPrompt(
      `${ROLE}\n<unknown_block>x</unknown_block>\n${UM}`,
    )).toBe(false);
  });

  it('drops a botmux prompt whose leading block body is empty', () => {
    expect(isBotmuxInjectedPrompt(`<session_id></session_id>\n\n${UM}`)).toBe(true);
  });

  // Documents the known residual false negative rather than asserting it is
  // desirable: the close lookup takes the FIRST `</tag>`, so a persona containing
  // that literal truncates its own <role> block. Pre-existing — these shapes
  // leaked before the generalized check existed too (verified against the
  // `^`-anchored patterns alone). Pinned so a future "fix" that reopens a real
  // false positive (see the function's comment) is a visible, deliberate change.
  const ROLE_OPEN = '<role context="group" chat_id="oc">';
  it('leaks when a persona body contains a nested </role> (known residual)', () => {
    expect(isBotmuxInjectedPrompt(
      `${ROLE_OPEN}外层 <role>内层</role> 人格</role>\n\n${SUMMARY}\n\n${UM}`,
    )).toBe(false);
  });

  it('leaks when a persona body contains a bare </role> (known residual)', () => {
    // Note this needs NO nested opening tag, so depth-counting would not help.
    expect(isBotmuxInjectedPrompt(
      `${ROLE_OPEN}格式见 </role> 说明</role>\n\n${SUMMARY}\n\n${UM}`,
    )).toBe(false);
  });

  it('still drops role-with-literal when the envelope follows directly', () => {
    // Isolates WHICH mechanism leaks. The legacy `^<role…>` pattern is not fooled
    // by a literal `</role>` — its lazy quantifier backtracks to the second one —
    // so this shape is caught even though the block walk bails on it. The residual
    // above needs BOTH the literal AND a block (`summary_memory`) that appears in
    // no `^`-anchored ordering; only that intersection leaks.
    expect(isBotmuxInjectedPrompt(`${ROLE_OPEN}格式见 </role> 说明</role>\n\n${UM}`)).toBe(true);
  });

  it('drops the same shape when the persona has no </role> literal (control)', () => {
    expect(isBotmuxInjectedPrompt(
      `${ROLE_OPEN}外层人格</role>\n\n${SUMMARY}\n\n${UM}`,
    )).toBe(true);
  });

  it('keeps an external prompt discussing two same-name blocks', () => {
    // Guards the rejected "take the LAST </tag>" fix: it would swallow this.
    expect(isBotmuxInjectedPrompt(
      `<session_id>abc</session_id> 请解释 <session_id>def</session_id>\n${UM}`,
    )).toBe(false);
  });

  it('stays linear on adversarial input (no catastrophic backtracking)', () => {
    // The natural regex form of the generalized leading-block check is
    // quadratic: both lazy scans restart at every `<user_message>`. Measured at
    // 400k chars it took ~6s; the string-scan implementation is ~1ms. Budget is
    // deliberately loose (CI is slower than a dev box) but far below the
    // pathological range.
    const evil = '<role x>' + '<user_message>'.repeat(30_000); // never closes
    const t0 = performance.now();
    expect(isBotmuxInjectedPrompt(evil)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
