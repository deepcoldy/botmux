/**
 * Unit tests for services/message-queue.
 *
 * The module is file-system backed, so we mock `node:fs` and the config/logger
 * dependencies to keep the tests fast and deterministic.
 *
 * Run:  pnpm vitest run test/message-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory FS simulation ─────────────────────────────────────────────────

/** Simple in-memory file store keyed by absolute path. */
let files: Record<string, string>;

vi.mock('node:fs', () => ({
  existsSync: (p: string) => p in files,
  mkdirSync: (_p: string, _opts?: any) => {
    /* no-op: directory creation is a side effect we don't need to track */
  },
  writeFileSync: (p: string, data: string, _enc?: string) => {
    files[p] = data;
  },
  appendFileSync: (p: string, data: string, _enc?: string) => {
    files[p] = (files[p] ?? '') + data;
  },
  readFileSync: (p: string, _enc?: string) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  },
  // atomic-write（tmp+rename）会经过这两个调用
  renameSync: (from: string, to: string) => {
    if (!(from in files)) throw new Error(`ENOENT: ${from}`);
    files[to] = files[from];
    delete files[from];
  },
  unlinkSync: (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    delete files[p];
  },
  promises: {},
}));

vi.mock('../src/config.js', () => ({
  config: {
    session: { dataDir: '/tmp/test-mq' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    warn: () => {},
    info: () => {},
    error: () => {},
  },
}));

// Import the module under test *after* mocks are registered.
import {
  ensureQueue,
  appendMessage,
  readUnread,
  rewindOffset,
  getOffset,
} from '../src/services/message-queue.js';
import type { LarkMessage } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(id: string, text = 'hello'): LarkMessage {
  return {
    messageId: id,
    rootId: 'root_1',
    senderId: 'ou_user',
    senderType: 'user',
    msgType: 'text',
    content: text,
    createTime: String(Date.now()),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  files = {};
});

describe('ensureQueue', () => {
  it('creates an empty queue file for a new key', () => {
    ensureQueue('root_a');
    expect(files['/tmp/test-mq/queues/root_a.jsonl']).toBe('');
  });

  it('does not overwrite an existing queue file', () => {
    files['/tmp/test-mq/queues'] = ''; // directory marker
    files['/tmp/test-mq/queues/root_a.jsonl'] = 'existing\n';
    ensureQueue('root_a');
    expect(files['/tmp/test-mq/queues/root_a.jsonl']).toBe('existing\n');
  });
});

describe('appendMessage', () => {
  it('appends a JSON line to the queue file', () => {
    const msg = makeMessage('m1');
    appendMessage('root_b', msg);

    const raw = files['/tmp/test-mq/queues/root_b.jsonl'];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toEqual(msg);
  });

  it('appends multiple messages as separate lines', () => {
    appendMessage('root_b', makeMessage('m1'));
    appendMessage('root_b', makeMessage('m2'));

    const lines = files['/tmp/test-mq/queues/root_b.jsonl']
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).messageId).toBe('m1');
    expect(JSON.parse(lines[1]).messageId).toBe('m2');
  });
});

describe('readUnread', () => {
  it('returns all messages when nothing has been read yet', () => {
    appendMessage('root_c', makeMessage('m1', 'first'));
    appendMessage('root_c', makeMessage('m2', 'second'));

    const msgs = readUnread('root_c');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('first');
    expect(msgs[1].content).toBe('second');
  });

  it('advances offset so subsequent call returns empty', () => {
    appendMessage('root_d', makeMessage('m1'));
    const first = readUnread('root_d');
    expect(first).toHaveLength(1);

    const second = readUnread('root_d');
    expect(second).toHaveLength(0);
  });

  it('returns only new messages after offset advances', () => {
    appendMessage('root_e', makeMessage('m1'));
    readUnread('root_e'); // consume m1

    appendMessage('root_e', makeMessage('m2', 'new'));
    const msgs = readUnread('root_e');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('new');
  });

  it('returns empty array for a non-existent queue', () => {
    expect(readUnread('nonexistent')).toEqual([]);
  });

  it('returns empty array when queue file exists but is empty', () => {
    ensureQueue('root_empty');
    expect(readUnread('root_empty')).toEqual([]);
  });
});

describe('rewindOffset', () => {
  it('resets offset to 0 so all messages are re-read', () => {
    appendMessage('root_f', makeMessage('m1'));
    appendMessage('root_f', makeMessage('m2'));
    readUnread('root_f'); // consume both

    rewindOffset('root_f');

    const msgs = readUnread('root_f');
    expect(msgs).toHaveLength(2);
  });

  it('resets offset to a specific byte position', () => {
    appendMessage('root_g', makeMessage('m1'));
    const afterFirst = getOffset('root_g'); // still 0

    // Read once to advance offset past m1.
    readUnread('root_g');
    const midpoint = getOffset('root_g');
    expect(midpoint).toBeGreaterThan(0);

    appendMessage('root_g', makeMessage('m2'));
    readUnread('root_g'); // consume m2

    // Rewind to midpoint — only m2 should be visible.
    rewindOffset('root_g', midpoint);
    const msgs = readUnread('root_g');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageId).toBe('m2');
  });
});

describe('getOffset', () => {
  it('returns 0 when no offset file exists', () => {
    expect(getOffset('root_new')).toBe(0);
  });

  it('returns current byte offset after reading', () => {
    appendMessage('root_h', makeMessage('m1'));
    readUnread('root_h');
    expect(getOffset('root_h')).toBeGreaterThan(0);
  });

  it('returns 0 after rewindOffset()', () => {
    appendMessage('root_i', makeMessage('m1'));
    readUnread('root_i');
    rewindOffset('root_i');
    expect(getOffset('root_i')).toBe(0);
  });
});

describe('key isolation', () => {
  it('separate keys maintain independent queues and offsets', () => {
    appendMessage('key_a', makeMessage('a1', 'alpha'));
    appendMessage('key_b', makeMessage('b1', 'beta'));

    const msgsA = readUnread('key_a');
    expect(msgsA).toHaveLength(1);
    expect(msgsA[0].content).toBe('alpha');

    const msgsB = readUnread('key_b');
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0].content).toBe('beta');

    // Reading key_a again yields nothing — offset was advanced independently.
    expect(readUnread('key_a')).toHaveLength(0);
  });

  it('rewinding one key does not affect another', () => {
    appendMessage('key_x', makeMessage('x1'));
    appendMessage('key_y', makeMessage('y1'));

    readUnread('key_x');
    readUnread('key_y');

    rewindOffset('key_x');

    expect(readUnread('key_x')).toHaveLength(1);
    expect(readUnread('key_y')).toHaveLength(0);
  });
});
