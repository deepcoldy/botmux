import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import { sendWorkerInput } from '../src/core/worker-pool.js';
import { launchCandidateRca } from '../src/services/candidate-rca-launch.js';
import {
  deliverCandidateTurnReceipt,
  deliverRcaChampionResult,
  RcaShadowMirror,
  rcaShadowMirrorConfigFromEnv,
  type RcaShadowMirrorConfig,
  type RcaSourceSnapshot,
} from '../src/services/rca-shadow-mirror.js';
import * as runtimeContractModule from '../src/services/candidate-runtime-contract.js';
import { CandidateTurnDurability } from '../src/services/candidate-turn-durability.js';
import type { DaemonSession } from '../src/types.js';

const snapshot: RcaSourceSnapshot = {
  schemaVersion: '1',
  capturedAt: '2026-08-13T08:00:00.000Z',
  captureStatus: 'complete',
  warnings: [],
  timeline: [{
    referenceKey: 'opaque-source',
    relation: 'current',
    senderRole: 'external_bot',
    messageType: 'interactive',
    content: 'Argos alarm',
  }],
};

function config(overrides: Partial<RcaShadowMirrorConfig> = {}): RcaShadowMirrorConfig {
  return {
    url: 'http://127.0.0.1:7310',
    token: 'mirror-secret',
    botAppIds: ['online_rca', 'candidate_rca'],
    candidateBotAppIds: ['candidate_rca'],
    shadowChatIds: ['oc_shadow'],
    timeoutMs: 20,
    maxInFlight: 1,
    maxQueued: 4,
    ...overrides,
  };
}

