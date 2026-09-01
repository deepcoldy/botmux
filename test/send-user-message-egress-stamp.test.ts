/**
 * sendUserMessage egress stamping: the FIFTH card egress surface.
 *
 * sendUserMessage DMs interactive cards (config / write-link / substitute /
 * overload / …) whose callback buttons must carry the `__bm_cb` ownership
 * marker, exactly like the other four egress choke points (sendMessage /
 * replyMessage / sendEphemeralCard / updateMessage). Without it a peer bot
 * reading such a DM via history flattens the buttons into its prompt, and a
 * FUTURE botmux DM button with an action the parser's legacy wordlist has
 * never heard of would leak unstripped.
 *
 * These assert the REAL client egress path (SDK mocked at the boundary,
 * capturing the exact `data.content` posted to Lark), plus a full
 * send -> flatten roundtrip proving an unknown-action button is dropped.
 *
 * Run: pnpm vitest run test/send-user-message-egress-stamp.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'bun:test';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { sendUserMessage } from '../src/im/lark/client.js';
import { parseApiMessage } from '../src/im/lark/message-parser.js';
import { BOTMUX_CALLBACK_MARKER_KEY } from '../src/im/lark/callback-button-marker.js';

/** Register a bot whose SDK create/request handlers capture the posted body. */
function setupCapture(appId: string) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  const calls: Array<{ via: 'create' | 'request'; content: string }> = [];
  getBot(appId).client = {
    im: { v1: { message: {
      create: async (args: any) => {
        calls.push({ via: 'create', content: args?.data?.content });
        return { code: 0, data: { message_id: 'om_dm' } };
      },
    } } },
    // The deadline (requestOptions) branch goes through c.request(...).
    request: async (args: any) => {
      calls.push({ via: 'request', content: args?.data?.content });
      return { code: 0, data: { message_id: 'om_dm' } };
    },
  } as any;
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('sendUserMessage egress: interactive DMs are stamped', () => {
  it('stamps a callback button on the plain create path', async () => {
    const calls = setupCapture('dm1');
    const card = JSON.stringify({
      body: { elements: [
        { tag: 'markdown', content: '配置' },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '⚙️ 配置' },
            value: { action: 'config_toggle', field: 'sandbox' } },
        ] },
      ] },
    });
    await sendUserMessage('dm1', 'ou_owner', card, 'interactive');
    expect(calls).toHaveLength(1);
    expect(calls[0].via).toBe('create');
    const posted = JSON.parse(calls[0].content);
    const btn = posted.body.elements[1].actions[0];
    expect(btn.value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
  });

  it('stamps on the deadline (requestOptions) path too — shared body', async () => {
    const calls = setupCapture('dm2');
    const card = JSON.stringify({
      body: { elements: [
        { tag: 'button', text: { tag: 'plain_text', content: '🔊 语音总结' },
          behaviors: [{ type: 'callback', value: { action: 'voice_summary', session_id: 's1' } }] },
      ] },
    });
    // Passing requestOptions routes through c.request(...) rather than create.
    await sendUserMessage('dm2', 'ou_owner', card, 'interactive', undefined, {});
    expect(calls).toHaveLength(1);
    expect(calls[0].via).toBe('request');
    const posted = JSON.parse(calls[0].content);
    expect(posted.body.elements[0].behaviors[0].value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
  });

  it('leaves text DMs and non-interactive bodies untouched', async () => {
    const calls = setupCapture('dm3');
    await sendUserMessage('dm3', 'ou_owner', 'hello', 'text');
    // text: wrapped as {text}, never stamped
    expect(JSON.parse(calls[0].content)).toEqual({ text: 'hello' });
    // a non-interactive structured body (e.g. 'post') passes through verbatim
    const postBody = JSON.stringify({ post: { zh_cn: { title: 't' } } });
    await sendUserMessage('dm3', 'ou_owner', postBody, 'post');
    expect(calls[1].content).toBe(postBody);
    expect(calls[1].content).not.toContain(BOTMUX_CALLBACK_MARKER_KEY);
  });

  it('does NOT stamp a jump-URL button (real link stays followable)', async () => {
    const calls = setupCapture('dm4');
    const card = JSON.stringify({
      body: { elements: [
        { tag: 'button', text: { tag: 'plain_text', content: '📄 打开报告' },
          behaviors: [{ type: 'open_url', default_url: 'https://example.com/report' }] },
      ] },
    });
    await sendUserMessage('dm4', 'ou_owner', card, 'interactive');
    const posted = JSON.parse(calls[0].content);
    // open_url button has no callback value to mark; stays marker-free
    expect(JSON.stringify(posted)).not.toContain(BOTMUX_CALLBACK_MARKER_KEY);
  });
});

describe('sendUserMessage egress: unknown-action DM button roundtrip (future-proof)', () => {
  it('an UNKNOWN future DM action, stamped on send, is dropped on flatten', async () => {
    // This is the exact leak codex reproduced: pre-fix, an interactive DM whose
    // button action is NOT in the parser wordlist flattened to
    // `[Future DM Callback]`. With egress stamping, the marker rides along and
    // the parser drops it WITHOUT anyone touching the wordlist.
    const calls = setupCapture('dm5');
    const card = JSON.stringify({
      body: { elements: [
        { tag: 'markdown', content: 'DM 正文' },
        { tag: 'button', text: { tag: 'plain_text', content: 'Future DM Callback' },
          value: { action: 'totally_new_dm_action', session_id: 's1' } },
      ] },
    });
    await sendUserMessage('dm5', 'ou_owner', card, 'interactive');
    const stampedOnWire = calls[0].content;
    expect(stampedOnWire).toContain(BOTMUX_CALLBACK_MARKER_KEY); // sanity: stamp fired

    // What a peer bot sees when it reads this DM back as a card.
    const flattened = parseApiMessage({
      message_id: 'om_dm', msg_type: 'interactive', create_time: '1',
      sender: { id: 'ou_bot', sender_type: 'app' },
      body: { content: stampedOnWire },
    } as any).content;
    expect(flattened).toContain('DM 正文');
    expect(flattened).not.toContain('Future DM Callback');
  });
});
