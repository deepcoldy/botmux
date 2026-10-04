import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindGroupContextDelivery,
  confirmGroupContextDelivery,
  getDeliveredGroupContextSeqs,
  readGroupContextDeliveryBinding,
  readPreparedGroupContext,
  writePreparedGroupContext,
  type GroupContextDeliveryBinding,
  type PreparedGroupContext,
} from '../src/services/group-context-delivery-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { spawnSyncTsEvalWithRepoImports, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const roots: string[] = [];
const DAY = 86_400_000;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-group-context-delivery-'));
  roots.push(dir);
  return dir;
}

function bundle(overrides: Partial<PreparedGroupContext> = {}): PreparedGroupContext {
  return {
    appId: 'app-one', chatId: 'chat-one', turnId: 'turn-one',
    createdAt: Date.now(), body: '<shared_group_context>Frozen excerpt</shared_group_context>',
    includedSeqs: [2, 5], throughSeq: 9, incomplete: true,
    ...overrides,
  };
}

function binding(overrides: Partial<GroupContextDeliveryBinding> = {}): GroupContextDeliveryBinding {
  return {
    appId: 'app-one', chatId: 'chat-one', turnId: 'turn-one',
    sessionId: 'session-one', epoch: 'native-one', ...overrides,
  };
}

function delivered(dir: string, overrides: Partial<GroupContextDeliveryBinding> = {}): number[] {
  const value = binding(overrides);
  return getDeliveredGroupContextSeqs(value.appId, value.chatId, value.sessionId, value.epoch, dir);
}

describe('group context frozen bundles', () => {
  it('returns empty for missing bundles and coverage without creating a store', () => {
    const dir = dataDir();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps the first persisted body and attachments when a retry changes the input', () => {
    const dir = dataDir();
    const first = bundle({ attachments: [{ type: 'file', path: '/tmp/source.pdf', name: 'source.pdf', resourceKey: 'original' }] });
    expect(writePreparedGroupContext(first, dir)).toEqual(first);
    expect(writePreparedGroupContext(bundle({
      body: 'Recomputed body', includedSeqs: [6], throughSeq: 6,
      attachments: [{ type: 'image', path: '/tmp/new.png', name: 'new.png' }],
    }), dir)).toEqual(first);
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir)).toEqual(first);
  });

  it('does not expose mutable in-memory aliases of a persisted bundle', () => {
    const dir = dataDir();
    const input = bundle();
    const expected = structuredClone(input);
    const written = writePreparedGroupContext(input, dir);
    input.includedSeqs.push(7);
    written.includedSeqs.push(8);
    written.body = 'Mutated';
    const read = readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)!;
    expect(read).toEqual(expected);
    read.includedSeqs.length = 0;
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(expected);
  });

  it('deduplicates sequence identities deterministically without filling holes', () => {
    const dir = dataDir();
    expect(writePreparedGroupContext(bundle({ includedSeqs: [5, 2, 5, 2] }), dir).includedSeqs).toEqual([2, 5]);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5]);
  });

  it('uses config.session.dataDir when the final argument is omitted', () => {
    const dir = dataDir();
    vi.stubEnv('SESSION_DATA_DIR', dir);
    try {
      const input = bundle();
      writePreparedGroupContext(input);
      bindGroupContextDelivery(binding());
      expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId)).toEqual(input);
      expect(readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId)).toEqual(binding());
      expect(confirmGroupContextDelivery(binding())).toBe(true);
      expect(getDeliveredGroupContextSeqs(input.appId, input.chatId, 'session-one', 'native-one')).toEqual([2, 5]);
      expect(existsSync(join(dir, 'group-context-delivery'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never incorporates application, chat, session, or turn IDs into paths', () => {
    const dir = dataDir();
    const input = bundle({ appId: '../app', chatId: '../chat', turnId: '../turn' });
    const consumer = binding({ ...input, sessionId: '../session', epoch: '../epoch' });
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(consumer, dir);
    expect(confirmGroupContextDelivery(consumer, dir)).toBe(true);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(input);
    expect(readdirSync(dir)).toEqual(['group-context-delivery']);
    expect(readdirSync(join(dir, 'group-context-delivery')).every(name => !/app|chat|session|turn/.test(name))).toBe(true);
    expect(statSync(join(dir, 'group-context-delivery')).mode & 0o777).toBe(0o700);
  });
});

