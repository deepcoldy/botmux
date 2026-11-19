import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as client from '../src/im/lark/client.js';
import * as sessionStore from '../src/services/session-store.js';
import {
  localClaimOwnerlessProjectSource,
  setProjectWorkstreamPool,
} from '../src/services/project-workstream-runtime.js';

const COORD_APP = 'cli_claim_coord';
const WORKER_APP = 'cli_claim_worker';
const CHAT = 'oc_claim_project_group';
const ROOT = 'om_claim_topic';
const SESSION_ID = 'claim-worker-session-1';

describe('localClaimOwnerlessProjectSource owner-boundary denial matrix', () => {
  const previousDir = config.session.dataDir;
  let dataDir: string;
  let workerSession: any;
  let workerDs: any;
  let updateSession: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'workstream-claim-'));
    config.session.dataDir = dataDir;

    registry.registerBot({
      larkAppId: COORD_APP,
      larkAppSecret: 'synthetic-coord',
      cliId: 'claude',
      allowedUsers: ['ou_coord_human'],
    });
    const workerBot = registry.registerBot({
      larkAppId: WORKER_APP,
      larkAppSecret: 'synthetic-worker',
      cliId: 'codex',
      allowedUsers: ['ou_worker_human'],
    });
    // Restricted mode: anyone not on this list must fail canHumanOperateBot.
    workerBot.resolvedAllowedUsers = ['ou_worker_human'];

    workerSession = {
      sessionId: SESSION_ID,
      larkAppId: WORKER_APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      scope: 'thread',
      chatType: 'group',
      status: 'active',
      projectRouteRevision: 2,
      projectImportSource: 'relay',
      ownerOpenId: undefined,
      ownerUnionId: undefined,
    };
    workerDs = { session: workerSession, larkAppId: WORKER_APP, chatId: CHAT, scope: 'thread', cliReady: true };

    setProjectWorkstreamPool({
      findActiveBySessionId: id => (id === SESSION_ID ? workerDs : undefined),
    });
    vi.spyOn(sessionStore, 'getOwnedSession').mockImplementation(id =>
      (id === SESSION_ID ? workerSession : undefined));
    updateSession = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    vi.spyOn(client, 'resolveTargetAppOpenId').mockImplementation(async (appId, unionId) => {
      if (appId === WORKER_APP && unionId === 'on_same_human') {
        return { status: 'resolved', openId: 'ou_worker_human' } as any;
      }
      if (appId === WORKER_APP && unionId === 'on_other_human') {
        return { status: 'resolved', openId: 'ou_other_worker_user' } as any;
      }
      return { status: 'not_found' } as any;
    });
  });

  afterEach(() => {
    setProjectWorkstreamPool(undefined);
    vi.restoreAllMocks();
    config.session.dataDir = previousDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const baseInput = () => ({
    sourceLarkAppId: WORKER_APP,
    sourceSessionId: SESSION_ID,
    chatId: CHAT,
    rootMessageId: ROOT,
    expectedRouteRevision: 2,
    claimantUnionId: 'on_same_human',
    claimantLarkAppId: COORD_APP,
    claimantOpenId: 'ou_coord_human',
    via: 'topic_card_confirm' as const,
  });

  it('positive control: claims a genuinely ownerless session for an allowed human and persists the owner', async () => {
    const result = await localClaimOwnerlessProjectSource(baseInput());
    expect(result).toMatchObject({ ok: true, alreadyClaimed: false });
    expect(workerSession.ownerUnionId).toBe('on_same_human');
    expect(workerSession.ownerOpenId).toBe('ou_worker_human');
    expect(workerDs.ownerOpenId).toBe('ou_worker_human');
    expect(updateSession).toHaveBeenCalledWith(workerSession);
  });

  it('refuses to overwrite a session already owned by a different human (source_owner_already_present) without mutating it', async () => {
    workerSession.ownerUnionId = 'on_foreign_human';
    workerSession.ownerOpenId = 'ou_foreign_worker_user';

    const result = await localClaimOwnerlessProjectSource(baseInput());
    expect(result).toEqual({ ok: false, error: 'source_owner_already_present' });
    // The foreign owner must remain untouched: no persist, no in-memory rewrite.
    expect(workerSession.ownerUnionId).toBe('on_foreign_human');
    expect(workerSession.ownerOpenId).toBe('ou_foreign_worker_user');
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('treats a repeat claim by the same human as idempotent alreadyClaimed without rewriting the session', async () => {
    workerSession.ownerUnionId = 'on_same_human';
    workerSession.ownerOpenId = 'ou_worker_human';

    const result = await localClaimOwnerlessProjectSource(baseInput());
    expect(result).toMatchObject({ ok: true, alreadyClaimed: true });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('rejects a human who cannot operate the source bot (source_claim_operator_not_allowed) and leaves it ownerless', async () => {
    const result = await localClaimOwnerlessProjectSource({
      ...baseInput(),
      claimantUnionId: 'on_other_human',
      claimantOpenId: 'ou_coord_other',
    });
    expect(result).toEqual({ ok: false, error: 'source_claim_operator_not_allowed' });
    expect(workerSession.ownerUnionId).toBeUndefined();
    expect(workerSession.ownerOpenId).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });

  // A human-turn `attach --claim-owner` claims before the attachment service
  // checks `ordinary`, so this is the only backend gate that keeps dedicated
  // workflow / meeting / listener / scheduled sessions from being re-owned.
  it.each([
    ['workflow node', () => { workerSession.workflowNode = { runId: 'wf-run', nodeId: 'node-a' }; }],
    ['meeting receiver', () => { workerSession.vcMeetingReceiver = { meetingId: 'vc-1' }; }],
    ['message listener run', () => { workerSession.messageListenerRun = { listenerId: 'listener-1' }; }],
    ['deferred schedule run', () => { workerSession.deferredScheduleRun = { scheduleId: 'sch-1' }; }],
    ['pending repo setup', () => { workerSession.pendingRepoSetup = true; }],
    ['live pending repo selection', () => { workerDs.pendingRepo = { cardMessageId: 'om_repo_card' }; }],
  ])('refuses to claim a managed %s session (source_managed_elsewhere) and leaves it ownerless', async (_kind, mark) => {
    mark();
    const result = await localClaimOwnerlessProjectSource(baseInput());
    expect(result).toEqual({ ok: false, error: 'source_managed_elsewhere' });
    expect(workerSession.ownerUnionId).toBeUndefined();
    expect(workerSession.ownerOpenId).toBeUndefined();
    expect(workerDs.ownerOpenId).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('rejects a claim carrying a stale route revision (source_route_mismatch) without persisting an owner', async () => {
    const result = await localClaimOwnerlessProjectSource({
      ...baseInput(),
      expectedRouteRevision: 1,
    });
    expect(result).toEqual({ ok: false, error: 'source_route_mismatch' });
    expect(workerSession.ownerUnionId).toBeUndefined();
    expect(workerSession.ownerOpenId).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });
});
