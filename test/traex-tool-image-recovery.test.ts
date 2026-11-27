import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTraexToolImageUploadError, purgeTraexToolImages, resolveTraexImagePurgeTarget } from '../src/services/traex-tool-image-recovery.js';
import { appendTraexImageRecoveryAction } from '../src/im/lark/traex-image-recovery-card.js';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { codexTaskFailureCode } from '../src/services/codex-transcript.js';
import { planPurgeRequest, purgeOutcomeNotice, runPurgeMaintenance } from '../src/services/image-purge-recovery.js';

const SID = '00000000-0000-7000-8000-000000000001';
const ERROR = 'failed to resolve image resource: tool image upload failed; retry the request';
const image = { type: 'input_image', image_url: `traex-rollout-blob:v1:sha256:${'a'.repeat(64)}:image/png`, detail: 'original' };
const writeFault = vi.hoisted(() => ({ mutate: '', partial: '', fired: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const paths = new Map<number, string>();
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { paths.delete(fd); fs.closeSync(fd); },
    writeFileSync: (file: any, data: any, options?: any) => {
      const name = typeof file === 'number' ? paths.get(file) ?? '' : String(file);
      if (!writeFault.fired && writeFault.partial && name.includes(writeFault.partial)) {
        writeFault.fired = true;
        fs.writeFileSync(file, Buffer.from(data).subarray(0, 20), options);
        throw new Error('injected partial write');
      }
      fs.writeFileSync(file, data, options);
      if (writeFault.mutate && name.includes('.tmp-tool-images-')) {
        fs.appendFileSync(writeFault.mutate, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new input' } }) + '\n');
        writeFault.mutate = '';
      }
    },
  };
});
let dir: string;
let path: string;
beforeEach(() => {
  writeFault.mutate = ''; writeFault.partial = ''; writeFault.fired = false;
  dir = mkdtempSync(join(tmpdir(), 'botmux-tool-images-'));
  path = join(dir, `rollout-2026-11-25T00-00-00-${SID}.jsonl`);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function transcript() {
  return [
    { ordinal: 0, type: 'session_meta', payload: { id: SID } },
    { ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep the task 中文' }, image] } },
    { ordinal: 2, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'tool-1', output: [{ type: 'input_text', text: 'already committed' }, image] } },
    { ordinal: 3, _trae_batch: { start: 0, index: 0, len: 1 }, type: 'event_msg', payload: { type: 'token_count', info: { total_tokens: 123 } } },
  ].map(row => JSON.stringify(row) + '\n').join('');
}
function purge(dryRun = false) {
  return purgeTraexToolImages(resolveTraexImagePurgeTarget(path)!, { trustedSessionsRoot: dir, dryRun });
}

describe('TRAE tool image upload classification', () => {
  it('recognizes the observed bad_request terminal and wrapped native errors', () => {
    const error = { message: ERROR, codex_error_info: 'bad_request' };
    expect(isTraexToolImageUploadError(error)).toBe(true);
    expect(isTraexToolImageUploadError({ error: JSON.stringify(error) })).toBe(true);
    writeFileSync(path, JSON.stringify({ type: 'event_msg', timestamp: '2026-11-25T00:00:00Z', payload: { type: 'user_message', message: 'continue', images: [] } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: '2026-11-25T00:00:01Z', payload: { type: 'task_complete', turn_id: '00000000-0000-7000-8000-000000000010', last_agent_message: null, error } }) + '\n');
    const drained = drainTraexRollout(path, 0);
    expect(drained.events).toEqual(expect.arrayContaining([expect.objectContaining({ terminalStatus: 'failed', terminalErrorCode: 'traex_tool_image_upload_failed' })]));
    expect(codexTaskFailureCode(error)).toBe('codex_task_failed');
  });
  it.each([null, { message: 'invalid request' }, { message: `User quoted: ${ERROR}` }, { output: ERROR }, { message: 'tool image upload succeeded' }])('does not classify unrelated data %j', error => {
    expect(isTraexToolImageUploadError(error)).toBe(false);
  });
});

describe('explicit transcript repair', () => {
  it('keeps text, user images, receipts, ordinals and every following byte offset, with a complete backup', () => {
    const before = transcript(); writeFileSync(path, before);
    const result = purge();
    expect(result.removed).toBe(1);
    expect(result.failedFiles).toEqual([]);
    expect(readFileSync(result.files[0].backup!, 'utf8')).toBe(before);
    const after = readFileSync(path, 'utf8');
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    const oldLines = before.trimEnd().split('\n'); const newLines = after.trimEnd().split('\n');
    expect(newLines.map(line => Buffer.byteLength(line))).toEqual(oldLines.map(line => Buffer.byteLength(line)));
    const rows = newLines.map(line => JSON.parse(line));
    expect(rows[1]).toEqual(JSON.parse(oldLines[1]));
    expect(rows[2].payload.call_id).toBe('tool-1');
    expect(rows[2].payload.output[0].text).toBe('already committed');
    expect(rows[2].payload.output[1].type).toBe('input_text');
    expect(rows[3]).toEqual(JSON.parse(oldLines[3]));
    expect(purge().removed).toBe(0);
    expect(readdirSync(dir).filter(name => name.includes('.botmux-tool-images-bak-'))).toHaveLength(1);
  });
  it('dry-runs without modifying the transcript or making a backup', () => {
    const before = transcript(); writeFileSync(path, before);
    expect(purge(true).removed).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toHaveLength(1);
  });
  it('refuses a repair that would grow a native line instead of shifting or corrupting later records', () => {
    const before = transcript().replace(JSON.stringify(image), JSON.stringify({ type: 'input_image', image_url: 'x' }));
    // Replace the tool image as well (the first occurrence is a user image).
    const short = before.replace(JSON.stringify(image), JSON.stringify({ type: 'input_image', image_url: 'x' }));
    writeFileSync(path, short);
    const result = purge();
    expect(result.removed).toBe(0);
    expect(result.failedFiles).not.toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe(short);
  });
  it('preserves a concurrent append rather than replacing a newer transcript', () => {
    const before = transcript(); writeFileSync(path, before); writeFault.mutate = path;
    const result = purge();
    expect(result.removed).toBe(0);
    expect(result.failedFiles).not.toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toContain(before);
    expect(readFileSync(path, 'utf8')).toContain('new input');
  });
  it.each(['.botmux-tool-images-bak-', '.tmp-tool-images-'])('keeps the original recoverable after a partial %s write', part => {
    const before = transcript(); writeFileSync(path, before); writeFault.partial = part;
    expect(purge().removed).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
    writeFault.partial = '';
    const repaired = purge();
    expect(repaired.removed).toBe(1);
    expect(readFileSync(repaired.files[0].backup!, 'utf8')).toBe(before);
  });
  it('repairs tool-output copies in native history snapshots', () => {
    const before = transcript() + JSON.stringify({ type: 'event_msg', payload: { type: 'history', items: [{ type: 'function_call_output', call_id: 'tool-copy', output: [image] }] } }) + '\n';
    writeFileSync(path, before);
    expect(purge().removed).toBe(2);
  });
  it.each(['malformed', 'partial', 'wrong session', 'missing metadata'])('leaves the whole transcript untouched for %s', kind => {
    let before = transcript();
    if (kind === 'malformed') before += '{broken}\n';
    if (kind === 'partial') before = before.slice(0, -1);
    if (kind === 'wrong session') before = before.replace(SID, '11111111-1111-7111-8111-111111111111');
    if (kind === 'missing metadata') before = before.slice(before.indexOf('\n') + 1);
    writeFileSync(path, before);
    expect(purge().removed).toBe(0);
    expect(purge().failedFiles).not.toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('rejects symlinked files and symlinked child directories', () => {
    const real = join(dir, 'outside.jsonl'); writeFileSync(real, transcript()); symlinkSync(real, path);
    expect(purge().failedFiles).not.toHaveLength(0);
    rmSync(path);
    const outside = join(dir, 'outside'); mkdirSync(outside);
    const linked = join(dir, 'link'); symlinkSync(outside, linked);
    const nested = join(linked, path.split('/').pop()!); writeFileSync(nested, transcript());
    expect(purgeTraexToolImages(resolveTraexImagePurgeTarget(nested)!, { trustedSessionsRoot: dir }).failedFiles).not.toHaveLength(0);
    expect(readFileSync(real, 'utf8')).toBe(transcript());
  });
  it('rejects paths outside the pinned sessions root and excessive read budgets', () => {
    writeFileSync(path, transcript());
    const inside = join(dir, 'inside'); mkdirSync(inside);
    expect(purgeTraexToolImages(resolveTraexImagePurgeTarget(path)!, { trustedSessionsRoot: inside }).removed).toBe(0);
    expect(purgeTraexToolImages(resolveTraexImagePurgeTarget(path)!, { trustedSessionsRoot: dir, maxReadBytes: 1 }).removed).toBe(0);
  });
  it('waits for CLI exit and only continues a successful repair and respawn', async () => {
    writeFileSync(path, transcript());
    const target = resolveTraexImagePurgeTarget(path)!;
    const plan = planPurgeRequest({ cliId: 'traex', repairKind: 'traex_tool_images', localOwnedSession: true, target, restartInProgress: false, childPid: 1, sandboxMode: 'off', platform: 'darwin', scan: () => purge(true) });
    expect(plan.kind).toBe('proceed');
    const blockedPurge = vi.fn(() => purge());
    const refused = await runPurgeMaintenance({ waitForQuiescence: async () => { throw new Error('still alive'); }, purge: blockedPurge });
    expect(blockedPurge).not.toHaveBeenCalled();
    expect(purgeOutcomeNotice(refused, 'spawned').deliverContinuation).toBe(false);
    const success = await runPurgeMaintenance({ waitForQuiescence: async () => {}, purge: () => purge() });
    expect(purgeOutcomeNotice(success, 'spawned').deliverContinuation).toBe(true);
    expect(purgeOutcomeNotice(success, 'superseded').deliverContinuation).toBe(false);
    expect(purgeOutcomeNotice(success, 'failed').deliverContinuation).toBe(false);
  });
});

describe('TRAE recovery card', () => {
  const base = JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'failure' }] } });
  const input = { cliId: 'traex', errorCode: 'traex_tool_image_upload_failed', localOwnedSession: true, rootId: 'om_root', sessionId: SID, turnId: 'om_failed' };
  it('binds the explicit repair to the exact failed turn and preserves the existing card', () => {
    const card = JSON.parse(appendTraexImageRecoveryAction(base, input));
    expect(card.body.elements[0]).toEqual(JSON.parse(base).body.elements[0]);
    expect(card.body.elements[1].columns[0].elements[0].behaviors[0].value).toMatchObject({ action: 'purge_images_continue', image_kind: 'traex_tool_images', turn_id: 'om_failed', session_id: SID });
  });
  it.each([{ cliId: 'codex' }, { localOwnedSession: false }, { errorCode: 'codex_connection_failed' }, { turnId: '' }])('does not offer repair for unsupported sessions %j', override => {
    expect(appendTraexImageRecoveryAction(base, { ...input, ...override })).toBe(base);
  });
});
