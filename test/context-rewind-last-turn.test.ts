/**
 * Reading a Claude Code transcript's last turn back from its end, and cutting
 * it with a backup of the removed bytes only. Fixtures follow the records
 * Claude Code 2.1.322 wrote for a turn the provider answered with a 503 and
 * nothing else (2026-11-16): the prompt, a hook attachment, per-turn metadata,
 * the API-error record and turn_duration.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectLastClaudeTurn, restoreRewoundTranscript, rewindClaudeTranscript, scanClaudeTranscriptCheckpoints, withOpenTranscript, type RewindResult } from '../src/core/context-rewind.js';

/** What a restore takes from a `removed` cut. */
const pinned = (result: RewindResult, offset: number) => ({ ...result, offset, removed: result.removed! });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(lines: unknown[], tail = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-last-turn-'));
  dirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map(line => `${JSON.stringify(line)}\n`).join('') + tail);
  return path;
}

const prompt = (text: string, uuid: string) => ({
  parentUuid: 'p', isSidechain: false, type: 'user', uuid, timestamp: '2026-11-16T14:20:40.948Z',
  message: { role: 'user', content: text }, promptSource: 'typed', turnOrigin: 'human',
});
const reply = (text: string) => ({
  type: 'assistant', uuid: `a-${text}`, message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
});
const toolCall = {
  type: 'assistant', uuid: 'a-tool', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' },
};
const toolResult = { type: 'user', uuid: 'tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
const thinking = {
  type: 'assistant', uuid: 'a-think', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'thinking', thinking: 'plan' }], stop_reason: 'end_turn' },
};
const apiError = (status = 503, error = 'server_error') => ({
  type: 'assistant', uuid: `err-${status}`, error, isApiErrorMessage: true, apiErrorStatus: status,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: `API Error: ${status} the upstream request failed` }], stop_reason: 'stop_sequence' },
});
const turnMetadata = [
  { type: 'attachment', uuid: 'att', attachment: { type: 'hook_additional_context', content: ['<rules/>'] } },
  { type: 'last-prompt', lastPrompt: '继续' },
  { type: 'mode', mode: 'normal' },
  { type: 'pr-link', prNumber: 1 },
];
const turnDuration = { type: 'system', subtype: 'turn_duration', durationMs: 1253 };
const history = [prompt('上一轮', 'u0'), reply('上一轮的答复'), turnDuration];

