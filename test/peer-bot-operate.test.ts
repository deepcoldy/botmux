/**
 * L1 sibling-bot operate trust: a same-deployment registered peer bot
 * (isKnownPeerBot — present in this app's bot-openids cross-ref) can run
 * `/` commands (canOperate) on a sibling, mirroring the talk gate. A human's
 * talk-grant still does NOT confer operate (PR#46 boundary preserved).
 *
 * Run: pnpm vitest run test/peer-bot-operate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot } from '../src/bot-registry.js';
import { canTalk, canOperate } from '../src/im/lark/event-dispatcher.js';
import { config } from '../src/config.js';

describe('sibling-bot operate trust (L1)', () => {
  let prevDataDir: string;
  let tmp: string;

  beforeEach(() => {
    const bot = registerBot({ larkAppId: 'op1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = { oc_1: ['ou_guest'] };
    prevDataDir = config.session.dataDir;
    tmp = mkdtempSync(join(tmpdir(), 'op-gates-'));
    // op1's cross-ref knows a sibling deployment bot "codex" = ou_sibling.
    writeFileSync(join(tmp, 'bot-openids-op1.json'), JSON.stringify({ codex: 'ou_sibling' }));
    config.session.dataDir = tmp;
  });

  afterEach(() => {
    config.session.dataDir = prevDataDir;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it('a registered sibling bot can operate (run / commands)', () => {
    expect(canOperate('op1', 'oc_1', 'ou_sibling')).toBe(true);
  });

  it('the sibling bot can also talk (parity with the talk gate)', () => {
    expect(canTalk('op1', 'oc_1', 'ou_sibling')).toBe(true);
  });

  it('a human with only a chat talk-grant still cannot operate (PR#46 preserved)', () => {
    expect(canTalk('op1', 'oc_1', 'ou_guest')).toBe(true);
    expect(canOperate('op1', 'oc_1', 'ou_guest')).toBe(false);
  });

  it('a random non-peer, non-allowed sender cannot operate', () => {
    expect(canOperate('op1', 'oc_1', 'ou_stranger')).toBe(false);
  });

  it('the human owner still operates everywhere', () => {
    expect(canOperate('op1', 'oc_9', 'ou_owner')).toBe(true);
  });
});
