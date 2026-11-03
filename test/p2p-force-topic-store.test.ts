import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  __resetP2pForceTopicRootsForTest,
  isP2pForceTopicRoot,
  recordP2pForceTopicRoot,
} from '../src/services/p2p-force-topic-store.js';

describe('p2p-force-topic-store', () => {
  let dataDir: string;
  let previousDataDir: string;

  beforeEach(() => {
    previousDataDir = config.session.dataDir;
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-p2p-force-topic-'));
    config.session.dataDir = dataDir;
    __resetP2pForceTopicRootsForTest();
  });

  afterEach(() => {
    config.session.dataDir = previousDataDir;
    __resetP2pForceTopicRootsForTest();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('persists an app-and-chat-scoped /t root across cache resets', () => {
    recordP2pForceTopicRoot('app-a', 'om-root', 'oc-chat');

    expect(isP2pForceTopicRoot('app-a', 'om-root', 'oc-chat')).toBe(true);
    expect(isP2pForceTopicRoot('app-a', 'om-root', 'oc-other')).toBe(false);
    expect(isP2pForceTopicRoot('app-b', 'om-root', 'oc-chat')).toBe(false);

    __resetP2pForceTopicRootsForTest();
    expect(isP2pForceTopicRoot('app-a', 'om-root', 'oc-chat')).toBe(true);
  });

  it('fails open for routing when persistence is unavailable but keeps the in-memory marker', () => {
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('disk unavailable'); });

    recordP2pForceTopicRoot('app-a', 'om-memory-root', 'oc-chat');

    expect(isP2pForceTopicRoot('app-a', 'om-memory-root', 'oc-chat')).toBe(true);
  });

  it('ignores malformed persisted data', () => {
    const file = join(dataDir, 'p2p-force-topic-roots', 'app-a.json');
    mkdirSync(join(dataDir, 'p2p-force-topic-roots'), { recursive: true });
    writeFileSync(file, '{not-json', 'utf-8');

    expect(isP2pForceTopicRoot('app-a', 'om-invalid', 'oc-chat')).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('refreshes an existing root before evicting the least-recently-recorded entry', () => {
    const dir = join(dataDir, 'p2p-force-topic-roots');
    const file = join(dir, 'app-a.json');
    mkdirSync(dir, { recursive: true });
    const initial = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [
      `om-root-${i}`,
      { chatId: 'oc-chat', createdAt: i },
    ]));
    writeFileSync(file, JSON.stringify(initial), 'utf-8');

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(20_000)
      .mockReturnValueOnce(20_001);
    recordP2pForceTopicRoot('app-a', 'om-root-0', 'oc-chat');
    recordP2pForceTopicRoot('app-a', 'om-root-new', 'oc-chat');

    __resetP2pForceTopicRootsForTest();
    expect(isP2pForceTopicRoot('app-a', 'om-root-0', 'oc-chat')).toBe(true);
    expect(isP2pForceTopicRoot('app-a', 'om-root-1', 'oc-chat')).toBe(false);
    expect(isP2pForceTopicRoot('app-a', 'om-root-new', 'oc-chat')).toBe(true);
  });
});