describe('inspectLastClaudeTurn', () => {
  it('a turn the provider answered with an API error and nothing else is error_only, cut at its prompt', () => {
    const path = fixture([...history, { type: 'api-request', id: 'r1' }, prompt('继续', 'u1'), ...turnMetadata, apiError(), turnDuration]);
    const raw = readFileSync(path);
    const result = inspectLastClaudeTurn(path);
    expect(result).toMatchObject({ outcome: 'error_only', uuid: 'u1', text: '继续', resumable: true });
    expect(raw.subarray(result.offset!).toString()).toMatch(/^\{"parentUuid":"p".*"uuid":"u1"/);
    expect(raw[result.offset! - 1]).toBe(0x0a);
  });

  // Claude Code ≥ 2.1.31x copies each request body into `api-request-blob`
  // records whose message.role is "user": in 428 of 565 direct failures found
  // in local transcripts one sat between the prompt and the error.
  it('a request blob between the prompt and the error is bookkeeping, not the turn start', () => {
    const blob = { type: 'api-request-blob', hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'tool_result', tool_use_id: 'x', content: 'y' }] } };
    const path = fixture([...history, prompt('继续', 'u1'), ...turnMetadata, blob, apiError(), turnDuration]);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', uuid: 'u1', text: '继续' });
    // Nor does /rewind list one as a checkpoint.
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['u1', 'u0']);
  });

  it('thinking before the error is still no output', () => {
    const path = fixture([...history, prompt('继续', 'u1'), thinking, apiError(), turnDuration]);
    expect(inspectLastClaudeTurn(path).outcome).toBe('error_only');
  });

  it('the no-model-reply placeholder of a resumed turn counts like an error', () => {
    const placeholder = {
      type: 'assistant', uuid: 'syn', isApiErrorMessage: false,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], stop_reason: 'stop_sequence' },
    };
    const meta = { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } };
    const path = fixture([...history, prompt('原任务', 'u1'), meta, placeholder]);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', text: '原任务' });
  });

  it.each([
    ['a tool call', [toolCall, apiError()]],
    ['a tool result', [toolCall, toolResult, apiError()]],
    ['a text reply cut by the error', [reply('写了一半'), apiError()]],
    ['a subagent record', [{ ...reply('子代理'), isSidechain: true }, apiError()]],
    ['a subagent that only thought', [{ ...thinking, isSidechain: true }, apiError()]],
  ])('a turn with %s made progress', (_label, records) => {
    const path = fixture([...history, prompt('原任务', 'u1'), ...records, turnDuration]);
    expect(inspectLastClaudeTurn(path).outcome).toBe('progress');
  });

  it.each([
    ['a rate limit', [{ ...apiError(429, 'rate_limit') }]],
    ['a cancelled request', [apiError(499, 'request_cancelled')]],
    ['a user interrupt', [{ type: 'user', uuid: 'int', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]],
    ['a slash command after the error', [apiError(), { type: 'user', uuid: 'cmd', message: { role: 'user', content: '<command-name>/model</command-name>' } }]],
    ['an input folded into the turn', [{ type: 'attachment', uuid: 'q', attachment: { type: 'queued_command', prompt: '顺便看下 X' }, renderedRole: 'system' }, apiError()]],
    ['a compaction', [apiError(), { type: 'system', subtype: 'compact_boundary' }]],
    ['a peer session\'s hand-back', [apiError(), { type: 'user', uuid: 'peer', isMeta: true, turnOrigin: 'peer', promptSource: 'system', message: { role: 'user', content: 'Another Claude session sent a message:\n<hand-back/>' } }, apiError()]],
    ['a note that the user edited a file', [{ type: 'attachment', uuid: 'ed', attachment: { type: 'edited_text_file', filename: '/w/a.ts', snippet: 'x' } }, apiError()]],
    ['no error at all', [turnDuration]],
  ])('a turn ending in %s is not a failed turn to cut', (_label, records) => {
    const path = fixture([...history, prompt('原任务', 'u1'), ...records]);
    expect(inspectLastClaudeTurn(path).outcome).toBe('other');
  });

  it('a line still being written is never read as the end of a turn', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError()], '{"type":"system","subty');
    expect(inspectLastClaudeTurn(path).outcome).toBe('other');
  });

  it('a first turn has nothing to resume after the cut', () => {
    const path = fixture([{ type: 'mode', mode: 'normal' }, prompt('第一条', 'u1'), apiError(), turnDuration]);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', offset: expect.any(Number), resumable: false });
  });

  it('only the last turn decides: an earlier failure behind a successful turn is not it', () => {
    const path = fixture([...history, prompt('失败那轮', 'u1'), apiError(), turnDuration, prompt('后来一轮', 'u2'), reply('好了'), turnDuration]);
    expect(inspectLastClaudeTurn(path).outcome).toBe('progress');
  });

  it('reads the tail only: lines spanning many chunks before the failed turn are not parsed', () => {
    const big = { ...toolResult, uuid: 'big', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(3 << 20) }] } };
    const path = fixture([prompt('早先', 'u0'), toolCall, big, reply('完成'), turnDuration, prompt('继续', 'u1'), apiError(), turnDuration]);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', text: '继续', resumable: true });
  });

  it('gives up (other) when the turn is longer than the read limit', () => {
    const path = fixture([...history, prompt('长', 'u1'), { ...thinking, message: { ...thinking.message, content: [{ type: 'thinking', thinking: 'y'.repeat(2 << 20) }] } }, apiError()]);
    expect(inspectLastClaudeTurn(path, 1 << 20).outcome).toBe('other');
  });

  it('an empty transcript has no turn', () => {
    expect(inspectLastClaudeTurn(fixture([])).outcome).toBe('no_turn');
  });
});

