import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceLatestGroupSessionsCard } from '../src/services/group-sessions-card-store.js';

describe('group sessions card store', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns only the predecessor for the same bot, group, and caller', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-group-sessions-card-'));
    dirs.push(dataDir);

    expect(replaceLatestGroupSessionsCard(dataDir, 'app-a', 'chat-a', 'user-a', 'msg-1', 1)).toBeUndefined();
    expect(replaceLatestGroupSessionsCard(dataDir, 'app-a', 'chat-a', 'user-b', 'msg-b', 2)).toBeUndefined();
    expect(replaceLatestGroupSessionsCard(dataDir, 'app-b', 'chat-a', 'user-a', 'msg-c', 3)).toBeUndefined();
    expect(replaceLatestGroupSessionsCard(dataDir, 'app-a', 'chat-a', 'user-a', 'msg-2', 4)).toBe('msg-1');
  });
});

