/**
 * VC meeting stores must tell "could not read the file" apart from "read the
 * bytes and they are invalid". Only the latter may quarantine.
 *
 * Incident (2026-11-06): a perfectly valid `vc-meeting-runtime-sessions.json`
 * (content `{}\n`) was renamed to `.corrupt.*` by a reader whose read failed;
 * afterwards every daemon threw "quarantined evidence" on each group @mention
 * and dropped the message. Read errors are injected below by failing the real
 * fs call for one exact path (EMFILE / EIO), everything else stays real.
 */
// Must stay the first import (this file fakes node:fs; see the helper).
import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsFaults = vi.hoisted(() => ({
  /** errno thrown when opening/reading this exact path */
  read: new Map<string, string>(),
  stat: new Map<string, string>(),
  readdir: new Map<string, string>(),
  /** runs right after the path was opened (the fd already pins the old inode) */
  afterOpen: new Map<string, () => void>(),
}));

function errnoError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected ${syscall} failure, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const code = typeof path === 'string' ? fsFaults.read.get(path) : undefined;
    if (code) throw errnoError(code, 'open', path as string);
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  const statSync = ((path: unknown, ...rest: unknown[]) => {
    const code = typeof path === 'string' ? fsFaults.stat.get(path) : undefined;
    if (code) throw errnoError(code, 'stat', path as string);
    return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.statSync;
  const readdirSync = ((path: unknown, ...rest: unknown[]) => {
    const code = typeof path === 'string' ? fsFaults.readdir.get(path) : undefined;
    if (code) throw errnoError(code, 'scandir', path as string);
    return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readdirSync;
  const openSync = ((path: unknown, ...rest: unknown[]) => {
    const code = typeof path === 'string' ? fsFaults.read.get(path) : undefined;
    if (code) throw errnoError(code, 'open', path as string);
    const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    const hook = typeof path === 'string' ? fsFaults.afterOpen.get(path) : undefined;
    if (hook) {
      fsFaults.afterOpen.delete(path as string);
      hook();
    }
    return fd;
  }) as typeof actual.openSync;
  const patched = { ...actual, readFileSync, statSync, readdirSync, openSync };
  return { ...patched, default: patched };
});

import { isStoreFileUnavailableError } from '../src/utils/json-file.js';
import {
  hasVcMeetingEndedTombstone,
  listVcMeetingRuntimeSessions,
  listVcMeetingRuntimeSessionsByListenerAndAgent,
  recordVcMeetingRuntimeSession,
} from '../src/services/vc-meeting-runtime-store.js';
import { getVcMeetingHubCloseState } from '../src/services/vc-meeting-delivery-hub-store.js';
import {
  getVcMeetingFeedMetadataState,
  ingestVcMeetingFeedMetadata,
} from '../src/services/vc-meeting-feed-metadata-store.js';
import {
  applyVcMeetingMemberProjection,
  getVcMeetingMemberProjection,
  listVcMeetingActiveProjectionsForReceiverSession,
  listVcMeetingMemberProjections,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';
import { resolveVcMeetingImRoutingForTurn } from '../src/services/vc-meeting-im-routing.js';
import { logger } from '../src/utils/logger.js';

const RUNTIME_FILE = 'vc-meeting-runtime-sessions.json';
const TOMBSTONE_FILE = 'vc-meeting-ended-tombstones.json';

let dataDir: string;

function corruptSiblings(dir: string, base: string): string[] {
  return readdirSync(dir).filter(name => name.startsWith(`${base}.corrupt`));
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-vc-read-errors-'));
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  fsFaults.read.clear();
  fsFaults.stat.clear();
  fsFaults.readdir.clear();
  fsFaults.afterOpen.clear();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('vc meeting runtime store read errors', () => {
  it('does not quarantine a valid store when reading it fails with EMFILE', () => {
    const fp = join(dataDir, RUNTIME_FILE);
    writeFileSync(fp, '{}\n', 'utf-8');
    fsFaults.read.set(fp, 'EMFILE');

    const err = thrown(() => listVcMeetingRuntimeSessions(dataDir, 'cli_listener'));
    expect(isStoreFileUnavailableError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe('EMFILE');
    expect(corruptSiblings(dataDir, RUNTIME_FILE)).toEqual([]);

    // The failure was transient: once reads work again the store is intact and
    // usable, with no lingering "quarantined evidence" lock-out.
    fsFaults.read.clear();
    expect(readFileSync(fp, 'utf-8')).toBe('{}\n');
    expect(listVcMeetingRuntimeSessions(dataDir, 'cli_listener')).toEqual([]);
    expect(listVcMeetingRuntimeSessionsByListenerAndAgent(dataDir, {
      listenerChatId: 'oc_listener',
      agentAppId: 'cli_agent',
    })).toEqual([]);
  });

  it('reports a failing stat as unavailable instead of an empty store', () => {
    const fp = join(dataDir, RUNTIME_FILE);
    writeFileSync(fp, '{}\n', 'utf-8');
    fsFaults.stat.set(fp, 'EIO');

    const err = thrown(() => listVcMeetingRuntimeSessionsByListenerAndAgent(dataDir, {
      listenerChatId: 'oc_listener',
      agentAppId: 'cli_agent',
    }));
    expect(isStoreFileUnavailableError(err)).toBe(true);
    expect(existsSync(fp)).toBe(true);
    expect(corruptSiblings(dataDir, RUNTIME_FILE)).toEqual([]);
  });

  it('does not treat an unlistable directory as "no quarantined evidence"', () => {
    // Store absent + evidence present: the directory scan is the only guard.
    writeFileSync(join(dataDir, `${RUNTIME_FILE}.corrupt.1.1`), '{bad', 'utf-8');
    fsFaults.readdir.set(dataDir, 'EMFILE');

    const err = thrown(() => listVcMeetingRuntimeSessions(dataDir, 'cli_listener'));
    expect(isStoreFileUnavailableError(err)).toBe(true);

    fsFaults.readdir.clear();
    expect(() => listVcMeetingRuntimeSessions(dataDir, 'cli_listener'))
      .toThrow(/quarantined evidence/);
  });

  it('reports a failing stat on the plain read path as unavailable, not empty', () => {
    const fp = join(dataDir, RUNTIME_FILE);
    writeFileSync(fp, '{}\n', 'utf-8');
    fsFaults.stat.set(fp, 'EIO');

    expect(isStoreFileUnavailableError(thrown(() => listVcMeetingRuntimeSessions(dataDir, 'cli_listener')))).toBe(true);
    expect(corruptSiblings(dataDir, RUNTIME_FILE)).toEqual([]);
  });

  it('never quarantines a file that was replaced after its bytes were judged', () => {
    const fp = join(dataDir, RUNTIME_FILE);
    writeFileSync(fp, '[]\n', 'utf-8');
    // An operator atomically restores a good store while our read is in flight.
    fsFaults.afterOpen.set(fp, () => {
      writeFileSync(`${fp}.repair`, '{}\n', 'utf-8');
      renameSync(`${fp}.repair`, fp);
    });

    expect(isStoreFileUnavailableError(thrown(() => listVcMeetingRuntimeSessions(dataDir, 'cli_listener')))).toBe(true);
    expect(corruptSiblings(dataDir, RUNTIME_FILE)).toEqual([]);
    expect(readFileSync(fp, 'utf-8')).toBe('{}\n');
    expect(listVcMeetingRuntimeSessions(dataDir, 'cli_listener')).toEqual([]);
  });

  it('keeps quarantining bytes that really are invalid', () => {
    const fp = join(dataDir, RUNTIME_FILE);
    writeFileSync(fp, '[]\n', 'utf-8');

    const err = thrown(() => listVcMeetingRuntimeSessions(dataDir, 'cli_listener'));
    expect(isStoreFileUnavailableError(err)).toBe(false);
    expect(String(err)).toMatch(/runtime session store is corrupt/);
    expect(corruptSiblings(dataDir, RUNTIME_FILE)).toHaveLength(1);
  });

  it('does not quarantine the ended tombstone store on a read error', () => {
    const fp = join(dataDir, TOMBSTONE_FILE);
    writeFileSync(fp, '{}\n', 'utf-8');
    fsFaults.read.set(fp, 'EIO');

    expect(isStoreFileUnavailableError(thrown(() =>
      hasVcMeetingEndedTombstone(dataDir, 'cli_listener', 'm1')))).toBe(true);
    expect(corruptSiblings(dataDir, TOMBSTONE_FILE)).toEqual([]);

    fsFaults.read.clear();
    expect(hasVcMeetingEndedTombstone(dataDir, 'cli_listener', 'm1')).toBe(false);
  });
});

describe('vc meeting hub / feed / delivery store read errors', () => {
  it('hub state: a read error neither quarantines nor reads as missing', () => {
    const dir = join(dataDir, 'vc-meeting-delivery-hub');
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'cli_listener__m1.json');
    writeFileSync(fp, '{"placeholder":true}\n', 'utf-8');
    fsFaults.read.set(fp, 'EMFILE');

    const err = thrown(() => getVcMeetingHubCloseState(dataDir, { listenerAppId: 'cli_listener', meetingId: 'm1' }));
    expect(isStoreFileUnavailableError(err)).toBe(true);
    expect(corruptSiblings(dir, 'cli_listener__m1.json')).toEqual([]);
    fsFaults.read.clear();
    expect(readFileSync(fp, 'utf-8')).toBe('{"placeholder":true}\n');
  });

  it('hub state: a failing stat in the lock-free precheck is unavailable, not missing', () => {
    const dir = join(dataDir, 'vc-meeting-delivery-hub');
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'cli_listener__m1.json');
    writeFileSync(fp, '{"placeholder":true}\n', 'utf-8');
    fsFaults.stat.set(fp, 'EIO');

    expect(isStoreFileUnavailableError(thrown(() =>
      getVcMeetingHubCloseState(dataDir, { listenerAppId: 'cli_listener', meetingId: 'm1' })))).toBe(true);
  });

  it('hub state: quarantined evidence is not "no state" in the lock-free precheck', () => {
    const dir = join(dataDir, 'vc-meeting-delivery-hub');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cli_listener__m1.json.corrupt.1.1'), '{bad', 'utf-8');

    expect(() => getVcMeetingHubCloseState(dataDir, { listenerAppId: 'cli_listener', meetingId: 'm1' }))
      .toThrow(/quarantined evidence/);
  });

  it('feed metadata: a read error keeps the state and its sequence', () => {
    const key = { listenerAppId: 'cli_listener', meetingId: 'm1' };
    ingestVcMeetingFeedMetadata(dataDir, key, [{
      source: 'push',
      type: 'chat_received',
      meetingId: 'm1',
      eventId: 'evt_chat_1',
      itemKey: 'chat:message_1',
      messageId: 'message_1',
      sender: { openId: 'ou_sender', name: 'Sender' },
      text: 'hello',
    }], 100);
    const dir = join(dataDir, 'vc-meeting-feed-metadata');
    const name = readdirSync(dir).find(entry => entry.endsWith('.json'))!;
    const fp = join(dir, name);
    const before = readFileSync(fp, 'utf-8');
    fsFaults.read.set(fp, 'EMFILE');

    expect(isStoreFileUnavailableError(thrown(() => getVcMeetingFeedMetadataState(dataDir, key)))).toBe(true);
    expect(corruptSiblings(dir, name)).toEqual([]);

    fsFaults.read.clear();
    expect(readFileSync(fp, 'utf-8')).toBe(before);
    expect(getVcMeetingFeedMetadataState(dataDir, key).nextIngestSeq).toBe(2);
  });

  it('delivery state: a read error during mutation does not reset the file', () => {
    const projection: VcMeetingMemberProjectionInput = {
      listenerAppId: 'cli_listener',
      meetingId: 'm1',
      ownerBootId: 'boot-1',
      ownerEpoch: 1,
      memberId: 'member-minutes',
      agentAppId: 'cli_agent',
      role: 'minutes',
      memberEpoch: 1,
      membershipGeneration: 1,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['listener.output.request', 'meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: 1,
      joinedAtIngestSeq: 0,
      receiverSessionId: 'sess-1',
      outputChatId: 'oc_listener',
    };
    expect(applyVcMeetingMemberProjection(dataDir, projection, 1_000)).toMatchObject({ ok: true });
    const dir = join(dataDir, 'vc-meeting-delivery');
    const name = readdirSync(dir).find(entry => entry.endsWith('.json'))!;
    const fp = join(dir, name);
    const before = readFileSync(fp, 'utf-8');
    fsFaults.read.set(fp, 'EMFILE');

    expect(isStoreFileUnavailableError(thrown(() =>
      applyVcMeetingMemberProjection(dataDir, { ...projection, membershipGeneration: 2 }, 2_000)))).toBe(true);
    expect(corruptSiblings(dir, name)).toEqual([]);

    fsFaults.read.clear();
    expect(readFileSync(fp, 'utf-8')).toBe(before);
    expect(getVcMeetingMemberProjection(dataDir, {
      listenerAppId: 'cli_listener',
      meetingId: 'm1',
      memberId: 'member-minutes',
      memberEpoch: 1,
    })).toMatchObject({ membershipGeneration: 1, createdAt: 1_000 });
  });
});

describe('turn-entry meeting routing with unreadable meeting state', () => {
  it('falls back to ordinary when this bot has no receiver session in the chat', () => {
    writeFileSync(join(dataDir, `${RUNTIME_FILE}.corrupt.1793952844472.2322345`), '{}\n', 'utf-8');

    expect(resolveVcMeetingImRoutingForTurn(dataDir, {
      listenerChatId: 'oc_plain_group',
      agentAppId: 'cli_agent',
    })).toMatchObject({
      kind: 'unavailable',
      fallback: 'ordinary',
      error: expect.stringMatching(/quarantined evidence/),
    });
  });

  it('blocks when the chat has a dedicated meeting receiver session', () => {
    writeFileSync(join(dataDir, `${RUNTIME_FILE}.corrupt.1793952844472.2322345`), '{}\n', 'utf-8');

    expect(resolveVcMeetingImRoutingForTurn(dataDir, {
      listenerChatId: 'oc_listener',
      agentAppId: 'cli_agent',
      sealedReceiverSessions: [{
        listenerAppId: 'cli_listener',
        listenerChatId: 'oc_listener',
        meetingId: 'm1',
        memberId: 'member-minutes',
        memberEpoch: 1,
        agentAppId: 'cli_agent',
        receiverSessionId: 'sess-1',
      }],
    })).toMatchObject({ kind: 'unavailable', fallback: 'block' });
  });

  it('blocks instead of demoting to ordinary when only the delivery state is unreadable', () => {
    const now = 2_000;
    recordVcMeetingRuntimeSession(dataDir, {
      larkAppId: 'cli_listener',
      meeting: { id: 'm1', meetingNo: 'no-m1', topic: 'Topic m1' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgents: [{
        profileId: 'profile-m1',
        memberId: 'member-m1',
        agentAppId: 'cli_agent',
        role: 'minutes',
        status: 'active',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
        ownedSinks: [],
      }],
    }, 1_000);
    expect(applyVcMeetingMemberProjection(dataDir, {
      listenerAppId: 'cli_listener',
      meetingId: 'm1',
      ownerBootId: 'owner-boot-1',
      ownerEpoch: 1,
      memberId: 'member-m1',
      agentAppId: 'cli_agent',
      role: 'minutes',
      memberEpoch: 1,
      membershipGeneration: 1,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
      sinkOwnerGeneration: 1,
      joinedAtIngestSeq: 0,
      receiverSessionId: 'receiver-m1',
      outputChatId: 'oc_listener',
    }, 1_000)).toMatchObject({ ok: true });
    const input = {
      listenerChatId: 'oc_listener',
      agentAppId: 'cli_agent',
      sealedReceiverSessions: [{
        listenerAppId: 'cli_listener',
        listenerChatId: 'oc_listener',
        meetingId: 'm1',
        memberId: 'member-m1',
        memberEpoch: 1,
        agentAppId: 'cli_agent',
        receiverSessionId: 'receiver-m1',
      }],
    };
    expect(resolveVcMeetingImRoutingForTurn(dataDir, input, now)).toMatchObject({ kind: 'receiver' });

    const deliveryDir = join(dataDir, 'vc-meeting-delivery');
    const deliveryFile = join(deliveryDir, readdirSync(deliveryDir).find(name => name.endsWith('.json'))!);
    fsFaults.read.set(deliveryFile, 'EMFILE');

    expect(resolveVcMeetingImRoutingForTurn(dataDir, input, now))
      .toMatchObject({ kind: 'unavailable', fallback: 'block' });
    // Read-only callers outside turn routing keep the historical soft read.
    expect(listVcMeetingMemberProjections(dataDir, { listenerAppId: 'cli_listener', meetingId: 'm1' })).toEqual([]);
  });

  // The sealed (post-meeting) route only reaches the delivery store through this
  // per-session scan. A delivery DIRECTORY that cannot be stat'ed must surface
  // as unavailable, not read as "no projections" — the latter demotes a chat
  // that still owns a receiver session to an ordinary turn (silent mis-route).
  it('reports an unreadable delivery directory as unavailable on the sealed scan', () => {
    const deliveryDir = join(dataDir, 'vc-meeting-delivery');
    mkdirSync(deliveryDir, { recursive: true });
    fsFaults.stat.set(deliveryDir, 'EIO');

    // Turn routing passes ioErrors: 'throw' — it must not read as "no projections".
    const err = thrown(() => listVcMeetingActiveProjectionsForReceiverSession(
      dataDir,
      'receiver-m1',
      { ioErrors: 'throw' },
    ));
    expect(isStoreFileUnavailableError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe('EIO');

    // Every other read-only caller keeps the historical soft behaviour.
    expect(listVcMeetingActiveProjectionsForReceiverSession(dataDir, 'receiver-m1')).toEqual([]);

    fsFaults.stat.clear();
    expect(listVcMeetingActiveProjectionsForReceiverSession(dataDir, 'receiver-m1', { ioErrors: 'throw' })).toEqual([]);
  });

  it('routes normally when the stores are readable', () => {
    expect(resolveVcMeetingImRoutingForTurn(dataDir, {
      listenerChatId: 'oc_plain_group',
      agentAppId: 'cli_agent',
    })).toMatchObject({ kind: 'ordinary' });
  });
});

describe('data-dir fence guard for fs-faking test files', () => {
  it('accepts only directories strictly inside the fence root', async () => {
    const { isInsideDir } = await import('./helpers/require-fenced-data-dir.js');
    expect(isInsideDir('/tmp/x/botmux-unit-1/file-2/data', '/tmp/x/botmux-unit-1/file-2')).toBe(true);
    expect(isInsideDir('/root/.botmux/data', '/tmp/x')).toBe(false);
    expect(isInsideDir('/tmp/x', '/tmp/x')).toBe(false);
    expect(isInsideDir('/tmp/xy/data', '/tmp/x')).toBe(false);
    expect(isInsideDir('/tmp/x/../y/data', '/tmp/x')).toBe(false);
    expect(isInsideDir('/tmp/x/data', 'relative/root')).toBe(false);
    expect(isInsideDir(undefined, '/tmp/x')).toBe(false);
  });

  it('requires SESSION_DATA_DIR inside the root that only the fence itself publishes', async () => {
    const { fencedTestDataDirProblem } = await import('./helpers/require-fenced-data-dir.js');
    const root = '/tmp/x/botmux-unit-1/file-2';
    expect(fencedTestDataDirProblem({ SESSION_DATA_DIR: `${root}/data`, __TEST_DATA_DIR_FENCE: root })).toBeUndefined();
    // Incident shape: a temp-looking data dir picked by hand, fence never ran.
    expect(fencedTestDataDirProblem({ SESSION_DATA_DIR: `${root}/data` })).toMatch(/refusing to run/);
    expect(fencedTestDataDirProblem({ SESSION_DATA_DIR: '/root/.botmux/data', __TEST_DATA_DIR_FENCE: root }))
      .toMatch(/refusing to run/);
  });
});
