/**
 * Pi transcript discovery when a session moves to another cwd, and the record
 * shapes Pi 1.3.0 writes.
 *
 * Incident (2026-10-21): review worktrees were deleted, the sessions
 * cold-resumed in `/root`, and Pi — whose `--session-id` lookup only searches
 * the CURRENT cwd's session directory — started a new file with the same id
 * under `--root--`. Discovery still returned the old file under the deleted
 * worktree's directory (our directory encoding never matched Pi's, so the
 * cwd-first lookup always fell through to a tree walk), the bridge pinned a
 * file Pi never wrote again, and every final of those sessions was lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  drainPiTranscript,
  findPiTranscriptBySessionId,
  piSessionDirName,
  resetPiPendingTurnState,
} from '../src/services/pi-transcript.js';
import { PI_TURN_BOUNDARY_CUSTOM_TYPE } from '../src/adapters/cli/pi-turn-boundary-extension.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

const ROOT = join(tmpdir(), `botmux-pi-locate-test-${process.pid}`);
const SESSIONS = join(ROOT, 'sessions');
const SID = '532763c5-4edc-4a44-9f10-3885639207f1';

function writeSession(dirName: string, file: string, rows: object[]): string {
  const dir = join(SESSIONS, dirName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

const header = (cwd: string, timestamp = '2026-10-20T17:03:23.621Z') => (
  { type: 'session', version: 3, id: SID, timestamp, cwd }
);

/** One review turn exactly as Pi 1.3.0 persisted it on 2026-10-21 (trimmed
 *  text): the v3 header with cwd, model/thinking changes, our extension's
 *  declaration marker, the persisted system prompt (`role:"system"`, string
 *  content + `sections`), a tool step, a provider error that Pi retried after
 *  writing a `context_edit` that strips it from context, and the final answer
 *  closed by the settle marker. */
function pi130Turn(cwd: string, prompt: string, answer: string): object[] {
  return [
    header(cwd),
    { type: 'model_change', id: 'be6e9421', parentId: null, timestamp: '2026-10-20T17:03:23.914Z', provider: 'super-relay', modelId: 'opensource/deepseek_v4_1_flash' },
    { type: 'thinking_level_change', id: '85a122a2', parentId: 'be6e9421', timestamp: '2026-10-20T17:03:23.914Z', thinkingLevel: 'high' },
    { type: 'custom', customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: null }, id: '97ae3457', parentId: '85a122a2', timestamp: '2026-10-20T17:03:24.104Z' },
    { type: 'message', id: 'f29c322a', parentId: '97ae3457', timestamp: '2026-10-20T17:03:24.171Z', message: { role: 'system', content: '', sections: { preamble: 'You are an expert coding assistant operating inside pi.' } } },
    { type: 'message', id: 'u1', parentId: 'f29c322a', timestamp: '2026-10-20T19:04:46.526Z', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-20T19:04:55.000Z', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'check the head' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'git log -1' } }] } },
    { type: 'message', id: 't1', parentId: 'a1', timestamp: '2026-10-20T19:04:55.100Z', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: '64b84e46 fix' }] } },
    { type: 'message', id: '6feeddba', parentId: 't1', timestamp: '2026-10-20T19:05:30.000Z', message: { role: 'assistant', stopReason: 'error', errorMessage: 'terminated', content: [{ type: 'thinking', thinking: '…' }] } },
    { type: 'context_edit', id: 'ce1', parentId: '6feeddba', timestamp: '2026-10-20T19:05:30.008Z', targetId: '6feeddba', replacement: null },
    { type: 'message', id: 'a2', parentId: 'ce1', timestamp: '2026-10-20T19:17:02.438Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'done' }, { type: 'text', text: answer }] } },
    { type: 'custom', customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: 'stop' }, id: 'm2', parentId: 'a2', timestamp: '2026-10-20T19:17:02.438Z' },
  ];
}

beforeEach(() => { rmSync(ROOT, { recursive: true, force: true }); resetPiPendingTurnState(); });
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); resetPiPendingTurnState(); });

describe('piSessionDirName mirrors Pi getDefaultSessionDirPath', () => {
  it.each([
    ['/root', '--root--'],
    ['/root/iserver/botmux-wt-botmux-claude-review-pr-1809-cd', '--root-iserver-botmux-wt-botmux-claude-review-pr-1809-cd--'],
    ['/', '----'],
    ['/root/iserver/', '--root-iserver--'],
  ])('%s → %s', (cwd, dir) => {
    expect(piSessionDirName(cwd)).toBe(dir);
  });
});

