import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBotClient: () => ({ request }),
}));
import { config } from '../src/config.js';
import { ProtectedResultStore, PROTECTED_RESULT_PLACEHOLDER } from '../src/services/protected-result-store.js';
import { getMessageDetail, listChatMessages, downloadMessageResource } from '../src/im/lark/client.js';
import { parseEventMessage, resolveMergedCardContent } from '../src/im/lark/message-parser.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { readQuotedMessages } from '../src/cli/quoted-read.js';
import { readHistoryMessages, parseHistoryReadOptions } from '../src/cli/history-read.js';

let root: string; let previous: string;
const secret = 'SYNTHETIC_BUSINESS_RESULT_7261';
const ctx = { appId: 'cli_writer', pluginId: 'synthetic', sessionId: 'session_one',
  turnId: 'om_turn', ownerUnionId: 'on_owner', chatId: 'oc_sensitive' };
function message(id: string, type: string, content: unknown, chat = ctx.chatId) {
  return { message_id: id, msg_type: type, chat_id: chat, create_time: '1700000000000', root_id: 'om_root',
    sender: { id: 'ou_sender', sender_type: 'user' }, body: { content: JSON.stringify(content) },
    alternateRepresentation: { secret } };
}
const card = () => message('om_primary', 'interactive', { body: { elements: [{ tag: 'markdown', content: secret }] } });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'protected-reads-'));
  previous = config.session.dataDir; config.session.dataDir = root;
  vi.stubEnv('SESSION_DATA_DIR', root);
  const store = new ProtectedResultStore(root);
  store.begin(ctx, 'delivery_abcdefgh', createHash('sha256').update('synthetic').digest('hex'));
  store.update(ctx, 'delivery_abcdefgh', { resource: 'file_sensitive' });
  store.update(ctx, 'delivery_abcdefgh', { message: { messageId: 'om_file', kind: 'attachment' } });
  store.update(ctx, 'delivery_abcdefgh', { message: { messageId: 'om_primary', kind: 'primary' } });
  store.update(ctx, 'delivery_abcdefgh', { status: 'delivered' });
  request.mockReset();
});
afterEach(() => { config.session.dataDir = previous; vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('protected result reads through production IM clients', () => {
  it('redacts single-message representations across reading applications', async () => {
    request.mockResolvedValue({ code: 0, data: { items: [card()] } });
    for (const app of ['cli_writer', 'cli_other_reader']) {
      const result = await getMessageDetail(app, 'om_primary');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.items[0].body.content).toContain(PROTECTED_RESULT_PLACEHOLDER);
      expect(result.items[0]).not.toHaveProperty('alternateRepresentation');
    }
  });
  it('filters before full/index history search and raw card expansion, preserving ordinary text', async () => {
    request.mockResolvedValue({ code: 0, data: { items: [card(), message('om_ordinary', 'text', { text: 'ordinary message' })], has_more: false } });
    const rows = await listChatMessages('cli_other_reader', ctx.chatId, 50);
    const deps = { expandMergeForward, resolveMergedCard: resolveMergedCardContent };
    for (const flags of [[], ['--view', 'index']]) {
      const output = await readHistoryMessages('cli_other_reader', rows, parseHistoryReadOptions(flags), false, deps);
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(JSON.stringify(output)).toContain('ordinary message');
      const filtered = await readHistoryMessages('cli_other_reader', rows, parseHistoryReadOptions([...flags, '--query', secret]), false, deps);
      expect(filtered.messages).toHaveLength(0);
    }
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('blocks quoted --raw and attachment expansion without downloading or revealing filenames', async () => {
    request.mockResolvedValue({ code: 0, data: { items: [card()] } });
    const downloadResources = vi.fn(async () => ({ attachments: [] }));
    const output = await readQuotedMessages('cli_other_reader', {
      messageIds: ['om_primary'], batch: false, raw: true, download: true,
    }, { getMessageDetail, expandMergeForward, resolveMergedCard: resolveMergedCardContent,
      downloadResources, decorate: async message => message });
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain('file_sensitive');
    expect(downloadResources).not.toHaveBeenCalled();
  });
  it('refuses direct resource downloads before a resource API request or filesystem write', async () => {
    request.mockResolvedValue({ code: 0, data: { items: [message('om_file', 'file', { file_key: 'file_sensitive', file_name: `${secret}.xlsx` })] } });
    const output = join(root, 'must-not-exist.xlsx');
    await expect(downloadMessageResource('cli_other_reader', 'om_file', 'file_sensitive', 'file', output)).rejects.toThrow(/read_denied/);
    expect(existsSync(output)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0].url)).not.toContain('/resources/');
  });
  it('redacts opaque forwarded input and copied resource keys before automatic prompt parsing', () => {
    for (const [type, content] of [
      ['merge_forward', { items: [card()] }],
      ['file', { file_key: 'file_sensitive', file_name: `${secret}.xlsx` }],
    ] as const) {
      const result = parseEventMessage({ sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
        message: { message_id: 'om_copy', chat_id: 'oc_other', message_type: type,
          content: JSON.stringify(content), create_time: '1700000000000' } });
      expect(result.resources).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('file_sensitive');
    }
  });
});
