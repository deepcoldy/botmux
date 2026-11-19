import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { larkApiError } from '../src/im/lark/lark-errors.js';
import * as larkClient from '../src/im/lark/client.js';
import { filterMatches } from '../src/services/hook-runner.js';
import * as hookRunner from '../src/services/hook-runner.js';
import {
  GROUP_CHAT_ID,
  GROUP_SEND_ARCHIVE_LIMIT,
  GROUP_SEND_BODY_MAX_BYTES,
  GROUP_SEND_COMPACT_BATCH,
  GROUP_SEND_RECORD_LIMIT,
  GROUP_SEND_UUID_REUSE_MS,
  groupSendArchivePath,
  groupSendUuid,
  parseGroupSendBody,
  readRequestBoundGroupMessage,
  sendRequestBoundGroupMessage,
  __setGroupSendLimitsForTest,
  type GroupSendCommitted,
  type GroupSendRecord,
} from '../src/services/request-bound-group-send.js';

const APP = 'cli_group_send';
const CHAT = 'oc_group_send';
let dir: string;
let storePath: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-group-send-'));
  storePath = join(dir, 'group-sends.json');
  clock = 1_700_000_000_000;
});
afterEach(() => {
  __setGroupSendLimitsForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

const deps = (send: (c: string, t: string, u: string) => Promise<string>, extra: { onCommitted?: (payload: GroupSendCommitted) => void } = {}) =>
  ({ larkAppId: APP, storePath, send, now: () => clock, ...extra });
const input = (requestId = 'req_000001', content = 'mosa-checkin abc123') => ({ chatId: CHAT, requestId, content });
const contentDigest = (content: string) => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');

function writeStore(records: Record<string, GroupSendRecord>): void {
  writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, records }));
}

function pendingRecord(requestId: string, chatId = CHAT, content = 'x', state: 'pending' | 'sent' = 'pending', at = clock): GroupSendRecord {
  return {
    chatId, requestId, contentDigest: contentDigest(content),
    uuid: groupSendUuid(APP, chatId, requestId), state, firstAttemptAt: at,
    ...(state === 'sent' ? { messageId: `om_${requestId}`, sentAt: at } : {}),
  };
}

describe('parseGroupSendBody', () => {
  it('accepts exactly {requestId, content}', () => {
    expect(parseGroupSendBody({ requestId: 'req_000001', content: 'hi' })).toEqual({ requestId: 'req_000001', content: 'hi' });
    expect(parseGroupSendBody({ requestId: 'req_000001', content: 'hi', extra: 1 })).toBeUndefined();
    expect(parseGroupSendBody({ requestId: 'short', content: 'hi' })).toBeUndefined();
    expect(parseGroupSendBody({ requestId: 'req_000001', content: '   ' })).toBeUndefined();
    expect(parseGroupSendBody({ requestId: 'req_000001', content: 'x'.repeat(8193) })).toBeUndefined();
    expect(parseGroupSendBody([])).toBeUndefined();
  });
});

