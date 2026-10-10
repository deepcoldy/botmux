import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsObservation = vi.hoisted(() => ({
  readPaths: [] as string[],
  fsyncCalls: 0,
  failFsyncAt: 0,
}));

const ticketResolver = vi.hoisted(() => ({
  tickets: new WeakMap<object, Readonly<Record<string, unknown>>>(),
  verified: new WeakMap<object, Readonly<Record<string, unknown>>>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      fsObservation.readPaths.push(String(args[0]));
      return (actual.readFileSync as (...inner: typeof args) => ReturnType<typeof actual.readFileSync>)(...args);
    },
    fsyncSync: (fd: number) => {
      fsObservation.fsyncCalls += 1;
      if (fsObservation.failFsyncAt === fsObservation.fsyncCalls) {
        const error = new Error('injected fsync failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return actual.fsyncSync(fd);
    },
  };
});

vi.mock('../src/services/principal-lane-ticket-record-resolver.js', () => ({
  resolvePrincipalLaneTicketRecord: (ticket: object) => {
    const locator = ticketResolver.tickets.get(ticket);
    if (!locator) return { status: 'invalid', reason: 'invalid_ticket_capability' };
    const verified = Object.freeze({ version: 1 });
    ticketResolver.verified.set(verified, locator);
    return { status: 'ready', value: verified };
  },
  principalLaneTicketRecordLocator: (verified: object) => ticketResolver.verified.get(verified),
}));

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { config } from '../src/config.js';
import type { LarkMessage } from '../src/types.js';
import {
  appendPrincipalLaneQueueRecord,
  inventoryPrincipalLaneQueueRecords,
  openPrincipalLaneQueue,
  principalLaneAppendReceiptLocator,
  readExactPrincipalLaneQueueRecord,
  rehydratePrincipalLaneClaimedRecordFromTicket,
  type PrincipalLaneAppendReceipt,
  type PrincipalLaneClaimedRecordCapability,
  type PrincipalLaneDurableRecordLocator,
} from '../src/services/message-queue.js';
import type { PrincipalLaneAdmissionTicketCapability } from '../src/services/principal-lane-ticket-record-resolver.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { principalLaneRecordFixture } from './helpers/principal-lane-record-fixture.js';

function message(id: string, content = `payload-${id}`): LarkMessage {
  return {
    messageId: id,
    rootId: 'root-record-shared',
    senderId: 'ou_record_user',
    senderType: 'user',
    msgType: 'text',
    content,
    createTime: '1789783200000',
  };
}

function readyValue<T>(result: { status: string; value?: T; reason?: string }): T {
  if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}:${result.reason}`);
  return result.value as T;
}

function recordPath(dataDir: string, locator: PrincipalLaneDurableRecordLocator): string {
  return join(
    dataDir,
    'queues',
    'principal-lanes',
    `v${locator.namespaceVersion}`,
    locator.namespace,
    'records',
    `v${locator.recordVersion}`,
    `${locator.recordId}.json`,
  );
}

function openRecordLane() {
  const fixture = principalLaneRecordFixture();
  const handle = readyValue(openPrincipalLaneQueue(fixture.capability, fixture.authority));
  return { ...fixture, handle };
}

function appendRecord(lane: ReturnType<typeof openRecordLane>, turnId: string, payload: LarkMessage) {
  const receipt = readyValue<PrincipalLaneAppendReceipt>(
    appendPrincipalLaneQueueRecord(lane.handle, lane.authority, turnId, payload),
  );
  const locator = readyValue<Readonly<PrincipalLaneDurableRecordLocator>>(
    principalLaneAppendReceiptLocator(receipt, lane.authority),
  );
  return { receipt, locator };
}

function verifiedTicketFor(locator: Readonly<PrincipalLaneDurableRecordLocator>) {
  const ticket = Object.freeze({ version: 1 }) as PrincipalLaneAdmissionTicketCapability;
  ticketResolver.tickets.set(
    ticket as object,
    Object.freeze(structuredClone(locator)) as unknown as Readonly<Record<string, unknown>>,
  );
  return ticket;
}

function runChildAppend(dataDir: string, turnId: string, payload: LarkMessage) {
  const source = `
    process.env.SESSION_DATA_DIR = ${JSON.stringify(dataDir)};
    import { principalLaneRecordFixture } from './test/helpers/principal-lane-record-fixture.js';
    import {
      appendPrincipalLaneQueueRecord,
      openPrincipalLaneQueue,
      principalLaneAppendReceiptLocator,
    } from './src/services/message-queue.js';
    const fixture = principalLaneRecordFixture();
    const opened = openPrincipalLaneQueue(fixture.capability, fixture.authority);
    if (opened.status !== 'ready') throw new Error('open:' + JSON.stringify(opened));
    const appended = appendPrincipalLaneQueueRecord(
      opened.value,
      fixture.authority,
      ${JSON.stringify(turnId)},
      ${JSON.stringify(payload)},
    );
    if (appended.status !== 'ready') throw new Error('append:' + JSON.stringify(appended));
    const located = principalLaneAppendReceiptLocator(appended.value, fixture.authority);
    if (located.status !== 'ready') throw new Error('locator:' + JSON.stringify(located));
    console.log('RECORD_LOCATOR=' + JSON.stringify(located.value));
  `;
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawnTsEvalWithRepoImports(source, {
      env: { ...process.env, SESSION_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

let dataDir: string;
let previousDataDir: string | undefined;
let previousNodeEnv: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-principal-record-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  previousNodeEnv = process.env.NODE_ENV;
  config.session.dataDir = dataDir;
  process.env.NODE_ENV = 'test';
  fsObservation.readPaths = [];
  fsObservation.fsyncCalls = 0;
  fsObservation.failFsyncAt = 0;
  ticketResolver.tickets = new WeakMap();
  ticketResolver.verified = new WeakMap();
});

afterEach(() => {
  fsObservation.failFsyncAt = 0;
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

describe('principal lane immutable exact records', () => {
  it('publishes canonical bytes and reads only the exact selected record', () => {
    const lane = openRecordLane();
    const first = appendRecord(lane, 'turn-a', message('message-a'));
    const second = appendRecord(lane, 'turn-b', message('message-b'));
    const firstPath = recordPath(dataDir, first.locator as PrincipalLaneDurableRecordLocator);
    const secondPath = recordPath(dataDir, second.locator as PrincipalLaneDurableRecordLocator);
    fsObservation.readPaths = [];

    expect(readExactPrincipalLaneQueueRecord(first.receipt, lane.authority)).toEqual({
      status: 'ready', value: message('message-a'),
    });
    expect(fsObservation.readPaths).toContain(firstPath);
    expect(fsObservation.readPaths).not.toContain(secondPath);
    const laneDir = join(
      dataDir, 'queues', 'principal-lanes', 'v1', lane.handle.namespace,
    );
    expect(existsSync(join(laneDir, 'messages.jsonl'))).toBe(false);
    expect(existsSync(join(laneDir, 'messages.offset'))).toBe(false);
  });

  it('rehydrates a child-process record only through a resolver-verified ticket', async () => {
    const lane = openRecordLane();
    const payload = message('message-restart');
    const outcome = await runChildAppend(dataDir, 'turn-restart', payload);
    expect(outcome.code, outcome.output).toBe(0);
    const marker = outcome.output.split('RECORD_LOCATOR=')[1];
    expect(marker, outcome.output).toBeDefined();
    const locator = JSON.parse(
      marker!.trim().split('\n')[0]!,
    ) as PrincipalLaneDurableRecordLocator;
    expect(readExactPrincipalLaneQueueRecord(
      { version: 1 } as PrincipalLaneClaimedRecordCapability,
      lane.authority,
    )).toEqual({ status: 'invalid', reason: 'invalid_capability' });

    const claimed = readyValue<PrincipalLaneClaimedRecordCapability>(
      rehydratePrincipalLaneClaimedRecordFromTicket(
        lane.handle,
        lane.authority,
        verifiedTicketFor(locator),
      ),
    );
    expect(readExactPrincipalLaneQueueRecord(claimed, lane.authority)).toEqual({
      status: 'ready', value: payload,
    });
    expect(rehydratePrincipalLaneClaimedRecordFromTicket(
      lane.handle,
      lane.authority,
      { version: 1 } as PrincipalLaneAdmissionTicketCapability,
    )).toEqual({ status: 'invalid', reason: 'invalid_capability' });
  });

  it('is idempotent for the same turn and payload without exposing staging files', () => {
    const lane = openRecordLane();
    const first = appendRecord(lane, 'turn-idempotent', message('message-idempotent'));
    const second = appendRecord(lane, 'turn-idempotent', message('message-idempotent'));
    expect(second.locator).toEqual(first.locator);
    expect(inventoryPrincipalLaneQueueRecords(lane.handle, lane.authority)).toEqual({
      status: 'ready',
      value: {
        namespaceVersion: first.locator.namespaceVersion,
        namespace: first.locator.namespace,
        records: [{
          recordId: first.locator.recordId,
          exactFileLength: first.locator.exactFileLength,
        }],
        staging: [],
      },
    });
  });

  it('keeps distinct immutable records for the same turn with different payloads', () => {
    const lane = openRecordLane();
    const first = appendRecord(lane, 'turn-conflicting-payload', message('message-one', 'one'));
    const second = appendRecord(lane, 'turn-conflicting-payload', message('message-two', 'two'));
    expect(second.locator.recordId).not.toBe(first.locator.recordId);
    expect(inventoryPrincipalLaneQueueRecords(lane.handle, lane.authority)).toMatchObject({
      status: 'ready', value: { records: [{}, {}], staging: [] },
    });
  });

  it('revalidates dispatch authority before touching an exact record', () => {
    const lane = openRecordLane();
    const appended = appendRecord(lane, 'turn-stale', message('message-stale'));
    const staleAuthority = {
      ...lane.authority,
      source: {
        ...lane.authority.source,
        source: {
          ...lane.authority.source.source,
          revision: lane.authority.source.source.revision + 1,
        },
      },
    };
    fsObservation.readPaths = [];
    expect(readExactPrincipalLaneQueueRecord(appended.receipt, staleAuthority)).toEqual({
      status: 'retry', reason: 'stale_authority',
    });
    expect(fsObservation.readPaths).toEqual([]);
  });

  it('never signs a receipt when fsync fails and ignores partial staging tails', () => {
    const lane = openRecordLane();
    fsObservation.failFsyncAt = fsObservation.fsyncCalls + 2;
    expect(appendPrincipalLaneQueueRecord(
      lane.handle, lane.authority, 'turn-fsync-fail', message('message-fsync-fail'),
    )).toEqual({ status: 'retry', reason: 'record_io_failed' });
    fsObservation.failFsyncAt = 0;
    const recordsDir = join(
      dataDir, 'queues', 'principal-lanes', 'v1', lane.handle.namespace, 'records', 'v1',
    );
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(join(recordsDir, '.stage-00000000-0000-0000-0000-000000000000.tmp'), '{partial');
    const valid = appendRecord(lane, 'turn-valid-after-tail', message('message-valid'));
    expect(readExactPrincipalLaneQueueRecord(valid.receipt, lane.authority)).toMatchObject({
      status: 'ready', value: { messageId: 'message-valid' },
    });
    expect(inventoryPrincipalLaneQueueRecords(lane.handle, lane.authority)).toMatchObject({
      status: 'ready', value: { records: [{ recordId: valid.locator.recordId }], staging: [{
        name: '.stage-00000000-0000-0000-0000-000000000000.tmp',
      }] },
    });
  });

  it('fails closed on payload, envelope, locator and file-length tampering', () => {
    const cases: Array<(path: string, locator: PrincipalLaneDurableRecordLocator) => void> = [
      path => writeFileSync(path, '{"partial":'),
      path => {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        raw.turnId = 'other-turn';
        writeFileSync(path, JSON.stringify(raw));
      },
      path => {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        raw.payloadHash = `sha256:${'0'.repeat(64)}`;
        writeFileSync(path, JSON.stringify(raw));
      },
      path => writeFileSync(path, `${readFileSync(path, 'utf8')}x`),
    ];
    for (const mutate of cases) {
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true });
      const lane = openRecordLane();
      const appended = appendRecord(lane, 'turn-tamper', message('message-tamper'));
      const locator = appended.locator as PrincipalLaneDurableRecordLocator;
      mutate(recordPath(dataDir, locator), locator);
      expect(readExactPrincipalLaneQueueRecord(appended.receipt, lane.authority).status)
        .toBe('quarantined');
    }
  });

  it('rejects non-canonical and oversized payloads before creating record files', () => {
    const lane = openRecordLane();
    expect(appendPrincipalLaneQueueRecord(
      lane.handle,
      lane.authority,
      'turn-nan',
      { ...message('message-nan'), extra: Number.NaN } as unknown as LarkMessage,
    )).toEqual({ status: 'invalid', reason: 'invalid_record_input' });
    const cyclic = message('message-cycle') as LarkMessage & { self?: unknown };
    cyclic.self = cyclic;
    expect(appendPrincipalLaneQueueRecord(
      lane.handle, lane.authority, 'turn-cycle', cyclic,
    )).toEqual({ status: 'invalid', reason: 'invalid_record_input' });
    expect(appendPrincipalLaneQueueRecord(
      lane.handle,
      lane.authority,
      'turn-large',
      message('message-large', 'x'.repeat(1024 * 1024 + 1)),
    )).toEqual({ status: 'invalid', reason: 'record_too_large' });
    expect(inventoryPrincipalLaneQueueRecords(lane.handle, lane.authority)).toEqual({
      status: 'ready',
      value: {
        namespaceVersion: lane.handle.namespaceVersion,
        namespace: lane.handle.namespace,
        records: [], staging: [],
      },
    });
  });

  it('atomically publishes one final file under a two-process same-record race', async () => {
    const lane = openRecordLane();
    const payload = message('message-race');
    const outcomes = await Promise.all([
      runChildAppend(dataDir, 'turn-race', payload),
      runChildAppend(dataDir, 'turn-race', payload),
    ]);
    const locators = outcomes.map(outcome => {
      expect(outcome.code, outcome.output).toBe(0);
      const marker = outcome.output.split('RECORD_LOCATOR=')[1];
      expect(marker, outcome.output).toBeDefined();
      return JSON.parse(marker!.trim().split('\n')[0]!) as PrincipalLaneDurableRecordLocator;
    });
    expect(locators[1]).toEqual(locators[0]);
    const claimed = readyValue<PrincipalLaneClaimedRecordCapability>(
      rehydratePrincipalLaneClaimedRecordFromTicket(
        lane.handle,
        lane.authority,
        verifiedTicketFor(locators[0]!),
      ),
    );
    expect(readExactPrincipalLaneQueueRecord(claimed, lane.authority)).toEqual({
      status: 'ready', value: payload,
    });
    expect(inventoryPrincipalLaneQueueRecords(lane.handle, lane.authority)).toMatchObject({
      status: 'ready', value: { records: [{ recordId: locators[0]!.recordId }], staging: [] },
    });
  });
});
