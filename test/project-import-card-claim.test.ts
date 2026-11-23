import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as client from '../src/im/lark/client.js';
import * as sessionStore from '../src/services/session-store.js';
import * as teamBots from '../src/services/team-bots-store.js';
import { writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import { readProjectGroup } from '../src/services/project-group-store.js';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import * as coordinatorRuntime from '../src/services/project-coordinator-runtime.js';
import {
  buildProjectImportCard,
  deriveImportWorkstreamTitle,
  PROJECT_IMPORT_CONFIRM_ACTION,
} from '../src/im/lark/project-import-card.js';
import {
  handleProjectImportCardAction,
  publishOrRefreshProjectImportCard,
  readProjectImportCardRecord,
} from '../src/services/project-import-card-runtime.js';
import {
  setProjectWorkstreamPool,
  validateProjectAttachmentReport,
} from '../src/services/project-workstream-runtime.js';
import { logger } from '../src/utils/logger.js';

const COORD_APP = 'cli_coord_pkg';
const WORKER_APP = 'cli_worker_codex';
const CHAT = 'oc_pkg_project_group';
const ROOT = 'om_relayed_ownerless_topic';

describe('project import card & ownerless session claim', () => {
  const previousDir = config.session.dataDir;
  let dataDir: string;
  let coordSession: any;
  let workerSession: any;
  let coordDs: any;
  let workerDs: any;
  let projectCardTransport: ProjectCoordinatorTransport;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'project-import-card-claim-'));
    config.session.dataDir = dataDir;

    const coordBot = registry.registerBot({
      larkAppId: COORD_APP,
      larkAppSecret: 'synthetic-coord',
      cliId: 'claude',
      botName: '包体专家',
      allowedUsers: ['ou_coord_human'],
    });
    coordBot.resolvedAllowedUsers = ['ou_coord_human'];

    const workerBot = registry.registerBot({
      larkAppId: WORKER_APP,
      larkAppSecret: 'synthetic-worker',
      cliId: 'codex',
      botName: 'CodexCpa',
      allowedUsers: ['ou_worker_human'],
    });
    workerBot.resolvedAllowedUsers = ['ou_worker_human'];

    coordSession = {
      sessionId: 'coord-session-1',
      larkAppId: COORD_APP,
      chatId: CHAT,
      rootMessageId: CHAT,
      scope: 'chat',
      chatType: 'group',
      status: 'active',
      ownerOpenId: 'ou_coord_human',
      ownerUnionId: 'on_same_human',
      cliSessionId: 'cli-coord-1',
    };
    workerSession = {
      sessionId: 'f8d515e4-402c-4b95-8bcb-bc9b10d84c5d',
      larkAppId: WORKER_APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      scope: 'thread',
      chatType: 'group',
      status: 'active',
      projectRouteRevision: 2,
      projectImportSource: 'relay',
      cliSessionId: 'cli-worker-1',
      title: '宿主模块源码竞态复现与超长补充说明用于验证二十四字自动截断逻辑',
      ownerOpenId: undefined,
      ownerUnionId: undefined,
    };
    coordDs = { session: coordSession, larkAppId: COORD_APP, chatId: CHAT, scope: 'chat', chatType: 'group', cliReady: true };
    workerDs = { session: workerSession, larkAppId: WORKER_APP, chatId: CHAT, scope: 'thread', chatType: 'group', cliReady: true };

    setProjectWorkstreamPool({
      findActiveBySessionId: id => {
        if (id === coordSession.sessionId) return coordDs;
        if (id === workerSession.sessionId) return workerDs;
        return undefined;
      },
    });

    vi.spyOn(sessionStore, 'getOwnedSession').mockImplementation(id => {
      if (id === coordSession.sessionId) return coordSession;
      if (id === workerSession.sessionId) return workerSession;
      return undefined;
    });
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    vi.spyOn(client, 'lookupMessageChatId').mockResolvedValue(CHAT);
    vi.spyOn(client, 'resolveTargetAppOpenId').mockImplementation(async (appId, unionId) => {
      if (appId === WORKER_APP && unionId === 'on_same_human') {
        return { status: 'resolved', openId: 'ou_worker_human' };
      }
      return { status: 'not_found' } as any;
    });

    projectCardTransport = {
      sendCard: vi.fn(async () => 'om_pinned_project_card'),
      updateCard: vi.fn(async () => {}),
      pinMessage: vi.fn(async () => true),
      unpinMessage: vi.fn(async () => true),
      resolveThreadId: vi.fn(async () => null),
      isMessageWithdrawn: () => false,
      isMessageUpdateExpired: () => false,
      brand: () => 'feishu',
    };
    const coordinator = new ProjectCoordinator(projectCardTransport);
    vi.spyOn(coordinatorRuntime.projectCoordinator, 'run').mockImplementation(
      (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
    );
    await writeGroupCollaborationMode(dataDir, {
      chatId: CHAT,
      mode: 'project',
      coordinatorAppId: COORD_APP,
      workerAppIds: [WORKER_APP],
      importedSessionPolicy: 'notify',
    });
    await coordinator.run(
      { dataDir, chatId: CHAT, larkAppId: COORD_APP, coordinatorSessionId: coordSession.sessionId },
      { action: 'init', title: '包体领域治理', goal: '验证无主会话显式认领' },
    );
  });

  afterEach(() => {
    setProjectWorkstreamPool(undefined);
    vi.restoreAllMocks();
    config.session.dataDir = previousDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('builds safe import cards without user IDs in button values and truncates workstream titles to <=24 chars', () => {
    const derived = deriveImportWorkstreamTitle({
      sourceTitle: workerSession.title,
      botName: 'CodexCpa',
      sessionId: workerSession.sessionId,
    });
    expect(Array.from(derived).length).toBeLessThanOrEqual(24);
    expect(['子任务', '子项目']).not.toContain(derived);

    const ownerlessCard = buildProjectImportCard({
      state: 'pending',
      chatId: CHAT,
      rootMessageId: ROOT,
      sourceSessionId: workerSession.sessionId,
      sourceLarkAppId: WORKER_APP,
      sourceBotName: 'CodexCpa',
      sourceKind: 'relay',
      routeRevision: 2,
      sessionTitle: workerSession.title,
      reason: 'source_owner_unknown',
      canConfirm: true,
    });
    const rawOwnerless = JSON.stringify(ownerlessCard);
    expect(rawOwnerless).toContain(PROJECT_IMPORT_CONFIRM_ACTION);
    expect(rawOwnerless).toContain('source_owner_unknown');
    expect(rawOwnerless).not.toContain('ou_');
    expect(rawOwnerless).not.toContain('on_');

    const foreignCard = buildProjectImportCard({
      state: 'pending',
      chatId: CHAT,
      rootMessageId: ROOT,
      sourceSessionId: workerSession.sessionId,
      sourceLarkAppId: WORKER_APP,
      sourceBotName: 'CodexCpa',
      sourceKind: 'relay',
      routeRevision: 2,
      reason: 'source_owner_authorization_required',
      canConfirm: false,
    });
    expect(JSON.stringify(foreignCard)).not.toContain(PROJECT_IMPORT_CONFIRM_ACTION);
  });

  it('posts pending ownerless card, claims owner + attaches on verified human click, updates pinned card, and passes report validation', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const replyCard = vi.fn(async () => 'om_topic_import_card');
    const updateCard = vi.fn(async () => {});
    const onCardAttached = vi.fn(async () => {});

    const published = await publishOrRefreshProjectImportCard({
      dataDir,
      coordinatorAppId: COORD_APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      sourceSessionId: workerSession.sessionId,
      sourceLarkAppId: WORKER_APP,
    }, {
      replyCard,
      updateCard,
      findCoordinatorSession: id => id === coordSession.sessionId ? coordSession : undefined,
    });
    expect(published).toEqual({
      cardPosted: true,
      messageId: 'om_topic_import_card',
      status: 'pending',
      reason: 'source_owner_unknown',
      canConfirm: true,
    });
    expect(replyCard).toHaveBeenCalledTimes(1);

    const clickResponse = await handleProjectImportCardAction({
      open_message_id: 'om_topic_import_card',
      context: { open_chat_id: CHAT, open_message_id: 'om_topic_import_card' },
      operator: { open_id: 'ou_coord_human', union_id: 'on_same_human' },
      action: {
        value: {
          action: PROJECT_IMPORT_CONFIRM_ACTION,
          chat_id: CHAT,
          root_id: ROOT,
          source_app: WORKER_APP,
          source_session: workerSession.sessionId,
          route_rev: '2',
        },
      },
    } as any, COORD_APP, {
      replyCard,
      updateCard,
      resolveOperator: async () => ({ openId: 'ou_coord_human', unionId: 'on_same_human' }),
      findCoordinatorSession: id => id === coordSession.sessionId ? coordSession : undefined,
      onCardAttached,
    });

    expect(clickResponse).toMatchObject({
      toast: { type: 'success', content: expect.stringContaining('已确认并登记') },
      card: { type: 'raw', data: expect.objectContaining({ header: expect.objectContaining({ template: 'green' }) }) },
    });
    // Cross-app open_id resolved for WORKER_APP (never borrowing COORD_APP's ou_coord_human!)
    expect(workerSession.ownerUnionId).toBe('on_same_human');
    expect(workerSession.ownerOpenId).toBe('ou_worker_human');
    expect(workerDs.ownerOpenId).toBe('ou_worker_human');
    expect(sessionStore.updateSession).toHaveBeenCalledWith(workerSession);

    // Pinned project card & persistent project group updated
    const project = readProjectGroup(dataDir, CHAT);
    expect(project?.workstreams).toHaveLength(1);
    expect(project?.workstreams[0]).toMatchObject({
      dispatchRoot: ROOT,
      status: 'pending',
      owners: [WORKER_APP],
    });
    expect(projectCardTransport.updateCard).toHaveBeenCalled();
    expect(onCardAttached).toHaveBeenCalledWith(CHAT, coordSession.sessionId);

    // Card record settled
    expect(readProjectImportCardRecord(dataDir, CHAT, ROOT)).toMatchObject({
      status: 'registered',
      confirmedByOpenId: 'ou_coord_human',
      registrationMode: 'human_card',
      routeRevision: 2,
    });

    // Audit trail emitted for both source claim and card confirmation
    const logged = infoSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('[project-workstream-claim] outcome=claimed via=topic_card_confirm');
    expect(logged).toContain('[project-import-card] action=project_import_confirm outcome=attached');

    // Claimed worker session can now legitimately report back to the coordinator
    const dispatchRegistry = JSON.parse(readFileSync(join(dataDir, 'orchestrate-dispatch.json'), 'utf8'));
    await expect(
      validateProjectAttachmentReport(dispatchRegistry, ROOT, WORKER_APP, workerSession.sessionId),
    ).resolves.toEqual({
      ok: true,
      ownerKey: 'union:on_same_human',
      routeRevision: 2,
    });
  });

  it('rejects unverified identity, bot clickers, non-owner humans, and foreign-owned sessions without mutating state', async () => {
    const baseClick: any = {
      open_message_id: 'om_topic_import_card',
      context: { open_chat_id: CHAT, open_message_id: 'om_topic_import_card' },
      action: {
        value: {
          action: PROJECT_IMPORT_CONFIRM_ACTION,
          chat_id: CHAT,
          root_id: ROOT,
          source_app: WORKER_APP,
          source_session: workerSession.sessionId,
          route_rev: '2',
        },
      },
    };

    // 1. Missing union_id
    const noUnion = await handleProjectImportCardAction(baseClick, COORD_APP, {
      resolveOperator: async () => ({ openId: 'ou_coord_human', unionId: undefined }),
      findCoordinatorSession: () => coordSession,
    });
    expect(noUnion).toMatchObject({ toast: { type: 'error' } });
    expect(workerSession.ownerUnionId).toBeUndefined();

    // 2. Known bot clicker
    vi.spyOn(teamBots, 'isTeamBot').mockReturnValueOnce(true);
    const botClick = await handleProjectImportCardAction(baseClick, COORD_APP, {
      resolveOperator: async () => ({ openId: 'ou_coord_human', unionId: 'on_same_human' }),
      findCoordinatorSession: () => coordSession,
    });
    expect(botClick).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('仅真人') } });
    expect(workerSession.ownerUnionId).toBeUndefined();

    // 3. Different human (not coordinator owner)
    const coordBot = registry.getBot(COORD_APP);
    coordBot.resolvedAllowedUsers = ['ou_coord_human', 'ou_other_human'];
    const nonOwner = await handleProjectImportCardAction(baseClick, COORD_APP, {
      resolveOperator: async () => ({ openId: 'ou_other_human', unionId: 'on_other_human' }),
      findCoordinatorSession: () => coordSession,
    });
    expect(nonOwner).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('仅当前项目主控会话的本人') } });
    expect(workerSession.ownerUnionId).toBeUndefined();

    // 4. Source session already has a foreign owner: must NOT overwrite it
    workerSession.ownerUnionId = 'on_foreign_human';
    workerSession.ownerOpenId = 'ou_foreign_worker_user';
    const foreignSource = await handleProjectImportCardAction(baseClick, COORD_APP, {
      resolveOperator: async () => ({ openId: 'ou_coord_human', unionId: 'on_same_human' }),
      findCoordinatorSession: () => coordSession,
    });
    expect(foreignSource).toMatchObject({
      toast: { type: 'error', content: expect.stringContaining('grant') },
      card: { type: 'raw' },
    });
    expect(workerSession.ownerUnionId).toBe('on_foreign_human');
    expect(workerSession.ownerOpenId).toBe('ou_foreign_worker_user');
    expect(readProjectGroup(dataDir, CHAT)?.workstreams).toHaveLength(0);
  });
});
