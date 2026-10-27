/**
 * Consecutive messages test:
 * Verifies the type-ahead message queue — sends 3 messages back to back
 * while the session is still starting or working, asserts every one gets its
 * own ACK reply. The ACK bubbles are the gate, not a 「工作中」 card title: a
 * fast (mock) model can finish a turn before a screenshot ever shows it.
 */
import { describe, it, beforeAll, afterAll } from './midscene-suite.js';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import {
  testMessage,
  expectedReplyMarker,
  sendMessage,
  waitForStreamingCard,
  waitForModelTextReply,
  scrollThreadToBottom,
  openChat,
  typeThreadReply,
  waitForPageTextCount,
} from './helpers.js';
import { openFeishuSession, releaseFeishuSession } from './feishu-session.js';

export function registerMidsceneSuites(): void {
  describe('consecutive messages', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let agent: PlaywrightAgent;

    beforeAll(async () => {
      ({ browser, context, page, agent } = await openFeishuSession((p, a) => openChat(p, a, 'Claude')));
    });

    afterAll(async () => {
      await releaseFeishuSession({ browser, context, page, agent }, { closeBotSession: true, publishVideo: true });
    });

    it('should process 3 rapidly sent messages in sequence', async () => {
      const msg1 = testMessage('consec-1');

      // Send first message to create the topic thread
      await sendMessage(agent, msg1, page);

      // Wait for the streaming card to appear (session starts)
      await waitForStreamingCard(agent, { msgHint: msg1, timeoutMs: 120_000, page });

      // Send 2 more messages back to back via thread reply, without waiting
      // for the first turn. Typed, not dictated to the vision agent, so the
      // prompts (and their ACK markers) arrive verbatim.
      const msg2 = testMessage('consec-2');
      const msg3 = testMessage('consec-3');
      await typeThreadReply(agent, page, msg2);
      await typeThreadReply(agent, page, msg3);

      // The queue is FIFO: once the last prompt's ACK is at the bottom, the two
      // earlier ACKs are already in the topic, possibly above the fold. Check
      // the newest visually, and the earlier ones in the DOM (prompt + reply = 2).
      await scrollThreadToBottom(agent);
      await waitForModelTextReply(agent, {
        botName: 'Claude',
        marker: expectedReplyMarker(msg3),
        timeoutMs: 300_000,
      });
      await waitForPageTextCount(page, expectedReplyMarker(msg1), 2, 30_000);
      await waitForPageTextCount(page, expectedReplyMarker(msg2), 2, 30_000);
    }, 600_000);
  });
}
