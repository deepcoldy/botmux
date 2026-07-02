/**
 * Platform-team trust through the auth gates: isTrustedTeamBotSender /
 * canOperate / evaluateTalk must honour the platform roster (union_id) at
 * parity with legacy federation team trust — 双模式都免 /grant.
 * Run: pnpm vitest run test/platform-team-trust.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import { canOperate, evaluateTalk, isTrustedTeamBotSender } from '../src/im/lark/event-dispatcher.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-pftrust-'));
  config.session.dataDir = dataDir;
  const bot = registerBot({ larkAppId: 'pf1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
  bot.resolvedAllowedUsers = ['ou_owner'];
});

function seedPlatformTeam(): void {
  applyPlatformTeamSync(dataDir, {
    rev: 'r1',
    teams: [{
      teamId: 't1', teamName: 'T1', groupChatIds: ['oc_hall'],
      bots: [{ appId: 'cli_peer', unionId: 'on_peer', name: 'Peer' }],
    }],
  });
}

describe('isTrustedTeamBotSender (platform mode)', () => {
  it('trusts a platform roster bot by union_id in ANY chat', () => {
    seedPlatformTeam();
    expect(isTrustedTeamBotSender(dataDir, 'oc_random', 'on_peer')).toBe(true);
    expect(isTrustedTeamBotSender(dataDir, 'oc_random', 'on_stranger')).toBe(false);
  });

  it('trusts first contact inside the mirrored 大厅/团队群', () => {
    seedPlatformTeam();
    // union_id not in roster yet (fresh bot, not yet echoed) but the hall is trusted
    expect(isTrustedTeamBotSender(dataDir, 'oc_hall', 'on_fresh')).toBe(true);
  });
});

describe('canOperate (platform mode)', () => {
  it('grants operate to a platform roster bot by union_id', () => {
    seedPlatformTeam();
    expect(canOperate('pf1', 'oc_random', 'ou_scoped', 'on_peer')).toBe(true);
    expect(canOperate('pf1', 'oc_random', 'ou_scoped', 'on_human')).toBe(false);
  });
});

describe('evaluateTalk teamBot leg (quota gate end-to-end hole fix)', () => {
  it('allows a platform roster bot on a RESTRICTED receiver', () => {
    seedPlatformTeam();
    const ev = evaluateTalk('pf1', 'oc_random', 'ou_peer_scoped', 'on_peer');
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe('teamBot');
  });

  it('allows a LEGACY learned team bot too (parity across 两条路)', () => {
    recordTeamBot(dataDir, { unionId: 'on_legacy', name: 'Legacy' });
    const ev = evaluateTalk('pf1', 'oc_random', 'ou_legacy_scoped', 'on_legacy');
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe('teamBot');
  });

  it('still denies unknown senders without union_id backing', () => {
    expect(evaluateTalk('pf1', 'oc_random', 'ou_x', 'on_unknown').allowed).toBe(false);
    expect(evaluateTalk('pf1', 'oc_random', 'ou_x').allowed).toBe(false);
  });
});
