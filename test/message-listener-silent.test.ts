import './helpers/require-fenced-data-dir.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { evaluateMessageListener } from '../src/services/message-listener.js';
import { messageListenerTaskAnchor, isSilentMessageListenerSession, messageListenerSendBlocked } from '../src/core/message-listener-silence.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const dataDirs: string[] = [];
const previousDataDir = config.session.dataDir;
afterEach(() => {
  sessionStore.init('listener-silent-test'); // detach the open SQLite handle
  config.session.dataDir = previousDataDir;
  dataDirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

describe('silent message listener tasks', () => {
  it('freezes silence in the first durable row and restores it independently of the rule', () => {
    config.session.dataDir = mkdtempSync(join(tmpdir(), 'botmux-listener-silent-'));
    dataDirs.push(config.session.dataDir);
    sessionStore.init('listener-silent-test');
    const sourceMessageId = 'om_source';
    const row = sessionStore.createSession('oc_source', messageListenerTaskAnchor(sourceMessageId), 'task', 'group', 'thread', {
      messageListenerRun: { sourceMessageId, replyMode: 'none' },
    });
    sessionStore.init('listener-silent-test');
    const restored = sessionStore.getSession(row.sessionId)!;
    expect(restored.messageListenerRun).toEqual({ sourceMessageId: 'om_source', replyMode: 'none' });
    expect(isSilentMessageListenerSession(restored)).toBe(true);
    expect(messageListenerSendBlocked(restored, 'oc_source')).toBe(true);
    expect(messageListenerSendBlocked(restored, 'oc_target')).toBe(false);
    const background = { session: restored, scope: 'thread', chatId: 'oc_source', larkAppId: 'app' } as DaemonSession;
    const human = { ...background, session: { ...restored, rootMessageId: sourceMessageId, messageListenerRun: undefined } } as DaemonSession;
    expect(activeSessionKey(background)).not.toBe(activeSessionKey(human));
    expect(messageListenerSendBlocked(human.session, 'oc_source')).toBe(false);
  });

  it('keeps matched task data and the silent policy together', () => {
    const match = evaluateMessageListener({
      bot: { config: { globalMessageListener: {
        enabled: true, prompt: 'execute existing task', contentPolicy: { includeKeywords: ['alert'] },
        replyPolicy: { mode: 'none' },
      } } } as any,
      chatId: 'oc_source', message: { message_id: 'om_source', message_type: 'text', content: JSON.stringify({ text: 'an alert' }) },
      senderOpenId: 'ou_sender', senderTypeRaw: 'user', explicitlyMentionedThisBot: false,
    });
    expect(match).toMatchObject({ replyMode: 'none', prompt: 'execute existing task', sourceMessageId: 'om_source', messageText: 'an alert' });
  });
});
