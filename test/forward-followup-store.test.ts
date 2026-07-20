import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listForwardFollowups,
  putForwardFollowup,
  removeForwardFollowup,
} from '../src/im/lark/forward-followup-store.js';

describe('forward-followup-store', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-forward-followup-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists, replaces, and removes pending payloads by seed message id', () => {
    putForwardFollowup('app-1', {
      messageId: 'seed-1',
      dueAt: 1_000,
      payload: { kind: 'seed' },
    });
    putForwardFollowup('app-1', {
      messageId: 'seed-1',
      dueAt: 2_000,
      payload: { kind: 'paired' },
    });

    expect(listForwardFollowups('app-1')).toEqual([{
      messageId: 'seed-1',
      dueAt: 2_000,
      payload: { kind: 'paired' },
    }]);

    removeForwardFollowup('app-1', 'seed-1');
    expect(listForwardFollowups('app-1')).toEqual([]);
  });

  it('isolates records by app', () => {
    putForwardFollowup('app-1', { messageId: 'seed-1', dueAt: 1_000, payload: {} });
    expect(listForwardFollowups('app-2')).toEqual([]);
  });
});