describe('restoreRewoundTranscript', () => {
  it('puts the cut bytes back when nothing was written after the cut', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const before = readFileSync(path);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 22), { backup: 'removed' }), offset!);
    expect(restoreRewoundTranscript(path, cut)).toBe(true);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('refuses once the transcript moved on after the cut', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 23), { backup: 'removed' }), offset!);
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(prompt('新的一轮', 'u2'))}\n`);
    const grown = readFileSync(path);
    expect(restoreRewoundTranscript(path, cut)).toBe(false);
    expect(readFileSync(path).equals(grown)).toBe(true);
  });

  it('puts the turn back after what a CLI wrote outside the conversation since the cut, as its latest turn', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const before = readFileSync(path);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 24), { backup: 'removed' }), offset!);
    // What Claude Code 2.1.326 appends when a resumed CLI that got no input exits.
    const onExit = `${JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUsd: 0 })}\n${JSON.stringify({ type: 'mode', mode: 'normal' })}\n`;
    writeFileSync(path, readFileSync(path, 'utf8') + onExit);
    expect(restoreRewoundTranscript(path, cut)).toBe(true);
    // Appended, never rewritten in place: a write cut short cannot interleave.
    expect(readFileSync(path).equals(Buffer.concat([before.subarray(0, offset), Buffer.from(onExit), before.subarray(offset)]))).toBe(true);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', uuid: 'u1' });
    // A second restore finds the turn already back and changes nothing.
    const restored = readFileSync(path);
    expect(restoreRewoundTranscript(path, cut)).toBe(false);
    expect(readFileSync(path).equals(restored)).toBe(true);
  });

  it('puts the turn back after the local slash commands a resumed CLI ran (a bot\'s startup commands), as its latest turn', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const before = readFileSync(path);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 27), { backup: 'removed' }), offset!);
    // What Claude Code 2.1.326 records for `/effort high`, then its exit.
    const ran = [
      { type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
      { parentUuid: 'p', type: 'user', uuid: 'c0', isMeta: true, message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>' } },
      { parentUuid: 'c0', type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>high</command-args>' } },
      { parentUuid: 'c1', type: 'user', uuid: 'c2', message: { role: 'user', content: '<local-command-stdout>Set effort level to high</local-command-stdout>' } },
      { type: 'cost-state', sessionId: 's', totalCostUsd: 0 },
    ].map(record => `${JSON.stringify(record)}\n`).join('');
    writeFileSync(path, readFileSync(path, 'utf8') + ran);
    expect(restoreRewoundTranscript(path, cut)).toBe(true);
    expect(readFileSync(path).equals(Buffer.concat([before.subarray(0, offset), Buffer.from(ran), before.subarray(offset)]))).toBe(true);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', uuid: 'u1' });
  });

  it('also takes a command output recorded as a local_command system record (earlier Claude Code builds)', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 29), { backup: 'removed' }), offset!);
    // The shape of test/fixtures/claude-background-tasks/after-clear.jsonl.
    const ran = [
      { parentUuid: 'p', type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/effort</command-name>' } },
      { parentUuid: 'c1', type: 'system', subtype: 'local_command', uuid: 'c2', isMeta: false, content: '<local-command-stdout></local-command-stdout>' },
    ].map(record => `${JSON.stringify(record)}\n`).join('');
    writeFileSync(path, readFileSync(path, 'utf8') + ran);
    expect(restoreRewoundTranscript(path, cut)).toBe(true);
    expect(inspectLastClaudeTurn(path)).toMatchObject({ outcome: 'error_only', uuid: 'u1' });
  });

  it('refuses once a slash command after the cut got a model turn', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 28), { backup: 'removed' }), offset!);
    const answered = [
      { parentUuid: 'p', type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/review</command-name>' } },
      reply('审查结果'),
    ].map(record => `${JSON.stringify(record)}\n`).join('');
    writeFileSync(path, readFileSync(path, 'utf8') + answered);
    const grown = readFileSync(path);
    expect(restoreRewoundTranscript(path, cut)).toBe(false);
    expect(readFileSync(path).equals(grown)).toBe(true);
  });

  it('refuses a message written after the cut even when it has no uuid', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 26), { backup: 'removed' }), offset!);
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify({ type: 'user', message: { role: 'user', content: '新的一轮' } })}\n`);
    const grown = readFileSync(path);
    expect(restoreRewoundTranscript(path, cut)).toBe(false);
    expect(readFileSync(path).equals(grown)).toBe(true);
  });

  it('refuses when what follows the cut ends in a partial line', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 25), { backup: 'removed' }), offset!);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"cost-state"`);
    const partial = readFileSync(path);
    expect(restoreRewoundTranscript(path, cut)).toBe(false);
    expect(readFileSync(path).equals(partial)).toBe(true);
  });
});

describe('restoreRewoundTranscript reads and writes only the files the cut pinned', () => {
  const cutFixture = (stamp: number) => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const before = readFileSync(path);
    const { offset } = inspectLastClaudeTurn(path);
    const cut = pinned(rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 15, stamp), { backup: 'removed' }), offset!);
    return { path, before, cut, afterCut: readFileSync(path) };
  };

  it('puts back the bytes the cut removed, never the backup file: a link or other bytes there change nothing', () => {
    const linked = cutFixture(1);
    const outside = join(mkdtempSync(join(tmpdir(), 'botmux-outside-')), 'host-only.txt');
    dirs.push(dirname(outside));
    writeFileSync(outside, 'HOST-ONLY-CONTENT\n');
    unlinkSync(linked.cut.backupPath);
    symlinkSync(outside, linked.cut.backupPath);
    expect(restoreRewoundTranscript(linked.path, linked.cut)).toBe(true);
    expect(readFileSync(linked.path).equals(linked.before)).toBe(true);
    expect(readFileSync(linked.path, 'utf8')).not.toContain('HOST-ONLY-CONTENT');

    const rewritten = cutFixture(2);
    writeFileSync(rewritten.cut.backupPath, `${JSON.stringify(prompt('别的内容', 'ux'))}\n`);
    expect(restoreRewoundTranscript(rewritten.path, rewritten.cut)).toBe(true);
    expect(readFileSync(rewritten.path).equals(rewritten.before)).toBe(true);
  });

  it('a transcript replaced by another file — a link or a regular file — is left alone', () => {
    const linked = cutFixture(4);
    const real = `${linked.path}.real`;
    renameSync(linked.path, real);
    symlinkSync(real, linked.path);
    expect(restoreRewoundTranscript(linked.path, linked.cut)).toBe(false);
    expect(readFileSync(real).equals(linked.afterCut)).toBe(true);

    const swapped = cutFixture(5);
    const copy = `${swapped.path}.copy`;
    copyFileSync(swapped.path, copy);
    renameSync(copy, swapped.path);
    expect(restoreRewoundTranscript(swapped.path, swapped.cut)).toBe(false);
    expect(readFileSync(swapped.path).equals(swapped.afterCut)).toBe(true);
  });

  it('without the cut bytes there is nothing to put back', () => {
    const { path, cut, afterCut } = cutFixture(8);
    expect(restoreRewoundTranscript(path, { ...cut, removed: Buffer.alloc(0) })).toBe(false);
    expect(readFileSync(path).equals(afterCut)).toBe(true);
  });

  it('the unchanged files are put back together', () => {
    const { path, before, cut } = cutFixture(6);
    expect(restoreRewoundTranscript(path, cut)).toBe(true);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('the last-turn read and the cut stay on the file they planned on', () => {
  it('the last-turn read does not follow a link, nor block on a FIFO', () => {
    const real = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const link = `${real}.link`;
    symlinkSync(real, link);
    expect(() => inspectLastClaudeTurn(link)).toThrow();
    const fifo = `${real}.fifo`;
    execFileSync('mkfifo', [fifo]);
    expect(() => inspectLastClaudeTurn(fifo)).toThrow(/non-regular/);
  });

  it('the last-turn read and the cut share one descriptor: a file swapped in between is not cut', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const original = readFileSync(path);
    const held = `${path}.held`;
    expect(() => withOpenTranscript(path, {}, transcript => {
      const { offset } = transcript.lastTurn();
      // Another file at the path between the read and the cut.
      renameSync(path, held);
      copyFileSync(held, path);
      return transcript.cut(offset!, Date.UTC(2026, 10, 16, 15, 7), { backup: 'removed' });
    })).toThrow(/replaced/);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(readFileSync(held).equals(original)).toBe(true);
  });

  it('in a CLI-writable tree, the cut keeps its backup out of the tree and the restore re-checks the tree', () => {
    const tree = mkdtempSync(join(tmpdir(), 'botmux-tree-'));
    dirs.push(tree);
    const backupDir = mkdtempSync(join(tmpdir(), 'botmux-backups-'));
    dirs.push(backupDir);
    const projectDir = join(tree, 'projects', 'cwd-key');
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, 'session.jsonl');
    writeFileSync(path, [...history, prompt('继续', 'u1'), apiError(), turnDuration].map(line => `${JSON.stringify(line)}\n`).join(''));
    const before = readFileSync(path);
    const scope = { writableTreeRoot: tree, backupDir };
    const result = withOpenTranscript(path, scope, transcript => transcript.cut(transcript.lastTurn().offset!, Date.UTC(2026, 10, 16, 15, 8), { backup: 'removed' }));
    expect(dirname(result.backupPath)).toBe(backupDir);
    expect(readdirSync(projectDir)).toEqual(['session.jsonl']);
    const cut = pinned(result, before.length - result.removedBytes);
    // The project directory became a link to a copy elsewhere: refused.
    const elsewhere = mkdtempSync(join(tmpdir(), 'botmux-elsewhere-'));
    dirs.push(elsewhere);
    renameSync(projectDir, join(elsewhere, 'cwd-key'));
    symlinkSync(join(elsewhere, 'cwd-key'), projectDir);
    expect(() => restoreRewoundTranscript(path, cut, scope)).toThrow();
    // Back in place: restored.
    unlinkSync(projectDir);
    renameSync(join(elsewhere, 'cwd-key'), projectDir);
    expect(restoreRewoundTranscript(path, cut, scope)).toBe(true);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe('rewindClaudeTranscript backup: removed', () => {
  it('backs up only the cut bytes and leaves whole lines behind', () => {
    const path = fixture([...history, prompt('继续', 'u1'), apiError(), turnDuration]);
    const before = readFileSync(path);
    const { offset } = inspectLastClaudeTurn(path);
    const result = rewindClaudeTranscript(path, offset!, Date.UTC(2026, 10, 16, 14, 21), { backup: 'removed' });
    expect(result.backupPath).toMatch(/\.rewind-2026-11-16T14-21-00-000Z\.removed\.bak$/);
    expect(readFileSync(result.backupPath).equals(before.subarray(offset))).toBe(true);
    expect(statSync(path).size).toBe(offset);
    expect(readFileSync(path).equals(before.subarray(0, offset))).toBe(true);
    expect(inspectLastClaudeTurn(path).outcome).toBe('progress');
  });
});
