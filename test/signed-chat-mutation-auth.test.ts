import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authorizeSignedChatMutation } from '../src/workflows/v3/signed-chat-mutation-auth.js';
import { v3RunHasChatBinding } from '../src/workflows/v3/cli-daemon-command-authority.js';
import { v3ScheduleTurnRelayAuth } from '../src/workflows/v3/session-relay.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { makeManualCliRunEnvelope, serializeRunEnvelope, type Sha256Digest } from '../src/workflows/v3/run-envelope.js';
import type { RunChatBinding } from '../src/workflows/v3/grill-state.js';
import type { ScheduledTask } from '../src/types.js';

const APP = 'cli_signed';
const CHAT = 'oc_signed';
const TASK_ID = 'abcdef12';
const TURN_ID = `schedule:${TASK_ID}:12345678-1234-1234-1234-123456789abc`;
const CAPABILITY = 'c'.repeat(64);
const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const BINDING: RunChatBinding = {
  larkAppId: APP,
  chatId: CHAT,
  rootMessageId: 'om_root',
  sessionId: 'sess-1',
  ownerOpenId: 'ou_owner',
};

describe('signed-envelope chat mutation authorization', () => {
  let root: string;
  let store: ScheduleAuthorityStore;
  let baseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'signed-chat-mutation-'));
    baseDir = join(root, 'runs');
    mkdirSync(baseDir, { recursive: true });
    store = ScheduleAuthorityStore.open(join(root, 'sessions'));
    store.initializeApp(APP, []);
    writeEnvelope('run-1');
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function writeEnvelope(runId: string, binding: RunChatBinding | null = BINDING): void {
    const runDir = join(baseDir, runId);
    mkdirSync(runDir, { recursive: true });
    const envelope = makeManualCliRunEnvelope({
      runId,
      createdAt: '2026-11-20T00:00:00.000Z',
      authorizedAt: '2026-11-20T00:00:00.000Z',
      ...(binding ? { chatBinding: binding } : {}),
      artifacts: {
        dag: { path: 'dag.json', sha256: DIGEST },
        botSnapshots: { path: 'bots.snapshot.json', sha256: DIGEST },
      },
    });
    writeFileSync(join(runDir, 'run.json'), serializeRunEnvelope(envelope));
  }

  function createTask(ownerAccess?: 'talk'): void {
    store.createDirect({
      id: TASK_ID,
      name: 'scheduled',
      schedule: 'every 30m',
      prompt: 'run',
      workingDir: '/repo',
      chatId: CHAT,
      larkAppId: APP,
      ownerOpenId: BINDING.ownerOpenId,
      ownerUnionId: 'on_owner',
      ownerAccess,
      enabled: true,
    } as ScheduledTask);
  }

  function authorize(capability = CAPABILITY) {
    return authorizeSignedChatMutation({
      runId: 'run-1',
      mutation: 'start',
      raw: {
        sessionId: 'sess-1',
        originTurnId: TURN_ID,
        originCapability: capability,
        originDispatchAttempt: 1,
      },
      session: {
        receiver: false,
        liveOrigin: { capability: CAPABILITY, turnId: TURN_ID, dispatchAttempt: 1 },
        chatId: CHAT,
        larkAppId: APP,
        rootMessageId: 'om_root',
      },
      selfLarkAppId: APP,
      baseDir,
      ...v3ScheduleTurnRelayAuth({
        loadTask: (appId, taskId) => store.getRecord(appId, taskId)?.task,
        isOwnerAllowed: () => true,
        isTurnLive: () => true,
      }),
    });
  }

  it('refuses a talk-only scheduled owner from host authority without any schedules.json', () => {
    createTask('talk');
    // There is deliberately no CLI-writable projection in this fixture. The
    // valid capability proves the scheduled turn; SQLite decides its access.
    expect(authorize()).toMatchObject({ ok: false, status: 403, error: 'schedule_turn_unauthorized' });
    expect(v3RunHasChatBinding('run-1', baseDir)).toBe(true);
  });

  it('admits an ordinary scheduled owner with valid per-turn proof', () => {
    createTask();
    expect(authorize()).toMatchObject({ ok: true, larkAppId: APP });
  });

  it('fails closed when the per-turn capability is missing or wrong', () => {
    createTask();
    expect(authorize('wrong-capability')).toMatchObject({ ok: false, status: 403, error: 'origin_unproven' });
    expect(authorize('')).toMatchObject({ ok: false, status: 403, error: 'origin_unproven' });
  });

  it('leaves standalone unbound runs outside the chat-proof requirement', () => {
    writeEnvelope('standalone', null);
    expect(v3RunHasChatBinding('standalone', baseDir)).toBe(false);
  });
});
