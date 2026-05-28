/**
 * Unit tests for resolvePrivateCardAudience (worker-pool.ts) — the audience of
 * a private /card.
 *
 * Privacy rule under test: the private card goes ONLY to the bot's allowedUsers
 * (owner / co-owners). Talk-only grants (globalGrants / chatGrants) and a bare
 * triggerer must NOT be included. ou_ filtered, deduped.
 *
 * Run:  pnpm vitest run test/private-card-audience.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

// Mutable bot state the mocked getBot returns; each test rewrites it.
let botState: any = { resolvedAllowedUsers: [], config: {} };

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => botState),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { resolvePrivateCardAudience } from '../src/core/worker-pool.js';

const ds = (over: Partial<DaemonSession> = {}) => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  ...over,
} as unknown as DaemonSession);

beforeEach(() => {
  botState = { resolvedAllowedUsers: [], config: {} };
});

describe('resolvePrivateCardAudience', () => {
  it('returns the allowedUsers (owner set)', () => {
    botState = { resolvedAllowedUsers: ['ou_owner1', 'ou_owner2'], config: {} };
    expect(resolvePrivateCardAudience(ds()).sort()).toEqual(['ou_owner1', 'ou_owner2']);
  });

  it('excludes talk-only globalGrants', () => {
    botState = { resolvedAllowedUsers: ['ou_owner'], config: { globalGrants: ['ou_grantglobal'] } };
    expect(resolvePrivateCardAudience(ds())).toEqual(['ou_owner']);
  });

  it("excludes this chat's talk-only chatGrants", () => {
    botState = { resolvedAllowedUsers: ['ou_owner'], config: { chatGrants: { oc_here: ['ou_chatgrant'] } } };
    expect(resolvePrivateCardAudience(ds())).toEqual(['ou_owner']);
  });

  it('filters out non-ou_ entries (unresolved emails) and dedupes', () => {
    botState = { resolvedAllowedUsers: ['ou_owner', 'someone@corp.com', 'ou_owner'], config: {} };
    expect(resolvePrivateCardAudience(ds())).toEqual(['ou_owner']);
  });

  it('is empty when the bot has no allowedUsers (open mode → no owner to send to)', () => {
    botState = { resolvedAllowedUsers: [], config: { globalGrants: ['ou_x'], chatGrants: { oc_here: ['ou_y'] } } };
    expect(resolvePrivateCardAudience(ds())).toEqual([]);
  });
});
