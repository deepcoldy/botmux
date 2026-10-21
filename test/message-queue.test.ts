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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
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
  };
});

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
