import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainCocoEvents } from '../src/services/coco-transcript.js';

let dir: string;
let path: string;

function line(obj: any): string { return JSON.stringify(obj) + '\n'; }
function userMsg(content: string, extra: any = {}, ts = '2026-04-30T02:33:13.000+08:00') {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: ts,
    message: { message: { role: 'user', content, extra } },
  };
}
function assistantMsg(
  content: string,
  finishReason: 'stop' | 'tool_calls' = 'stop',
  ts = '2026-04-30T02:33:13.000+08:00',
) {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: ts,
    message: { message: { role: 'assistant', content, response_meta: { finish_reason: finishReason } } },
  };
}
function originalUser(content: string) { return userMsg(content, { is_original_user_input: true }); }
function assistant(content: string) { return assistantMsg(content, 'stop'); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coco-transcript-'));
  path = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('drainCocoEvents', () => {
  it('returns empty for missing file', () => {
    const r = drainCocoEvents(join(dir, 'missing.jsonl'), 0);
    expect(r.events).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it('extracts original user prompt and assistant final message', () => {
    writeFileSync(path, line(originalUser('just say PONG')) + line(assistant('PONG')));
    const r = drainCocoEvents(path, 0);
    expect(r.events.map(e => [e.kind, e.text])).toEqual([
      ['user', 'just say PONG'],
      ['assistant_final', 'PONG'],
    ]);
  });

  it('skips injected user system reminders', () => {
    writeFileSync(path,
      line(userMsg('<system-reminder>ignore</system-reminder>', { is_additional_context_input: true })) +
      line(originalUser('real prompt')));
    const r = drainCocoEvents(path, 0);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].text).toBe('real prompt');
  });

  it('skips assistant tool_calls events even when content is non-empty', () => {
    // CoCo emits mid-turn narration like "Let me run the tests..." with
    // finish_reason=tool_calls before invoking a tool. Treating that as
    // assistant_final would close the Lark turn early and drop the real
    // stop message that follows.
    writeFileSync(path,
      line(originalUser('run the tests')) +
      line(assistantMsg('Let me run the tests now.', 'tool_calls')) +
      line(assistantMsg('', 'tool_calls')) +
      line(assistantMsg('All 35 tests passed.', 'stop')));
    const r = drainCocoEvents(path, 0);
    expect(r.events.map(e => [e.kind, e.text])).toEqual([
      ['user', 'run the tests'],
      ['assistant_final', 'All 35 tests passed.'],
    ]);
  });

  it('ignores malformed and non-message lines', () => {
    writeFileSync(path, 'bad json\n' + line({ state_update: { updates: {} } }) + line(assistant('done')));
    const r = drainCocoEvents(path, 0);
    expect(r.events.map(e => e.text)).toEqual(['done']);
  });

  it('drains incrementally and keeps partial trailing line pending', () => {
    writeFileSync(path, line(originalUser('first')) + '{"message":');
    const r1 = drainCocoEvents(path, 0);
    expect(r1.events).toHaveLength(1);
    expect(r1.pendingTail).toContain('message');
    expect(r1.newOffset).toBeLessThan(statSync(path).size);

    appendFileSync(path, '\n' + line(assistant('reply')));
    const r2 = drainCocoEvents(path, r1.newOffset);
    expect(r2.events.map(e => e.text)).toEqual(['reply']);
  });

  it('re-drains from top after truncation', () => {
    writeFileSync(path, line(originalUser('long original prompt')) + line(assistant('long reply')));
    const r1 = drainCocoEvents(path, 0);
    writeFileSync(path, line(originalUser('new')));
    const r2 = drainCocoEvents(path, r1.newOffset);
    expect(r2.events.map(e => e.text)).toEqual(['new']);
  });

  it('drains large records across chunk boundaries without allocating the full delta as one string', () => {
    const hugePrompt = 'p'.repeat(80_000);
    const hugeReply = 'r'.repeat(90_000);
    writeFileSync(path, line(originalUser(hugePrompt)) + line(assistant(hugeReply)));

    const r = drainCocoEvents(path, 0);

    expect(r.events.map((e) => [e.kind, e.text.length])).toEqual([
      ['user', hugePrompt.length],
      ['assistant_final', hugeReply.length],
    ]);
    expect(r.pendingTail).toBe('');
    expect(r.newOffset).toBe(statSync(path).size);
  });

  it('preserves UTF-8 multi-byte characters split across the default scan chunk boundary', () => {
    const chunkBoundary = 64 * 1024;
    const marker = '你';
    const suffix = '尾巴';
    const buildOriginalUserLine = (content: string) => line({
      id: 'fixed-user-id',
      created_at: '2026-04-30T02:33:13.000+08:00',
      message: { message: { role: 'user', content, extra: { is_original_user_input: true } } },
    });
    const prefixBytes = Buffer.byteLength(buildOriginalUserLine(`${marker}${suffix}`).split(marker)[0], 'utf8');
    const fillerLen = chunkBoundary - prefixBytes - 1;
    const promptText = `${'a'.repeat(fillerLen)}${marker}${suffix}`;
    const promptLine = buildOriginalUserLine(promptText);
    const markerOffset = Buffer.byteLength(promptLine.slice(0, promptLine.indexOf(marker)), 'utf8');

    expect(markerOffset).toBeGreaterThanOrEqual(chunkBoundary - 2);
    expect(markerOffset).toBeLessThan(chunkBoundary);

    writeFileSync(path, promptLine + line(assistant('收到')));

    const r = drainCocoEvents(path, 0);

    expect(r.events.map((e) => [e.kind, e.text])).toEqual([
      ['user', promptText],
      ['assistant_final', '收到'],
    ]);
  });

  it('preserves a large partial trailing line as pendingTail until newline arrives', () => {
    const hugePrompt = 'q'.repeat(80_000);
    writeFileSync(path, line(originalUser('seed')) + JSON.stringify(originalUser(hugePrompt)).slice(0, -10));

    const r1 = drainCocoEvents(path, 0);
    expect(r1.events.map((e) => e.text)).toEqual(['seed']);
    expect(r1.pendingTail.length).toBeGreaterThan(70_000);

    appendFileSync(path, JSON.stringify(originalUser(hugePrompt)).slice(-10) + '\n');
    const r2 = drainCocoEvents(path, r1.newOffset);
    expect(r2.events.map((e) => e.text)).toEqual([hugePrompt]);
  });
});

describe('findCocoSessionByPid', () => {
  it('rejects non-positive / non-integer pids', async () => {
    const { findCocoSessionByPid } = await import('../src/services/coco-transcript.js');
    expect(findCocoSessionByPid(0)).toBeUndefined();
    expect(findCocoSessionByPid(-1)).toBeUndefined();
    expect(findCocoSessionByPid(1.5 as any)).toBeUndefined();
  });

  it('returns undefined for a pid with no discoverable open coco fds', async () => {
    const { findCocoSessionByPid } = await import('../src/services/coco-transcript.js');
    // pid 99999999 在测试主机上几乎保证不存在；Linux 走 /proc 时 fdDir
    // 不存在直接返回 undefined，macOS / 其他平台走 lsof，对不存在的 pid
    // 也会非零退出 → undefined。一条断言兜两条路径，避免 OS 分叉。
    expect(findCocoSessionByPid(99999999)).toBeUndefined();
  });
});

describe('cocoEventsPathForSession', () => {
  it('builds the events.jsonl path under the platform-appropriate coco sessions dir', async () => {
    const { cocoEventsPathForSession } = await import('../src/services/coco-transcript.js');
    const sid = '8db7d911-96f3-4764-a310-e42ae4cb626f';
    const out = cocoEventsPathForSession(sid);
    // macOS 走 ~/Library/Caches/coco/sessions/<sid>/events.jsonl，Linux 走
    // ~/.cache/coco/sessions/<sid>/events.jsonl —— 两种形态都接受，否则跨
    // 平台 CI / 本地一边绿一边红。
    expect(out).toMatch(
      /(?:\/\.cache\/coco\/sessions\/|\/Library\/Caches\/coco\/sessions\/)[0-9a-f-]{36}\/events\.jsonl$/,
    );
    expect(out).toContain(sid);
  });
});
