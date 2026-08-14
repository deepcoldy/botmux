import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const productionMocks = vi.hoisted(() => ({
  getMessageChatId: vi.fn(async () => 'oc_shadow'),
  getChatMode: vi.fn(async () => 'topic'),
  sendMessage: vi.fn(async () => 'om_production_root'),
  listChatMessages: vi.fn(async () => []),
  listChatMessagesUntil: vi.fn(async () => []),
  getBot: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  findActiveSessionsByRoot: vi.fn(() => []),
  forkWorker: vi.fn(),
  getDaemonBootId: vi.fn(() => 'boot-test'),
}));

vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: (...args: any[]) => productionMocks.getMessageChatId(...args),
  getChatMode: (...args: any[]) => productionMocks.getChatMode(...args),
  sendMessage: (...args: any[]) => productionMocks.sendMessage(...args),
  listChatMessages: (...args: any[]) => productionMocks.listChatMessages(...args),
  listChatMessagesUntil: (...args: any[]) => productionMocks.listChatMessagesUntil(...args),
  replyMessage: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => productionMocks.getBot(...args),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));
vi.mock('../src/services/groups-store.js', () => ({ isInChat: vi.fn(async () => true) }));
vi.mock('../src/services/oncall-store.js', () => ({ getOncallStatus: vi.fn(() => undefined) }));
vi.mock('../src/services/session-store.js', () => ({
  createSession: (...args: any[]) => productionMocks.createSession(...args),
  updateSession: (...args: any[]) => productionMocks.updateSession(...args),
  findActiveSessionsByRoot: (...args: any[]) => productionMocks.findActiveSessionsByRoot(...args),
}));
vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...args: any[]) => productionMocks.forkWorker(...args),
  sendWorkerInput: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test-cli-version'),
  getDaemonBootId: (...args: any[]) => productionMocks.getDaemonBootId(...args),
}));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpCliInput: vi.fn((prompt: string) => `follow:${prompt}`),
  buildNewTopicCliInput: vi.fn((prompt: string) => `new:${prompt}`),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));
vi.mock('../src/services/default-worktree.js', () => ({ botAutoWorktreeEnabled: vi.fn(() => false) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ runAutoWorktreeCommit: vi.fn() }));
import {
  candidateRcaLaunchReceiptPath,
  findCandidateRcaLaunchByIncidentAndDispatch,
  launchCandidateRca,
  readCandidateRcaLaunchReceipt,
  type CandidateRcaLaunchDeps,
  type CandidateRcaLaunchRequest,
} from '../src/services/candidate-rca-launch.js';
import {
  launchCandidateRcaFromDaemon,
  setCandidateLaunchTurnRecovery,
  setCandidateLaunchTurnReceiptReporter,
} from '../src/core/candidate-rca-launch-entry.js';
import { CandidateTurnDurability } from '../src/services/candidate-turn-durability.js';
import {
  candidateBotmuxCommit,
  hashCandidateRuntimeTree,
} from '../src/services/candidate-runtime-contract.js';

