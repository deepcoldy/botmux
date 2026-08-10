/**
 * Source-level guard for message-listener / foreign-bot new-topic ownership.
 *
 * handleNewTopic() is a daemon.ts closure (not exported), so — mirroring
 * initial-passthrough-ownership.test.ts — we pin the ownership invariant by
 * asserting on the source region.
 *
 * What must hold (upstream PR #723 review blocker P1-2):
 *  - A bot-sent new topic (a message-listener match on a third-party alert bot,
 *    or a peer bot) must NOT become the session owner. Otherwise daemon footers
 *    --mention-back the alert bot on every reply (self-poke / re-trigger loop)
 *    and owner-gated surfaces leak to a bot.
 *  - Owner/ownerUnion must come from the foreign-bot-suppressed vars, while
 *    creatorOpenId + quoteTarget keep the raw sender (botmux report + first
 *    quote still resolve).
 *
 * Run: pnpm vitest run test/listener-foreign-bot-owner.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

function fnRegion(name: string, span = 50000): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} not found in daemon.ts`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('handleNewTopic foreign-bot ownership suppression', () => {
  const region = fnRegion('handleNewTopic');

  it('derives a foreign-bot-sender flag and owner-suppressed vars', () => {
    expect(region).toContain('const isForeignBotSender = isBotSenderType');
    expect(region).toContain('isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)');
    expect(region).toContain('const ownerOpenIdForSession = isForeignBotSender ? undefined : senderOpenId;');
    expect(region).toContain('const ownerUnionIdForSession = isForeignBotSender ? undefined : senderUnionId;');
  });

  it('assigns session/ds owner from the suppressed vars, not the raw sender', () => {
    expect(region).toContain('session.ownerOpenId = ownerOpenIdForSession;');
    expect(region).toContain('session.ownerUnionId = ownerUnionIdForSession;');
    // The main-spawn ds object must not re-fill owner straight from the sender.
    expect(region).toContain('ownerOpenId: ownerOpenIdForSession,');
  });

  it('keeps creator + quote target on the raw sender so report/quote still resolve', () => {
    expect(region).toContain('session.creatorOpenId = senderOpenId;');
    expect(region).toContain('session.quoteTargetSenderOpenId = senderOpenId;');
    expect(region).toContain('session.quoteTargetSenderIsBot = isForeignBotSender');
  });
});
