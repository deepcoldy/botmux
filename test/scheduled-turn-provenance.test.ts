/**
 * scheduled-turn-provenance.test.ts
 *
 * Unit tests for the scheduled-turn authentication helper shared by the CLI
 * provenance resolver and the daemon relay authorizer. Focus: turnId parsing,
 * task lookup, binding checks, and the injected owner gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  authorizeScheduledTurn,
  parseScheduledTurnId,
  readScheduledTaskForProvenance,
} from '../src/core/scheduled-turn-provenance.js';
import { botHomePath } from '../src/adapters/cli/read-isolation.js';

const TASK_ID = 'abcdef12';
const TURN_ID = `schedule:${TASK_ID}:12345678-1234-1234-1234-123456789abc`;

describe('parseScheduledTurnId', () => {
  it('extracts the task id from a scheduled turn id', () => {
    expect(parseScheduledTurnId(TURN_ID)).toBe(TASK_ID);
  });

  it('rejects human and malformed turn ids', () => {
    expect(parseScheduledTurnId('turn-1')).toBeNull();
    expect(parseScheduledTurnId('schedule:abc:def')).toBeNull();
    // task id must be exactly 8 lowercase hex chars
    expect(parseScheduledTurnId('schedule:short123:12345678-1234-1234-1234-123456789abc')).toBeNull();
    expect(parseScheduledTurnId('schedule:ABCDEF12:12345678-1234-1234-1234-123456789abc')).toBeNull();
    // no prefix smuggling
    expect(parseScheduledTurnId(`x${TURN_ID}`)).toBeNull();
    // uuid must be its canonical 8-4-4-4-12 hex shape
    expect(parseScheduledTurnId(`schedule:${TASK_ID}:12345678-1234-1234-1234-123456789ab`)).toBeNull();
  });
});

describe('authorizeScheduledTurn', () => {
  let root: string;
  let dataDir: string;
  const appId = 'cli_test';
  const chatId = 'oc_test';
  const owner = 'ou_owner';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-sched-auth-'));
    // Mirror the real layout: sessions live under `<root>/sessions`, so the
    // per-bot schedules.json resolves to `<root>/bots/<appId>/schedules.json`.
    dataDir = join(root, 'sessions');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function schedulesPath(): string {
    return join(botHomePath(dirname(dataDir), appId), 'schedules.json');
  }

  function writeTask(over: Record<string, unknown> = {}): void {
    const dir = dirname(schedulesPath());
    mkdirSync(dir, { recursive: true });
    writeFileSync(schedulesPath(), JSON.stringify({
      [TASK_ID]: {
        id: TASK_ID,
        name: 't',
        chatId,
        larkAppId: appId,
        ownerOpenId: owner,
        enabled: true,
        ...over,
      },
    }));
  }

  const allow = () => true;
  const deny = () => false;
  const call = (isOwnerAllowed: (app: string, openId: string) => boolean = allow) =>
    authorizeScheduledTurn({
      turnId: TURN_ID,
      dataDir,
      sessionLarkAppId: appId,
      sessionChatId: chatId,
      isOwnerAllowed,
    });

  it('authorizes a matching task when the owner gate passes', () => {
    writeTask();
    expect(call()).toMatchObject({ ownerOpenId: owner, taskLarkAppId: appId });
  });

  it('reads the task back through the sandbox-safe file helper', () => {
    writeTask();
    const task = readScheduledTaskForProvenance(dataDir, appId, TASK_ID);
    expect(task?.ownerOpenId).toBe(owner);
  });

  it('rejects when the task does not exist', () => {
    expect(call()).toEqual({ error: 'task_not_found' });
  });

  it('rejects a disabled task', () => {
    writeTask({ enabled: false });
    expect(call()).toEqual({ error: 'task_disabled' });
  });

  it('rejects a task without ownerOpenId (legacy task cannot run workflows)', () => {
    writeTask({ ownerOpenId: undefined });
    expect(call()).toEqual({ error: 'task_owner_missing' });
  });

  it('rejects when the owner gate fails (creator revoked)', () => {
    writeTask();
    expect(call(deny)).toEqual({ error: 'owner_revoked' });
  });

  it('rejects a chat binding mismatch', () => {
    writeTask();
    expect(authorizeScheduledTurn({
      turnId: TURN_ID, dataDir, sessionLarkAppId: appId,
      sessionChatId: 'oc_other', isOwnerAllowed: allow,
    })).toEqual({ error: 'binding_mismatch' });
  });

  it('rejects an app binding mismatch', () => {
    // The task row lives in cli_test's store but claims a different app —
    // store isolation already binds the file, so this exercises the
    // defense-in-depth row check.
    writeTask({ larkAppId: 'cli_other' });
    expect(call()).toEqual({ error: 'binding_mismatch' });
  });

  it('accepts a legacy task without larkAppId (bound by its own store path)', () => {
    writeTask({ larkAppId: undefined });
    expect(call()).toMatchObject({ ownerOpenId: owner, taskLarkAppId: appId });
  });

  it('fails closed on a corrupt schedules.json', () => {
    mkdirSync(dirname(schedulesPath()), { recursive: true });
    writeFileSync(schedulesPath(), '{not json');
    expect(call()).toEqual({ error: 'task_not_found' });
  });

  it('passes the resolved app id and owner into the gate', () => {
    writeTask({ larkAppId: undefined });
    const seen: Array<[string, string]> = [];
    authorizeScheduledTurn({
      turnId: TURN_ID, dataDir, sessionLarkAppId: appId, sessionChatId: chatId,
      isOwnerAllowed: (app, openId) => { seen.push([app, openId]); return true; },
    });
    expect(seen).toEqual([[appId, owner]]);
  });
});
