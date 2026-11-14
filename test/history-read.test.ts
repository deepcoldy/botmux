import { describe, it, expect, vi } from 'vitest';
import { parseHistoryReadOptions, parseQuotedReadOptions, readHistoryMessages } from '../src/cli/history-read.js';
import type { ExpandMergeForwardFn, ResolveMergedCardFn } from '../src/cli/quoted-render.js';

const message = (id: string, type: string, content: unknown, time = 1_700_000_000_000) => ({
  message_id: id, msg_type: type, create_time: String(time), root_id: 'om_root',
  sender: { id: 'ou_sender', sender_type: 'user' },
  body: { content: typeof content === 'string' ? content : JSON.stringify(content) },
});
const deps = () => ({
  expandMergeForward: vi.fn<ExpandMergeForwardFn>(async () => ({ extraResources: [] })),
  resolveMergedCard: vi.fn<ResolveMergedCardFn>(async () => null),
});

describe('history read views', () => {
  it('keeps the default full text and resource keys', async () => {
    const result = await readHistoryMessages('app', [message('om_text', 'text', { text: 'complete '.repeat(100) }), message('om_img', 'image', { image_key: 'img_key' })], parseHistoryReadOptions([]), false, deps());
    expect(result.messages[0]).toMatchObject({ messageId: 'om_text', content: 'complete '.repeat(100).trim() });
    expect(result.messages[1]).toMatchObject({ resources: [{ type: 'image', key: 'img_key' }] });
  });

  it('returns bounded Unicode previews and a resource index without detail reads', async () => {
    const d = deps();
    const input = [message('om_text', 'text', { text: '😀'.repeat(400) }), message('om_card', 'interactive', { body: { elements: [{ tag: 'markdown', content: '请升级至最新版本客户端，以查看内容' }] } }), message('om_forward', 'merge_forward', {}), message('om_img', 'image', { image_key: 'img_key' })];
    const result = await readHistoryMessages('app', input, parseHistoryReadOptions(['--view', 'index']), false, d);
    expect(result.messages[0]).toMatchObject({ previewTruncated: true });
    expect(Array.from((result.messages[0] as any).preview)).toHaveLength(240);
    expect(result.messages[3]).toMatchObject({ resourceCount: 1, resourceTypes: ['image'] });
    expect(result.retrieval.detailsDeferred).toEqual(['om_card', 'om_forward']);
    expect(d.expandMergeForward).not.toHaveBeenCalled();
    expect(d.resolveMergedCard).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('img_key');
    expect(result.messages[0]).not.toHaveProperty('content');
  });

  it('filters times and types before expanding expensive cards', async () => {
    const d = deps();
    const start = Date.parse('2026-11-14T00:00:00+08:00');
    const input = [message('om_early', 'interactive', {}, start - 1), message('om_start', 'text', { text: 'accepted' }, start), message('om_type', 'interactive', {}, start + 1), message('om_end', 'text', { text: 'excluded' }, start + 1000)];
    const options = parseHistoryReadOptions(['--since', '2026-11-14T00:00:00+08:00', '--until', new Date(start + 1000).toISOString(), '--type', 'text']);
    const result = await readHistoryMessages('app', input, options, true, d);
    expect(result.messages.map(m => m.messageId)).toEqual(['om_start']);
    expect(result.retrieval).toMatchObject({ listedCount: 4, metadataMatchedCount: 1, filterScope: 'fetched-window' });
    expect(d.resolveMergedCard).not.toHaveBeenCalled();
  });

  it('searches resolved card text and exposes original structured content', async () => {
    const d = deps();
    d.resolveMergedCard.mockResolvedValue({ text: 'Root cause FOUND', structuredContent: '{"answer":42}', resources: [{ type: 'image', key: 'real_image', name: 'real.jpg' }] } as never);
    const result = await readHistoryMessages('app', [message('om_card', 'interactive', { elements: [] }), message('om_other', 'text', { text: 'unrelated' })], parseHistoryReadOptions(['--query', 'found']), true, d);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ content: 'Root cause FOUND', cardJson: { answer: 42 }, resources: [{ key: 'real_image' }] });
    expect(d.resolveMergedCard).toHaveBeenCalledTimes(1);
  });

  it('retains unexpanded cards and forwards as unverified query candidates', async () => {
    const result = await readHistoryMessages('app', [message('om_card', 'interactive', { elements: [] }), message('om_forward', 'merge_forward', {}), message('om_no', 'text', { text: 'unrelated' }), message('om_yes', 'text', { text: 'needle' })], parseHistoryReadOptions(['--view', 'index', '--query', 'needle']), false, deps());
    expect(result.messages.map(m => m.messageId)).toEqual(['om_card', 'om_forward', 'om_yes']);
    expect(result.messages[0]).toMatchObject({ queryMatch: 'deferred' });
    expect(result.messages[2]).not.toHaveProperty('queryMatch');
  });

  it('preserves successful rows and identifies a card detail failure', async () => {
    const d = deps();
    d.resolveMergedCard.mockRejectedValue(new Error('provider unavailable'));
    const result = await readHistoryMessages('app', [message('om_card', 'interactive', {}), message('om_text', 'text', { text: 'needle' })], parseHistoryReadOptions(['--query', 'needle']), true, d);
    expect(result.messages.map(m => m.messageId)).toEqual(['om_card', 'om_text']);
    expect(result.retrieval.detailFailures).toEqual(['om_card']);
    expect(result.messages[0]).toMatchObject({ queryMatch: 'deferred' });
  });

  it('preserves parent and forwarded resource order', async () => {
    const d = deps();
    d.expandMergeForward.mockImplementation(async (_app, _id, parsed) => {
      parsed.content = 'expanded target';
      parsed.msgType = 'merge_forward_expanded';
      return { extraResources: [{ type: 'file', key: 'file_key', name: 'proof.txt' }] } as never;
    });
    const result = await readHistoryMessages('app', [message('om_forward', 'merge_forward', {})], parseHistoryReadOptions(['--type', 'merge_forward_expanded', '--query', 'target']), false, d);
    expect(result.messages[0]).toMatchObject({ msgType: 'merge_forward_expanded', resources: [{ key: 'file_key' }] });
  });
});

