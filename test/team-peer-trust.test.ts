/**
 * Team-peer trust: isTeamGroupChat (trust root) + isTrustedTeamBotSender (the
 * foreign-bot gate predicate that lets teammates collaborate without /grant).
 * Run: pnpm vitest run test/team-peer-trust.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { recordTeamGroup, isTeamGroupChat } from '../src/services/team-groups-store.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { isTrustedTeamBotSender } from '../src/im/lark/event-dispatcher.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-teampeer-')); });

describe('isTeamGroupChat', () => {
  it('recognises a recorded 拉群 group of any team', () => {
    expect(isTeamGroupChat(dataDir, 'oc_team')).toBe(false);
    recordTeamGroup(dataDir, 'team1', 'oc_team');
    expect(isTeamGroupChat(dataDir, 'oc_team')).toBe(true);
    expect(isTeamGroupChat(dataDir, 'oc_other')).toBe(false);
    expect(isTeamGroupChat(dataDir, undefined)).toBe(false);
  });
});

describe('isTrustedTeamBotSender (gate predicate)', () => {
  it('trusts a learned teammate union_id in ANY chat (no /grant)', () => {
    recordTeamBot(dataDir, { unionId: 'on_codex', name: 'Codex' });
    expect(isTrustedTeamBotSender(dataDir, 'oc_random', 'on_codex')).toBe(true);
    // a stranger bot (unknown union_id) in a non-team chat is NOT trusted
    expect(isTrustedTeamBotSender(dataDir, 'oc_random', 'on_stranger')).toBe(false);
  });

  it('trusts any bot inside a team-assembled group even on first contact', () => {
    recordTeamGroup(dataDir, 'team1', 'oc_team');
    // union_id not yet learned, but the chat itself is team-controlled
    expect(isTrustedTeamBotSender(dataDir, 'oc_team', 'on_fresh')).toBe(true);
  });

  it('does NOT trust on a spoofable-name basis — only union_id / team group', () => {
    // no team group, union_id unknown → must fall back to /grant
    expect(isTrustedTeamBotSender(dataDir, 'oc_random', undefined)).toBe(false);
    expect(isTrustedTeamBotSender(dataDir, 'oc_random', 'on_unknown')).toBe(false);
  });
});