describe('sendRequestBoundGroupMessage', () => {
  it('sends once with a stable uuid and replays the stored message id', async () => {
    const send = vi.fn(async () => 'om_1');
    const first = await sendRequestBoundGroupMessage(deps(send), input());
    expect(first).toEqual({ ok: true, status: 200, messageId: 'om_1', requestId: 'req_000001', chatId: CHAT, replayed: false });
    expect(send).toHaveBeenCalledWith(CHAT, 'mosa-checkin abc123', groupSendUuid(APP, CHAT, 'req_000001'));
    expect(groupSendUuid(APP, CHAT, 'req_000001').length).toBeLessThanOrEqual(50);
    const again = await sendRequestBoundGroupMessage(deps(send), input());
    expect(again).toMatchObject({ ok: true, messageId: 'om_1', replayed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serialises concurrent identical requests into one provider call', async () => {
    const send = vi.fn(async () => 'om_c');
    const [a, b] = await Promise.all([sendRequestBoundGroupMessage(deps(send), input()), sendRequestBoundGroupMessage(deps(send), input())]);
    expect(send).toHaveBeenCalledTimes(1);
    expect([a, b].map(r => r.ok && r.messageId)).toEqual(['om_c', 'om_c']);
  });

  it('rejects the same requestId with different content', async () => {
    const send = vi.fn(async () => 'om_1');
    await sendRequestBoundGroupMessage(deps(send), input());
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_000001', 'other'))).toEqual({ ok: false, status: 409, error: 'request_conflict' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a durable pending record and reuses the uuid only inside the window', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce('om_2');
    expect(await sendRequestBoundGroupMessage(deps(send), input())).toEqual({ ok: false, status: 502, error: 'send_failed', retryable: true });
    const stored = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(Object.values(stored.records)).toMatchObject([{ state: 'pending', requestId: 'req_000001' }]);
    clock += GROUP_SEND_UUID_REUSE_MS - 1;
    expect(await sendRequestBoundGroupMessage(deps(send), input())).toMatchObject({ ok: true, messageId: 'om_2', replayed: true });
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('reports outcome_unknown for a pending record outside the window and never re-sends', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    await sendRequestBoundGroupMessage(deps(send), input());
    clock += GROUP_SEND_UUID_REUSE_MS + 1;
    expect(await sendRequestBoundGroupMessage(deps(send), input())).toEqual({ ok: false, status: 409, error: 'outcome_unknown', retryable: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a corrupt store', async () => {
    writeFileSync(storePath, '{not json');
    const send = vi.fn(async () => 'om_x');
    await expect(sendRequestBoundGroupMessage(deps(send), input())).rejects.toThrow();
    writeFileSync(storePath, JSON.stringify({ schemaVersion: 2, records: {} }));
    await expect(sendRequestBoundGroupMessage(deps(send), input())).rejects.toThrow(/invalid/);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when a record is missing uuid or firstAttemptAt', async () => {
    const broken = pendingRecord('req_000001');
    delete (broken as Partial<GroupSendRecord>).uuid;
    delete (broken as Partial<GroupSendRecord>).firstAttemptAt;
    writeStore({ [`${CHAT}\0req_000001`]: broken });
    const send = vi.fn(async () => 'om_x');
    await expect(sendRequestBoundGroupMessage(deps(send), input())).rejects.toThrow(/invalid/);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts underscore and long chat ids and rejects anything else', async () => {
    const longId = `oc_${'a'.repeat(40)}_long_group`;
    expect(GROUP_CHAT_ID.test(longId)).toBe(true);
    expect(longId.length).toBeGreaterThan(CHAT.length);
    const send = vi.fn(async () => 'om_long');
    expect(await sendRequestBoundGroupMessage(deps(send), { ...input(), chatId: longId })).toMatchObject({ ok: true, chatId: longId, messageId: 'om_long' });
    expect(send).toHaveBeenCalledWith(longId, input().content, groupSendUuid(APP, longId, 'req_000001'));
    for (const chatId of ['ou_not_a_chat', '../../etc/x', 'oc_', 'chat']) {
      expect(await sendRequestBoundGroupMessage(deps(vi.fn(async () => 'om')), { ...input(), chatId })).toEqual({ ok: false, status: 400, error: 'invalid_request' });
    }
  });

  it('marks definite provider rejections as not retryable', async () => {
    const cases = [
      larkApiError('send message', { code: 230002, msg: 'Bot can NOT be out of the chat' }),
      Object.assign(new Error('too long'), { response: { status: 400, data: { code: 230025 } } }),
      Object.assign(new Error('missing scope (code: 99991672)'), { code: 99991672 }),
      Object.assign(new Error('Message om has been withdrawn'), { name: 'MessageWithdrawnError' }),
    ];
    for (const [i, error] of cases.entries()) {
      const send = vi.fn(async () => { throw error; });
      expect(await sendRequestBoundGroupMessage(deps(send), input(`req_fail_${i}0`))).toEqual({ ok: false, status: 502, error: 'send_failed', retryable: false });
    }
  });

  it('fires outbound.send at most once, with the filter fields, and not on a sent replay', async () => {
    const committed: GroupSendCommitted[] = [];
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('om_2');
    const onCommitted = (payload: GroupSendCommitted) => { committed.push(payload); };
    expect((await sendRequestBoundGroupMessage(deps(send, { onCommitted }), input())).ok).toBe(false);
    expect(committed).toEqual([]);
    clock += GROUP_SEND_UUID_REUSE_MS - 1;
    expect(await sendRequestBoundGroupMessage(deps(send, { onCommitted }), input())).toMatchObject({ ok: true, messageId: 'om_2', replayed: true });
    expect(committed).toEqual([{
      larkAppId: APP, chatId: CHAT, messageId: 'om_2', msgType: 'text',
      uuid: groupSendUuid(APP, CHAT, 'req_000001'), content: 'mosa-checkin abc123', requestId: 'req_000001',
    }]);
    expect(committed[0].uuid.startsWith('bmxgs-')).toBe(true);
    expect(filterMatches({ larkAppId: APP, chatId: CHAT }, { event: 'outbound.send', ...committed[0] })).toBe(true);
    const { larkAppId: _app, chatId: _chat, ...withoutFilterKeys } = committed[0];
    expect(filterMatches({ larkAppId: APP, chatId: CHAT }, { event: 'outbound.send', ...withoutFilterKeys })).toBe(false);
    expect(await sendRequestBoundGroupMessage(deps(send, { onCommitted }), input())).toMatchObject({ replayed: true, messageId: 'om_2' });
    expect(committed).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not fire the hook when the sent record was already durable', async () => {
    writeStore({ [`${CHAT}\0req_000001`]: pendingRecord('req_000001', CHAT, input().content, 'sent') });
    const committed: GroupSendCommitted[] = [];
    const send = vi.fn(async () => 'om_new');
    const result = await sendRequestBoundGroupMessage(deps(send, { onCommitted: p => committed.push(p) }), input());
    expect(result).toMatchObject({ ok: true, messageId: 'om_req_000001', replayed: true });
    expect(send).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  it('fires the hook once when the post-send save fails and the same requestId is retried', async () => {
    const committed: GroupSendCommitted[] = [];
    let pendingBytes: Buffer | undefined;
    let attempt = 0;
    // First attempt: the provider accepts, then the test turns the store path
    // into a directory so the sent-record write throws. The pending bytes are
    // restored before the retry, which dedupes and commits the hook once.
    const send = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        pendingBytes = readFileSync(storePath);
        rmSync(storePath);
        mkdirSync(storePath);
      }
      return 'om_real';
    });
    await expect(sendRequestBoundGroupMessage(deps(send, { onCommitted: p => committed.push(p) }), input())).rejects.toThrow();
    expect(committed).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    rmSync(storePath, { recursive: true, force: true });
    writeFileSync(storePath, pendingBytes!);
    const again = await sendRequestBoundGroupMessage(deps(send, { onCommitted: p => committed.push(p) }), input());
    expect(again).toMatchObject({ ok: true, messageId: 'om_real', replayed: true });
    expect(committed).toHaveLength(1);
    expect(committed[0].messageId).toBe('om_real');
    expect(committed[0].content).toBe(input().content);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await sendRequestBoundGroupMessage(deps(send, { onCommitted: p => committed.push(p) }), input())).toMatchObject({ replayed: true });
    expect(committed).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('still returns the message when the hook callback throws', async () => {
    const send = vi.fn(async () => 'om_1');
    const result = await sendRequestBoundGroupMessage(deps(send, { onCommitted: () => { throw new Error('hook down'); } }), input());
    expect(result).toMatchObject({ ok: true, messageId: 'om_1', replayed: false });
    expect(await sendRequestBoundGroupMessage(deps(send, { onCommitted: () => { throw new Error('hook down'); } }), input())).toMatchObject({ replayed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a new requestId once pending records fill the cap and still retries one that is already stored', async () => {
    const records: Record<string, GroupSendRecord> = {};
    for (let i = 0; i < GROUP_SEND_RECORD_LIMIT; i++) {
      const requestId = `req_${String(i).padStart(8, '0')}`;
      records[`${CHAT}\0${requestId}`] = pendingRecord(requestId);
    }
    writeStore(records);
    const before = readFileSync(storePath, 'utf8');
    const send = vi.fn(async () => 'om_new');
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_extra01'))).toEqual({ ok: false, status: 503, error: 'store_full', retryable: false });
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(storePath, 'utf8')).toBe(before);

    const retry = vi.fn(async () => 'om_keep');
    expect(await sendRequestBoundGroupMessage(deps(retry), { chatId: CHAT, requestId: 'req_00000000', content: 'x' })).toMatchObject({ ok: true, messageId: 'om_keep' });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')).records)).toHaveLength(GROUP_SEND_RECORD_LIMIT);
  });

  // 源码结构护栏(K1)：request-bound-group-send 必须保持不 import hook-runner。
  // 评审要求 hook 经 onCommitted 注入，服务模块被单测加载时不能拉起全局 hook 配置和子进程。
  // 只加一行未调用的 import 时，假回调的行为测试仍然全绿，所以只能读源码钉住这条边界。
  it('does not import the hook runner', () => {
    const src = readFileSync(new URL('../src/services/request-bound-group-send.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('hook-runner');
  });
});

describe('sent archive', () => {
  const archiveFile = () => groupSendArchivePath(storePath);
  const writeArchive = (records: Record<string, GroupSendRecord>) => {
    writeFileSync(archiveFile(), JSON.stringify({ schemaVersion: 1, records }));
  };
  const readRecords = (path: string) => JSON.parse(readFileSync(path, 'utf8')).records as Record<string, GroupSendRecord>;

  // Crossing the live cap through real sends rewrites the whole live file on
  // every send, which is quadratic at the production cap. Tests that cross it
  // that way run at a fiftieth of the production limits, same ratios.
  const SMALL = { record: 40, compactBatch: 4, archive: 400 };

  function fillSent(count: number, idPrefix: string, sentAtStart: number, content = 'x'): Record<string, GroupSendRecord> {
    const records: Record<string, GroupSendRecord> = {};
    for (let i = 0; i < count; i++) {
      const requestId = `${idPrefix}${String(i).padStart(7, '0')}`;
      records[`${CHAT}\0${requestId}`] = pendingRecord(requestId, CHAT, content, 'sent', sentAtStart + i);
    }
    return records;
  }

  it('refuses a new requestId when pending records fill the live file and leaves both files unchanged', async () => {
    const records: Record<string, GroupSendRecord> = {};
    for (let i = 0; i < GROUP_SEND_RECORD_LIMIT; i++) {
      const requestId = `req_${String(i).padStart(8, '0')}`;
      records[`${CHAT}\0${requestId}`] = pendingRecord(requestId);
    }
    writeStore(records);
    writeArchive({ [`${CHAT}\0req_arch001`]: pendingRecord('req_arch001', CHAT, 'x', 'sent', 1) });
    const activeBefore = readFileSync(storePath);
    const archiveBefore = readFileSync(archiveFile());
    const send = vi.fn(async () => 'om_new');
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_extra01'))).toEqual({
      ok: false, status: 503, error: 'store_full', retryable: false,
    });
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(storePath).equals(activeBefore)).toBe(true);
    expect(readFileSync(archiveFile()).equals(archiveBefore)).toBe(true);
  });

  it('keeps every live claim when the archive write fails during compaction', async () => {
    writeStore(fillSent(GROUP_SEND_RECORD_LIMIT, 'c', clock, 'x'));
    const activeBefore = readFileSync(storePath);
    const send = vi.fn(async () => 'om_new');
    // `now` runs after both files are loaded and before the archive is written.
    // A directory at the archive path fails that write without failing the load.
    let blockArchive = true;
    const now = () => {
      if (blockArchive) {
        blockArchive = false;
        mkdirSync(join(archiveFile(), 'blocker'), { recursive: true });
      }
      return clock;
    };
    await expect(sendRequestBoundGroupMessage({ ...deps(send), now }, input('req_trigger', 'x'))).rejects.toMatchObject({ syscall: 'rename' });
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(storePath).equals(activeBefore)).toBe(true);

    rmSync(archiveFile(), { recursive: true, force: true });
    const oldest = 'c0000000';
    expect(await sendRequestBoundGroupMessage(deps(send), { chatId: CHAT, requestId: oldest, content: 'x' })).toMatchObject({
      ok: true, replayed: true, messageId: `om_${oldest}`,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('replays a stored requestId inside and outside the uuid window when the live file is full', async () => {
    const requestId = 'c0000000';
    writeStore(fillSent(GROUP_SEND_RECORD_LIMIT, 'c', clock, 'x'));
    const committed: GroupSendCommitted[] = [];
    const send = vi.fn(async () => 'om_should_not');
    const onCommitted = (payload: GroupSendCommitted) => { committed.push(payload); };
    const inside = await sendRequestBoundGroupMessage(deps(send, { onCommitted }), { chatId: CHAT, requestId, content: 'x' });
    expect(inside).toMatchObject({ ok: true, replayed: true, messageId: `om_${requestId}` });
    expect(send).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    clock += GROUP_SEND_UUID_REUSE_MS + 1;
    const outside = await sendRequestBoundGroupMessage(deps(send, { onCommitted }), { chatId: CHAT, requestId, content: 'x' });
    expect(outside).toMatchObject({ ok: true, replayed: true, messageId: `om_${requestId}` });
    expect(send).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  it('still sends new requestIds past the live cap after only unseeded successes', async () => {
    __setGroupSendLimitsForTest(SMALL);
    // A full archive of older sends: what the sends below write must outrank it.
    writeArchive(fillSent(SMALL.archive, 'a', 1, 'old'));
    let n = 0;
    const send = vi.fn(async () => {
      n += 1;
      return `om_${String(n).padStart(8, '0')}`;
    });
    for (let i = 0; i < SMALL.record + 1; i++) {
      const requestId = `req_${String(i).padStart(8, '0')}`;
      expect(await sendRequestBoundGroupMessage(deps(send), input(requestId, 'fresh'))).toMatchObject({ ok: true, replayed: false });
    }
    const next = `req_${String(SMALL.record + 1).padStart(8, '0')}`;
    expect(await sendRequestBoundGroupMessage(deps(send), input(next, 'fresh'))).toMatchObject({ ok: true, replayed: false });
    expect(send).toHaveBeenCalledTimes(SMALL.record + 2);
    // The cap was crossed: the records these sends wrote themselves were
    // compacted, and as the newest sends they stayed while the oldest archived
    // ones were evicted to keep the archive at its cap.
    const archived = readRecords(archiveFile());
    expect(Object.keys(archived)).toHaveLength(SMALL.archive);
    for (let i = 0; i < SMALL.compactBatch; i++) {
      expect(archived[`${CHAT}\0req_${String(i).padStart(8, '0')}`]).toMatchObject({ state: 'sent' });
      expect(archived[`${CHAT}\0a${String(i).padStart(7, '0')}`]).toBeUndefined();
    }
  });

  it('replays an archived requestId with no provider call and reads that binding back', async () => {
    const requestId = 'req_archived';
    const record = pendingRecord(requestId, CHAT, input().content, 'sent', clock);
    writeArchive({ [`${CHAT}\0${requestId}`]: record });
    expect(existsSync(storePath)).toBe(false);
    const archiveBefore = readFileSync(archiveFile());
    const committed: GroupSendCommitted[] = [];
    const send = vi.fn(async () => 'om_new');
    const result = await sendRequestBoundGroupMessage(
      deps(send, { onCommitted: payload => committed.push(payload) }),
      input(requestId),
    );
    expect(result).toMatchObject({ ok: true, replayed: true, messageId: record.messageId });
    expect(send).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    expect(await sendRequestBoundGroupMessage(deps(send), input(requestId, 'other text'))).toEqual({
      ok: false, status: 409, error: 'request_conflict',
    });
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(storePath)).toBe(false);
    expect(readFileSync(archiveFile()).equals(archiveBefore)).toBe(true);
    const read = await readRequestBoundGroupMessage({
      larkAppId: APP, storePath,
      detail: async () => ({ items: [{
        message_id: record.messageId, chat_id: CHAT, msg_type: 'text', deleted: false,
        sender: { id: APP, id_type: 'app_id', sender_type: 'app' },
        body: { content: JSON.stringify({ text: input().content }) },
      }] }),
    }, CHAT, record.messageId!);
    expect(read).toMatchObject({ ok: true, requestId });
  });

  it('keeps the active file at the live cap and the archive within ARCHIVE_LIMIT', async () => {
    __setGroupSendLimitsForTest(SMALL);
    // Half a compaction batch past the cap: exactly one compaction.
    const total = SMALL.record + SMALL.compactBatch / 2;
    let n = 0;
    let archiveDuringSend: Buffer | undefined;
    const send = vi.fn(async () => {
      if (existsSync(archiveFile())) archiveDuringSend = readFileSync(archiveFile());
      n += 1;
      return `om_${String(n).padStart(8, '0')}`;
    });
    const sizes: number[] = [];
    let archiveIno: number | undefined;
    let archiveRewrites = 0;
    for (let i = 0; i < total; i++) {
      const requestId = `req_${String(i).padStart(8, '0')}`;
      expect(await sendRequestBoundGroupMessage(deps(send), input(requestId, 'plateau'))).toMatchObject({ ok: true, replayed: false });
      if (i + 1 === SMALL.record + 1) expect(readFileSync(archiveFile()).equals(archiveDuringSend!)).toBe(true);
      // Every atomic rewrite renames a new inode over the archive.
      if (existsSync(archiveFile()) && statSync(archiveFile()).ino !== archiveIno) {
        archiveIno = statSync(archiveFile()).ino;
        archiveRewrites++;
      }
      if (i + 1 === SMALL.record || i + 1 === total) sizes.push(statSync(storePath).size);
    }
    expect(archiveRewrites).toBe(1);
    const [atCap, atTotal] = sizes;
    expect(atTotal).toBeLessThan(atCap * 1.04);
    const live = Object.keys(readRecords(storePath)).length;
    const archived = Object.keys(readRecords(archiveFile())).length;
    expect(live).toBeLessThanOrEqual(SMALL.record);
    expect(archived).toBe(SMALL.compactBatch);
    expect(live + archived).toBe(total);

    const beforeReplay = readFileSync(archiveFile());
    await sendRequestBoundGroupMessage(deps(send), input(`req_${String(total - 1).padStart(8, '0')}`, 'plateau'));
    expect(readFileSync(archiveFile()).equals(beforeReplay)).toBe(true);

    // The same paths at the production limits, from seeded files: one send each.
    __setGroupSendLimitsForTest(null);
    rmSync(archiveFile());
    writeStore(fillSent(GROUP_SEND_RECORD_LIMIT, 'b', clock, 'plateau'));
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_firstcmp', 'plateau'))).toMatchObject({ ok: true, replayed: false });
    expect(Object.keys(readRecords(archiveFile()))).toHaveLength(GROUP_SEND_COMPACT_BATCH);
    expect(Object.keys(readRecords(storePath))).toHaveLength(GROUP_SEND_RECORD_LIMIT - GROUP_SEND_COMPACT_BATCH + 1);

    writeArchive(fillSent(GROUP_SEND_ARCHIVE_LIMIT, 'a', 1, 'old'));
    writeStore(fillSent(GROUP_SEND_RECORD_LIMIT, 'b', clock, 'plateau'));
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_pastcap', 'plateau'))).toMatchObject({ ok: true, replayed: false });
    expect(Object.keys(readRecords(archiveFile()))).toHaveLength(GROUP_SEND_ARCHIVE_LIMIT);
  });

  it('retries a requestId evicted from the archive as a new send', async () => {
    const victim = 'req_victim1';
    const archived = fillSent(GROUP_SEND_ARCHIVE_LIMIT - 2, 'a', 2, 'x');
    const victimRecord = pendingRecord(victim, CHAT, 'x', 'sent', 1);
    victimRecord.sentAt = 1;
    archived[`${CHAT}\0${victim}`] = victimRecord;
    // The oldest attempt, but sent late: retention follows sentAt, so it stays.
    const keeper = 'req_keeper1';
    const keeperRecord = pendingRecord(keeper, CHAT, 'x', 'sent', 0);
    keeperRecord.sentAt = GROUP_SEND_ARCHIVE_LIMIT + 5;
    archived[`${CHAT}\0${keeper}`] = keeperRecord;
    writeArchive(archived);
    writeStore(fillSent(GROUP_SEND_RECORD_LIMIT, 'b', GROUP_SEND_ARCHIVE_LIMIT + 10, 'x'));
    const send = vi.fn(async () => 'om_newsend');
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_trigger', 'x'))).toMatchObject({
      ok: true, replayed: false, messageId: 'om_newsend',
    });
    expect(readRecords(archiveFile())[`${CHAT}\0${victim}`]).toBeUndefined();
    expect(readRecords(archiveFile())[`${CHAT}\0${keeper}`]).toMatchObject({ messageId: `om_${keeper}` });
    const retry = await sendRequestBoundGroupMessage(deps(send), { chatId: CHAT, requestId: victim, content: 'x' });
    expect(retry).toMatchObject({ ok: true, replayed: false, messageId: 'om_newsend' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('prefers the live messageId when the archive has a different one for the same key', async () => {
    const requestId = 'req_diverg1';
    const storeKey = `${CHAT}\0${requestId}`;
    const live = pendingRecord(requestId, CHAT, 'x', 'sent', clock);
    live.messageId = 'om_LIVE';
    const stale = pendingRecord(requestId, CHAT, 'x', 'sent', clock - 5);
    stale.messageId = 'om_STALE';
    stale.sentAt = clock - 5;
    writeStore({ [storeKey]: live });
    writeArchive({ [storeKey]: stale });
    const send = vi.fn(async () => 'om_new');
    expect(await sendRequestBoundGroupMessage(deps(send), { chatId: CHAT, requestId, content: 'x' })).toMatchObject({
      ok: true, replayed: true, messageId: 'om_LIVE',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('read-back returns the requestId for both the live and the archived message id', async () => {
    const requestId = 'req_diverg1';
    const storeKey = `${CHAT}\0${requestId}`;
    const live = pendingRecord(requestId, CHAT, 'x', 'sent', clock);
    live.messageId = 'om_LIVE';
    const stale = pendingRecord(requestId, CHAT, 'x', 'sent', clock - 5);
    stale.messageId = 'om_STALE';
    stale.sentAt = clock - 5;
    writeStore({ [storeKey]: live });
    writeArchive({ [storeKey]: stale });
    const detail = async (messageId: string) => ({ items: [{
      message_id: messageId, chat_id: CHAT, msg_type: 'text', deleted: false, create_time: '1',
      sender: { id: APP, id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify({ text: 'x' }) },
    }] });
    const base = { larkAppId: APP, storePath, detail };
    expect(await readRequestBoundGroupMessage(base, CHAT, 'om_LIVE')).toMatchObject({ ok: true, requestId });
    expect(await readRequestBoundGroupMessage(base, CHAT, 'om_STALE')).toMatchObject({ ok: true, requestId });
  });

  it('fails closed when the archive is unreadable and does not call the provider', async () => {
    writeFileSync(archiveFile(), '{not json');
    const send = vi.fn(async () => 'om_x');
    await expect(sendRequestBoundGroupMessage(deps(send), input())).rejects.toThrow(/invalid|JSON|Unexpected/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('readRequestBoundGroupMessage', () => {
  const item = (over: Record<string, unknown> = {}) => ({ items: [{
    message_id: 'om_1', chat_id: CHAT, msg_type: 'text', deleted: false, create_time: '1700000000000',
    sender: { id: APP, id_type: 'app_id', sender_type: 'app' }, body: { content: JSON.stringify({ text: 'mosa-checkin abc123' }) }, ...over,
  }] });

  it('reads back sender, text and the bound requestId', async () => {
    await sendRequestBoundGroupMessage(deps(async () => 'om_1'), input());
    const r = await readRequestBoundGroupMessage({ larkAppId: APP, storePath, detail: async () => item() }, CHAT, 'om_1');
    expect(r).toEqual({ ok: true, messageId: 'om_1', chatId: CHAT, deleted: false, msgType: 'text',
      sender: { id: APP, idType: 'app_id', senderType: 'app', isSelf: true }, createTime: '1700000000000',
      text: 'mosa-checkin abc123', requestId: 'req_000001' });
  });

  it('treats this app stamped as bot as self, and another bot as not', async () => {
    const base = { larkAppId: APP, storePath };
    const self = await readRequestBoundGroupMessage({ ...base, detail: async () => item({ sender: { id: APP, id_type: 'app_id', sender_type: 'bot' } }) }, CHAT, 'om_1');
    expect(self).toMatchObject({ ok: true, sender: { senderType: 'bot', id: APP, isSelf: true } });
    const other = await readRequestBoundGroupMessage({ ...base, detail: async () => item({ sender: { id: 'cli_other_bot', id_type: 'app_id', sender_type: 'bot' } }) }, CHAT, 'om_1');
    expect(other).toMatchObject({ ok: true, sender: { senderType: 'bot', id: 'cli_other_bot', isSelf: false } });
  });

  it('reports deleted, foreign senders and unbound messages honestly', async () => {
    const r = await readRequestBoundGroupMessage({ larkAppId: APP, storePath,
      detail: async () => item({ deleted: true, sender: { id: 'ou_x', id_type: 'open_id', sender_type: 'user' } }) }, CHAT, 'om_1');
    expect(r).toMatchObject({ ok: true, deleted: true, requestId: null, sender: { isSelf: false, senderType: 'user' } });
  });

  it('rejects chat mismatch, missing messages and provider errors', async () => {
    const base = { larkAppId: APP, storePath };
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => item({ chat_id: 'oc_other' }) }, CHAT, 'om_1')).toEqual({ ok: false, status: 409, error: 'chat_mismatch' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => ({ items: [] }) }, CHAT, 'om_1')).toEqual({ ok: false, status: 404, error: 'not_found' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw new Error('x'); } }, CHAT, 'om_1')).toEqual({ ok: false, status: 502, error: 'read_failed' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => item() }, '../../etc/x', 'om_1')).toEqual({ ok: false, status: 400, error: 'invalid_request' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw Object.assign(new Error('rate'), { response: { data: { code: 99991400 } } }); } }, CHAT, 'om_1')).toEqual({ ok: false, status: 502, error: 'read_failed' });
  });

  it('maps withdrawn and not-visible rejections instead of a blanket 502', async () => {
    await sendRequestBoundGroupMessage(deps(async () => 'om_1'), input());
    const base = { larkAppId: APP, storePath };
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw larkApiError('get message', { code: 230011, msg: 'withdrawn' }); } }, CHAT, 'om_1')).toEqual({
      ok: true, messageId: 'om_1', chatId: CHAT, deleted: true, msgType: null,
      sender: { id: null, idType: null, senderType: null, isSelf: false },
      createTime: null, text: null, requestId: 'req_000001',
    });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw Object.assign(new Error('gone'), { response: { status: 400, data: { code: 230011 } } }); } }, CHAT, 'om_2')).toMatchObject({ ok: true, deleted: true, messageId: 'om_2', requestId: null });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw Object.assign(new Error('not in chat'), { response: { status: 400, data: { code: 230002 } } }); } }, CHAT, 'om_1')).toEqual({ ok: false, status: 404, error: 'not_found' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw larkApiError('get message', { code: 230001, msg: 'invalid' }); } }, CHAT, 'om_1')).toEqual({ ok: false, status: 404, error: 'not_found' });
  });
});

