/**
 * Unit tests for Grok updates.jsonl drain + session discovery helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, existsSync,
  openSync, closeSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  drainGrokUpdates,
  matchGrokPromptAppend,
  discoverGrokSessions,
  findGrokSessionByPid,
  grokSessionDirExists,
  grokSessionIdFromPath,
} from '../src/services/grok-transcript.js';
import {
  encodeGrokCwd,
  grokPromptHistoryPath,
  resolveGrokCwdBucketDir,
} from '../src/services/grok-paths.js';

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

function turnDone(sessionId: string, eventId: string, ts = 1_000_200, stopReason = 'end_turn') {
  return {
    timestamp: ts,
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        stop_reason: stopReason,
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
    expect(r.events[1]).toMatchObject({
      kind: 'assistant_final', text: 'Hi there', sourceSessionId: sid, terminalStatus: 'completed',
    });
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

  it('emits an empty completed terminal without leaking narration when no post-tool final exists', () => {
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
    // Prefer empty over posting mid-turn chatter as the Lark fallback, but the
    // authoritative boundary must still release an exact durable turn.
    expect(r.events.filter((e) => e.kind === 'assistant_final')).toEqual([
      expect.objectContaining({
        kind: 'assistant_final', text: '', sourceSessionId: sid, terminalStatus: 'completed',
      }),
    ]);
  });

  it.each([
    ['error', 'failed', 'grok_turn_error'],
    ['cancelled', 'failed', 'grok_turn_cancelled'],
    ['future reason', 'failed', 'grok_stop_reason:future_reason'],
  ] as const)('maps %s turn_completed to %s even with an empty final', (reason, status, errorCode) => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writeUpdates(sid, '/tmp/proj', [
      userChunk(sid, 'q', 'e1'),
      turnDone(sid, 'e2', 1_000_200, reason),
    ]);

    const r = drainGrokUpdates(path, 0);

    expect(r.events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'q', sourceSessionId: sid }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: '',
        sourceSessionId: sid,
        terminalStatus: status,
        terminalErrorCode: errorCode,
      }),
    ]);
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

  it('does not advance offset on a pure partial-line window (no trailing \\n yet)', () => {
    // Grok mid-flush of a long JSONL line: poll sees bytes but no newline.
    // Advancing by 1 would desync the next poll and drop the finished event.
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const dir = join(ROOT, 'sessions', encodeURIComponent('/tmp/proj'), sid);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'updates.jsonl');
    const half = JSON.stringify(userChunk(sid, 'hello world', 'e1')).slice(0, 40);
    writeFileSync(path, half); // no trailing \n
    const r1 = drainGrokUpdates(path, 0);
    expect(r1.events).toHaveLength(0);
    expect(r1.newOffset).toBe(0);
    expect(r1.pendingTail).toBe(half);

    // Finish the line; next drain from the same offset must see the full event.
    writeFileSync(path, JSON.stringify(userChunk(sid, 'hello world', 'e1')) + '\n');
    const r2 = drainGrokUpdates(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]).toMatchObject({ kind: 'user', text: 'hello world' });
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

  it('does not cross-claim when two sessions append the same prompt (preferSessionId)', () => {
    const sidA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const sidB = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const path = writePromptHistory('/tmp/shared-proj', []);
    const prompt = '继续';
    // Worker A and B both submit the same text into the shared cwd bucket.
    appendFileSync(path, JSON.stringify(promptHistoryLine(sidA, prompt)) + '\n');
    appendFileSync(path, JSON.stringify(promptHistoryLine(sidB, prompt)) + '\n');

    // Without binding: ambiguous → fail closed (never hand B's sid to A).
    expect(matchGrokPromptAppend(path, 0, prompt).found).toBe(false);

    // With prefer: each worker claims only its own line.
    expect(matchGrokPromptAppend(path, 0, prompt, { preferSessionId: sidA }))
      .toEqual({ found: true, cliSessionId: sidA });
    expect(matchGrokPromptAppend(path, 0, prompt, { preferSessionId: sidB }))
      .toEqual({ found: true, cliSessionId: sidB });

    // Prefer a sid that has not appended yet → not found (keep polling).
    expect(matchGrokPromptAppend(path, 0, prompt, {
      preferSessionId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }).found).toBe(false);
  });
});

describe('resolveGrokCwdBucketDir / hashed buckets', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('prefers the normal encoded bucket when present', () => {
    const cwd = '/tmp/short-proj';
    const encoded = encodeGrokCwd(cwd);
    mkdirSync(join(ROOT, 'sessions', encoded), { recursive: true });
    expect(resolveGrokCwdBucketDir(cwd)).toBe(join(ROOT, 'sessions', encoded));
  });

  it('locates a hashed bucket via .cwd when encoded name would exceed 255 bytes', () => {
    // CJK path: percent-encoding balloons past 255 bytes easily.
    const cwd = '/tmp/' + '测'.repeat(90);
    expect(Buffer.byteLength(encodeGrokCwd(cwd), 'utf8')).toBeGreaterThan(255);

    const hashBucket = 'ce-shi-a1b2c3d4'; // fake slug+hash; only .cwd content matters
    const bucketDir = join(ROOT, 'sessions', hashBucket);
    mkdirSync(bucketDir, { recursive: true });
    writeFileSync(join(bucketDir, '.cwd'), cwd + '\n');
    writeFileSync(join(bucketDir, 'prompt_history.jsonl'), '');

    expect(resolveGrokCwdBucketDir(cwd)).toBe(bucketDir);
    // prompt_history must resolve through the hashed bucket — not the
    // non-existent encoded path that would ENAMETOOLONG / miss the file.
    expect(grokPromptHistoryPath(cwd)).toBe(join(bucketDir, 'prompt_history.jsonl'));
    expect(existsSync(grokPromptHistoryPath(cwd))).toBe(true);
  });

  it('does not bind a hashed bucket whose .cwd points at a different path', () => {
    const cwd = '/tmp/' + '路'.repeat(90);
    const other = '/tmp/other-long-' + '径'.repeat(80);
    const hashBucket = 'other-hash-ffff';
    mkdirSync(join(ROOT, 'sessions', hashBucket), { recursive: true });
    writeFileSync(join(ROOT, 'sessions', hashBucket, '.cwd'), other);
    // No matching bucket → fall back to preferred encoded path (may not exist).
    expect(resolveGrokCwdBucketDir(cwd)).toBe(join(ROOT, 'sessions', encodeGrokCwd(cwd)));
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

describe.skipIf(process.platform !== 'linux')('findGrokSessionByPid rotation', () => {
  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('prefers the newest open updates stream when /new briefly retains both sessions', () => {
    const oldSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const newSid = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const oldPath = writeUpdates(oldSid, '/tmp/proj', [userChunk(oldSid, 'old', 'e1')]);
    const newPath = writeUpdates(newSid, '/tmp/proj', [userChunk(newSid, 'new', 'e2')]);
    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-01-01T00:00:05Z');
    utimesSync(oldPath, oldTime, oldTime);
    utimesSync(newPath, newTime, newTime);
    const oldFd = openSync(oldPath, 'r');
    const newFd = openSync(newPath, 'r');
    try {
      expect(findGrokSessionByPid(process.pid)).toEqual({
        sessionId: newSid,
        updatesPath: newPath,
      });
    } finally {
      closeSync(newFd);
      closeSync(oldFd);
    }
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

  it('keeps external prompts that merely discuss botmux tags (structural filter only)', async () => {
    const discuss = '33333333-3333-4333-8333-333333333333';
    // Real botmux envelope: whole turn IS the structural wrapper.
    const botmuxReal = '44444444-4444-4444-8444-444444444444';
    writeUpdates(discuss, '/tmp/c', [
      userChunk(discuss, 'explain why <user_message>…</user_message> and <botmux_routing> appear in the transcript', 'e1'),
    ]);
    writeUpdates(botmuxReal, '/tmp/d', [
      userChunk(
        botmuxReal,
        '<user_message>\nplease review\n</user_message>\n\n<sender type="user" open_id="ou_0123456789abcdef0123456789abcdef" />',
        'e1',
      ),
    ]);
    const out = await discoverGrokSessions(10);
    expect(out.map((s) => s.cliSessionId)).toContain(discuss);
    expect(out.map((s) => s.cliSessionId)).not.toContain(botmuxReal);
  });
});
