import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOncallGroup, oncallCreationSource } from '../src/services/oncall-group-client.js';
import { readOncallGroupResult } from '../src/services/oncall-platform.js';

const target = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, typeId: 34, region: 'cn', emailDomain: 'example.test' };
const creation = { target, username: 'test.user', region: 'cn', typeId: 34 };
const attempt = 'fixture-attempt';
const row = { id: 123, tenant_id: 12, source_location: oncallCreationSource(attempt), originator_user: 'test.user',
  region: 'cn', oncall_question_type_id: 34, chat_id: 'internal-chat', stage: 'closed' };
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
afterEach(() => vi.restoreAllMocks());

describe('Oncall creation result protocol', () => {
  it('sends the persisted attempt marker without changing the selected route', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ oncall_flow_id: 123, open_chat_id: 'oc_created' }));
    await createOncallGroup(target, 'secret', 'test.user', 'test question', fetcher,
      { region: 'cn', typeId: 56, priority: 'P2' }, attempt);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ source_location: oncallCreationSource(attempt), type_id: 56, region: 'cn' });
  });

  it('looks up an exact attempt and converts only its verified group, including a closed ticket', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => response(url.includes('/oncall_flow/list') ? [row] : 'oc_created'));
    await expect(readOncallGroupResult(creation, 'secret', attempt, fetcher)).resolves.toEqual({ flowId: '123', openChatId: 'oc_created' });
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request.filter_fields).toContainEqual({ field: 'source_location', value: [row.source_location], operator: 'in' });
    expect(fetcher.mock.calls[1][0]).toContain('chat_id=internal-chat');
    expect(fetcher.mock.calls.every(([, init]) => !init.method || init.method === 'POST')).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init.body && JSON.parse(init.body).type === 'create_chat')).toBe(false);
  });

  it.each([{ rows: [] }, { rows: [{ ...row, chat_id: null }] }])('keeps an absent or not-yet-ready group uncertain', async ({ rows }) => {
    const fetcher = vi.fn().mockResolvedValue(response(rows));
    await expect(readOncallGroupResult(creation, 'secret', attempt, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { source_location: 'botmux:other-attempt' }, { tenant_id: 99 }, { originator_user: 'other.user' },
    { region: 'other' }, { oncall_question_type_id: 99 }, { id: null },
  ])('rejects a result with mismatching identity or route: %j', async mismatch => {
    const fetcher = vi.fn().mockResolvedValue(response([{ ...row, ...mismatch }]));
    await expect(readOncallGroupResult(creation, 'secret', attempt, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not guess between multiple tickets, even when the first one matches', async () => {
    const fetcher = vi.fn().mockResolvedValue(response([row, { ...row, id: 456 }]));
    await expect(readOncallGroupResult(creation, 'secret', attempt, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([new Response('', { status: 403 }), new Response('{}'), new Response('invalid')])('rejects failed or malformed list responses', async reply => {
    await expect(readOncallGroupResult(creation, 'secret', attempt, vi.fn().mockResolvedValue(reply))).rejects.toThrow();
  });

  it('preserves timeout provenance without retrying or exposing the original error to the user', async () => {
    const cause = new DOMException('synthetic private detail', 'TimeoutError');
    const fetcher = vi.fn().mockRejectedValue(cause);
    await expect(createOncallGroup(target, 'secret', 'test.user', 'test question', fetcher)).rejects.toMatchObject({
      uncertain: true, reason: 'timeout', cause,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
