import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtectedResultStore, PROTECTED_RESULT_PLACEHOLDER } from '../src/services/protected-result-store.js';
import { redactProtectedLarkEvent } from '../src/im/lark/protected-event.js';
import { parseEventMessage } from '../src/im/lark/message-parser.js';
import { evaluateMessageListener, refreshListenerCardTextFromResolved, renderMessageListenerPrompt } from '../src/services/message-listener.js';

let root: string;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });
describe('protected listener routing', () => {
  it('uses the same redacted event through matching, parsing and late refresh', () => {
    root = mkdtempSync(join(tmpdir(), 'protected-listener-')); vi.stubEnv('SESSION_DATA_DIR', root);
    const store = new ProtectedResultStore(root);
    const context = { appId: 'cli_fixture', pluginId: 'reference-reporter', sessionId: 'session', turnId: 'om_turn', ownerUnionId: 'on_owner', chatId: 'oc_chat' };
    store.begin(context, 'delivery_fixture', 'a'.repeat(64));
    store.update(context, 'delivery_fixture', { message: { messageId: 'om_result', kind: 'primary' } });
    store.update(context, 'delivery_fixture', { status: 'delivered' });
    const data = { sender: { sender_id: { open_id: 'ou_other' }, sender_type: 'user' }, message: {
      message_id: 'om_result', chat_id: 'oc_chat', chat_type: 'group', message_type: 'interactive',
      content: JSON.stringify({ header: { title: { tag: 'plain_text', content: 'SYNTHETIC_SECRET_TITLE' } },
        elements: [{ tag: 'markdown', content: 'SYNTHETIC_SECRET_BODY' }] }), card_json: { private: 'SYNTHETIC_SECRET_BODY' },
    } };
    const bot: any = { botOpenId: 'ou_self', config: { larkAppId: 'cli_fixture', globalMessageListener: {
      enabled: true, prompt: 'summarize', senderPolicy: { mode: 'all', includeSenderTypes: ['user'] },
      messagePolicy: { includeMsgTypes: ['text', 'interactive'], scope: 'top_level' },
    } } };
    const safe = redactProtectedLarkEvent(data);
    expect(JSON.stringify(safe)).not.toContain('SYNTHETIC_SECRET');
    const parsed = parseEventMessage(safe as any);
    expect(parsed.parsed.content).toContain(PROTECTED_RESULT_PLACEHOLDER);
    const match = evaluateMessageListener({ bot, chatId: 'oc_chat', message: data.message,
      senderOpenId: 'ou_other', senderTypeRaw: 'user', explicitlyMentionedThisBot: false });
    expect(match).toBeDefined();
    // Simulate a previously matched card being hydrated at daemon admission.
    match!.msgType = 'interactive'; match!.messageTitle = 'SYNTHETIC_SECRET_TITLE';
    refreshListenerCardTextFromResolved(match!, data.message);
    const prompt = renderMessageListenerPrompt(match!);
    expect(prompt).toContain(PROTECTED_RESULT_PLACEHOLDER);
    expect(prompt).not.toContain('SYNTHETIC_SECRET');
  });
});
