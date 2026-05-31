/**
 * relay-picker.test.ts
 *
 * Unit tests for collectRelayPickerEntries — the candidate collector shared
 * by the /relay picker's initial render (command-handler) and its re-render
 * (card-handler). Focus: ordering (most-recently-active first) and that the
 * existing selection filters still hold.
 *
 * getChatNameAndMode and isRelayableRealSession are external; we stub them so
 * the test exercises selection + sort logic in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  // Resolve every group chat to a stable friendly name so the mapping step
  // doesn't fan out to a real API. Mode 'group' keeps all fixtures group-scope.
  getChatNameAndMode: vi.fn(async (_app: string, chatId: string) => ({
    name: `name-of-${chatId}`,
    mode: 'group' as const,
  })),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  // Treat every fixture as a real session unless it explicitly omits BOTH a
  // worker and persisted CLI markers (matches the production predicate).
  isRelayableRealSession: (ds: any) =>
    !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
}));

import { collectRelayPickerEntries } from '../src/services/relay-picker.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'cli_app_test';
const OWNER = 'ou_owner';
const CURRENT_CHAT = 'oc_current';

function makeDs(over: {
  sessionId: string;
  chatId: string;
  lastMessageAt: number;
  title?: string;
  ownerOpenId?: string;
  adoptedFrom?: any;
  cliId?: string | undefined;
  worker?: any;
}): DaemonSession {
  return {
    session: {
      sessionId: over.sessionId,
      chatId: over.chatId,
      rootMessageId: `om_${over.sessionId}`,
      title: over.title ?? over.sessionId,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      scope: 'chat',
      chatType: 'group',
      larkAppId: APP,
      ownerOpenId: over.ownerOpenId ?? OWNER,
      workingDir: '/tmp',
      cliId: 'cliId' in over ? over.cliId : ('claude-code' as any),
      adoptedFrom: over.adoptedFrom,
    },
    worker: over.worker ?? null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: over.chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 0,
    cliVersion: '1.0.0',
    lastMessageAt: over.lastMessageAt,
    hasHistory: true,
    workingDir: '/tmp',
  } as DaemonSession;
}

function registryOf(...sessions: DaemonSession[]): Map<string, DaemonSession> {
  const m = new Map<string, DaemonSession>();
  for (const s of sessions) m.set(sessionKey(s.session.rootMessageId, APP), s);
  return m;
}

describe('collectRelayPickerEntries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders entries most-recently-active first regardless of Map insertion order', async () => {
    // Insert in deliberately scrambled time order; expect lastMessageAt desc.
    const oldest = makeDs({ sessionId: 'sess-old', chatId: 'oc_a', lastMessageAt: 1_000 });
    const newest = makeDs({ sessionId: 'sess-new', chatId: 'oc_b', lastMessageAt: 9_000 });
    const middle = makeDs({ sessionId: 'sess-mid', chatId: 'oc_c', lastMessageAt: 5_000 });
    const reg = registryOf(oldest, newest, middle);

    const entries = await collectRelayPickerEntries(reg, APP, CURRENT_CHAT, OWNER);

    expect(entries.map(e => e.sessionId)).toEqual(['sess-new', 'sess-mid', 'sess-old']);
  });

  it('sorts sessions missing lastMessageAt to the bottom', async () => {
    const withTime = makeDs({ sessionId: 'sess-t', chatId: 'oc_a', lastMessageAt: 3_000 });
    const noTime = makeDs({ sessionId: 'sess-none', chatId: 'oc_b', lastMessageAt: 0 });
    const reg = registryOf(noTime, withTime);

    const entries = await collectRelayPickerEntries(reg, APP, CURRENT_CHAT, OWNER);

    expect(entries.map(e => e.sessionId)).toEqual(['sess-t', 'sess-none']);
  });

  it('still applies the selection filters (current chat / owner / adopt / scratch) before sorting', async () => {
    const keep = makeDs({ sessionId: 'keep', chatId: 'oc_other', lastMessageAt: 100 });
    const inCurrentChat = makeDs({ sessionId: 'in-current', chatId: CURRENT_CHAT, lastMessageAt: 9_999 });
    const notOwner = makeDs({ sessionId: 'not-owner', chatId: 'oc_x', lastMessageAt: 9_999, ownerOpenId: 'ou_someone_else' });
    const adopt = makeDs({ sessionId: 'adopt', chatId: 'oc_y', lastMessageAt: 9_999, adoptedFrom: { tmuxTarget: '0:1', originalCliPid: 1, cwd: '/t' } });
    const scratch = makeDs({ sessionId: 'scratch', chatId: 'oc_z', lastMessageAt: 9_999, cliId: undefined, worker: null });
    const reg = registryOf(keep, inCurrentChat, notOwner, adopt, scratch);

    const entries = await collectRelayPickerEntries(reg, APP, CURRENT_CHAT, OWNER);

    // Only `keep` survives the filters — despite the others having a much
    // larger lastMessageAt, sort runs AFTER selection.
    expect(entries.map(e => e.sessionId)).toEqual(['keep']);
  });
});
