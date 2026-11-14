import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { ReplyDeliveryStore } from '../src/services/reply-delivery-store.js';
import { sendFileAttachments, sendVideoAttachments } from '../src/cli/send-dispatch.js';
import { renderQuotedMessage } from '../src/cli/quoted-render.js';
import * as atomicWrite from '../src/utils/atomic-write.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const APP = 'cli_reply_adversarial';
const MAIN = 'om_main';
const CHAT = 'oc_chat';
let directory: string;
let store: ReplyDeliveryStore;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  directory = mkdtempSync(join(tmpdir(), 'reply-delivery-adversarial-'));
  store = new ReplyDeliveryStore(directory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function recordPath(): string {
  const folder = join(directory, 'attachments', APP, 'deliveries');
  return join(folder, readdirSync(folder).find(name => name.endsWith('.json'))!);
}
const quoted = () => renderQuotedMessage(APP, {
  message_id: MAIN, chat_id: CHAT, msg_type: 'text', body: { content: '{"text":"main evidence"}' },
}, async () => ({ extraResources: [] }), undefined, undefined, new ReplyDeliveryStore(directory));

function childCompletion(child: ChildProcess) {
  let stdout = '', stderr = '';
  child.stdout!.on('data', data => { stdout += data; });
  child.stderr!.on('data', data => { stderr += data; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
function launch(script: string, args: string[] = []) {
  return spawnTsScript(script, args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, SESSION_DATA_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('reply delivery persistence under interference', () => {
  it.each(['primary receipt', 'duplicate slot'] as const)('degrades a manually introduced %s while keeping the main evidence readable', async mutation => {
    const id = store.begin(APP, MAIN, CHAT, [
      { path: 'accepted.csv', type: 'file' }, { path: 'waiting.txt', type: 'file' },
    ]);
    store.record(APP, MAIN, CHAT, id, 0, { messageId: 'om_attachment' });
    vi.advanceTimersByTime(1000);
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (mutation === 'primary receipt') record.attachments[0].messageId = MAIN;
    else record.attachments[1].index = record.attachments[0].index;
    record.updatedAt = Date.now();
    writeFileSync(path, JSON.stringify(record));

    const rendered = await quoted();
    expect(rendered.content).toContain('main evidence');
    expect(rendered.delivery).toBeUndefined();
    expect(rendered.deliveryError).toBe('unavailable');
  });

  it('keeps accepted history and records the new failure when authority is revoked during upload', async () => {
    const old = store.begin(APP, MAIN, CHAT, [{ path: 'old.csv', type: 'file' }]);
    store.record(APP, MAIN, CHAT, old, 0, { messageId: 'om_old' });
    const next = store.begin(APP, MAIN, CHAT, [{ path: 'waiting.txt', type: 'file' }]);
    let allowed = true;
    const dispatch = vi.fn(async () => 'om_should_not_send');
    const sending = sendFileAttachments({
      beforeEffect: () => { if (!allowed) throw new Error('authority revoked'); },
      uploadFile: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return 'file_key'; },
      dispatch,
      onResult: (index, outcome) => store.record(APP, MAIN, CHAT, next, index, outcome),
    }, APP, ['waiting.txt']);
    await vi.advanceTimersByTimeAsync(50);
    allowed = false;
    await vi.advanceTimersByTimeAsync(100);
    const result = await sending;
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.sent).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect((await quoted()).delivery?.attachments).toMatchObject([
      { status: 'sent', messageId: 'om_old' }, { status: 'failed', errorCode: 'attachment_delivery_failed' },
    ]);
  });

  it('ignores an old failure arriving after a new delivery and survives reopen', async () => {
    const first = store.begin(APP, MAIN, CHAT, [{ path: 'first.txt', type: 'file' }]);
    store.record(APP, MAIN, CHAT, first, 0, { messageId: 'om_first' });
    setTimeout(() => store.record(APP, MAIN, CHAT, first, 0, { failed: true }), 30_000);
    await vi.advanceTimersByTimeAsync(1000);
    const second = store.begin(APP, MAIN, CHAT, [{ path: 'second.txt', type: 'file' }]);
    store.record(APP, MAIN, CHAT, second, 0, { messageId: 'om_second' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await quoted()).delivery?.attachments.map(item => item.messageId)).toEqual(['om_first', 'om_second']);
    expect(new ReplyDeliveryStore(directory).read(APP, MAIN, CHAT)?.attachments.every(item => item.status === 'sent')).toBe(true);
  });

  it.each(['file', 'media'] as const)('retains provider success when the %s metadata write commits and then reports failure', async type => {
    const id = store.begin(APP, MAIN, CHAT, [{ path: type === 'file' ? 'data.csv' : 'video.mp4', type }]);
    const actualWrite = atomicWrite.atomicWriteFileSync;
    vi.spyOn(atomicWrite, 'atomicWriteFileSync').mockImplementationOnce((...args) => {
      actualWrite(...args);
      throw new Error('post-rename EIO');
    });
    const onResult = (index: number, outcome: { messageId: string } | { failed: true }) => store.record(APP, MAIN, CHAT, id, index, outcome);
    const dispatch = vi.fn(async () => `om_${type}`);
    const result = type === 'file'
      ? await sendFileAttachments({ uploadFile: async () => 'file_key', dispatch, onResult }, APP, ['data.csv'])
      : await sendVideoAttachments({ uploadFile: async () => 'file_key', uploadImage: async () => 'cover_key', dispatch, onResult }, APP,
        [{ videoPath: 'video.mp4', coverPath: 'cover.png', durationMs: 1 }]);
    expect(result.sent).toEqual([`om_${type}`]);
    expect(result.failed).toEqual([]);
    expect(result.trackingErrors).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(new ReplyDeliveryStore(directory).read(APP, MAIN, CHAT)?.attachments[0]).toMatchObject({ status: 'sent', messageId: `om_${type}` });
  });

  it('keeps the unrecorded provider result pending after the sending process exits', async () => {
    store.begin(APP, MAIN, CHAT, [{ path: 'first.txt', type: 'file' }, { path: 'second.txt', type: 'file' }]);
    const script = join(directory, 'crash.mts');
    writeFileSync(script, `import { sendFileAttachments } from ${JSON.stringify(new URL('../src/cli/send-dispatch.ts', import.meta.url).href)};
await sendFileAttachments({
  uploadFile: async () => 'file_key',
  dispatch: async () => { process.stdout.write('provider:om_before_crash\\n'); return 'om_before_crash'; },
  onResult: () => process.exit(31),
}, ${JSON.stringify(APP)}, ['first.txt', 'second.txt']);
`);
    const result = await childCompletion(launch(script));
    expect(result.code, result.stderr).toBe(31);
    expect(result.stdout).toContain('provider:om_before_crash');
    vi.advanceTimersByTime(60_000);
    expect((await quoted()).delivery?.attachments.map(item => ({ status: item.status, messageId: item.messageId }))).toEqual([
      { status: 'pending', messageId: undefined }, { status: 'pending', messageId: undefined },
    ]);
  }, 30_000);

  it('retains both receipts from two processes released through one barrier', async () => {
    const id = store.begin(APP, MAIN, CHAT, [{ path: 'a.csv', type: 'file' }, { path: 'b.csv', type: 'file' }]);
    const script = join(directory, 'writer.mts');
    writeFileSync(script, `import { ReplyDeliveryStore } from ${JSON.stringify(new URL('../src/services/reply-delivery-store.ts', import.meta.url).href)};
const [directory, deliveryId, index, messageId] = process.argv.slice(2);
process.stdin.once('data', () => {
  new ReplyDeliveryStore(directory).record(${JSON.stringify(APP)}, ${JSON.stringify(MAIN)}, ${JSON.stringify(CHAT)}, deliveryId, Number(index), { messageId });
  process.stdout.write('done\\n');
  process.exit(0);
});
process.stdout.write('ready\\n');
`);
    const children = [launch(script, [directory, id, '0', 'om_a']), launch(script, [directory, id, '1', 'om_b'])];
    const completions = children.map(childCompletion);
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', () => resolve());
    })));
    for (const child of children) child.stdin!.end('go\n');
    for (const result of await Promise.all(completions)) expect(result.code, result.stderr).toBe(0);
    expect(new ReplyDeliveryStore(directory).read(APP, MAIN, CHAT)?.attachments.map(item => item.messageId)).toEqual(['om_a', 'om_b']);
  }, 30_000);

  it('refuses a conflicting late success without losing the first accepted receipt', () => {
    const id = store.begin(APP, MAIN, CHAT, [{ path: 'a.csv', type: 'file' }]);
    store.record(APP, MAIN, CHAT, id, 0, { messageId: 'om_accepted' });
    vi.advanceTimersByTime(30_000);
    expect(() => new ReplyDeliveryStore(directory).record(APP, MAIN, CHAT, id, 0, { messageId: 'om_conflict' })).toThrow('Conflicting attachment receipt');
    expect(store.read(APP, MAIN, CHAT)?.attachments[0]).toMatchObject({ status: 'sent', messageId: 'om_accepted' });
  });
});