describe('read option validation', () => {
  it.each([['--view', 'wrong'], ['--view', 'index', '--with-card-json'], ['--query'], ['--query', ' '], ['--type', ','], ['--since', 'yesterday'], ['--until', 'invalid'], ['--since', '2026-11-15', '--until', '2026-11-14']])('rejects invalid history options before reads: %j', (...args) => {
    expect(() => parseHistoryReadOptions(args)).toThrow();
  });
  it('reads --flag=value the same as --flag value, since both spellings pass the unknown-flag gate', () => {
    const spaced = parseHistoryReadOptions(['--view', 'index', '--query', 'queue', '--type', 'text,interactive', '--since', '2026-11-14T00:00:00+08:00', '--until', '2026-11-15T00:00:00+08:00']);
    expect(parseHistoryReadOptions(['--view=index', '--query=queue', '--type=text,interactive', '--since=2026-11-14T00:00:00+08:00', '--until=2026-11-15T00:00:00+08:00'])).toEqual(spaced);
    expect(spaced).toMatchObject({ view: 'index', query: 'queue', types: ['text', 'interactive'] });
    for (const args of [['--view='], ['--view=wrong'], ['--type='], ['--type=,'], ['--query='], ['--since=yesterday'], ['--view=index', '--with-card-json']]) {
      expect(() => parseHistoryReadOptions(args), JSON.stringify(args)).toThrow();
    }
  });
  it('accepts the inline --session-id=<id> spelling for quoted', () => {
    expect(parseQuotedReadOptions(['om_one', '--session-id=session'])).toEqual({ messageIds: ['om_one'], batch: false, download: true });
    expect(() => parseQuotedReadOptions(['om_one', '--session-id='])).toThrow('--session-id requires a value');
  });
  it('deduplicates a quoted batch and skips the session-id value', () => {
    expect(parseQuotedReadOptions(['om_one', '--session-id', 'session', '--no-download', 'om_two', 'om_one', '--raw'])).toEqual({ messageIds: ['om_one', 'om_two'], batch: true, download: false });
    expect(parseQuotedReadOptions(['om_one'])).toEqual({ messageIds: ['om_one'], batch: false, download: true });
    expect(parseQuotedReadOptions(['om_one', 'om_one'])).toEqual({ messageIds: ['om_one'], batch: false, download: true });
  });
  it('applies the 20-id cap after deduplication rather than on raw args', () => {
    const repeated = [...Array.from({ length: 20 }, (_, index) => `om_${index}`), 'om_0'];
    expect(parseQuotedReadOptions(repeated)).toMatchObject({ messageIds: Array.from({ length: 20 }, (_, index) => `om_${index}`), batch: true });
    expect(() => parseQuotedReadOptions(Array.from({ length: 21 }, (_, index) => `om_${index}`))).toThrow('at most 20');
  });
  it.each([[], ['--session-id'], ['om_one', '--unknown'], ['oc_chat'], Array.from({ length: 21 }, (_, index) => `om_${index}`)].map(args => ({ args })))('rejects invalid quoted inputs: $args', ({ args }) => {
    expect(() => parseQuotedReadOptions(args)).toThrow();
  });
});
