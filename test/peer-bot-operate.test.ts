/**
 * Same-deployment peer identity is talk-only: isKnownPeerBot / cross-ref may
 * route a sibling's prompt, but it must never confer management-command
 * permission. Explicit operate-capable sources remain authoritative.
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

import { getBot, registerBot } from '../src/bot-registry.js';
import { canTalk, canOperate } from '../src/im/lark/event-dispatcher.js';
import { config } from '../src/config.js';

describe('sibling-bot cross-ref is talk-only', () => {
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

  it('a registered sibling bot cannot operate management commands', () => {
    expect(canOperate('op1', 'oc_1', 'ou_sibling')).toBe(false);
  });

  it('the sibling bot can also talk (parity with the talk gate)', () => {
    expect(canTalk('op1', 'oc_1', 'ou_sibling')).toBe(true);
  });

  it('known peer + exact chatGrant remains talk-only', () => {
    getBot('op1').config.chatGrants = { oc_1: ['ou_sibling'] };
    expect(canTalk('op1', 'oc_1', 'ou_sibling')).toBe(true);
    expect(canOperate('op1', 'oc_1', 'ou_sibling')).toBe(false);
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