function turn(larkAppId: string, chatId: string, turnId: string) {
  return {
    larkAppId,
    chatId,
    sessionId: `${larkAppId}:${chatId}:${turnId}`,
    turnId,
    turnKind: 'first_turn' as const,
    topicId: 'topic-source',
    preparedInput: { content: 'Argos alarm' },
    sourceSnapshot: snapshot,
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function cleanBotmuxBuildFixture(): {
  checkout: string;
  commit: string;
  artifactSha256: string;
  workerPath: string;
} {
  const checkout = mkdtempSync(join(tmpdir(), 'botmux-build-identity-'));
  const dist = join(checkout, 'dist');
  mkdirSync(dist);
  writeFileSync(join(checkout, '.gitignore'), 'dist/\n');
  writeFileSync(join(checkout, 'package.json'), '{"name":"candidate-botmux"}\n');
  execFileSync('git', ['init', checkout]);
  execFileSync('git', ['-C', checkout, 'config', 'user.email', 'candidate@example.invalid']);
  execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Candidate Test']);
  execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'ssh://example.invalid/botmux.git']);
  execFileSync('git', ['-C', checkout, 'add', '.gitignore', 'package.json']);
  execFileSync('git', ['-C', checkout, 'commit', '-m', 'candidate fixture']);
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const entryPath = join(dist, 'index-daemon.js');
  const workerPath = join(dist, 'worker.js');
  writeFileSync(entryPath, 'export const daemonBuild = "release-a";\n');
  writeFileSync(workerPath, 'export const workerBuild = "release-a";\n');
  const files = [entryPath, workerPath].map(file => ({
    path: file.slice(dist.length + 1),
    sha256: sha256(readFileSync(file)),
  }));
  const treeSha256 = sha256(JSON.stringify(files));
  const manifestPath = join(dist, 'botmux-build-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    botmuxCommit: commit,
    treeSha256,
    files,
  })}\n`);
  return {
    checkout,
    commit,
    artifactSha256: treeSha256,
    workerPath,
  };
}

afterEach(() => {
  __testOnly_resetBotRegistry();
});

describe('Candidate RCA recursion isolation', () => {
  it('filters Candidate appId and Shadow chatId before any mirror delivery', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });

    // @online bot in Shadow, @Candidate bot, and replying to an old Shadow card
    // all reach the same appId/chatId circuit breaker before source capture.
    expect(mirror.submit(turn('online_rca', 'oc_shadow', 'mention-online'))).toBe('filtered');
    expect(mirror.submit(turn('candidate_rca', 'oc_alarm', 'mention-candidate'))).toBe('filtered');
    expect(mirror.submit(turn('online_rca', 'oc_shadow', 'reply-old-card'))).toBe('filtered');

    expect(mirror.submit(turn('online_rca', 'oc_alarm', 'original-alarm'))).toBe('queued');
    await mirror.onIdle();
    expect(fetchMock).toHaveBeenCalledOnce();

    expect(await deliverRcaChampionResult({
      larkAppId: 'candidate_rca',
      sessionId: 'candidate-session',
      turnId: 'candidate-final',
      result: 'Candidate output in Shadow',
    }, config(), fetchMock as any)).toBe('disabled');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('loads explicit appId and chatId isolation sets from the Candidate deployment environment', () => {
    const parsed = rcaShadowMirrorConfigFromEnv({
      BOTMUX_RCA_MIRROR_URL: 'http://127.0.0.1:7310',
      BOTMUX_RCA_MIRROR_TOKEN: 'secret',
      BOTMUX_RCA_MIRROR_BOT_APP_IDS: 'online_rca,candidate_rca',
      BOTMUX_RCA_MIRROR_CANDIDATE_BOT_APP_IDS: 'candidate_rca',
      BOTMUX_RCA_SHADOW_CHAT_ID: 'oc_shadow',
      BOTMUX_RCA_MIRROR_SHADOW_CHAT_IDS: 'oc_replay',
    });
    expect(parsed.candidateBotAppIds).toEqual(['candidate_rca']);
    expect(parsed.shadowChatIds).toEqual(['oc_shadow', 'oc_replay']);

    expect(() => rcaShadowMirrorConfigFromEnv({
      BOTMUX_RCA_MIRROR_URL: 'http://127.0.0.1:7310',
      BOTMUX_RCA_MIRROR_TOKEN: 'secret',
      BOTMUX_RCA_MIRROR_BOT_APP_IDS: 'online_rca,candidate_rca',
      BOTMUX_RCA_SHADOW_CHAT_ID: 'oc_shadow',
    })).toThrow(/Candidate.*app.*exclusion/i);
    expect(() => rcaShadowMirrorConfigFromEnv({
      BOTMUX_RCA_MIRROR_URL: 'http://127.0.0.1:7310',
      BOTMUX_RCA_MIRROR_TOKEN: 'secret',
      BOTMUX_RCA_MIRROR_BOT_APP_IDS: 'online_rca,candidate_rca',
    })).toThrow(/Candidate.*app.*exclusion|Shadow.*chat.*exclusion/i);
  });

  it('reports the frozen Release and observed BotMux identity in every durable turn receipt', async () => {
    const botmuxCommit = runtimeContractModule.candidateBotmuxCommit();
    const botmuxArtifactSha256 = '6'.repeat(64);
    expect(botmuxCommit).toMatch(/^[0-9a-f]{40}$/);
    const contract = {
      schemaVersion: 1 as const,
      incidentKey: 'argos:release-identity',
      eventId: 'event-release-identity',
      candidateDispatchId: 'cand_release_identity',
      releaseId: 'release-a',
      releaseManifestSha256: '1'.repeat(64),
      runtimeBundleId: 'runtime-a',
      runtimeName: 'coco' as const,
      searchRcaCommit: 'c'.repeat(40),
      botmuxCommit,
      botmuxArtifactSha256,
      workspaceSnapshot: {
        realpath: '/tmp/workspace',
        repository: 'ssh://example.invalid/search.git',
        commit: 'a'.repeat(40),
      },
      capabilityLockSha256: '2'.repeat(64),
      skillsRoot: '/tmp/skills',
      skillsSha256: '3'.repeat(64),
      executable: { realpath: '/tmp/coco', sha256: '4'.repeat(64) },
      disabledFeatures: ['memories'] as ['memories'],
      investigation: {
        title: 'release identity',
        symptom: 'candidate release identity check',
        preparedInput: { content: 'Investigate release identity.' },
        sourceSnapshot: null,
      },
      shadowTarget: { larkAppId: 'candidate_rca', chatId: 'oc_shadow' },
    };
    expect(runtimeContractModule.validateCandidateRuntimeContract(contract, {
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
    }, {
      observeBotmuxIdentity: () => ({ commit: botmuxCommit, artifactSha256: botmuxArtifactSha256 }),
    }).botmuxCommit).toBe(botmuxCommit);
    expect(() => runtimeContractModule.validateCandidateRuntimeContract({
      ...contract,
      botmuxCommit: 'd'.repeat(40),
    }, {
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
    }, {
      observeBotmuxIdentity: () => ({ commit: botmuxCommit, artifactSha256: botmuxArtifactSha256 }),
    })).toThrow(/BotMux commit mismatch/i);

    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const durability = new CandidateTurnDurability({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-release-receipt-')),
    });
    const { receipt } = await durability.accept({
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      releaseId: contract.releaseId,
      releaseManifestSha256: contract.releaseManifestSha256,
      runtimeBundleId: contract.runtimeBundleId,
      larkAppId: 'candidate_rca',
      chatId: 'oc_shadow',
      rootMessageId: 'om_root',
      botmuxSessionId: 'botmux-session',
      botmuxCommit,
      botmuxArtifactSha256,
      turnId: 'om_turn',
      prompt: 'continue',
      acceptedAt: '2026-08-13T00:00:01.000Z',
    });
    await deliverCandidateTurnReceipt(receipt, config(), fetchMock as any);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      releaseId: contract.releaseId,
      releaseManifestSha256: contract.releaseManifestSha256,
      runtimeBundleId: contract.runtimeBundleId,
      botmuxCommit,
      botmuxArtifactSha256,
    });
  });

  it('rejects Candidate launch when ignored dist diverges from its clean BotMux HEAD', async () => {
    const build = cleanBotmuxBuildFixture();
    expect(runtimeContractModule.candidateBotmuxBuildIdentity(build.checkout)).toEqual({
      commit: build.commit,
      artifactSha256: build.artifactSha256,
    });
    writeFileSync(build.workerPath, 'export const workerBuild = "drifted";\n');
    const sendTopic = vi.fn();
    const contract = {
      schemaVersion: 1 as const,
      incidentKey: 'argos:dist-drift',
      eventId: 'event-dist-drift',
      candidateDispatchId: 'cand_dist_drift',
      releaseId: 'release-a',
      releaseManifestSha256: '1'.repeat(64),
      runtimeBundleId: 'runtime-a',
      runtimeName: 'coco' as const,
      searchRcaCommit: 'c'.repeat(40),
      botmuxCommit: build.commit,
      botmuxArtifactSha256: build.artifactSha256,
      workspaceSnapshot: {
        realpath: '/tmp/workspace',
        repository: 'ssh://example.invalid/search.git',
        commit: 'a'.repeat(40),
      },
      capabilityLockSha256: '2'.repeat(64),
      skillsRoot: '/tmp/skills',
      skillsSha256: '3'.repeat(64),
      executable: { realpath: '/tmp/coco', sha256: '4'.repeat(64) },
      disabledFeatures: ['memories'] as ['memories'],
      investigation: {
        title: 'dist drift',
        symptom: 'candidate dist differs from release',
        preparedInput: { content: 'Investigate dist drift.' },
        sourceSnapshot: null,
      },
      shadowTarget: { larkAppId: 'candidate_rca', chatId: 'oc_shadow' },
    };
    await expect(launchCandidateRca({
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
      topicMessage: 'Candidate dist drift',
      launchContext: contract,
    }, {
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-launch-dist-drift-')),
      botmuxSourceRoot: build.checkout,
      sendTopic,
      findTopicByDispatch: vi.fn(),
      findSessionByRoot: vi.fn(),
      dispatchTurn: vi.fn(),
    })).resolves.toEqual({ ok: false, reason: 'identity_conflict' });
    expect(sendTopic).not.toHaveBeenCalled();
  });

  it('rejects a Candidate launch when the observed BotMux checkout is dirty', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'botmux-runtime-identity-'));
    execFileSync('git', ['init', checkout]);
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'candidate@example.invalid']);
    execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Candidate Test']);
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'ssh://example.invalid/botmux.git']);
    writeFileSync(join(checkout, 'package.json'), '{"name":"candidate-botmux"}\n');
    execFileSync('git', ['-C', checkout, 'add', 'package.json']);
    execFileSync('git', ['-C', checkout, 'commit', '-m', 'candidate fixture']);
    const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(checkout, 'package.json'), '{"name":"dirty-candidate-botmux"}\n');

    const contract = {
      schemaVersion: 1 as const,
      incidentKey: 'argos:dirty-botmux',
      eventId: 'event-dirty-botmux',
      candidateDispatchId: 'cand_dirty_botmux',
      releaseId: 'release-a',
      releaseManifestSha256: '1'.repeat(64),
      runtimeBundleId: 'runtime-a',
      runtimeName: 'coco' as const,
      searchRcaCommit: 'c'.repeat(40),
      botmuxCommit: commit,
      botmuxArtifactSha256: '6'.repeat(64),
      workspaceSnapshot: {
        realpath: '/tmp/workspace',
        repository: 'ssh://example.invalid/search.git',
        commit: 'a'.repeat(40),
      },
      capabilityLockSha256: '2'.repeat(64),
      skillsRoot: '/tmp/skills',
      skillsSha256: '3'.repeat(64),
      executable: { realpath: '/tmp/coco', sha256: '4'.repeat(64) },
      disabledFeatures: ['memories'] as ['memories'],
      investigation: {
        title: 'dirty botmux',
        symptom: 'candidate BotMux checkout is dirty',
        preparedInput: { content: 'Investigate dirty BotMux checkout.' },
        sourceSnapshot: null,
      },
      shadowTarget: { larkAppId: 'candidate_rca', chatId: 'oc_shadow' },
    };
    expect(() => runtimeContractModule.validateCandidateRuntimeContract(contract, {
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
    }, { botmuxSourceRoot: checkout })).toThrow(/clean.*BotMux|BotMux.*clean/i);
  });

  it('keeps legacy worker IPC successful when the Candidate path is disabled or unreachable', async () => {
    registerBot({
      larkAppId: 'legacy_rca',
      larkAppSecret: 'test',
      cliId: 'coco',
      allowedUsers: ['ou_owner'],
    });
    const worker = new EventEmitter() as any;
    worker.killed = false;
    worker.send = vi.fn();
    const ds = {
      session: {
        sessionId: 'legacy-session',
        rootMessageId: 'om_root',
        chatId: 'oc_alarm',
        title: 'Legacy RCA',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pid: null,
        chatType: 'group',
        cliId: 'coco',
      },
      worker,
      larkAppId: 'legacy_rca',
      chatId: 'oc_alarm',
      chatType: 'group',
      scope: 'thread',
      currentTurnTitle: 'Legacy RCA',
    } as DaemonSession;

    expect(sendWorkerInput(ds, { content: 'legacy investigation' }, 'om_alarm')).toBe(true);
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      content: 'legacy investigation',
      turnId: 'om_alarm',
    }));

    const log = { info: vi.fn(), warn: vi.fn() };
    const unavailable = new RcaShadowMirror(config(), {
      fetchImpl: vi.fn(async () => { throw new Error('Search RCA unreachable'); }) as any,
      log,
    });
    expect(unavailable.submit(turn('online_rca', 'oc_alarm', 'network-failure'))).toBe('queued');
    expect(worker.send).toHaveBeenCalledOnce();
    await unavailable.onIdle();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Search RCA unreachable'));
    expect(worker.send).toHaveBeenCalledOnce();
  });
});