describe('group context delivery coverage', () => {
  it('does not cover queued, prepared, or bound input before confirmation', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    bindGroupContextDelivery(binding(), dir);
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toEqual(binding());
    expect(delivered(dir)).toEqual([]);
  });

  it('confirms only explicit included sources and treats matching retries as idempotent', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5]);
  });

  it.each(['appId', 'chatId', 'turnId', 'sessionId', 'epoch'] as const)('rejects confirmation with a different %s', key => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding({ [key]: 'other' }), dir)).toBe(false);
    expect(delivered(dir)).toEqual([]);
    expect(delivered(dir, { [key]: 'other' })).toEqual([]);
  });

  it('does not allow retries to rebind a frozen turn to another consumer', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(() => bindGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toThrow();
    expect(() => bindGroupContextDelivery(binding({ sessionId: 'session-two' }), dir)).toThrow();
    expect(confirmGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toBe(false);
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toEqual(binding());
  });

  it('requires a prepared bundle and enforces an explicitly prepared native epoch', () => {
    const dir = dataDir();
    expect(() => bindGroupContextDelivery(binding(), dir)).toThrow();
    writePreparedGroupContext(bundle({ epoch: 'native-one' }), dir);
    expect(() => bindGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toThrow();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
  });

  it('isolates applications, groups, sessions, and native epochs with reused turn IDs', () => {
    const dir = dataDir();
    const scopes = [
      binding(), binding({ appId: 'app-two' }), binding({ chatId: 'chat-two' }),
      binding({ sessionId: 'session-two', turnId: 'turn-two' }),
      binding({ epoch: 'native-two', turnId: 'turn-three' }),
    ];
    scopes.forEach((scope, index) => {
      writePreparedGroupContext(bundle({ appId: scope.appId, chatId: scope.chatId, turnId: scope.turnId, includedSeqs: [index + 1] }), dir);
      bindGroupContextDelivery(scope, dir);
      confirmGroupContextDelivery(scope, dir);
    });
    scopes.forEach((scope, index) => expect(delivered(dir, scope)).toEqual([index + 1]));
  });

  it('retains newer bundles when an older turn completes after them', () => {
    const dir = dataDir();
    const older = bundle({ turnId: 'older', includedSeqs: [2], throughSeq: 3 });
    const newer = bundle({ turnId: 'newer', includedSeqs: [8], throughSeq: 9 });
    writePreparedGroupContext(older, dir);
    writePreparedGroupContext(newer, dir);
    bindGroupContextDelivery(binding({ turnId: 'older' }), dir);
    bindGroupContextDelivery(binding({ turnId: 'newer' }), dir);
    expect(confirmGroupContextDelivery(binding({ turnId: 'newer' }), dir)).toBe(true);
    expect(delivered(dir)).toEqual([8]);
    expect(confirmGroupContextDelivery(binding({ turnId: 'older' }), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 8]);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'newer', dir)).toEqual(newer);
  });

  it('reopens both frozen input and delivery evidence in a new process', () => {
    const dir = dataDir();
    const input = bundle();
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(binding(), dir);
    confirmGroupContextDelivery(binding(), dir);
    const result = spawnSyncTsEvalWithRepoImports(`
      import { readPreparedGroupContext, readGroupContextDeliveryBinding, getDeliveredGroupContextSeqs } from './src/services/group-context-delivery-store.js';
      const dir = process.env.DELIVERY_TEST_DIR;
      console.log(JSON.stringify({
        prepared: readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir),
        binding: readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir),
        seqs: getDeliveredGroupContextSeqs('app-one', 'chat-one', 'session-one', 'native-one', dir),
      }));
    `, { cwd: process.cwd(), env: { ...process.env, DELIVERY_TEST_DIR: dir }, encoding: 'utf8' });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout).trim())).toEqual({ prepared: input, binding: binding(), seqs: [2, 5] });
  });

  it('serializes competing processes so every retry receives the same first bundle', async () => {
    const dir = dataDir();
    const input = bundle();
    const outputs = await Promise.all([1, 2, 3].map(index => new Promise<PreparedGroupContext>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(`
        import { writePreparedGroupContext } from './src/services/group-context-delivery-store.js';
        console.log(JSON.stringify(writePreparedGroupContext(JSON.parse(process.env.DELIVERY_TEST_INPUT), process.env.DELIVERY_TEST_DIR)));
      `, {
        cwd: process.cwd(),
        env: { ...process.env, DELIVERY_TEST_DIR: dir, DELIVERY_TEST_INPUT: JSON.stringify({ ...input, body: `Writer ${index}` }) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', data => { stdout += String(data); });
      child.stderr!.on('data', data => { stderr += String(data); });
      child.once('error', reject);
      child.once('exit', code => {
        if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`));
        else {
          try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
        }
      });
    })));
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(outputs[0]);
  });
});

describe('group context delivery validation and retention', () => {
  it.each([
    { includedSeqs: [0] }, { includedSeqs: [-1] }, { includedSeqs: [1.5] },
    { includedSeqs: [Number.NaN] }, { includedSeqs: [Number.MAX_SAFE_INTEGER + 1] },
    { includedSeqs: ['2'] }, { includedSeqs: [10], throughSeq: 9 },
    { throughSeq: -1 }, { throughSeq: 0.5 }, { createdAt: Number.NaN },
    { body: null }, { incomplete: 'true' }, { appId: '' }, { epoch: '' },
    { attachments: [{ type: 'file', name: 'bad' }] }, { attachments: 'bad' },
  ])('rejects invalid bundle data: %j', patch => {
    const dir = dataDir();
    expect(() => writePreparedGroupContext(bundle(patch as Partial<PreparedGroupContext>), dir)).toThrow();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
  });

  it('rejects empty consumer identities', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    expect(() => bindGroupContextDelivery(binding({ epoch: '' }), dir)).toThrow();
    expect(() => bindGroupContextDelivery(binding({ sessionId: '' }), dir)).toThrow();
    expect(confirmGroupContextDelivery(binding({ epoch: '' }), dir)).toBe(false);
    expect(delivered(dir, { epoch: '' })).toEqual([]);
  });

  it('accepts an empty context without inventing covered sources', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle({ body: '', includedSeqs: [], throughSeq: 0 }), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([]);
  });

  it('expires input and coverage after 30 days without extending TTL on retry or confirmation', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const input = bundle();
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(binding(), dir);
    clock.mockReturnValue(now + 29 * DAY);
    expect(writePreparedGroupContext(bundle({ body: 'Retry' }), dir)).toEqual(input);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5]);
    clock.mockReturnValue(now + 30 * DAY);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    expect(delivered(dir)).toEqual([]);
  });

  it('clamps future timestamps so they cannot bypass 30-day retention', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    writePreparedGroupContext(bundle({ createdAt: now + 365 * DAY }), dir);
    clock.mockReturnValue(now + 30 * DAY);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
  });

  it('caps retention at 1,000 bundles and refuses to report an unretained old insertion as frozen', () => {
    const dir = dataDir();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const original = bundle({ turnId: 'turn-0', createdAt: now - 1_000 });
    writePreparedGroupContext(original, dir);
    // Seed an already populated store, then exercise the public insertion path.
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare(`INSERT INTO prepared_contexts (app_id, chat_id, turn_id, created_at, expires_at, payload)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (let index = 1; index < 1_000; index++) {
        const input = bundle({ turnId: `turn-${index}`, createdAt: now - 1_000 + index });
        insert.run(input.appId, input.chatId, input.turnId, input.createdAt, input.createdAt + 30 * DAY, JSON.stringify(input));
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const newest = bundle({ turnId: 'newest' });
    expect(writePreparedGroupContext(newest, dir)).toEqual(newest);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-0', dir)).toBeUndefined();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-1', dir)).toBeDefined();
    expect(() => writePreparedGroupContext(bundle({ turnId: 'too-old', createdAt: now - DAY }), dir)).toThrow();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'newest', dir)).toEqual(newest);
    const reopened = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM prepared_contexts').get()).toEqual({ count: 1_000 });
    } finally {
      reopened.close();
    }
  });

  it('fails closed on a corrupted database and refuses to overwrite it', () => {
    const dir = dataDir();
    mkdirSync(join(dir, 'group-context-delivery'));
    const file = join(dir, 'group-context-delivery', 'store.db');
    writeFileSync(file, 'not a SQLite database');
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    expect(() => writePreparedGroupContext(bundle(), dir)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('not a SQLite database');
  });

  it('fails closed when a persisted bundle has invalid source sequences', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    confirmGroupContextDelivery(binding(), dir);
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      db.prepare('UPDATE prepared_contexts SET payload = ?').run(JSON.stringify(bundle({ includedSeqs: [-1] })));
    } finally {
      db.close();
    }
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
  });
});
