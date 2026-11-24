import { describe, expect, it, vi } from 'vitest';
import { buildRelaySessionToolRequest } from '../src/cli/relay-session-tool.js';
import { normalizeRemoteRunnerSessionToolRequest } from '../src/adapters/backend/remote-runner-protocol.js';
import { remoteRunnerSessionToolArgs } from '../src/services/remote-runner-session-tool.js';
import { parseHistoryReadOptions, parseQuotedReadOptions, readHistoryMessages } from '../src/cli/history-read.js';
import { readQuotedMessages } from '../src/cli/quoted-read.js';

function hostArgs(tool: 'history' | 'quoted', args: string[]) {
  const built = buildRelaySessionToolRequest(tool, args, 'session-current');
  if (!built.ok) throw new Error(built.error);
  const request = normalizeRemoteRunnerSessionToolRequest(built.request);
  if (!request) throw new Error('host rejected the structured request');
  return remoteRunnerSessionToolArgs(request, 'session-current', 'oc_current').slice(1);
}

describe('session read options across the sandbox and host boundary', () => {
  it('applies literal keyword, type and date filters while retaining the index view', async () => {
    const args = hostArgs('history', ['--view', 'index', '--query=--session-id', '--type', 'text',
      '--since', '2026-11-24T01:00:00Z', '--until', '2026-11-24T02:00:00Z']);
    expect(args.filter(arg => arg === '--session-id')).toHaveLength(1);
    expect(args.at(-1)).toBe('session-current');
    const row = (id: string, text: string, time: string, type = 'text') => ({
      message_id: id, chat_id: 'oc_current', msg_type: type, create_time: String(Date.parse(time)),
      sender: { id: 'ou_fixture', sender_type: 'user' }, body: { content: JSON.stringify({ text }) },
    });
    const result = await readHistoryMessages('cli_fixture', [
      row('om_match', 'literal --session-id', '2026-11-24T01:30:00Z'),
      row('om_old', 'literal --session-id', '2026-11-24T00:30:00Z'),
      row('om_new', 'literal --session-id', '2026-11-24T02:00:00Z'),
      row('om_keyword', 'other text', '2026-11-24T01:30:00Z'),
      row('om_type', 'literal --session-id', '2026-11-24T01:30:00Z', 'post'),
    ], parseHistoryReadOptions(args), args.includes('--with-card-json'), {
      expandMergeForward: vi.fn(), resolveMergedCard: vi.fn(),
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ messageId: 'om_match', preview: 'literal --session-id', resourceCount: 0 });
    expect(result.messages[0]).not.toHaveProperty('content');
    expect(result.messages[0]).not.toHaveProperty('cardJson');
  });

  it('honours no-download after both structured boundaries instead of fetching attachment bytes', async () => {
    const args = hostArgs('quoted', ['om_image', '--raw', '--no-download']);
    const downloadResources = vi.fn(async () => ({ attachments: [] }));
    const result = await readQuotedMessages('cli_fixture', {
      ...parseQuotedReadOptions(args), raw: args.includes('--raw'), currentChatId: 'oc_current',
    }, {
      getMessageDetail: vi.fn(async () => ({ items: [{
        message_id: 'om_image', chat_id: 'oc_current', msg_type: 'image', create_time: '1700000000000',
        sender: { id: 'ou_fixture', sender_type: 'user' }, body: { content: '{"image_key":"synthetic_image"}' },
      }] })),
      expandMergeForward: vi.fn(async () => ({ extraResources: [] })), resolveMergedCard: vi.fn(),
      downloadResources, decorate: async message => message,
    });
    expect(result.messages[0]).toMatchObject({ attachmentDownloadSkipped: true, rawContent: '{"image_key":"synthetic_image"}' });
    expect(result.messages[0]).not.toHaveProperty('attachments');
    expect(downloadResources).not.toHaveBeenCalled();
  });

  it.each([
    { view: 'index', withCardJson: true },
    { query: { text: 'not a string' } },
    { types: ['text', '--session-id'] },
    { since: '2026-11-25', until: '2026-11-24' },
    { since: 'not-an-iso-date' },
    { sessionId: 'another-session' },
  ])('rejects malformed or authority-expanding host filters: %j', fields => {
    expect(normalizeRemoteRunnerSessionToolRequest({ tool: 'history', ...fields })).toBeUndefined();
  });
});