describe('findPiTranscriptBySessionId after the session moved to another cwd', () => {
  const oldCwd = '/root/iserver/botmux-wt-botmux-claude-review-pr-1809-cd';

  it('does not return the stale transcript of the old cwd before Pi creates the new one', () => {
    const newCwd = join(ROOT, 'home');
    mkdirSync(newCwd, { recursive: true });
    writeSession(piSessionDirName(oldCwd), `2026-10-12T01-33-02-359Z_${SID}.jsonl`, [header(oldCwd, '2026-10-12T01:33:02.359Z')]);

    // The window the incident fell into: the worker looks the session up at
    // spawn, a moment before Pi writes its new file. Answering with the old
    // file pinned the bridge to it for the life of the process.
    expect(findPiTranscriptBySessionId(SID, newCwd, SESSIONS)).toBeUndefined();

    const fresh = writeSession(piSessionDirName(newCwd), `2026-10-20T17-03-23-621Z_${SID}.jsonl`, [header(newCwd)]);
    expect(findPiTranscriptBySessionId(SID, newCwd, SESSIONS)).toBe(fresh);
  });

  it('still resumes the existing transcript when the cwd did not change', () => {
    const cwd = join(ROOT, 'wt');
    mkdirSync(cwd, { recursive: true });
    const path = writeSession(piSessionDirName(cwd), `2026-10-12T01-33-02-359Z_${SID}.jsonl`, [header(cwd)]);
    writeSession(piSessionDirName('/somewhere/else'), `2026-10-01T00-00-00-000Z_${SID}.jsonl`, [header('/somewhere/else')]);
    expect(findPiTranscriptBySessionId(SID, cwd, SESSIONS)).toBe(path);
  });

  it('finds the transcript Pi filed under the resolved path of a symlinked working dir', () => {
    const real = join(ROOT, 'real-wt');
    const link = join(ROOT, 'link-wt');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const path = writeSession(piSessionDirName(real), `2026-10-20T00-00-00-000Z_${SID}.jsonl`, [header(real)]);
    expect(findPiTranscriptBySessionId(SID, link, SESSIONS)).toBe(path);
  });

  it('keeps the tree walk as a safety net, but only for a header naming the same cwd', () => {
    const cwd = join(ROOT, 'wt');
    mkdirSync(cwd, { recursive: true });
    const foreign = writeSession('--layout-we-do-not-mirror-a--', `a_${SID}.jsonl`, [header('/other/cwd')]);
    expect(findPiTranscriptBySessionId(SID, cwd, SESSIONS)).toBeUndefined();
    const own = writeSession('--layout-we-do-not-mirror-b--', `b_${SID}.jsonl`, [header(cwd)]);
    expect(findPiTranscriptBySessionId(SID, cwd, SESSIONS)).toBe(own);
    // Without a cwd there is nothing to compare against: first match, as before.
    expect([foreign, own]).toContain(findPiTranscriptBySessionId(SID, undefined, SESSIONS));
  });
});

describe('findPiTranscriptBySessionId: header longer than one read block', () => {
  it('reads the whole first line when judging a fallback candidate', () => {
    const cwd = join(ROOT, 'wt');
    mkdirSync(cwd, { recursive: true });
    // Pi itself scans up to 1 MiB for the header; a bulky first line must not
    // make a foreign transcript look "unknown" and slip through.
    const padding = 'x'.repeat(200_000);
    writeSession('--layout-we-do-not-mirror-a--', `a_${SID}.jsonl`, [{ ...header('/other/cwd'), padding }]);
    expect(findPiTranscriptBySessionId(SID, cwd, SESSIONS)).toBeUndefined();
    const own = writeSession('--layout-we-do-not-mirror-b--', `b_${SID}.jsonl`, [{ ...header(cwd), padding }]);
    expect(findPiTranscriptBySessionId(SID, cwd, SESSIONS)).toBe(own);
  });
});

describe('Pi 1.3.0 transcript: one turn read by the late-attached bridge', () => {
  it('drains the new record kinds without stray events and closes the turn once', () => {
    const answer = '已跑完，结论先给：**head 64b84e46 可以直接合**。';
    const path = writeSession('--root--', `2026-10-20T17-03-23-621Z_${SID}.jsonl`, pi130Turn('/root', '@Pure(pi) #1809 复审', answer));
    const events = drainPiTranscript(path, 0).events;
    // The system prompt record, model/thinking changes, context_edit and the
    // markers are not turn events; the retried error is not a failure.
    expect(events.filter(ev => ev.kind !== 'cot').map(ev => ev.kind)).toEqual(['user', 'assistant_final']);
    const final = events.find(ev => ev.kind === 'assistant_final')!;
    expect(final.text).toBe(answer);
    expect(final.terminalStatus).toBeUndefined();
    expect(final.sourceSessionId).toBe(SID);
  });

  it('attributes the final to the Lark turn marked before the file existed', () => {
    const prompt = '@Pure(pi) #1809 你上一轮复审跑到一半报了 super-relay 鉴权失败，没给结论。接着做完就行';
    const answer = '已跑完，结论先给：**head 64b84e46 可以直接合**。';
    const queue = new CodexBridgeQueue();
    const markedAt = Date.parse('2026-10-20T19:04:46.254Z');
    queue.mark('om_x100b624ffa1d', prompt, markedAt);

    // Late attach reads the new file from offset 0 (worker `fresh-empty`).
    const path = writeSession('--root--', `2026-10-20T17-03-23-621Z_${SID}.jsonl`, pi130Turn('/root', prompt, answer));
    queue.ingest(drainPiTranscript(path, 0).events);
    const ready = queue.drainEmittable();
    expect(ready.map(turn => [turn.turnId, turn.finalText])).toEqual([['om_x100b624ffa1d', answer]]);
  });
});
