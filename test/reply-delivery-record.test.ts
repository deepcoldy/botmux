import { mkdtempSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyDeliveryStore } from '../src/services/reply-delivery-store.js';
import { sendFileAttachments, sendVideoAttachments } from '../src/cli/send-dispatch.js';
import { renderQuotedMessage } from '../src/cli/quoted-render.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'reply-delivery-')); roots.push(root);
  return { root, store: new ReplyDeliveryStore(root) };
}
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const app = 'cli_test', main = 'om_main', chat = 'oc_test';
const files = ['/evidence/list.csv', '/evidence/list.txt'];
describe('reply evidence delivery records', () => {
  it('keeps actual sent and failed results discoverable from the quoted main message after restart', async () => {
    const { root, store } = setup();
    const deliveryId = store.begin(app, main, chat, files.map(path => ({ path, type: 'file' })));
    const result = await sendFileAttachments({ uploadFile: async (_app, path) => {
      if (path.endsWith('.txt')) throw new Error('upload failed at /private/path'); return 'file_key';
    }, dispatch: async () => 'om_csv', onResult: (index, outcome) => store.record(app, main, chat, deliveryId, index, outcome) }, app, files);
    expect(result.sent).toEqual(['om_csv']); expect(result.failed).toHaveLength(1);
    const rendered = await renderQuotedMessage(app, { message_id: main, chat_id: chat, msg_type: 'text', body: { content: JSON.stringify({ text: '结论' }) } },
      async () => ({ extraResources: [] }), undefined, undefined, new ReplyDeliveryStore(root));
    expect(rendered.delivery?.attachments).toMatchObject([
      { name: 'list.csv', status: 'sent', messageId: 'om_csv' }, { name: 'list.txt', status: 'failed' },
    ]);
    expect(JSON.stringify(rendered.delivery)).not.toContain('/evidence');
    expect(JSON.stringify(rendered.delivery)).not.toContain('/private');
    expect(rendered.resources).toEqual([]);
  });
  it('a second delivery and late failures preserve earlier accepted receipts', () => {
    const { store } = setup();
    const first = store.begin(app, main, chat, [{ path: files[0], type: 'file' }]);
    store.record(app, main, chat, first, 0, { messageId: 'om_first' });
    const second = store.begin(app, main, chat, [{ path: files[1], type: 'file' }]);
    store.record(app, main, chat, second, 0, { messageId: 'om_second' });
    store.record(app, main, chat, first, 0, { failed: true });
    expect(store.read(app, main, chat)?.attachments.map(item => item.messageId)).toEqual(['om_first', 'om_second']);
    expect(() => store.record(app, main, chat, first, 0, { messageId: 'om_conflict' })).toThrow();
  });
  it('keeps interrupted slots unconfirmed after restart and isolates app/chat identities', () => {
    const { root, store } = setup();
    vi.useFakeTimers(); vi.setSystemTime(1000);
    store.begin(app, main, chat, [{ path: 'waiting.txt', type: 'file' }]);
    vi.setSystemTime(600000);
    expect(new ReplyDeliveryStore(root).read(app, main, chat)?.attachments[0].status).toBe('pending');
    expect(store.read('cli_other', main, chat)).toBeUndefined();
    expect(() => store.read(app, main, 'oc_other')).toThrow();
    expect(() => store.begin('../escape', main, chat, [])).toThrow();
  });
  it('reports metadata failure separately without dropping successful provider sends', async () => {
    const { root, store } = setup();
    const id = store.begin(app, main, chat, files.map(path => ({ path, type: 'file' })));
    const dir = join(root, 'attachments', app, 'deliveries'), saved = join(root, 'saved');
    let sent = 0;
    const result = await sendFileAttachments({ uploadFile: async () => 'key', dispatch: async () => {
      sent++;
      if (sent === 2) { renameSync(dir, saved); writeFileSync(dir, 'blocked'); }
      return `om_file_${sent}`;
    }, onResult: (index, outcome) => store.record(app, main, chat, id, index, outcome) }, app, files);
    expect(result.sent).toEqual(['om_file_1', 'om_file_2']); expect(result.failed).toEqual([]);
    expect(result.trackingErrors).toHaveLength(1);
    rmSync(dir); renameSync(saved, dir);
    expect(store.read(app, main, chat)?.attachments.map(item => item.status)).toEqual(['sent', 'pending']);
  });
  it('records video receipts and still returns success when the result callback fails', async () => {
    const result = await sendVideoAttachments({ uploadFile: async () => 'file', uploadImage: async () => 'cover',
      dispatch: async () => 'om_video', onResult: () => { throw new Error('EIO'); } }, app,
      [{ videoPath: 'video.mp4', coverPath: 'cover.png', durationMs: 1 }]);
    expect(result.sent).toEqual(['om_video']); expect(result.failed).toEqual([]); expect(result.trackingErrors).toHaveLength(1);
  });
  it('degrades a corrupt association record while retaining the main message text', async () => {
    const { root, store } = setup();
    store.begin(app, main, chat, [{ path: 'a.txt', type: 'file' }]);
    const { readdirSync } = await import('node:fs');
    const dir = join(root, 'attachments', app, 'deliveries');
    writeFileSync(join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!), '{');
    const rendered = await renderQuotedMessage(app, { message_id: main, chat_id: chat, msg_type: 'text', body: { content: '{"text":"main evidence"}' } },
      async () => ({ extraResources: [] }), undefined, undefined, store);
    expect(rendered.content).toContain('main evidence'); expect(rendered.deliveryError).toBe('unavailable');
  });
});
