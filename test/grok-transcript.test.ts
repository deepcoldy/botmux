/**
 * Unit tests for Grok updates.jsonl drain + session discovery helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  drainGrokUpdates,
  matchGrokPromptAppend,
  discoverGrokSessions,
  grokSessionDirExists,
  grokSessionIdFromPath,
} from '../src/services/grok-transcript.js';

const ROOT = join(tmpdir(), `botmux-grok-test-${process.pid}`);

function writeUpdates(sessionId: string, cwd: string, lines: object[]): string {
  const bucket = encodeURIComponent(cwd);
  const dir = join(ROOT, 'sessions', bucket, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'updates.jsonl');
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    info: { id: sessionId, cwd },
    generated_title: 'Test session',
    updated_at: new Date().toISOString(),
  }));
  return path;
}

function userChunk(sessionId: string, text: string, eventId: string, ts = 1_000_000) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function agentChunk(sessionId: string, text: string, eventId: string, ts = 1_000_100) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function turnDone(sessionId: string, eventId: string, ts = 1_000_200) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        stop_reason: 'end_turn',
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function toolCall(sessionId: string, eventId: string, ts = 1_000_150) {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `call-${eventId}`,
        title: 'run_terminal_command',
        _meta: { eventId, agentTimestampMs: ts },
      },
    },
  };
}

function promptHistoryLine(sessionId: string, prompt: string, ts = '2026-07-12T10:00:00Z') {
  return { timestamp: ts, session_id: sessionId, prompt, is_bash: false };
}

describe('drainGrokUpdates', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('emits user + assistant_final for a completed turn', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'hello world', 'e1'),
      agentChunk(sid, 'Hi ', 'e2'),
      agentChunk(sid, 'there', 'e3'),
      turnDone(sid, 'e4'),
    ]);
    const r = drainGrokUpdates(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ kind: 'user', text: 'hello world', sourceSessionId: sid });
    expect(r.events[1]).toMatchObject({ kind: 'assistant_final', text: 'Hi there', sourceSessionId: sid });
  });

  it('rewinds offset when turn is still open (no turn_completed yet)', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q1', 'e1'),
      agentChunk(sid, 'partial', 'e2'),
    ]);
    const r = drainGrokUpdates(path, 0);
    // user emitted; agent buffered → offset rewound to first agent line
    expect(r.events.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
    expect(r.newOffset).toBeGreaterThan(0);
    // re-drain from newOffset still has no final
    const r2 = drainGrokUpdates(path, r.newOffset);
    expect(r2.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
  });

  it('emits only the LAST agent-message group as assistant_final (codex final_answer parity)', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'do the thing', 'e1'),
      // Progress narration before a tool call — must NOT reach Lark.
      agentChunk(sid, '先跑一下测试。', 'e2'),
      toolCall(sid, 'e3'),
      // Another narration group between tools.
      agentChunk(sid, '测试通过，', 'e4'),
      agentChunk(sid, '开始改代码。', 'e5'),
      toolCall(sid, 'e6'),
      // Final answer group (streams in two chunks).
      agentChunk(sid, '改完了：', 'e7'),
      agentChunk(sid, '一切正常。', 'e8'),
      turnDone(sid, 'e9'),
    ]);
    const r = drainGrokUpdates(path, 0);
    const finals = r.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('改完了：一切正常。');
  });

  it('still converges when a tool-only stretch follows a narration group', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'narration', 'e2'),
      toolCall(sid, 'e3'),
      toolCall(sid, 'e4'),
    ]);
    // Narration is dropped on the first tool_call; offset advances past the
    // tool stretch (no rewind pin) so long tool runs stay cheap to poll.
    const r1 = drainGrokUpdates(path, 0);
    expect(r1.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
    expect(r1.newOffset).toBeGreaterThan(0);
    // Turn completes with a fresh final group appended later.
    appendFileSync(path, JSON.stringify(agentChunk(sid, 'final', 'e5', 1_000_180)) + '\n');
    appendFileSync(path, JSON.stringify(turnDone(sid, 'e6')) + '\n');
    const r2 = drainGrokUpdates(path, r1.newOffset);
    const finals = r2.events.filter((e) => e.kind === 'assistant_final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('final');
  });

  it('does not emit narration when turn_completed has no post-tool agent group', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'looking at files…', 'e2'),
      toolCall(sid, 'e3'),
      toolCall(sid, 'e4'),
      // Model ends the turn without a further agent_message_chunk.
      turnDone(sid, 'e5'),
    ]);
    const r = drainGrokUpdates(path, 0);
    expect(r.events.filter((e) => e.kind === 'user')).toHaveLength(1);
    // Prefer empty over posting mid-turn chatter as the Lark fallback.
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toHaveLength(0);
  });

  it('does not rewind across a long tool stretch after dropping narration', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const lines: object[] = [
      userChunk(sid, 'q', 'e1'),
      agentChunk(sid, 'narration', 'e2'),
    ];
    // Simulate a heavy tool phase (real turns can have hundreds of updates).
    for (let i = 0; i < 50; i++) lines.push(toolCall(sid, `t${i}`, 1_000_150 + i));
    const path = writeUpdates(sid, '/tmp/proj', lines);
    const r1 = drainGrokUpdates(path, 0);
    // Offset should sit at EOF (no open agent group to pin).
    const size = statSync(path).size;
    expect(r1.newOffset).toBe(size);
    // Incremental poll from that offset sees only the new final group.
    appendFileSync(path, JSON.stringify(agentChunk(sid, 'done', 'f1', 1_000_300)) + '\n');
    appendFileSync(path, JSON.stringify(turnDone(sid, 'f2', 1_000_301)) + '\n');
    const r2 = drainGrokUpdates(path, r1.newOffset);
    expect(r2.events.filter((e) => e.kind === 'assistant_final').map((e) => e.text)).toEqual(['done']);
  });
});

describe('matchGrokPromptAppend', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  function writePromptHistory(cwd: string, lines: object[]): string {
    const dir = join(ROOT, 'sessions', encodeURIComponent(cwd));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'prompt_history.jsonl');
    writeFileSync(path, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return path;
  }

  it('finds a newly appended submit and returns its session id', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writePromptHistory('/tmp/proj', [
      promptHistoryLine(sid, 'old prompt'),
    ]);
    const base = statSync(path).size;
    appendFileSync(path, JSON.stringify(promptHistoryLine(sid, 'fresh botmux prompt xyz')) + '\n');
    const hit = matchGrokPromptAppend(path, base, 'fresh botmux prompt xyz');
    expect(hit).toEqual({ found: true, cliSessionId: sid });
    // Lines before the baseline must not match.
    expect(matchGrokPromptAppend(path, base, 'old prompt').found).toBe(false);
  });

  it('matches multi-line prompts verbatim (composer soft newlines)', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writePromptHistory('/tmp/proj', []);
    const content = 'first line\nsecond line';
    appendFileSync(path, JSON.stringify(promptHistoryLine(sid, content)) + '\n');
    expect(matchGrokPromptAppend(path, 0, content).found).toBe(true);
    expect(matchGrokPromptAppend(path, 0, 'first line\r\nsecond line').found).toBe(true);
    expect(matchGrokPromptAppend(path, 0, 'unrelated').found).toBe(false);
  });
});

describe('grokSessionDirExists / grokSessionIdFromPath', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('detects an existing session dir in the cwd bucket and in other buckets', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    mkdirSync(join(ROOT, 'sessions', encodeURIComponent('/tmp/proj'), sid), { recursive: true });
    expect(grokSessionDirExists(sid, '/tmp/proj')).toBe(true);
    expect(grokSessionDirExists(sid, '/tmp/other')).toBe(true); // cross-bucket scan
    expect(grokSessionDirExists('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', '/tmp/proj')).toBe(false);
    expect(grokSessionDirExists('not-a-uuid', '/tmp/proj')).toBe(false);
  });

  it('extracts the session id from an updates.jsonl path under a custom GROK_HOME', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const p = join(ROOT, 'sessions', encodeURIComponent('/tmp/proj'), sid, 'updates.jsonl');
    expect(grokSessionIdFromPath(p)).toBe(sid);
    expect(grokSessionIdFromPath(`/home/u/.grok/sessions/%2Ftmp/${sid}/updates.jsonl`)).toBe(sid);
    expect(grokSessionIdFromPath('/somewhere/else.jsonl')).toBeUndefined();
  });
});

describe('discoverGrokSessions', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('lists external sessions and hides botmux-injected ones', async () => {
    const external = '11111111-1111-4111-8111-111111111111';
    const botmux = '22222222-2222-4222-8222-222222222222';
    writeUpdates(external, '/tmp/a', [
      userChunk(external, 'raw external prompt', 'e1'),
      agentChunk(external, 'ok', 'e2'),
      turnDone(external, 'e3'),
    ]);
    writeUpdates(botmux, '/tmp/b', [
      userChunk(botmux, '<user_message>from lark</user_message><botmux_routing>x</botmux_routing>', 'e1'),
    ]);
    const out = await discoverGrokSessions(10);
    expect(out.map((s) => s.cliSessionId)).toContain(external);
    expect(out.map((s) => s.cliSessionId)).not.toContain(botmux);
    expect(out.find((s) => s.cliSessionId === external)?.cwd).toBe('/tmp/a');
  });
});
