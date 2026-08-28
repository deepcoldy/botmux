import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverClaudeFamilySessions,
  discoverRolloutSessions,
  discoverAntigravitySessions,
  isBotmuxInjectedPrompt,
} from '../src/services/resumable-session-discovery.js';

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
