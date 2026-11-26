import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureTraexPromptCheckpoint, inspectTraexFailedPrompt, withTraexFailedPrompt } from '../src/services/traex-prompt-checkpoint.js';
import { planFailedTurnRewind, runFailedTurnRewindMaintenance } from '../src/core/failed-turn-rewind.js';
import { restoreRewoundTranscript, withOpenTranscript } from '../src/core/context-rewind.js';

const SID = '00000000-0000-7000-8000-000000000001';
const row = (type: string, payload: unknown): string => JSON.stringify({ type, payload }) + '\n';
const prefix = row('session_meta', { id: SID }) + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier work' }] })
  + row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier work complete' }] });
const input = '<user_message>\nDescribe café 图片\n</user_message>';
const user = row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: input }, { type: 'input_image', image_url: 'test-image' }] });
const failed = row('event_msg', { type: 'task_complete', last_agent_message: null, error: { message: 'tool image upload failed' } });
let root: string; let path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'botmux-prompt-checkpoint-')); mkdirSync(join(root, 'backups')); path = join(root, `rollout-test-${SID}.jsonl`); writeFileSync(path, prefix); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function setup(extra = '') {
  const checkpoint = captureTraexPromptCheckpoint(path, root)!;
  appendFileSync(path, user + extra + failed);
  return checkpoint;
}
describe('TRAE saved prompt boundary', () => {
  it('cuts only the failed input, keeps earlier work, and can restore the cut', async () => {
    const checkpoint = setup();
    const before = readFileSync(path);
    const inspection = inspectTraexFailedPrompt(path, root, checkpoint, input);
    expect(inspection.outcome).toBe('error_only');
    const outcome = await runFailedTurnRewindMaintenance({
      waitForQuiescence: async () => {}, planned: inspection as { offset: number; uuid: string }, failedInput: input,
      messageStillQueued: () => true,
      withTranscript: use => withTraexFailedPrompt(path, root, { backupDir: join(root, 'backups') }, checkpoint, input, use),
    });
    expect(outcome.kind).toBe('rewound');
    expect(readFileSync(path, 'utf8')).toBe(prefix);
    if (outcome.kind !== 'rewound') throw new Error('expected a cut');
    expect(restoreRewoundTranscript(path, { ...outcome.result, offset: checkpoint.offset, removed: outcome.result.removed! }, { writableTreeRoot: root })).toBe(true);
    expect(readFileSync(path)).toEqual(before);
  });
  it.each([
    row('response_item', { type: 'custom_tool_call', name: 'exec_command' }),
    row('response_item', { type: 'custom_tool_call_output', output: [] }),
    row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'started work' }] }),
    row('event_msg', { type: 'agent_message', message: 'sent a message' }),
    row('compacted', { message: 'summary' }),
    user,
    row('something_new', {}),
  ])('declines output, tools, compaction, repeated input and unknown records %s', extra => {
    const checkpoint = setup(extra);
    expect(inspectTraexFailedPrompt(path, root, checkpoint, input).outcome).toBe('other');
  });
  it('accepts the native user-message mirror and rejects a second same-text turn', () => {
    const checkpoint = captureTraexPromptCheckpoint(path, root)!;
    const mirror = row('event_msg', { type: 'user_message', message: input });
    appendFileSync(path, mirror + failed);
    expect(inspectTraexFailedPrompt(path, root, checkpoint, input).outcome).toBe('error_only');
    appendFileSync(path, mirror);
    expect(inspectTraexFailedPrompt(path, root, checkpoint, input).outcome).toBe('other');
  });
  it('never trusts an altered prefix, wrong input, partial tail or wrong identity', () => {
    const checkpoint = setup();
    expect(inspectTraexFailedPrompt(path, root, checkpoint, 'different').outcome).toBe('other');
    writeFileSync(path, readFileSync(path, 'utf8').replace('earlier work', 'changed work'));
    expect(inspectTraexFailedPrompt(path, root, checkpoint, input).outcome).toBe('other');
    writeFileSync(path, prefix + user + failed.trimEnd());
    expect(inspectTraexFailedPrompt(path, root, checkpoint, input).outcome).toBe('other');
    expect(inspectTraexFailedPrompt(path, root, { ...checkpoint, sessionId: 'wrong' }, input).outcome).toBe('other');
  });
  it('refuses capture through a symlink or outside the pinned root', () => {
    const linked = join(root, `rollout-link-${SID}.jsonl`); symlinkSync(path, linked);
    expect(captureTraexPromptCheckpoint(linked, root)).toBeUndefined();
    expect(captureTraexPromptCheckpoint(path, join(root, 'other'))).toBeUndefined();
  });
  it.each(['exit', 'stop', 'append'])('keeps the failed input when %s invalidates the cut', async cause => {
    const checkpoint = setup(); const before = readFileSync(path);
    const planned = inspectTraexFailedPrompt(path, root, checkpoint, input) as { offset: number; uuid: string };
    const result = await runFailedTurnRewindMaintenance({ planned, failedInput: input,
      waitForQuiescence: async () => { if (cause === 'exit') throw new Error('still running'); if (cause === 'append') appendFileSync(path, user); },
      messageStillQueued: () => cause !== 'stop',
      withTranscript: use => withTraexFailedPrompt(path, root, { backupDir: join(root, 'backups') }, checkpoint, input, use),
    });
    expect(result.kind).toBe('declined');
    expect(readFileSync(path).subarray(0, before.length)).toEqual(before);
  });
  it('makes an edited retry use the replacement prompt and an explicit checkpoint requirement', () => {
    const checkpoint = setup();
    const directive = planFailedTurnRewind({ record: { turnId: 'failed', userPrompt: 'old', cliInput: input,
      failedAt: new Date().toISOString(), retryCount: 0, status: 'failed', directFailure: true,
      retryable: false, errorCode: 'traex_tool_image_upload_failed', traexPromptCheckpoint: checkpoint },
      turnId: 'retry', mode: 'edit', content: 'edited prompt' });
    expect(directive).toMatchObject({ content: 'edited prompt', failedInput: input, requireRewind: true });
  });
  it('refuses a same-size modification between descriptor inspection and cut', () => {
    setup();
    withOpenTranscript(path, { writableTreeRoot: root, backupDir: join(root, 'backups') }, transcript => {
      transcript.read(1 << 20);
      writeFileSync(path, readFileSync(path, 'utf8').replace('Earlier work complete', 'Changed work complete'));
      expect(() => transcript.cut(Buffer.byteLength(prefix))).toThrow('transcript changed after inspection');
    });
  });
  it('refuses to restore a cut over native work appended by a replacement', () => {
    const checkpoint = setup();
    const result = withTraexFailedPrompt(path, root, { backupDir: join(root, 'backups') }, checkpoint, input, transcript => transcript.cut(checkpoint.offset));
    appendFileSync(path, row('response_item', { type: 'custom_tool_call', name: 'exec_command' }));
    const before = readFileSync(path);
    expect(restoreRewoundTranscript(path, { ...result, offset: checkpoint.offset, removed: result.removed! }, { writableTreeRoot: root, requireUnchangedTail: true })).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  });
});