const runtimeFixtureRoot = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-runtime-'));
const runtimeWorkspace = join(runtimeFixtureRoot, 'workspace');
const runtimeSkills = join(runtimeFixtureRoot, 'skills');
const runtimeExecutable = join(runtimeFixtureRoot, 'bin', 'coco');
mkdirSync(join(runtimeWorkspace, '.git', 'refs', 'heads'), { recursive: true });
mkdirSync(join(runtimeSkills, 'release-only'), { recursive: true });
mkdirSync(dirname(runtimeExecutable), { recursive: true });
writeFileSync(join(runtimeWorkspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
writeFileSync(join(runtimeWorkspace, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
writeFileSync(join(runtimeWorkspace, '.git', 'config'), '[remote "origin"]\n\turl = ssh://example.invalid/release-a.git\n');
writeFileSync(join(runtimeSkills, 'release-only', 'SKILL.md'), '# release only\n');
writeFileSync(runtimeExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const runtimeExecutableSha256 = createHash('sha256')
  .update(readFileSync(runtimeExecutable))
  .digest('hex');
const BOTMUX_COMMIT = candidateBotmuxCommit();
const BOTMUX_ARTIFACT_SHA256 = '6'.repeat(64);
const observeBotmuxIdentity = () => ({
  commit: BOTMUX_COMMIT,
  artifactSha256: BOTMUX_ARTIFACT_SHA256,
});

const runtimeContract = () => ({
  schemaVersion: 1 as const,
  incidentKey: 'argos:alarm-42',
  eventId: 'event-42',
  candidateDispatchId: 'cand_0123456789abcdef',
  releaseId: 'release-a',
  releaseManifestSha256: '1'.repeat(64),
  runtimeBundleId: 'runtime-a',
  runtimeName: 'coco' as const,
  searchRcaCommit: 'c'.repeat(40),
  botmuxCommit: BOTMUX_COMMIT,
  botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
  workspaceSnapshot: {
    realpath: realpathSync(runtimeWorkspace),
    repository: 'ssh://example.invalid/release-a.git',
    commit: 'a'.repeat(40),
  },
  capabilityLockSha256: '2'.repeat(64),
  skillsRoot: realpathSync(runtimeSkills),
  skillsSha256: hashCandidateRuntimeTree(runtimeSkills),
  executable: { realpath: realpathSync(runtimeExecutable), sha256: runtimeExecutableSha256 },
  disabledFeatures: ['memories'] as ['memories'],
  model: 'candidate-model-a',
  investigation: {
    title: 'alarm-42 panic',
    symptom: 'panic rate elevated',
    preparedInput: { content: 'Investigate alarm-42 and identify the root cause.' },
    sourceSnapshot: { schemaVersion: '1', timeline: [] },
  },
  shadowTarget: { larkAppId: 'cli_candidate', chatId: 'oc_shadow' },
});

const request = (overrides: Partial<CandidateRcaLaunchRequest> = {}): CandidateRcaLaunchRequest => ({
  incidentKey: 'argos:alarm-42',
  candidateDispatchId: 'cand_0123456789abcdef',
  larkAppId: 'cli_candidate',
  chatId: 'oc_shadow',
  topicMessage: 'Candidate Shadow · alarm-42',
  launchContext: runtimeContract(),
  ...overrides,
});

function harness(dataDir: string) {
  const providerMessages = new Map<string, string>();
  const sessions = new Map<string, string>();
  const sendTopic = vi.fn(async ({ uuid }: { uuid: string }) => {
    const persisted = readCandidateRcaLaunchReceipt(dataDir, request().candidateDispatchId);
    expect(persisted?.status).toBe('sending');
    if (!providerMessages.has(uuid)) providerMessages.set(uuid, `om_${providerMessages.size + 1}`);
    return providerMessages.get(uuid)!;
  });
  const findTopicByDispatch = vi.fn(async (candidateDispatchId: string) => (
    providerMessages.get(candidateDispatchId)
  ));
  const dispatchTurn = vi.fn(async ({ rootMessageId, stableTurnId, beforeDispatch }: any) => {
    expect(stableTurnId).toBe(request().candidateDispatchId);
    const sessionId = sessions.get(rootMessageId) ?? `session-${sessions.size + 1}`;
    sessions.set(rootMessageId, sessionId);
    beforeDispatch({ sessionId, workerGeneration: 1, prompt: 'rendered Candidate prompt' });
    return { ok: true as const, sessionId };
  });
  const deps: CandidateRcaLaunchDeps = {
    dataDir,
    observeBotmuxIdentity,
    sendTopic,
    findTopicByDispatch,
    findSessionByRoot: (rootMessageId) => sessions.get(rootMessageId),
    prepareLaunchTurn: vi.fn(() => ({ dispatchAttempt: 1 })),
    dispatchTurn,
  };
  return { deps, providerMessages, sessions, sendTopic, findTopicByDispatch, dispatchTurn };
}

describe('Candidate RCA launch identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    productionMocks.getBot.mockReturnValue({
      config: { larkAppId: 'cli_candidate', cliId: 'claude-code', workingDir: '/tmp' },
      botName: 'Candidate',
      botOpenId: 'ou_candidate',
    });
    productionMocks.createSession.mockImplementation((chatId, rootMessageId, title, chatType) => ({
      sessionId: 'botmux-production-session',
      chatId,
      rootMessageId,
      title,
      chatType,
      status: 'active',
      createdAt: '2026-08-13T00:00:00.000Z',
    }));
    setCandidateLaunchTurnReceiptReporter(undefined);
    setCandidateLaunchTurnRecovery(async (session, receipt) => {
      productionMocks.forkWorker(session, receipt.prompt, {
        resume: true,
        turnId: receipt.turnId,
        dispatchAttempt: receipt.dispatchAttempt,
      });
    });
  });
  it('rejects a launch without stable alarm identity instead of guessing from chat identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);

    await expect(launchCandidateRca(request({ incidentKey: '' }), h.deps)).resolves.toEqual({
      ok: false,
      reason: 'identity_gap',
    });
    expect(h.sendTopic).not.toHaveBeenCalled();
    expect(h.dispatchTurn).not.toHaveBeenCalled();
  });

  it('persists the dispatch receipt before send and concurrent retries converge on one topic and Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);

    const [left, right] = await Promise.all([
      launchCandidateRca(request(), h.deps),
      launchCandidateRca(request(), h.deps),
    ]);

    expect(left).toEqual(right);
    expect(left).toMatchObject({
      ok: true,
      incidentKey: 'argos:alarm-42',
      candidateDispatchId: 'cand_0123456789abcdef',
      feishuUuid: 'cand_0123456789abcdef',
      rootMessageId: 'om_1',
      botmuxSessionId: 'session-1',
      status: 'launched',
    });
    expect(h.sendTopic).toHaveBeenCalledTimes(1);
    expect(h.sendTopic).toHaveBeenCalledWith(expect.objectContaining({ uuid: request().candidateDispatchId }));
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(h.providerMessages.size).toBe(1);
    expect(h.sessions.size).toBe(1);
  });

  it('reconciles the original topic after a lost send response without relying on the UUID window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    let loseResponse = true;
    h.deps.sendTopic = vi.fn(async ({ uuid }) => {
      if (!h.providerMessages.has(uuid)) h.providerMessages.set(uuid, 'om_original');
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost after provider accepted send');
      }
      return h.providerMessages.get(uuid)!;
    });

    await expect(launchCandidateRca(request(), h.deps)).rejects.toThrow(/response lost/);
    expect(readCandidateRcaLaunchReceipt(root, request().candidateDispatchId)?.status).toBe('sending');

    const recovered = await launchCandidateRca(request({
      launchContext: { ...runtimeContract(), eventId: 'event-redelivery', releaseId: 'release-b' },
    }), h.deps);
    expect(recovered).toMatchObject({ ok: true, rootMessageId: 'om_original', botmuxSessionId: 'session-1' });
    expect(h.providerMessages.size).toBe(1);
    expect(h.findTopicByDispatch).toHaveBeenCalledWith(
      request().candidateDispatchId,
      request().larkAppId,
      request().chatId,
      request().topicMessage,
      expect.any(String),
    );
    expect(h.deps.sendTopic).toHaveBeenCalledTimes(1);
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of sending again when an unresolved receipt is beyond the UUID window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    h.deps.sendTopic = vi.fn(async () => {
      throw new Error('provider outcome unknown');
    });

    await expect(launchCandidateRca(request(), h.deps)).rejects.toThrow(/provider outcome unknown/);
    const receiptPath = candidateRcaLaunchReceiptPath(root, request().candidateDispatchId);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.createdAt = '2026-08-12T00:00:00.000Z';
    receipt.updatedAt = receipt.createdAt;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(launchCandidateRca(request(), h.deps)).rejects.toThrow(/cannot safely retry/i);
    expect(h.findTopicByDispatch).toHaveBeenCalledTimes(1);
    expect(h.deps.sendTopic).toHaveBeenCalledTimes(1);
  });

  it('continues an old creating receipt because no Feishu send had started yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    const receiptPath = candidateRcaLaunchReceiptPath(root, request().candidateDispatchId);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      ...request(),
      feishuUuid: request().candidateDispatchId,
      status: 'creating',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }, null, 2)}\n`);

    const recovered = await launchCandidateRca(request(), h.deps);
    expect(recovered).toMatchObject({
      ok: true,
      rootMessageId: 'om_1',
      botmuxSessionId: 'session-1',
    });
    expect(h.findTopicByDispatch).not.toHaveBeenCalled();
    expect(h.deps.sendTopic).toHaveBeenCalledTimes(1);
  });

  it('bounds a UUID retry so the provider request cannot outlive the dedupe window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    h.deps.sendTopic = vi.fn(async () => {
      throw new Error('provider response lost');
    });

    await expect(launchCandidateRca(request(), h.deps)).rejects.toThrow(/response lost/);
    const receiptPath = candidateRcaLaunchReceiptPath(root, request().candidateDispatchId);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const retryStartedAt = Date.now();
    receipt.createdAt = new Date(retryStartedAt - 54 * 60 * 1000).toISOString();
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    h.deps.sendTopic = vi.fn(async ({ timeoutMs }) => {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(retryStartedAt - Date.parse(receipt.createdAt) + timeoutMs)
        .toBeLessThan(60 * 60 * 1000);
      return 'om_bounded_retry';
    });

    await expect(launchCandidateRca(request(), h.deps)).resolves.toMatchObject({
      ok: true,
      rootMessageId: 'om_bounded_retry',
    });
  });

  it('does not report launched when worker dispatch fails after the Session identity is recorded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    let failDispatch = true;
    let sessionCreations = 0;
    h.deps.dispatchTurn = vi.fn(async ({ rootMessageId, botmuxSessionId, beforeDispatch }) => {
      const sessionId = botmuxSessionId
        ?? h.sessions.get(rootMessageId)
        ?? `session-${++sessionCreations}`;
      h.sessions.set(rootMessageId, sessionId);
      beforeDispatch({ sessionId, workerGeneration: 1, prompt: 'rendered Candidate prompt' });
      if (failDispatch) {
        failDispatch = false;
        throw new Error('worker fork failed after dispatch identity write');
      }
      return { ok: true, sessionId };
    });

    await expect(launchCandidateRca(request(), h.deps)).rejects.toThrow(/worker fork failed/);
    expect(readCandidateRcaLaunchReceipt(root, request().candidateDispatchId)).toMatchObject({
      status: 'dispatching',
      rootMessageId: 'om_1',
      botmuxSessionId: 'session-1',
    });

    h.sessions.clear();

    const recovered = await launchCandidateRca(request({
      launchContext: { ...runtimeContract(), eventId: 'event-redelivery', releaseId: 'release-b' },
    }), h.deps);
    expect(recovered).toMatchObject({ status: 'launched', botmuxSessionId: 'session-1' });
    expect(h.deps.dispatchTurn).toHaveBeenCalledTimes(2);
    expect(h.deps.dispatchTurn.mock.calls[1][0].botmuxSessionId).toBe('session-1');
    expect(sessionCreations).toBe(1);
    expect(h.sessions.size).toBe(1);
  });

  it('reconciles a Session created before a crash without dispatching a second Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    let failAfterSessionCreate = true;
    h.deps.dispatchTurn = vi.fn(async ({ rootMessageId, beforeDispatch }) => {
      h.sessions.set(rootMessageId, 'session-survived');
      if (failAfterSessionCreate) {
        failAfterSessionCreate = false;
        throw new Error('crash before dispatch receipt callback');
      }
      beforeDispatch({
        sessionId: 'session-survived',
        workerGeneration: 1,
        prompt: 'rendered Candidate prompt',
      });
      return { ok: true, sessionId: 'session-survived' };
    });

    await expect(launchCandidateRca(request(), h.deps)).rejects.toThrow(/crash before dispatch/);
    expect(readCandidateRcaLaunchReceipt(root, request().candidateDispatchId)).toMatchObject({
      status: 'topic_created',
      rootMessageId: 'om_1',
    });

    const recovered = await launchCandidateRca(request(), h.deps);
    expect(recovered).toMatchObject({ ok: true, rootMessageId: 'om_1', botmuxSessionId: 'session-survived' });
    expect(h.deps.dispatchTurn).toHaveBeenCalledTimes(2);
    expect(h.sessions.size).toBe(1);
  });

  it('keeps a durable, directly readable dispatch receipt and rejects identity reuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-launch-'));
    const h = harness(root);
    await launchCandidateRca(request(), h.deps);

    const receipt = JSON.parse(readFileSync(
      candidateRcaLaunchReceiptPath(root, request().candidateDispatchId),
      'utf8',
    ));
    expect(receipt).toMatchObject({ rootMessageId: 'om_1', botmuxSessionId: 'session-1' });
    await expect(launchCandidateRca(request({ incidentKey: 'argos:other-alarm' }), h.deps))
      .resolves.toEqual({ ok: false, reason: 'identity_conflict' });
  });

  it('incidentKey + candidateDispatchId uniquely reverse-lookup root and Session after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-lookup-'));
    const h = harness(root);
    await launchCandidateRca(request(), h.deps);

    expect(findCandidateRcaLaunchByIncidentAndDispatch(
      root,
      request().incidentKey,
      request().candidateDispatchId,
    )).toEqual({
      rootMessageId: 'om_1',
      botmuxSessionId: 'session-1',
    });
    expect(findCandidateRcaLaunchByIncidentAndDispatch(
      root,
      'argos:other-alarm',
      request().candidateDispatchId,
    )).toBeNull();
    expect(findCandidateRcaLaunchByIncidentAndDispatch(
      root,
      request().incidentKey,
      'cand_not_this_dispatch',
    )).toBeNull();
  });

  it('the daemon production entry reconciles a lost Feishu response before stable Session dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-production-'));
    const activeSessions = new Map();
    const reported = vi.fn();
    setCandidateLaunchTurnReceiptReporter(reported);
    let providerMessage: any;
    productionMocks.sendMessage.mockImplementationOnce(async (_appId, _chatId, content, _type, uuid) => {
      expect(uuid).toBe(request().candidateDispatchId);
      expect(content).toContain(`[Search RCA dispatch: ${request().candidateDispatchId}]`);
      expect(readCandidateRcaLaunchReceipt(root, request().candidateDispatchId)).toMatchObject({
        status: 'sending',
      });
      providerMessage = {
        message_id: 'om_production_root',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: content }) },
      };
      throw new Error('provider response lost');
    });
    productionMocks.listChatMessagesUntil.mockImplementation(async (_appId, _chatId, options) => {
      expect(options.pageSize).toBe(50);
      expect(options.stopAfter({ create_time: String(Date.now()) }, 499)).toBe(false);
      expect(options.stopAfter({ create_time: String(Date.now()) }, 500)).toBe(true);
      return [providerMessage];
    });

    await expect(launchCandidateRcaFromDaemon(request(), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: true,
      observeBotmuxIdentity,
    })).rejects.toThrow(/provider response lost/);

    const result = await launchCandidateRcaFromDaemon(request(), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: true,
      observeBotmuxIdentity,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'launched',
      rootMessageId: 'om_production_root',
      botmuxSessionId: 'botmux-production-session',
    });
    expect(productionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(productionMocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(productionMocks.forkWorker.mock.calls[0][0].session).toMatchObject({
      // The frozen `coco` bundle selects BotMux's rollout-backed TRAE adapter.
      cliId: 'traex',
      cliPathOverride: runtimeContract().executable.realpath,
      workingDir: runtimeContract().workspaceSnapshot.realpath,
      candidateRuntimeContract: runtimeContract(),
    });
    const launchPrompt = productionMocks.forkWorker.mock.calls[0][1] as string;
    expect(launchPrompt).toContain('Investigate alarm-42');
    expect(launchPrompt).toContain('panic rate elevated');
    expect(launchPrompt).not.toContain('releaseManifestSha256');
    const launchTurn = new CandidateTurnDurability({ dataDir: root })
      .get(request().candidateDispatchId, request().candidateDispatchId);
    expect(launchTurn).toMatchObject({
      releaseId: runtimeContract().releaseId,
      releaseManifestSha256: runtimeContract().releaseManifestSha256,
      runtimeBundleId: runtimeContract().runtimeBundleId,
      status: 'accepted',
      dispatchAttempt: 1,
      workerGeneration: 1,
      transitions: [{ status: 'accepted' }],
    });
    expect(reported).toHaveBeenCalledWith(expect.objectContaining({
      candidateDispatchId: request().candidateDispatchId,
      turnId: request().candidateDispatchId,
      status: 'accepted',
      dispatchAttempt: 1,
    }));
    expect(productionMocks.forkWorker.mock.calls[0][2]).toMatchObject({
      turnId: request().candidateDispatchId,
      dispatchAttempt: 1,
    });
    expect(productionMocks.sendMessage.mock.calls[0][6]).toMatchObject({
      requestTimeoutMs: expect.any(Number),
    });
    expect(productionMocks.listChatMessagesUntil).toHaveBeenCalledWith(
      'cli_candidate',
      'oc_shadow',
      expect.objectContaining({ pageSize: 50, stopAfter: expect.any(Function) }),
    );
    expect(productionMocks.listChatMessages).not.toHaveBeenCalled();
    expect(productionMocks.getMessageChatId).toHaveBeenCalledWith('cli_candidate', 'om_production_root');
    expect(productionMocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(activeSessions.size).toBe(1);
  });

  it('the daemon production fast path rejects a dispatch reused by another incident', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-identity-conflict-'));
    const activeSessions = new Map();

    await expect(launchCandidateRcaFromDaemon(request(), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: true,
      observeBotmuxIdentity,
    })).resolves.toMatchObject({
      ok: true,
      incidentKey: request().incidentKey,
      candidateDispatchId: request().candidateDispatchId,
      rootMessageId: 'om_production_root',
      botmuxSessionId: 'botmux-production-session',
    });

    await expect(launchCandidateRcaFromDaemon(request({ incidentKey: 'argos:other-alarm' }), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: true,
      observeBotmuxIdentity,
    })).resolves.toEqual({ ok: false, reason: 'identity_conflict' });

    expect(productionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(productionMocks.createSession).toHaveBeenCalledTimes(1);
    expect(productionMocks.forkWorker).toHaveBeenCalledTimes(1);
    expect([...activeSessions.values()].map(session => session.session.sessionId))
      .toEqual(['botmux-production-session']);
  });

  it('waits for canonical restore, then reuses the persisted Session after a mid-dispatch restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-restart-'));
    const activeSessions = new Map();
    productionMocks.forkWorker.mockImplementationOnce(() => {
      throw new Error('daemon crashed after Session receipt');
    });

    await expect(launchCandidateRcaFromDaemon(request(), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: true,
      observeBotmuxIdentity,
    })).rejects.toThrow(/daemon crashed/);
    expect(readCandidateRcaLaunchReceipt(root, request().candidateDispatchId)).toMatchObject({
      status: 'dispatching',
      rootMessageId: 'om_production_root',
      botmuxSessionId: 'botmux-production-session',
    });

    const restoredSession = activeSessions.get('om_production_root::cli_candidate');
    activeSessions.clear();

    await expect(launchCandidateRcaFromDaemon(request(), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: false,
      observeBotmuxIdentity,
    })).rejects.toThrow(/session restore pending/i);
    expect(productionMocks.forkWorker).toHaveBeenCalledTimes(1);

    activeSessions.set('om_production_root::cli_candidate', restoredSession);

    const recovered = await launchCandidateRcaFromDaemon(request(), {
      dataDir: root,
      larkAppId: 'cli_candidate',
      activeSessions,
      sessionsReady: true,
      observeBotmuxIdentity,
    });

    expect(recovered).toMatchObject({
      ok: true,
      status: 'launched',
      rootMessageId: 'om_production_root',
      botmuxSessionId: 'botmux-production-session',
    });
    expect(productionMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(productionMocks.createSession).toHaveBeenCalledTimes(1);
    expect(productionMocks.forkWorker).toHaveBeenCalledTimes(2);
    expect(productionMocks.findActiveSessionsByRoot).not.toHaveBeenCalled();
    expect([...activeSessions.values()].map(session => session.session.sessionId))
      .toEqual(['botmux-production-session']);
  });
});
