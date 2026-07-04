import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverClaudeFamilySessions,
  discoverRolloutSessions,
  discoverAntigravitySessions,
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

describe('discoverClaudeFamilySessions', () => {
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

  it('skips sidechain entries and slash-command meta lines when picking a title', async () => {
    writeSession('-root-proj', 'bbbb2222-0000-0000-0000-000000000002', [
      { type: 'user', cwd: '/root/proj', isSidechain: true, message: { role: 'user', content: 'subagent noise' } },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'the real first question' } },
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

  // Regression (whiteboard /adopt leak): Claude-family CLIs with
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
  // <custom>`) bound to a Claude-family + role-less session also opens with
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
