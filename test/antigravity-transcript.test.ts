import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTIGRAVITY_TRUNCATED_REPLY_NOTICE,
  drainAntigravityTranscript,
  antigravityTranscriptPath,
  mapAntigravityCompactOffsetToFull,
  resolveAntigravityTranscriptPath,
  unwrapAntigravityUserInput,
  type AntigravityTranscriptState,
} from '../src/services/antigravity-transcript.js';
import { resolveFileBridgePath } from '../src/services/file-bridge-path.js';
import { resolveSessionTranscriptPath, __resetTranscriptResolverCacheForTest } from '../src/services/transcript-resolver.js';
import { bridgeSpecFor } from '../src/adapters/cli/registry.js';
import { jsonl, writeAntigravityTwoLogs } from './helpers/antigravity-two-logs.js';

let dir: string;
let path: string;

function line(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

const USER_REQUEST = '帮我看下这个报错';

function userRecord(text: string, createdAt = '2026-09-29T03:00:00Z') {
  return {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: createdAt,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-29.\n</ADDITIONAL_METADATA>`,
  };
}

/** Continuing step: tool_calls present (content optional). */
function plannerStep(opts: { content?: string; toolCalls?: any[]; createdAt?: string; step?: number }) {
  return {
    step_index: opts.step ?? 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: opts.createdAt ?? '2026-09-29T03:00:10Z',
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(opts.toolCalls !== undefined ? { tool_calls: opts.toolCalls } : {}),
  };
}

function toolCall(name: string) {
  return { id: `call-${name}`, name, args: {} };
}

const BG_RUNNING_RECORD = {
  step_index: 100, source: 'MODEL', type: 'GENERIC', status: 'RUNNING',
  content: 'Created At: 2026-09-29T03:00:10-07:00\nTool is running as a background task with task id t-1',
};
const BG_DONE_RECORD = {
  step_index: 101, source: 'MODEL', type: 'GENERIC', status: 'DONE',
  content: 'Created At: 2026-09-29T03:00:10-07:00\nCompleted At: 2026-09-29T03:01:30-07:00\n$ bun run build\n',
};
const BG_SYSTEM_RECORD = {
  step_index: 102, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
  content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] task t-1 finished with result: exited with code 0\n</SYSTEM_MESSAGE>',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'antigravity-transcript-'));
  path = join(dir, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('antigravityTranscriptPath', () => {
  it('builds the brain transcript path and rejects unsafe ids', () => {
    const p = antigravityTranscriptPath('abc-123_X.Y', dir);
    expect(p).toBe(join(dir, 'abc-123_X.Y', '.system_generated', 'logs', 'transcript.jsonl'));
    expect(antigravityTranscriptPath(undefined)).toBeNull();
    expect(antigravityTranscriptPath('')).toBeNull();
    expect(antigravityTranscriptPath('../escape')).toBeNull();
    expect(antigravityTranscriptPath('a/b')).toBeNull();
  });
});

describe('unwrapAntigravityUserInput', () => {
  it('unwraps the USER_REQUEST envelope, dropping ADDITIONAL_METADATA', () => {
    const rec = userRecord(USER_REQUEST);
    expect(unwrapAntigravityUserInput(rec.content)).toBe(USER_REQUEST);
  });

  it('returns raw content when a future build stops wrapping', () => {
    expect(unwrapAntigravityUserInput('plain submitted text')).toBe('plain submitted text');
  });

  it('keeps a literal close tag INSIDE the submitted payload (last marker wins)', () => {
    // The user is asking about the envelope itself: the payload legitimately
    // contains the literal close marker. indexOf would truncate at it and
    // break the turn's fingerprint; the OUTER marker must be used.
    const prompt = '帮我看看这段模板哪里错了：\n</USER_REQUEST>\n少了开头？';
    const content = `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>`;
    expect(unwrapAntigravityUserInput(content)).toBe(prompt);
  });
});

describe('drainAntigravityTranscript', () => {
  it('holds the content-only terminal as provisional until the quiet-tick flush', () => {
    writeFileSync(path, [
      line(userRecord(USER_REQUEST)),
      line(plannerStep({ content: 'Wait for task to complete.', toolCalls: [toolCall('shell')], step: 1 })),
      line({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Created At: ...' }),
      // Empty no-tool-call planner step: model-output error precursor, NOT a final.
      line(plannerStep({ step: 3 })),
      line({ step_index: 4, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', content: 'model output error' }),
      line(plannerStep({ content: '报错原因是 X，已修复。', toolCalls: [toolCall('edit')], step: 5, createdAt: '2026-09-29T03:00:20Z' })),
      line({ step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'tool output' }),
      line(plannerStep({ content: '修好了，重跑即可。', step: 7, createdAt: '2026-09-29T03:00:30Z' })),
      line({ step_index: 8, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE' }),
    ].join(''));

    const r = drainAntigravityTranscript(path, 0);
    // Only the user event is emitted; the final is held (CHECKPOINT does not
    // cancel it).
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.events[0].text).toBe(USER_REQUEST);
    expect(r.events[0].timestampMs).toBe(Date.parse('2026-09-29T03:00:00Z'));
    expect(r.state.provisionalFinal?.text).toBe('修好了，重跑即可。');
    expect(r.state.provisionalFinal?.timestampMs).toBe(Date.parse('2026-09-29T03:00:30Z'));
    expect(r.pendingTail).toBe('');
    expect(r.newOffset).toBe(require('node:fs').statSync(path).size);

    // Quiet-tick flush at a settled offset releases exactly one final.
    const flushed = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(flushed.events.map(e => `${e.kind}:${e.text}`)).toEqual(['assistant_final:修好了，重跑即可。']);
    expect(flushed.state.provisionalFinal).toBeUndefined();
  });

  it('releases the prior held final when the next USER_INPUT arrives', () => {
    writeFileSync(path, line(userRecord('第一问')));
    let r = drainAntigravityTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    const off1 = r.newOffset;

    appendFileSync(path, [
      line(plannerStep({ content: '答案一', step: 1 })),
      line(userRecord('第二问', '2026-09-29T04:00:00Z')),
    ].join(''));
    r = drainAntigravityTranscript(path, off1, r.state);
    expect(r.events.map(e => `${e.kind}:${e.text}`)).toEqual([
      'assistant_final:答案一',
      'user:第二问',
    ]);

    appendFileSync(path, line(plannerStep({ content: '答案二', step: 3, createdAt: '2026-09-29T04:00:05Z' })));
    r = drainAntigravityTranscript(path, r.newOffset, r.state);
    // Turn 2's final is provisional again — held, not emitted.
    expect(r.events).toHaveLength(0);
    expect(r.state.provisionalFinal?.text).toBe('答案二');
  });

  it('cancels a held candidate when the planner wakes and runs more tools (background-task shape)', () => {
    writeFileSync(path, [
      line(userRecord('跑下构建')),
      line(plannerStep({ content: 'Wait for task `build-1` to finish.', toolCalls: [toolCall('shell')], step: 1 })),
      line({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Created At: ...' }),
      // The background shell returns while the TUI is back at the ready
      // marker: this content-only step is the interim narration, which the
      // old drainer mistook for the final.
      line(plannerStep({ content: 'Wait for task `build-1` to finish.', step: 3, createdAt: '2026-09-29T03:00:20Z' })),
      // Task completion wakes the planner (stop-hook/message SYSTEM_MESSAGE)…
      line({ step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
        content: 'Task id "build-1" finished with result: success' }),
      // …and it continues with more tool calls.
      line(plannerStep({ content: 'Build green, checking artifacts.', toolCalls: [toolCall('read')], step: 5, createdAt: '2026-09-29T03:00:25Z' })),
      line({ step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'artifact list' }),
      line(plannerStep({ content: '构建通过，产物已就绪。', step: 7, createdAt: '2026-09-29T03:00:30Z' })),
    ].join(''));

    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    // The interim "Wait…" must NOT survive; only the real final is held.
    expect(r.state.provisionalFinal?.text).toBe('构建通过，产物已就绪。');
  });

  it('cancels a held candidate when a GENERIC tool-output record follows it', () => {
    writeFileSync(path, [
      line(userRecord('q')),
      line(plannerStep({ content: '像是收尾但其实还要收工具结果', step: 1 })),
      line({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'tool result' }),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.state.provisionalFinal).toBeUndefined();
  });

  it('holds a provisional final from a complete EOF object without a trailing newline', () => {
    writeFileSync(path, line(userRecord('问题')));
    let r = drainAntigravityTranscript(path, 0);
    const off = r.newOffset;
    appendFileSync(path, JSON.stringify(plannerStep({ content: '答案', step: 1 }))); // no \n
    r = drainAntigravityTranscript(path, off, r.state);
    expect(r.events).toHaveLength(0);
    expect(r.state.provisionalFinal?.text).toBe('答案');
    expect(r.newOffset).toBe(require('node:fs').statSync(path).size);
    expect(r.pendingTail).toBe('');

    // Half-written next line must stay pending and produce no event.
    appendFileSync(path, '\n{"step_index":2,"type":"PLANNER_RESPONSE","content":"还在写');
    r = drainAntigravityTranscript(path, r.newOffset, r.state);
    expect(r.events).toHaveLength(0);
    expect(r.state.provisionalFinal?.text).toBe('答案');
    expect(r.pendingTail).toContain('还在写');
    expect(r.newOffset).toBe(require('node:fs').statSync(path).size - Buffer.byteLength(r.pendingTail, 'utf8'));
  });

  it('holds a pending background task: the quiet flush is refused until the completion SYSTEM_MESSAGE', () => {
    writeFileSync(path, [
      line(userRecord('跑下构建')),
      line(plannerStep({ content: 'Wait for task `b-1` to finish.', toolCalls: [toolCall('manage_task')], step: 1 })),
      line(BG_RUNNING_RECORD),
      // The TUI is back at the ready composer while the task runs.
      line(plannerStep({ content: 'Wait for task `b-1` to finish.', step: 2, createdAt: '2026-09-29T03:00:11Z' })),
    ].join(''));

    let r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.provisionalFinal?.text).toBe('Wait for task `b-1` to finish.');
    expect(r.state.hasPendingTask).toBe(true);

    // Screen quiet + unchanged offset is NOT enough: the flush must be refused
    // while the transcript proves a task is outstanding.
    r = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(r.events).toHaveLength(0);
    expect(r.state.provisionalFinal?.text).toBe('Wait for task `b-1` to finish.');
    expect(r.state.hasPendingTask).toBe(true);

    // The tool result lands (DONE) — the task is still outstanding until the
    // SYSTEM_MESSAGE wake-up.
    appendFileSync(path, line(BG_DONE_RECORD));
    r = drainAntigravityTranscript(path, r.newOffset, r.state);
    expect(r.events).toHaveLength(0);
    expect(r.state.hasPendingTask).toBe(true);
    expect(r.state.provisionalFinal).toBeUndefined();

    // Wake-up clears the wait; the planner continues with tools, then gives
    // the real final.
    appendFileSync(path, [
      line(BG_SYSTEM_RECORD),
      line(plannerStep({ content: '构建绿了，检查产物。', toolCalls: [toolCall('read')], step: 103, createdAt: '2026-09-29T03:01:31Z' })),
      line(plannerStep({ content: '构建通过，产物已就绪。', step: 104, createdAt: '2026-09-29T03:01:40Z' })),
    ].join(''));
    r = drainAntigravityTranscript(path, r.newOffset, r.state);
    expect(r.events).toHaveLength(0);
    expect(r.state.hasPendingTask).toBeUndefined();
    expect(r.state.provisionalFinal?.text).toBe('构建通过，产物已就绪。');

    // NOW the quiet flush releases the real answer.
    r = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(r.events.map(e => `${e.kind}:${e.text}`)).toEqual(['assistant_final:构建通过，产物已就绪。']);
  });

  it('latches a pending task from a RUNNING background GENERIC even without the manage_task tool name', () => {
    writeFileSync(path, [
      line(userRecord('q')),
      line(plannerStep({ content: '稍等后台任务', step: 1 })),
      line(BG_RUNNING_RECORD),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.state.provisionalFinal?.text).toBe('稍等后台任务');
    expect(r.state.hasPendingTask).toBe(true);
    const flushed = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(flushed.events).toHaveLength(0);
  });

  it('clears a pending task when the planner resumes with a FOREGROUND tool call without any SYSTEM_MESSAGE', () => {
    // Observed in real logs: agy sometimes finishes a background task with
    // only a GENERIC DONE (no SYSTEM_MESSAGE) and immediately continues with
    // an ordinary tool call. Without this clear the real final would be held
    // forever behind hasPendingTask.
    writeFileSync(path, [
      line(userRecord('跑下发布评估')),
      line(plannerStep({ content: 'No tools called; waiting for task notification.', toolCalls: [toolCall('manage_task')], step: 1 })),
      line(BG_DONE_RECORD),
      line(plannerStep({ content: '结果回来了，整理结论。', toolCalls: [toolCall('shell')], step: 103, createdAt: '2026-09-29T03:01:31Z' })),
      line({ step_index: 104, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'git log output' }),
      line(plannerStep({ content: '评估完成，今日无待发版提交。', step: 105, createdAt: '2026-09-29T03:01:40Z' })),
    ].join(''));
    let r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.hasPendingTask).toBeUndefined();
    expect(r.state.provisionalFinal?.text).toBe('评估完成，今日无待发版提交。');
    r = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(r.events.map(e => e.kind)).toEqual(['assistant_final']);
  });

  it('keeps the pending flag across an OUT-OF-ORDER task poll tool_call (real build/review wait shape)', () => {
    // Real logs write the GENERIC RUNNING record and the launch/poll
    // PLANNER_RESPONSE out of step_index order: the RUNNING line lands BEFORE
    // the manage_task/schedule tool_call line even though its step is higher.
    // Clearing pending on every PLANNER tool_call dropped the flag right after
    // it was latched, so the subsequent "Waiting for build" final was flushable
    // ~63% of the time (90 real turns). Only FOREGROUND tools may clear it.
    writeFileSync(path, [
      line(userRecord('跑下构建')),
      line(BG_RUNNING_RECORD),                                   // physical: RUNNING first
      line(plannerStep({ toolCalls: [toolCall('schedule')], step: 1 })), // then the poll call
      line(plannerStep({ content: 'Waiting for `bun run build` to finish.', step: 2, createdAt: '2026-09-29T03:00:11Z' })),
    ].join(''));
    let r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.provisionalFinal?.text).toContain('bun run build');
    expect(r.state.hasPendingTask).toBe(true);
    // A neutral CHECKPOINT arriving later grows the file but must not clear
    // the flag — exercises the trailing (file-grew) flush branch, which must
    // refuse just like the unchanged-offset branch.
    appendFileSync(path, line({ step_index: 200, source: 'MODEL', type: 'CHECKPOINT', status: 'DONE' }));
    r = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(r.events).toHaveLength(0);
    expect(r.state.hasPendingTask).toBe(true);
    expect(r.state.provisionalFinal?.text).toContain('bun run build');
  });

  it('a schedule/manage_task poll call without a prior RUNNING does NOT latch (name alone never sets pending)', () => {
    writeFileSync(path, [
      line(userRecord('q')),
      line(plannerStep({ toolCalls: [toolCall('manage_task')], step: 1 })),
      line(BG_DONE_RECORD),
      line(plannerStep({ content: '同步查完，没有在跑的任务，结论如下。', step: 2, createdAt: '2026-09-29T03:00:20Z' })),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.state.hasPendingTask).toBeUndefined();
    expect(r.state.provisionalFinal?.text).toContain('结论如下');
    const flushed = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(flushed.events.map(e => e.kind)).toEqual(['assistant_final']);
  });

  it('releases the real final when the planner wraps up with foreground tools and NO wake-up SYSTEM_MESSAGE (session 098f4ab3 shape)', () => {
    // The failure mode of "PLANNER tool_calls never clears pending": a task
    // goes RUNNING, the model polls with view_file/manage_task, then produces a
    // substantial final with no completion SYSTEM_MESSAGE and no next user
    // turn. A foreground tool (view_file) must clear pending; later poll-only
    // calls must not re-latch (no new RUNNING), so the real final flushes.
    writeFileSync(path, [
      line(userRecord('做个发版评估')),
      line(BG_RUNNING_RECORD),
      line(plannerStep({ content: 'No tools called; waiting for task notification.', toolCalls: [toolCall('view_file')], step: 46, createdAt: '2026-09-29T03:00:12Z' })),
      line(BG_DONE_RECORD),
      line(plannerStep({ toolCalls: [toolCall('manage_task')], step: 48, createdAt: '2026-09-29T03:00:14Z' })),
      line(plannerStep({ content: 'No tools called; waiting for task notification.', toolCalls: [toolCall('view_file')], step: 50, createdAt: '2026-09-29T03:00:16Z' })),
      line(plannerStep({ content: '已完成发版评估：最新 Tag v3.30.0，待发版 2 个，建议 v3.31.0。', step: 54, createdAt: '2026-09-29T03:01:40Z' })),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.hasPendingTask).toBeUndefined();
    expect(r.state.provisionalFinal?.text).toContain('v3.31.0');
    const flushed = drainAntigravityTranscript(path, r.newOffset, r.state, { flushTrailingFinal: true });
    expect(flushed.events.map(e => `${e.kind}:${e.text}`)).toEqual(['assistant_final:已完成发版评估：最新 Tag v3.30.0，待发版 2 个，建议 v3.31.0。']);
  });

  it('a mixed tool_calls batch (poll tool + any foreground tool) clears pending like a foreground tool', () => {
    writeFileSync(path, [
      line(userRecord('q')),
      line(BG_RUNNING_RECORD),
      line(plannerStep({ toolCalls: [toolCall('manage_task'), toolCall('run_command')], step: 3, createdAt: '2026-09-29T03:00:12Z' })),
      line(plannerStep({ content: '前台命令拿到结果，收尾答复。', step: 4, createdAt: '2026-09-29T03:00:20Z' })),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.state.hasPendingTask).toBeUndefined();
    expect(r.state.provisionalFinal?.text).toContain('收尾答复');
  });

  it('a SYSTEM_MESSAGE alone cancels a candidate and clears the pending flag (no following tools)', () => {
    writeFileSync(path, [
      line(userRecord('q')),
      line(plannerStep({ content: '看似收尾', step: 1 })),
      line(BG_SYSTEM_RECORD),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.provisionalFinal).toBeUndefined();
    expect(r.state.hasPendingTask).toBeUndefined();
  });

  it('newest content-only step wins and replaces the earlier held candidate', () => {
    writeFileSync(path, [
      line(userRecord('q')),
      line(plannerStep({ content: '第一版结论', step: 1 })),
      line(plannerStep({ content: '修正后的结论', step: 2, createdAt: '2026-09-29T03:00:30Z' })),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.provisionalFinal?.text).toBe('修正后的结论');
  });

  it('treats an empty tool_calls array with content as a candidate terminal', () => {
    writeFileSync(path, [
      line(userRecord('问题')),
      line(plannerStep({ content: '中间叙述', toolCalls: [toolCall('shell')], step: 1 })),
      // Defensive: some model/SDK build could emit [] instead of omitting the
      // field on the content-only terminal step.
      line(plannerStep({ content: '最终答案', toolCalls: [], step: 2, createdAt: '2026-09-29T03:00:30Z' })),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
    expect(r.state.provisionalFinal?.text).toBe('最终答案');
  });

  it('ignores non-USER_EXPLICIT user records (MODEL/SYSTEM source) and shrunken files', () => {
    writeFileSync(path, [
      line({ ...userRecord('真用户'), source: 'USER_EXPLICIT' }),
      line({ ...userRecord('模型塞进来的'), source: 'MODEL' }),
      line({ ...userRecord('系统塞进来的'), source: 'SYSTEM' }),
    ].join(''));
    const r1 = drainAntigravityTranscript(path, 0);
    expect(r1.events.map(e => `${e.kind}:${e.text}`)).toEqual(['user:真用户']);

    // Offset past EOF (rotated/replaced file): do not replay from zero.
    const r2 = drainAntigravityTranscript(path, r1.newOffset + 100, r1.state);
    expect(r2.events).toHaveLength(0);
    expect(r2.newOffset).toBe(r1.newOffset + 100);
  });
});

describe('transcript_full.jsonl vs the compact transcript.jsonl', () => {
  const CID = '00000000-0000-4000-8000-000000000025';
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'antigravity-two-logs-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const brainDir = (): string => join(home, '.gemini', 'antigravity-cli', 'brain');

  /** The worker's own path: resolveFileBridgePath → antigravity bridge spec
   *  locate, then the spec's drain with the quiet-tick flush. */
  function harvestFinal(): { path: string; final: string | undefined } {
    const path = resolveFileBridgePath('antigravity', { sessionId: CID });
    expect(path).toBeDefined();
    const spec = bridgeSpecFor('antigravity')!;
    const r = spec.drain(path!, 0, { adoptMode: false, state: undefined, flushTrailingFinal: true });
    return { path: path!, final: r.events.find(e => e.kind === 'assistant_final')?.text };
  }

  it('harvests the complete final reply from the full log, not the head/tail the compact log kept', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    const { path, final } = harvestFinal();
    expect(path).toBe(logs.fullPath);
    expect(final).toBe(logs.finalText);
    expect(final).toContain(logs.middleSentinel);
    expect(final).not.toContain(ANTIGRAVITY_TRUNCATED_REPLY_NOTICE);
  });

  it('leaves the model-facing "truncated" text inside full-log tool records alone', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    // steps 12/13/14 still say "truncated" in the full log: that is what the
    // model itself saw (agy's middle-cut tool output, a printing command), not
    // log truncation — the user turn and final are unaffected.
    const r = drainAntigravityTranscript(logs.fullPath, 0, {}, { flushTrailingFinal: true });
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.events[0].text).toBe(logs.userRequest);
    expect(r.events[1].text).toBe(logs.finalText);
  });

  it('falls back to the compact log without a full one, and says the reply was cut', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID, { withFull: false });
    const { path, final } = harvestFinal();
    expect(path).toBe(logs.compactPath);
    expect(final).toBe(`${logs.compactRecords[25].content}\n\n${ANTIGRAVITY_TRUNCATED_REPLY_NOTICE}`);
    expect(final).not.toContain(logs.middleSentinel);
  });

  it('adds no notice to a compact-log final that was not cut', () => {
    writeFileSync(path, line(userRecord('问题')) + line(plannerStep({ content: '短答案', step: 1 })));
    const r = drainAntigravityTranscript(path, 0, {}, { flushTrailingFinal: true });
    expect(r.events.at(-1)?.text).toBe('短答案');
  });

  it('resolves full first, then compact, then nothing, through the caller path map', () => {
    expect(resolveAntigravityTranscriptPath(CID, { brainDir: brainDir() })).toBeNull();
    const logs = writeAntigravityTwoLogs(brainDir(), CID, { withFull: false });
    expect(resolveAntigravityTranscriptPath(CID, { brainDir: brainDir() })).toBe(logs.compactPath);
    writeFileSync(logs.fullPath, jsonl(logs.fullRecords));
    expect(resolveAntigravityTranscriptPath(CID, { brainDir: brainDir() })).toBe(logs.fullPath);
    expect(resolveAntigravityTranscriptPath('../escape', { brainDir: brainDir() })).toBeNull();
    const overlay = join(home, 'overlay');
    const mapped = resolveAntigravityTranscriptPath(CID, { brainDir: brainDir(), mapPath: p => p.replace(home, overlay) });
    expect(mapped).toBeNull();
  });

  it('points the session transcript resolver (Insight, todo, usage readers) at the full log too', () => {
    __resetTranscriptResolverCacheForTest();
    const logs = writeAntigravityTwoLogs(brainDir(), CID, { withFull: false });
    const query = { cliId: 'antigravity' as const, sessionId: 'botmux-sid-agy-full', cliSessionId: CID };
    expect(resolveSessionTranscriptPath(query)).toEqual({ path: logs.compactPath, kind: 'antigravity' });
    writeFileSync(logs.fullPath, jsonl(logs.fullRecords));
    expect(resolveSessionTranscriptPath(query)).toEqual({ path: logs.fullPath, kind: 'antigravity' });
  });

  it('drains the full log incrementally — uneven chunked growth — to exactly the one-shot events', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    const oneShot = drainAntigravityTranscript(logs.fullPath, 0, {}, { flushTrailingFinal: true });
    const bytes = Buffer.from(jsonl(logs.fullRecords), 'utf8');
    const growing = join(home, 'growing.jsonl');
    writeFileSync(growing, '');
    let offset = 0;
    let state: AntigravityTranscriptState = {};
    const texts: string[] = [];
    // Uneven appends that split records (and multi-byte characters) mid-way.
    for (let at = 0; at < bytes.length;) {
      const next = Math.min(bytes.length, at + 997);
      appendFileSync(growing, bytes.subarray(at, next));
      at = next;
      const r = drainAntigravityTranscript(growing, offset, state);
      offset = r.newOffset;
      state = r.state;
      texts.push(...r.events.map(e => `${e.kind}:${e.text}`));
    }
    const flushed = drainAntigravityTranscript(growing, offset, state, { flushTrailingFinal: true });
    texts.push(...flushed.events.map(e => `${e.kind}:${e.text}`));
    expect(offset).toBe(bytes.length);
    expect(texts).toEqual(oneShot.events.map(e => `${e.kind}:${e.text}`));
  });

  it('maps every compact record boundary to the same record boundary of the full log', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    let compactOffset = 0;
    let fullOffset = 0;
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, 0, logs.fullPath)).toBe(0);
    for (let i = 0; i < logs.fullRecords.length; i++) {
      compactOffset += Buffer.byteLength(jsonl([logs.compactRecords[i]]));
      fullOffset += Buffer.byteLength(jsonl([logs.fullRecords[i]]));
      expect(mapAntigravityCompactOffsetToFull(logs.compactPath, compactOffset, logs.fullPath)).toBe(fullOffset);
    }
  });

  it('continues on the full log after a compact read with no record lost or repeated', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    // A bind made before agy created the full log has consumed records 0–11
    // of the compact file; the move must resume at record 12 of the full file.
    const compactPrefix = join(home, 'compact-prefix.jsonl');
    writeFileSync(compactPrefix, jsonl(logs.compactRecords.slice(0, 12)));
    const head = drainAntigravityTranscript(compactPrefix, 0);
    expect(head.events.map(e => e.kind)).toEqual(['user']);
    const mapped = mapAntigravityCompactOffsetToFull(logs.compactPath, head.newOffset, logs.fullPath);
    expect(mapped).toBe(Buffer.byteLength(jsonl(logs.fullRecords.slice(0, 12))));
    const rest = drainAntigravityTranscript(logs.fullPath, mapped!, head.state, { flushTrailingFinal: true });
    expect([...head.events, ...rest.events].map(e => `${e.kind}:${e.text}`))
      .toEqual([`user:${logs.userRequest}`, `assistant_final:${logs.finalText}`]);
    expect(rest.newOffset).toBe(Buffer.byteLength(jsonl(logs.fullRecords)));
  });

  it('refuses to map while the full log trails, or when the records disagree', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    const compactAll = Buffer.byteLength(jsonl(logs.compactRecords));
    // agy writes the full line a few ms after the compact one.
    writeFileSync(logs.fullPath, jsonl(logs.fullRecords.slice(0, 25)) + JSON.stringify(logs.fullRecords[25]).slice(0, 40));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, compactAll, logs.fullPath)).toBeUndefined();
    writeFileSync(logs.fullPath, jsonl(logs.fullRecords.slice(0, 24)) + jsonl([{ ...logs.fullRecords[25], step_index: 99 }]));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, Buffer.byteLength(jsonl(logs.compactRecords.slice(0, 25))), logs.fullPath)).toBeUndefined();
    rmSync(logs.fullPath);
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, compactAll, logs.fullPath)).toBeUndefined();
  });

  it('refuses to map from a compact log that was truncated or replaced under the consumed offset', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    const consumed = Buffer.byteLength(jsonl(logs.compactRecords.slice(0, 5)));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath))
      .toBe(Buffer.byteLength(jsonl(logs.fullRecords.slice(0, 5))));
    // Cut back to one record: mapping would land after record 1 of the full
    // log and replay records 2–5 as new.
    writeFileSync(logs.compactPath, jsonl(logs.compactRecords.slice(0, 1)));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath)).toBeUndefined();
    // Emptied: mapping would land at byte 0 and replay the whole conversation.
    writeFileSync(logs.compactPath, '');
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath)).toBeUndefined();
    // Same length again but only blank lines before the offset: no record boundary.
    writeFileSync(logs.compactPath, '\n'.repeat(consumed));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath)).toBeUndefined();
  });

  it('refuses when the compact log is cut between the size probe and the scan', async () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    const consumed = Buffer.byteLength(jsonl(logs.compactRecords.slice(0, 5)));
    // The on-disk compact log still holds all consumed records, so the stat
    // size probe passes; the scanner is redirected at a cut copy holding only
    // the first three records. This is exactly the window between statSync
    // and the scan opening: without re-checking the bytes actually read, the
    // mapper would count three records and resume on the full log after
    // record 3, replaying records 4–5.
    const cutPath = join(logs.logsDir, 'transcript.cut.jsonl');
    writeFileSync(cutPath, jsonl(logs.compactRecords.slice(0, 3)));
    const cursor = await import('../src/services/jsonl-cursor.js');
    const realScan = cursor.scanJsonlFromOffset;
    const scan = vi.spyOn(cursor, 'scanJsonlFromOffset');
    scan.mockImplementation((p, from, opts) =>
      p === logs.compactPath ? realScan(cutPath, from, opts) : realScan(p, from, opts));
    try {
      expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath)).toBeUndefined();
    } finally {
      scan.mockRestore();
    }
    // Once the scan reaches the consumed frontier again, it maps normally.
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath))
      .toBe(Buffer.byteLength(jsonl(logs.fullRecords.slice(0, 5))));
  });

  it('refuses to map when the full log does not start at the same first record', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    // A full log that began mid-conversation can still agree on the N-th
    // record by coincidence of shape; the first record anchors it.
    const shifted = [{ ...logs.fullRecords[0], step_index: 40 }, ...logs.fullRecords.slice(1)];
    writeFileSync(logs.fullPath, jsonl(shifted));
    const consumed = Buffer.byteLength(jsonl(logs.compactRecords.slice(0, 12)));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath)).toBeUndefined();
  });

  it('maps a consumed final record that has no trailing newline yet', () => {
    const logs = writeAntigravityTwoLogs(brainDir(), CID);
    const compactText = jsonl(logs.compactRecords).replace(/\n$/, '');
    writeFileSync(logs.compactPath, compactText);
    const consumed = drainAntigravityTranscript(logs.compactPath, 0).newOffset;
    expect(consumed).toBe(Buffer.byteLength(compactText));
    expect(mapAntigravityCompactOffsetToFull(logs.compactPath, consumed, logs.fullPath))
      .toBe(Buffer.byteLength(jsonl(logs.fullRecords)));
  });
});