describe('request-bound group send routes', () => {
  let handle: IpcServerHandle | null = null;
  let previousDataDir: string;
  const routeApp = 'cli_route_send';
  const routeChat = 'oc_route_group_send_long';

  beforeEach(async () => {
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dir;
    setLarkAppId(routeApp);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    setLarkAppId('');
    config.session.dataDir = previousDataDir;
  });

  const post = (chatId: string, body: string) => fetch(`http://127.0.0.1:${handle!.port}/api/groups/${chatId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });

  it('passes service statuses through and bounds the body', async () => {
    const bad = await post(routeChat, '{}');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: 'invalid_request' });

    const notJson = await post(routeChat, '{');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ ok: false, error: 'bad_json' });

    const shaped = await post('ou_not_a_chat', JSON.stringify({ requestId: 'req_route1', content: 'hello' }));
    expect(shaped.status).toBe(400);
    expect(await shaped.json()).toEqual({ ok: false, error: 'invalid_request' });

    const huge = await post(routeChat, JSON.stringify({ requestId: 'req_route1', content: 'x'.repeat(GROUP_SEND_BODY_MAX_BYTES) }));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ ok: false, error: 'body_too_large' });

    const requestId = 'req_route1';
    const content = 'hello';
    const record = pendingRecord(requestId, routeChat, content, 'sent');
    record.messageId = 'om_seed';
    writeFileSync(join(dir, `group-sends-${routeApp}.json`), JSON.stringify({
      schemaVersion: 1,
      records: { [`${routeChat}\0${requestId}`]: { ...record, uuid: groupSendUuid(routeApp, routeChat, requestId) } },
    }));
    const ok = await post(routeChat, JSON.stringify({ requestId, content }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, messageId: 'om_seed', requestId, chatId: routeChat, replayed: true });

    const conflict = await post(routeChat, JSON.stringify({ requestId, content: 'other text' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: 'request_conflict' });

    const missing = await fetch(`http://127.0.0.1:${handle!.port}/api/groups/${routeChat}/messages/om_missing`);
    expect(missing.status).toBe(502);
    expect(await missing.json()).toEqual({ ok: false, error: 'read_failed' });

    writeFileSync(join(dir, `group-sends-${routeApp}.json`), '{not json');
    const unavailable = await post(routeChat, JSON.stringify({ requestId: 'req_route9', content: 'hello' }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, error: 'store_unavailable', retryable: true });
  });

  it('suppresses the client hook and emits outbound.send from the route once', async () => {
    const sendMessage = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_route');
    const emit = vi.spyOn(hookRunner, 'emitHookEventLocal').mockImplementation(() => {});
    try {
      const requestId = 'req_route2';
      const content = 'hello plain';
      const first = await post(routeChat, JSON.stringify({ requestId, content }));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, messageId: 'om_route', replayed: false });
      expect(sendMessage).toHaveBeenCalledWith(routeApp, routeChat, content, 'text', groupSendUuid(routeApp, routeChat, requestId), undefined, { suppressHook: true });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('outbound.send', {
        larkAppId: routeApp, chatId: routeChat, messageId: 'om_route', msgType: 'text',
        uuid: groupSendUuid(routeApp, routeChat, requestId), content, requestId,
      });
      const again = await post(routeChat, JSON.stringify({ requestId, content }));
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ replayed: true, messageId: 'om_route' });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledTimes(1);
    } finally {
      sendMessage.mockRestore();
      emit.mockRestore();
    }
  });
});
