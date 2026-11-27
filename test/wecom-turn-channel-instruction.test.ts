import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { WECOM_GATEWAY_LINE_FACTORY } from '../src/im/wecom/contract/prompt-fragments.js';

/**
 * The gateway's per-turn instruction tells the model who will read its reply.
 * That must match where the gateway actually delivers (bridge/addressing.ts):
 * a private chat reaches only the requester, a group chat its members.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function admittedRequest(chatType: 'single' | 'group'): Promise<{ request: TriggerRequest; recipient: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-channel-line-')); dirs.push(dir);
  const transport = {
    reply: vi.fn(async () => {}),
    send: vi.fn(async (_to: string, _text: string) => {}),
  };
  const core: WecomCore = {
    trigger: vi.fn(async () => ({ ok: true, triggerId: 't1', target: { kind: 'turn', sessionId: 's1' } })),
    result: vi.fn(async () => ({ ok: true, state: 'completed', output: { content: 'answer' } })),
    interrupt: vi.fn(async () => {}),
  };
  const bridge = new WecomBridge({
    botId: 'bot', stateFile: join(dir, 'state.json'), allowedUsers: ['alice'], transport, core,
    policy: () => ({ allowedUsers: ['alice'], disableStreamingCard: true }),
  } as any);
  const message: WecomInboundMessage = {
    messageId: 'm1', userId: 'alice', conversationId: chatType === 'single' ? 'alice' : 'group-1', chatType,
    text: 'hello', attachments: [], replyContext: { requestId: 'req-m1' },
  };
  await bridge.receive(message);
  await bridge.tick();
  const request = vi.mocked(core.trigger).mock.calls[0][0];
  // Where the final answer really went.
  const sends = transport.send.mock.calls.map(call => call[0]);
  const recipient = sends.at(-1) ?? (transport.reply.mock.calls.length ? message.conversationId : '');
  return { request, recipient };
}

/** The per-audience channel lines (editable prompt fragments, factory text here). */
const PRIVATE_LINE = WECOM_GATEWAY_LINE_FACTORY['wecom.task.channel_private'];
const GROUP_LINE = WECOM_GATEWAY_LINE_FACTORY['wecom.task.channel_group'];
const paragraphs = (request: TriggerRequest) => (request.instruction ?? '').split('\n\n');

describe('WeCom per-turn channel line', () => {
  it('private and group chats get different lines, each naming its real audience', async () => {
    const single = await admittedRequest('single');
    const group = await admittedRequest('group');
    expect(PRIVATE_LINE).not.toBe(GROUP_LINE);
    expect(single.recipient).toBe('alice');
    expect(paragraphs(single.request)).toContain(PRIVATE_LINE);
    expect(paragraphs(single.request)).not.toContain(GROUP_LINE);
    expect(group.recipient).toBe('group-1');
    expect(paragraphs(group.request)).toContain(GROUP_LINE);
    expect(paragraphs(group.request)).not.toContain(PRIVATE_LINE);
  });
});
