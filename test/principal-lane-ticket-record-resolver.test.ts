import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as messageQueueModule from '../src/services/message-queue.js';
import {
  appendPrincipalLaneQueueRecord,
  openPrincipalLaneQueue,
  principalLaneAppendReceiptLocator,
  rehydratePrincipalLaneClaimedRecordFromTicket,
  type PrincipalLaneDurableRecordLocator,
} from '../src/services/message-queue.js';
import {
  principalLaneTicketRecordLocator,
  resolvePrincipalLaneTicketRecord,
  type PrincipalLaneAdmissionTicketCapability,
  type VerifiedPrincipalLaneTicketRecord,
} from '../src/services/principal-lane-ticket-record-resolver.js';
import type { LarkMessage } from '../src/types.js';
import { principalLaneRecordFixture } from './helpers/principal-lane-record-fixture.js';

function message(): LarkMessage {
  return {
    messageId: 'message-production-resolver',
    rootId: 'root-record-shared',
    senderId: 'ou_record_user',
    senderType: 'user',
    msgType: 'text',
    content: 'resolver boundary',
    createTime: '1789783200000',
  };
}

let dataDir: string;
let previousDataDir: string | undefined;
let previousNodeEnv: string | undefined;
let previousVitest: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-record-resolver-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  previousNodeEnv = process.env.NODE_ENV;
  previousVitest = process.env.VITEST;
  config.session.dataDir = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;
});

describe('principal lane production ticket record resolver boundary', () => {
  it('does not export environment-gated raw locator test issuers', () => {
    expect(messageQueueModule).not.toHaveProperty('__testOnlyRehydrateClaimedPrincipalLaneRecord');
    expect(messageQueueModule).not.toHaveProperty('__testOnlyDropPrincipalLaneAppendReceipt');
  });

  it('rejects raw locators and hand-built tickets even when test environment flags are set', () => {
    process.env.NODE_ENV = 'test';
    process.env.VITEST = 'true';
    const fixture = principalLaneRecordFixture();
    const opened = openPrincipalLaneQueue(fixture.capability, fixture.authority);
    if (opened.status !== 'ready') throw new Error(`open failed: ${opened.status}`);
    const appended = appendPrincipalLaneQueueRecord(
      opened.value, fixture.authority, 'turn-production-resolver', message(),
    );
    if (appended.status !== 'ready') throw new Error(`append failed: ${appended.status}`);
    const located = principalLaneAppendReceiptLocator(appended.value, fixture.authority);
    if (located.status !== 'ready') throw new Error(`locator failed: ${located.status}`);
    const rawLocator = located.value as PrincipalLaneDurableRecordLocator;

    expect(rehydratePrincipalLaneClaimedRecordFromTicket(
      opened.value,
      fixture.authority,
      rawLocator as unknown as PrincipalLaneAdmissionTicketCapability,
    )).toEqual({ status: 'invalid', reason: 'invalid_capability' });
    expect(rehydratePrincipalLaneClaimedRecordFromTicket(
      opened.value,
      fixture.authority,
      { version: 1 } as PrincipalLaneAdmissionTicketCapability,
    )).toEqual({ status: 'invalid', reason: 'invalid_capability' });
    expect(resolvePrincipalLaneTicketRecord(
      { version: 1 } as PrincipalLaneAdmissionTicketCapability,
      fixture.authority,
    )).toEqual({ status: 'invalid', reason: 'invalid_ticket_capability' });
  });

  it('does not accept a structurally hand-built verified resolver result', () => {
    expect(principalLaneTicketRecordLocator(
      { version: 1 } as VerifiedPrincipalLaneTicketRecord,
    )).toBeUndefined();
  });
});
