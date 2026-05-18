/**
 * Unit tests for chat-first-seen-store's `markSeenBulkDetailed` — the
 * provenance signal that defaultOncall's auto-bind judge relies on to
 * distinguish "we already knew about this chat" from "we're stamping it
 * right now". Codex review point #1: a backfill that missed a chat must
 * NOT cause it to be later misclassified as new.
 *
 * Run:  pnpm vitest run test/chat-first-seen-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

async function freshStore() {
  vi.resetModules();
  const cfg = await import('../src/config.js');
  const store = await import('../src/services/chat-first-seen-store.js');
  return { cfg, store };
}

describe('chat-first-seen-store.markSeenBulkDetailed', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-fs-store-'));
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });

  it('reports preexisting=false on first stamp, then preexisting=true on subsequent reads', async () => {
    const { cfg, store } = await freshStore();
    void cfg; // touch import so it ranks ahead of any side-effecting re-imports
    store.init('app_x');

    const first = store.markSeenBulkDetailed(['chat_a']);
    expect(first.get('chat_a')?.preexisting).toBe(false);
    const firstStamp = first.get('chat_a')!.firstSeenAt;
    expect(firstStamp).toBeGreaterThan(0);

    const again = store.markSeenBulkDetailed(['chat_a']);
    expect(again.get('chat_a')?.preexisting).toBe(true);
    expect(again.get('chat_a')?.firstSeenAt).toBe(firstStamp);
  });

  it('mixed call: each id reports its own preexisting flag', async () => {
    const { store } = await freshStore();
    store.init('app_x');
    store.markSeenBulkDetailed(['chat_old']); // seed

    const r = store.markSeenBulkDetailed(['chat_old', 'chat_new']);
    expect(r.get('chat_old')?.preexisting).toBe(true);
    expect(r.get('chat_new')?.preexisting).toBe(false);
  });

  it('back-compat markSeenBulk still returns plain timestamps', async () => {
    const { store } = await freshStore();
    store.init('app_x');
    const r = store.markSeenBulk(['chat_a', 'chat_b']);
    expect(r.get('chat_a')).toBeTypeOf('number');
    expect(r.get('chat_b')).toBeTypeOf('number');
  });
});
