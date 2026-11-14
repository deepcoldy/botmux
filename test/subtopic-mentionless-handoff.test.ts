import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import {
  __resetSubtopicHandoffCacheForTest,
  findLiveMentionlessSubtopicOwner,
  ORCHESTRATE_DISPATCH_STORE_FILE,
  resolveManagedSubtopicMentionlessHandoff,
  type ResolveSubtopicHandoffDeps,
  type SubtopicSessionSnapshot,
} from '../src/services/subtopic-mentionless-handoff.js';
import { PROJECT_GROUP_STORE_FILE } from '../src/services/project-group-store.js';

const CHAT_PROJECT = 'oc_project_chat_1';
const CHAT_OTHER = 'oc_other_chat_2';
const COORD_APP = 'cli_coord_lead';
const WORKER_ALWAYS = 'cli_worker_always';
const WORKER_TOPIC = 'cli_worker_topic';
const WORKER_AMBIENT = 'cli_worker_ambient';

describe('subtopic-mentionless-handoff service', () => {
  let dataDir: string;
  let liveSessions: SubtopicSessionSnapshot[];
  let diskActiveSessions: SubtopicSessionSnapshot[];
  let allHistorySessions: SubtopicSessionSnapshot[];
  let mentionlessBots: Set<string>;

  function makeDeps(): ResolveSubtopicHandoffDeps {
    return {
      dataDir,
      getLiveThreadSessionsAtRoot: (rootId, chatId) =>
        liveSessions.filter(s => s.rootMessageId === rootId && s.chatId === chatId),
      findActiveSessionsByRoot: rootId =>
        diskActiveSessions.filter(s => s.rootMessageId === rootId),
      readSessionsByRoots: roots =>
        allHistorySessions.filter(s => !!s.rootMessageId && roots.has(s.rootMessageId)),
      doesBotAnswerTopicWithoutMention: appId => mentionlessBots.has(appId),
      getConfiguredBots: () => [
        { larkAppId: COORD_APP, cliId: 'codex', botName: '主控Bot', botOpenId: 'ou_coord' },
        { larkAppId: WORKER_ALWAYS, cliId: 'claude-code', botName: '执行者Always', botOpenId: 'ou_w_always' },
        { larkAppId: WORKER_TOPIC, cliId: 'antigravity', botName: '执行者Topic', botOpenId: 'ou_w_topic' },
        { larkAppId: WORKER_AMBIENT, cliId: 'grok', botName: '执行者Ambient', botOpenId: 'ou_w_ambient' },
      ],
    };
  }

  async function enableProjectGroup(chatId = CHAT_PROJECT, coordinatorAppId = COORD_APP) {
    await writeGroupCollaborationMode(dataDir, {
      chatId,
      mode: 'project',
      coordinatorAppId,
      workerAppIds: [WORKER_ALWAYS, WORKER_TOPIC, WORKER_AMBIENT],
    });
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-subtopic-handoff-'));
    liveSessions = [];
    diskActiveSessions = [];
    allHistorySessions = [];
    mentionlessBots = new Set([COORD_APP, WORKER_TOPIC, WORKER_AMBIENT]);
    __resetSubtopicHandoffCacheForTest();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    __resetSubtopicHandoffCacheForTest();
  });

  it('routes all 3 managed subtopic kinds (imported, dispatch, workstream) to project coordinator when worker is always', async () => {
    await enableProjectGroup();

    // 1) Imported topic (active thread session with projectImportSource on always worker)
    liveSessions.push({
      sessionId: 'sess-imported-1',
      larkAppId: WORKER_ALWAYS,
      chatId: CHAT_PROJECT,
      scope: 'thread',
      rootMessageId: 'om_root_imported',
      status: 'active',
      projectImportSource: 'relay',
    });

    // 2) Dispatch subtopic in orchestrate-dispatch.json
    writeFileSync(join(dataDir, ORCHESTRATE_DISPATCH_STORE_FILE), JSON.stringify({
      om_root_dispatch: {
        orchChatId: CHAT_PROJECT,
        targetChatId: CHAT_PROJECT,
        orchAppId: COORD_APP,
        targetAppIds: [WORKER_ALWAYS],
        acceptedBotAppIds: [WORKER_ALWAYS],
        title: '派单子任务',
      },
    }));

    // 3) Project card subtask workstream topic in project-groups.json
    writeFileSync(join(dataDir, PROJECT_GROUP_STORE_FILE), JSON.stringify({
      schemaVersion: 1,
      projects: {
        [CHAT_PROJECT]: {
          schemaVersion: 1,
          revision: 1,
          chatId: CHAT_PROJECT,
          larkAppId: COORD_APP,
          coordinatorSessionId: 'coord-sess-1',
          title: '项目A',
          goal: '目标',
          phase: '进行中',
          focus: '焦点',
          status: 'active',
          blockers: [],
          milestones: [],
          createdAt: '2026-11-14T00:00:00.000Z',
          updatedAt: '2026-11-14T00:00:00.000Z',
          workstreams: [
            {
              dispatchRoot: 'om_root_workstream',
              title: '项目卡子任务',
              purpose: '实现方案A',
              owners: ['执行者Always'],
              status: 'in_progress',
              progress: 50,
              createdAt: '2026-11-14T00:00:00.000Z',
              updatedAt: '2026-11-14T00:00:00.000Z',
            },
          ],
        },
      },
    }));

    const deps = makeDeps();

    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_imported', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'imported',
      sourceLarkAppId: WORKER_ALWAYS,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_dispatch', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'dispatch',
      sourceLarkAppId: WORKER_ALWAYS,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_workstream', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'workstream',
      sourceLarkAppId: WORKER_ALWAYS,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });

    // Non-coordinator bots see isProjectCoordinator=false so they yield (including ambient bystanders)
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_dispatch', CHAT_PROJECT, WORKER_AMBIENT)).toEqual({
      kind: 'dispatch',
      sourceLarkAppId: WORKER_ALWAYS,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: false,
    });
  });

  it('keeps worker in charge when worker has免@ enabled AND live thread session, then falls back to coordinator once worker session closes', async () => {
    await enableProjectGroup();
    writeFileSync(join(dataDir, ORCHESTRATE_DISPATCH_STORE_FILE), JSON.stringify({
      om_root_live_worker: {
        orchChatId: CHAT_PROJECT,
        targetChatId: CHAT_PROJECT,
        orchAppId: COORD_APP,
        targetAppIds: [WORKER_TOPIC],
        acceptedBotAppIds: [WORKER_TOPIC],
        title: '免@执行者话题',
      },
    }));

    // Live active thread session on WORKER_TOPIC (mentionMode = topic)
    liveSessions = [{
      sessionId: 'sess-topic-live',
      larkAppId: WORKER_TOPIC,
      chatId: CHAT_PROJECT,
      scope: 'thread',
      rootMessageId: 'om_root_live_worker',
      status: 'active',
    }];
    const deps = makeDeps();

    // Worker itself gets null so it processes its own live thread session normally
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_live_worker', CHAT_PROJECT, WORKER_TOPIC)).toBeNull();
    // Coordinator and bystander bots get sourceAnswersWithoutMention=true so they yield
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_live_worker', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'dispatch',
      sourceLarkAppId: WORKER_TOPIC,
      sourceAnswersWithoutMention: true,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });
    // findLiveMentionlessSubtopicOwner blocks replyThreadAliases fold-back on coordinator
    expect(findLiveMentionlessSubtopicOwner(deps, 'om_root_live_worker', CHAT_PROJECT, COORD_APP)).toBe(WORKER_TOPIC);

    // Once the worker's thread session closes, coordinator takes over and closed worker yields!
    liveSessions = [];
    diskActiveSessions = [];
    allHistorySessions = [{
      sessionId: 'sess-topic-live',
      larkAppId: WORKER_TOPIC,
      chatId: CHAT_PROJECT,
      scope: 'thread',
      rootMessageId: 'om_root_live_worker',
      status: 'closed',
    }];

    expect(findLiveMentionlessSubtopicOwner(deps, 'om_root_live_worker', CHAT_PROJECT, COORD_APP)).toBeUndefined();
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_live_worker', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'dispatch',
      sourceLarkAppId: WORKER_TOPIC,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_live_worker', CHAT_PROJECT, WORKER_TOPIC)).toEqual({
      kind: 'dispatch',
      sourceLarkAppId: WORKER_TOPIC,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: false,
    });
  });

  it('a coordinator holding its own live thread session still yields to a live免@ worker in the managed subtopic', async () => {
    await enableProjectGroup();
    // Imported worker topic + the coordinator's own thread session at the same
    // root (the coordinator was @-ed inside the topic under chat-topic mode).
    liveSessions = [
      {
        sessionId: 'sess-imported-topic',
        larkAppId: WORKER_TOPIC,
        chatId: CHAT_PROJECT,
        scope: 'thread',
        rootMessageId: 'om_root_coord_own',
        status: 'active',
        projectImportSource: 'relay',
      },
      {
        sessionId: 'sess-coord-own-thread',
        larkAppId: COORD_APP,
        chatId: CHAT_PROJECT,
        scope: 'thread',
        rootMessageId: 'om_root_coord_own',
        status: 'active',
      },
    ];
    const deps = makeDeps();

    // Both answer un-@ in this topic; only the live worker may (no double reply).
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_coord_own', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'imported',
      sourceLarkAppId: WORKER_TOPIC,
      sourceAnswersWithoutMention: true,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });
    expect(findLiveMentionlessSubtopicOwner(deps, 'om_root_coord_own', CHAT_PROJECT, COORD_APP)).toBe(WORKER_TOPIC);
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_coord_own', CHAT_PROJECT, WORKER_TOPIC)).toBeNull();

    // Worker requires @ → plain fold candidate; the dispatcher's continuesRoot
    // (isSessionOwner) keeps the coordinator on its own thread session.
    mentionlessBots.delete(WORKER_TOPIC);
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_root_coord_own', CHAT_PROJECT, COORD_APP)).toEqual({
      kind: 'imported',
      sourceLarkAppId: WORKER_TOPIC,
      sourceAnswersWithoutMention: false,
      hasProjectCoordinator: true,
      isProjectCoordinator: true,
    });
    expect(findLiveMentionlessSubtopicOwner(deps, 'om_root_coord_own', CHAT_PROJECT, COORD_APP)).toBeUndefined();
  });

  it('ignores unmanaged topics, cross-chat dispatch entries, moved attachments, and preserves non-project group behavior', async () => {
    await enableProjectGroup(CHAT_PROJECT);
    writeFileSync(join(dataDir, ORCHESTRATE_DISPATCH_STORE_FILE), JSON.stringify({
      om_other_chat_root: {
        orchChatId: CHAT_OTHER,
        targetChatId: CHAT_OTHER,
        targetAppIds: [WORKER_ALWAYS],
      },
      om_moved_root: {
        orchChatId: CHAT_PROJECT,
        targetChatId: CHAT_PROJECT,
        projectAttachment: {
          sourceSessionId: 's-moved',
          sourceLarkAppId: WORKER_ALWAYS,
          revision: 1,
          state: 'moved',
          reportCapability: 'verified',
        },
      },
    }));

    const deps = makeDeps();
    // Unmanaged random thread in project group -> null
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_unmanaged_thread', CHAT_PROJECT, COORD_APP)).toBeNull();
    // Dispatch registered in another chat -> null in CHAT_PROJECT
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_other_chat_root', CHAT_PROJECT, COORD_APP)).toBeNull();
    // Moved attachment -> null
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_moved_root', CHAT_PROJECT, COORD_APP)).toBeNull();

    // Non-project group (CHAT_OTHER has no project collaboration mode):
    // dispatch root in CHAT_OTHER does NOT trigger project-group handoff!
    expect(resolveManagedSubtopicMentionlessHandoff(deps, 'om_other_chat_root', CHAT_OTHER, COORD_APP)).toBeNull();
  });
});
