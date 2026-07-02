/**
 * canOperate team-peer trust (option B): a cross-deployment TEAM peer bot gets
 * daemon-command operate by its tenant-stable union_id, at parity with same-
 * deployment siblings — WITHOUT leaking operate to humans who happen to be in a
 * team group.
 * Run: pnpm vitest run test/team-operate.test.ts
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
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-teamop-'));
  config.session.dataDir = dataDir; // canOperate reads team-bots from here
  // Restricted bot (has an allowlist) so canOperate isn't open-mode.
  const bot = registerBot({ larkAppId: 'op1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
  bot.resolvedAllowedUsers = ['ou_owner'];
});

describe('canOperate team-peer trust (B)', () => {
  it('grants operate to a learned team peer bot by union_id, in ANY chat', () => {
    recordTeamBot(dataDir, { unionId: 'on_codex', name: 'Codex' });
    expect(canOperate('op1', 'oc_random', 'ou_codex_scoped', 'on_codex')).toBe(true);
  });

  it('does NOT grant operate to an unknown bot union_id', () => {
    expect(canOperate('op1', 'oc_random', 'ou_x', 'on_unknown')).toBe(false);
  });

  it('SAFETY: a human in a team group does NOT inherit operate', () => {
    // The chat is a team-assembled group, and the human is talking in it...
    recordTeamGroup(dataDir, 'team1', 'oc_team');
    // ...but canOperate keys on the per-sender union_id (isTeamBot), not group
    // membership, so a non-teammate-bot union_id (a human's) is rejected.
    expect(canOperate('op1', 'oc_team', 'ou_human', 'on_human')).toBe(false);
    expect(canOperate('op1', 'oc_team', 'ou_human', undefined)).toBe(false);
  });

  it('still honours the existing allowedUsers operator', () => {
    expect(canOperate('op1', 'oc_team', 'ou_owner')).toBe(true);
  });
});
