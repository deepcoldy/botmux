/**
 * ClaudeModelRequestClock (services/claude-transcript.ts): when the main
 * conversation's latest model request was served, read from Claude Code
 * transcript records shaped like the real ones (2.1.322: an `api-request`
 * record as the request goes out, then the assistant records carrying its
 * usage). The idle auto-compact times the prompt cache from it.
 *
 * Run: bun run vitest run test/claude-model-request-clock.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeModelRequestClock, type TranscriptEvent } from '../src/services/claude-transcript.js';

const at = (hhmmss: string): string => `2026-11-21T${hhmmss}.000Z`;
const ms = (hhmmss: string): number => Date.parse(at(hhmmss));

function request(hhmmss: string, querySource = 'repl_main_thread'): TranscriptEvent {
  return {
    type: 'api-request', sessionId: 's', timestamp: at(hhmmss), querySource,
  } as TranscriptEvent;
}

function served(hhmmss: string, extra: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    type: 'assistant', uuid: `u-${hhmmss}`, timestamp: at(hhmmss),
    message: {
      role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 2, cache_read_input_tokens: 506_000, cache_creation_input_tokens: 900 },
    },
    ...extra,
  } as TranscriptEvent;
}

function prompt(hhmmss: string, content: string, stamps: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { type: 'user', timestamp: at(hhmmss), message: { role: 'user', content }, ...stamps } as TranscriptEvent;
}

/** Shapes Claude Code 2.1.322 writes for each kind of turn start. */
const byPerson = (hhmmss: string, text = '修个 bug'): TranscriptEvent =>
  prompt(hhmmss, text, { origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' } as Partial<TranscriptEvent>);
const byWatcher = (hhmmss: string): TranscriptEvent => prompt(hhmmss,
  '<task-notification> <task-id>bnyl8umkq</task-id> <status>completed</status> <summary>Background command completed (exit code 0)</summary> </task-notification>',
  { origin: { kind: 'task-notification' }, promptSource: 'system', turnOrigin: 'task_notification' } as Partial<TranscriptEvent>);
const byPlugin = (hhmmss: string): TranscriptEvent => prompt(hhmmss,
  "I'm stepping away for a while. Without calling tools this turn, briefly summarize",
  { origin: { kind: 'plugin', name: 'cache-keeper', asUser: true }, promptSource: 'system', turnOrigin: 'system' } as Partial<TranscriptEvent>);
const bySchedule = (hhmmss: string): TranscriptEvent => prompt(hhmmss, 'check the release',
  { isMeta: true, turnOrigin: 'scheduled', scheduledTaskId: 'job1', scheduledFireId: 'fire1' } as Partial<TranscriptEvent>);
const KEEPALIVE = '<botmux_cache_keepalive>这是 botmux 自动发送的提示缓存保活消息</botmux_cache_keepalive>';

/** A served request in the middle of a turn (it asked for a tool). */
const midTurn = (hhmmss: string): TranscriptEvent => {
  const ev = served(hhmmss);
  ev.message!.stop_reason = 'tool_use';
  return ev;
};
const turnEnd = (hhmmss: string): TranscriptEvent => ({ type: 'system', subtype: 'turn_duration', timestamp: at(hhmmss) } as TranscriptEvent);

function clockOf(events: TranscriptEvent[]): ClaudeModelRequestClock {
  const clock = new ClaudeModelRequestClock();
  for (const ev of events) clock.observe(ev);
  return clock;
}

describe('ClaudeModelRequestClock', () => {
  it('credits cache warmth to the request start but activity to its response completion', () => {
    const clock = clockOf([byPerson('09:05:50'), request('09:05:55'), served('09:06:59')]);
    expect(clock.lastServedAt()).toBe(ms('09:05:55'));
    expect(clock.lastActivityAt()).toBe(ms('09:06:59'));
  });

  it('a request that failed proves nothing; the retry the model answered counts from its own start', () => {
    const clock = clockOf([
      request('10:00:00'),
      served('10:00:04', {
        isApiErrorMessage: true, error: 'server_error',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }], usage: { input_tokens: 0 } },
      } as Partial<TranscriptEvent>),
      // The API-error exclusion is independent of the model placeholder: even
      // a real model field and non-zero usage must not turn a failure into a
      // served request.
      served('10:00:05', {
        isApiErrorMessage: true, error: 'server_error',
        message: {
          role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'API Error: 500 internal server error' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      } as Partial<TranscriptEvent>),
    ]);
    expect(clock.lastServedAt()).toBeUndefined();
    clock.observe(request('10:02:00'));
    clock.observe(served('10:02:40'));
    expect(clock.lastServedAt()).toBe(ms('10:02:00'));
  });

  it('ignores content blobs that read as assistant, sidechains and records without usage', () => {
    const clock = clockOf([request('08:00:00'), served('08:00:30')]);
    // The request's content blobs precede the next api-request and carry
    // message.role:"assistant" without a timestamp or usage.
    clock.observe({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'thinking' }] } } as TranscriptEvent);
    clock.observe(served('09:00:00', { isSidechain: true }));
    clock.observe(served('09:10:00', {
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0 } },
    } as Partial<TranscriptEvent>));
    clock.observe(request('09:20:00', 'side_question'));
    // An assistant record with no usage after a main-thread request: nothing
    // says the model read anything.
    clock.observe(request('09:29:00'));
    clock.observe(served('09:30:00', {
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }] },
    } as Partial<TranscriptEvent>));
    expect(clock.lastServedAt()).toBe(ms('08:00:00'));
  });

  it('never credits a <synthetic> local tool call, even when its record carries non-zero usage', () => {
    // Claude Code writes local tool calls (virtual Read/project-doc replays,
    // PushNotification) as assistant records with model "<synthetic>". No model
    // request was served, so the clock must ignore them regardless of content
    // shape or usage values — the synthetic-message factory accepts a usage
    // argument, so zero usage cannot be assumed.
    const clock = clockOf([request('08:00:00'), served('08:00:30')]);
    clock.observe({
      type: 'assistant', uuid: 'syn-tool', timestamp: at('08:01:00'),
      isApiErrorMessage: false,
      message: {
        role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/a' } }],
      },
    } as TranscriptEvent);
    expect(clock.lastServedAt()).toBe(ms('08:00:00'));
    expect(clock.lastActivityAt()).toBe(ms('08:00:30'));
  });

  it('builds without api-request records credit the response time; a re-read older pair never moves it back', () => {
    const clock = clockOf([served('11:00:10')]);
    expect(clock.lastServedAt()).toBe(ms('11:00:10'));
    clock.observe(request('10:00:00'));
    clock.observe(served('10:00:20'));
    expect(clock.lastServedAt()).toBe(ms('11:00:10'));
  });

  it('every served request is activity except idle upkeep: botmux\'s keep-alive and a plugin\'s prompt', () => {
    const clock = clockOf([byPerson('09:00:00'), request('09:00:01'), served('09:01:00'), turnEnd('09:01:01')]);
    expect(clock.lastActivityAt()).toBe(ms('09:01:00'));
    // A watcher waking the model, a scheduled fire: each produces something
    // someone may answer.
    for (const [start, hhmmss] of [[byWatcher, '09:20:00'], [bySchedule, '10:00:00']] as const) {
      clock.observe(start(hhmmss));
      clock.observe(request(hhmmss.replace(/:00$/, ':02')));
      clock.observe(served(hhmmss.replace(/:00$/, ':30')));
      clock.observe(turnEnd(hhmmss.replace(/:00$/, ':31')));
      expect(clock.lastActivityAt()).toBe(ms(hhmmss.replace(/:00$/, ':30')));
    }
    // A cache-keeping plugin's "stepping away" summary, and botmux's keep-alive
    // (typed like a person's prompt; its tag says whose): both only keep warm.
    clock.observe(byPlugin('10:40:00'));
    clock.observe(request('10:40:02'));
    clock.observe(served('10:40:30'));
    clock.observe(turnEnd('10:40:31'));
    clock.observe(byPerson('11:30:00', KEEPALIVE));
    clock.observe(request('11:30:02'));
    clock.observe(served('11:30:05'));
    clock.observe(turnEnd('11:30:06'));
    expect(clock.lastServedAt()).toBe(ms('11:30:02'));
    expect(clock.lastActivityAt()).toBe(ms('10:00:30'));
  });

  it('upkeep ends with its turn: a later request no record marks as a turn start is activity', () => {
    // After a keep-alive, a person types `/review` in the terminal: Claude Code
    // writes a command wrapper, not a prompt record, then sends the request.
    const clock = clockOf([byPerson('12:00:00', KEEPALIVE), request('12:00:02')]);
    // The keep-alive's reply is written as several records of one request.
    clock.observe(served('12:00:04'));
    clock.observe(turnEnd('12:00:05'));
    clock.observe(served('12:00:06'));
    expect(clock.lastActivityAt()).toBeUndefined();
    clock.observe(prompt('12:30:00', '<command-name>/review</command-name>\n<command-message>review</command-message>'));
    clock.observe(request('12:30:01'));
    clock.observe(served('12:31:00'));
    expect(clock.lastActivityAt()).toBe(ms('12:31:00'));
  });

  it("input folded into an upkeep turn makes it real work; a worker attached mid-turn counts it too", () => {
    const clock = clockOf([byPerson('11:00:00', KEEPALIVE), request('11:00:01'), midTurn('11:00:20')]);
    expect(clock.lastActivityAt()).toBeUndefined();
    // How Claude Code 2.1.322 records a message absorbed into a running turn.
    clock.observe({
      type: 'attachment', timestamp: at('11:00:30'), renderedRole: 'system',
      attachment: { type: 'queued_command', prompt: '先别合，等我看一下', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true },
      rendered: [{ content: '<system-reminder>\nThe user sent a new message while you were working:\n先别合，等我看一下\n</system-reminder>' }],
    } as unknown as TranscriptEvent);
    clock.observe(request('11:00:31'));
    clock.observe(served('11:01:00'));
    expect(clock.lastActivityAt()).toBe(ms('11:01:00'));
    const attached = clockOf([request('08:00:00'), served('08:00:10')]);
    expect(attached.lastActivityAt()).toBe(ms('08:00:10'));
    // A keep-alive queued while a person's turn still runs does not take that
    // turn's remaining requests away from activity.
    const busy = clockOf([byPerson('13:00:00'), request('13:00:01'), midTurn('13:00:20')]);
    busy.observe(byPerson('13:00:25', KEEPALIVE));
    busy.observe(request('13:00:30'));
    busy.observe(served('13:00:50'));
    expect(busy.lastActivityAt()).toBe(ms('13:00:50'));
  });

  it('rebinding to another native session drops the old timestamps and accepts its older history', () => {
    const clock = new ClaudeModelRequestClock();
    expect(clock.bind('session-a')).toBe(true);
    for (const ev of [byPerson('10:00:00'), request('10:00:01'), served('10:00:30'), turnEnd('10:00:31')]) clock.observe(ev);
    expect(clock.lastServedAt()).toBe(ms('10:00:01'));
    expect(clock.bind('session-b')).toBe(true);
    expect(clock.boundClaudeSessionId).toBe('session-b');
    expect(clock.lastServedAt()).toBeUndefined();
    expect(clock.lastActivityAt()).toBeUndefined();
    for (const ev of [byPerson('06:00:00'), request('06:00:01'), served('06:00:30'), turnEnd('06:00:31')]) clock.observe(ev);
    expect(clock.lastServedAt()).toBe(ms('06:00:01'));
    expect(clock.lastActivityAt()).toBe(ms('06:00:30'));
    expect(clock.bind('session-b')).toBe(false);
  });

  it('seeds from the tail of a transcript it starts following at the end, skipping a cut first line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-request-clock-'));
    try {
      const path = join(dir, 'session.jsonl');
      const lines = [
        byWatcher('06:00:00'), request('06:00:01'), served('06:00:30'), turnEnd('06:00:31'),
        byPerson('07:00:00', KEEPALIVE), request('07:00:01'), served('07:00:30'), turnEnd('07:00:31'),
      ].map(ev => JSON.stringify(ev));
      writeFileSync(path, lines.join('\n') + '\n');
      // The tail starts 20 bytes before the end of the keep-alive's start
      // record: that partial line neither throws nor counts, and a turn whose
      // start the tail does not hold counts as activity (errs toward not
      // compacting).
      const tailBytes = lines.slice(5).join('\n').length + 1 + 20;
      const clock = new ClaudeModelRequestClock();
      clock.seedFromTail(path, tailBytes);
      expect(clock.lastServedAt()).toBe(ms('07:00:01'));
      expect(clock.lastActivityAt()).toBe(ms('07:00:30'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
