/**
 * Two-deployment A2A regression without real Lark or real CLI processes.
 *
 * The fake bus only performs Lark's transport normalization (at tags become
 * mention placeholders). Message parsing, dispatch repo preflight, envelope
 * parsing/auth/ingestion, ledger materialization, and reconciliation all use
 * production code. Each deployment has an isolated data directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

import { buildDispatchMessages, buildReportText } from '../src/core/dispatch.js';
import { buildMissingRepoBlocker } from '../src/core/repo-help.js';
import { formatHelpEnvelope, formatReportEnvelope, parseDeliveryEnvelope } from '../src/verified-delivery/envelope.js';
import { ingestParsedDeliveryEnvelope } from '../src/verified-delivery/envelope-ingest.js';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { reconcileTaskByCriteria } from '../src/verified-delivery/reconcile.js';
import { runGoalReleaseCheck } from '../src/verified-delivery/release-engine.js';
import { classifyTaskDisposition } from '../src/verified-delivery/attention.js';
import type { TaskPlannedPayload } from '../src/verified-delivery/types.js';
import { parseEventMessage } from '../src/im/lark/message-parser.js';

interface DeploymentIdentity {
  appId: string;
  name: string;
  unionId: string;
  /** Sender open_id as observed by the other deployment's app. */
  peerScopedOpenId: string;
}

interface BusMessage {
  from: string;
  to: string;
  rawText: string;
  parsedText: string;
  messageId: string;
}

class FakeLarkBus {
  readonly messages: BusMessage[] = [];
  private seq = 0;

  deliver(from: DeploymentIdentity, to: DeploymentIdentity, rawText: string) {
    const mentions: Array<{ key: string; name: string; id: { open_id: string } }> = [];
    const transportedText = rawText.replace(/<at user_id="([^"]+)"><\/at>/g, (_all, openId: string) => {
      const key = `@_user_${mentions.length + 1}`;
      mentions.push({ key, name: openId === to.peerScopedOpenId ? to.name : 'mentioned-bot', id: { open_id: openId } });
      return key;
    });
    const messageId = `om_bus_${++this.seq}`;
    const { parsed } = parseEventMessage({
      sender: {
        sender_id: { open_id: from.peerScopedOpenId, union_id: from.unionId },
        sender_type: 'bot',
      },
      message: {
        message_id: messageId,
        message_type: 'text',
        content: JSON.stringify({ text: transportedText }),
        chat_id: 'oc_dual_deploy',
        chat_type: 'group',
        create_time: String(Date.now()),
        mentions,
      },
    } as any);
    this.messages.push({ from: from.appId, to: to.appId, rawText, parsedText: parsed.content, messageId });
    return parsed;
  }
}

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `botmux-a2a-dual-${label}-`));
  roots.push(root);
  return root;
}

function makeRepo(root: string, remote: string): string {
  const path = join(root, 'receiver-checkout');
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['-C', path, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote], { stdio: 'ignore' });
  return path;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('A2A dual-deployment delivery loop', () => {
  it('keeps downstream work planned until upstream acceptance, then releases and accepts it across deployments', async () => {
    const supervisorData = tempRoot('supervisor-dependency');
    const workerData = tempRoot('worker-dependency');
    const workerRepos = tempRoot('worker-dependency-repos');
    const repoRemote = 'https://github.com/acme/dependency-chain.git';
    const repoPath = makeRepo(workerRepos, repoRemote);
    const upstreamOutput = join(repoPath, 'upstream.txt');
    const downstreamOutput = join(repoPath, 'downstream.txt');
    const ledger = openLedger({ baseDir: join(supervisorData, 'verified-delivery') });
    const bus = new FakeLarkBus();
    const supervisor: DeploymentIdentity = {
      appId: 'cli_supervisor', name: 'codex-loopy', unionId: 'on_supervisor', peerScopedOpenId: 'ou_supervisor_seen_by_worker',
    };
    const worker: DeploymentIdentity = {
      appId: 'cli_worker', name: 'relay-loopy', unionId: 'on_worker_stable', peerScopedOpenId: 'ou_worker_seen_by_supervisor',
    };
    const upstreamTaskId = 'dual-dependency-upstream';
    const downstreamTaskId = 'dual-dependency-downstream';
    let now = 100;

    ledger.append({
      type: 'TaskDispatched', actor: 'orchestrator', taskId: upstreamTaskId, chatId: 'oc_dual_deploy', ts: now++,
      idempotencyKey: `dispatched:${upstreamTaskId}`,
      payload: {
        taskId: upstreamTaskId,
        title: '生成上游接口说明',
        workerOpenIds: [worker.peerScopedOpenId],
        workerNames: [worker.name],
        workerLarkAppIds: [worker.appId],
        workerCliIds: ['relay'],
        workerBotUnionIds: [worker.unionId],
        requiredRepo: repoRemote,
        acceptanceCriteria: {
          version: 1,
          artifacts: [{ path: upstreamOutput, checks: [{ type: 'exists' }, { type: 'contains', text: 'UPSTREAM_PASS' }] }],
        },
      },
    });
    const downstreamPlan: TaskPlannedPayload = {
      taskId: downstreamTaskId,
      chatId: 'oc_dual_deploy',
      title: '消费上游接口说明',
      dependsOnTaskIds: [upstreamTaskId],
      planGeneration: 1,
      dispatchSpec: {
        title: '消费上游接口说明',
        briefBase: '读取上游验收摘要，生成下游验证文件。',
        workers: [{
          openId: worker.peerScopedOpenId,
          name: worker.name,
          role: '执行者',
          larkAppId: worker.appId,
          cliId: 'relay',
          unionId: worker.unionId,
        }],
        senderLarkAppId: supervisor.appId,
        requiredRepo: repoRemote,
        acceptanceHint: '下游文件存在且包含 DOWNSTREAM_PASS',
        acceptanceCriteria: {
          version: 1,
          artifacts: [{ path: downstreamOutput, checks: [{ type: 'exists' }, { type: 'contains', text: 'DOWNSTREAM_PASS' }] }],
        },
      },
      plannedBy: supervisor.name,
    };
    ledger.append({
      type: 'TaskPlanned', actor: 'orchestrator', taskId: downstreamTaskId, chatId: 'oc_dual_deploy', ts: now++,
      idempotencyKey: `planned:${downstreamTaskId}`,
      payload: downstreamPlan,
    });

    const daemon = await import('../src/daemon.js');
    const upstreamDispatch = buildDispatchMessages({
      title: '生成上游接口说明',
      brief: '生成接口说明并提交结果。',
      bots: [{ openId: worker.peerScopedOpenId, name: worker.name, role: '执行者' }],
      repoRequirement: { taskId: upstreamTaskId, repo: repoRemote },
    });
    const inboundUpstreamDispatch = bus.deliver(supervisor, worker, upstreamDispatch.kickoffText);
    expect(await daemon.__testOnly_preflightDispatchRepo({
      parsed: inboundUpstreamDispatch,
      larkAppId: worker.appId,
      chatId: 'oc_dual_deploy',
      scope: 'chat',
      anchor: 'oc_dual_deploy',
    }, {
      scanDirs: [workerRepos],
      dataDir: workerData,
      sendAccessHelp: vi.fn(async () => { throw new Error('repo hit must not request help'); }),
    })).toEqual({ handled: false, workingDir: repoPath });

    const releasedDispatches: ReturnType<FakeLarkBus['deliver']>[] = [];
    const releaseDeps = {
      ledger,
      now: () => now++,
      releasedBy: supervisor.name,
      checkReadiness: vi.fn(async () => ({ ok: true, issues: [] })),
      send: vi.fn(async ({ text }: { text: string }) => {
        const delivered = bus.deliver(supervisor, worker, text);
        releasedDispatches.push(delivered);
        return delivered.messageId;
      }),
    };
    expect(await runGoalReleaseCheck({
      goalChatId: 'oc_dual_deploy', ownerLarkAppId: supervisor.appId, mode: 'trigger', deps: releaseDeps,
    })).toEqual([{ taskId: downstreamTaskId, outcome: 'not-ready' }]);
    expect(releasedDispatches).toHaveLength(0);

    writeFileSync(upstreamOutput, 'UPSTREAM_PASS\n');
    const inboundUpstreamReport = bus.deliver(worker, supervisor, buildReportText({
      orchOpenId: supervisor.peerScopedOpenId,
      content: formatReportEnvelope({
        taskId: upstreamTaskId,
        reportId: 'dual-upstream-report',
        summary: '上游接口说明已生成',
        evidence: [{ kind: 'inline', name: 'contract', text: 'UPSTREAM_PASS' }],
      }),
    }));
    const upstreamEnvelope = parseDeliveryEnvelope(inboundUpstreamReport.content);
    if (!upstreamEnvelope) throw new Error('expected upstream report envelope');
    expect(ingestParsedDeliveryEnvelope({
      envelope: upstreamEnvelope,
      ledger,
      goalChatId: 'oc_dual_deploy',
      senderOpenId: inboundUpstreamReport.senderId,
      senderUnionId: inboundUpstreamReport.senderUnionId,
      messageId: inboundUpstreamReport.messageId,
      now: now++,
    })).toMatchObject({ outcome: 'report', taskId: upstreamTaskId });

    expect(await runGoalReleaseCheck({
      goalChatId: 'oc_dual_deploy', ownerLarkAppId: supervisor.appId, mode: 'trigger', deps: releaseDeps,
    })).toEqual([{ taskId: downstreamTaskId, outcome: 'not-ready' }]);
    expect(releasedDispatches).toHaveLength(0);

    const acceptedUpstream = reconcileTaskByCriteria(ledger, upstreamTaskId, {
      checkedBy: supervisor.name,
      now: now++,
    });
    expect(acceptedUpstream.action).toBe('accepted');
    const released = await runGoalReleaseCheck({
      goalChatId: 'oc_dual_deploy', ownerLarkAppId: supervisor.appId, mode: 'trigger', deps: releaseDeps,
    });
    expect(released).toEqual([expect.objectContaining({ taskId: downstreamTaskId, outcome: 'dispatched' })]);
    expect(releasedDispatches).toHaveLength(1);
    expect(releasedDispatches[0]!.content).toContain('[botmux-dispatch v1]');
    expect(releasedDispatches[0]!.content).toContain('上游接口说明已生成');
    expect(releasedDispatches[0]!.content).not.toContain('UPSTREAM_PASS');

    expect(await daemon.__testOnly_preflightDispatchRepo({
      parsed: releasedDispatches[0]!,
      larkAppId: worker.appId,
      chatId: 'oc_dual_deploy',
      scope: 'chat',
      anchor: 'oc_dual_deploy',
    }, {
      scanDirs: [workerRepos],
      dataDir: workerData,
      sendAccessHelp: vi.fn(async () => { throw new Error('released repo hit must not request help'); }),
    })).toEqual({ handled: false, workingDir: repoPath });

    writeFileSync(downstreamOutput, 'DOWNSTREAM_PASS\n');
    const inboundDownstreamReport = bus.deliver(worker, supervisor, buildReportText({
      orchOpenId: supervisor.peerScopedOpenId,
      content: formatReportEnvelope({
        taskId: downstreamTaskId,
        reportId: 'dual-downstream-report',
        summary: '下游消费完成',
        evidence: [{ kind: 'inline', name: 'result', text: 'DOWNSTREAM_PASS' }],
      }),
    }));
    const downstreamEnvelope = parseDeliveryEnvelope(inboundDownstreamReport.content);
    if (!downstreamEnvelope) throw new Error('expected downstream report envelope');
    expect(ingestParsedDeliveryEnvelope({
      envelope: downstreamEnvelope,
      ledger,
      goalChatId: 'oc_dual_deploy',
      senderOpenId: inboundDownstreamReport.senderId,
      senderUnionId: inboundDownstreamReport.senderUnionId,
      messageId: inboundDownstreamReport.messageId,
      now: now++,
    })).toMatchObject({ outcome: 'report', taskId: downstreamTaskId });
    expect(reconcileTaskByCriteria(ledger, downstreamTaskId, {
      checkedBy: supervisor.name,
      now: now++,
    }).action).toBe('accepted');

    expect(ledger.read().map((event) => `${event.type}:${event.taskId}`)).toEqual([
      `TaskDispatched:${upstreamTaskId}`,
      `TaskPlanned:${downstreamTaskId}`,
      `TaskReported:${upstreamTaskId}`,
      `TaskAccepted:${upstreamTaskId}`,
      `TaskDispatchIntent:${downstreamTaskId}`,
      `TaskDispatched:${downstreamTaskId}`,
      `TaskReported:${downstreamTaskId}`,
      `TaskAccepted:${downstreamTaskId}`,
    ]);
    expect(ledger.task(downstreamTaskId)).toMatchObject({ status: 'accepted' });
    expect(ledger.task(downstreamTaskId)?.reports).toHaveLength(1);
  });

  it('routes repo hit → report → union_id-authorized ingestion → automatic acceptance', async () => {
    const supervisorData = tempRoot('supervisor');
    const workerData = tempRoot('worker');
    const workerRepos = tempRoot('worker-repos');
    const repoRemote = 'git@github.com:acme/dual-deploy.git';
    const repoPath = makeRepo(workerRepos, repoRemote);
    const outputPath = join(repoPath, 'a2a-result.txt');
    const ledger = openLedger({ baseDir: join(supervisorData, 'verified-delivery') });
    const bus = new FakeLarkBus();
    const supervisor: DeploymentIdentity = {
      appId: 'cli_supervisor', name: 'codex-loopy', unionId: 'on_supervisor', peerScopedOpenId: 'ou_supervisor_seen_by_worker',
    };
    const worker: DeploymentIdentity = {
      appId: 'cli_worker', name: 'relay-loopy', unionId: 'on_worker_stable', peerScopedOpenId: 'ou_worker_seen_by_supervisor',
    };
    const taskId = 'dual-repo-hit';

    ledger.append({
      type: 'TaskDispatched', actor: 'orchestrator', taskId, chatId: 'oc_dual_deploy', ts: 1,
      idempotencyKey: `dispatched:${taskId}`,
      payload: {
        taskId,
        title: '跨设备项目命中',
        workerOpenIds: ['ou_stale_app_scoped_id'],
        workerNames: [worker.name],
        workerLarkAppIds: [worker.appId],
        workerCliIds: ['relay'],
        workerBotUnionIds: [worker.unionId],
        requiredRepo: repoRemote,
        acceptanceCriteria: {
          version: 1,
          artifacts: [{ path: outputPath, checks: [{ type: 'exists' }, { type: 'contains', text: 'A2A_PASS' }] }],
        },
      },
    });

    const dispatch = buildDispatchMessages({
      title: '跨设备项目命中',
      brief: '在接收端项目中生成验证文件并提交结果。',
      bots: [{ openId: worker.peerScopedOpenId, name: worker.name, role: '执行者' }],
      repoRequirement: { taskId, repo: repoRemote },
    });
    const inboundDispatch = bus.deliver(supervisor, worker, dispatch.kickoffText);
    expect(inboundDispatch.content).toContain('[botmux-dispatch v1]');

    const daemon = await import('../src/daemon.js');
    const preflight = await daemon.__testOnly_preflightDispatchRepo({
      parsed: inboundDispatch,
      larkAppId: worker.appId,
      chatId: 'oc_dual_deploy',
      scope: 'chat',
      anchor: 'oc_dual_deploy',
    }, {
      scanDirs: [workerRepos],
      dataDir: workerData,
      sendAccessHelp: vi.fn(async () => { throw new Error('repo hit must not request help'); }),
    });
    expect(preflight).toEqual({ handled: false, workingDir: repoPath });

    writeFileSync(outputPath, 'A2A_PASS\n');
    const reportText = buildReportText({
      orchOpenId: supervisor.peerScopedOpenId,
      content: formatReportEnvelope({
        taskId,
        reportId: 'dual-report-1',
        summary: '远端项目验证完成',
        evidence: [{ kind: 'inline', name: 'result', text: 'A2A_PASS' }],
      }),
    });
    const inboundReport = bus.deliver(worker, supervisor, reportText);
    const reportEnvelope = parseDeliveryEnvelope(inboundReport.content);
    expect(reportEnvelope?.kind).toBe('report');
    if (!reportEnvelope) throw new Error('expected report envelope');

    const ingested = ingestParsedDeliveryEnvelope({
      envelope: reportEnvelope,
      ledger,
      goalChatId: 'oc_dual_deploy',
      senderOpenId: inboundReport.senderId,
      senderUnionId: inboundReport.senderUnionId,
      messageId: inboundReport.messageId,
      now: 2,
    });
    expect(ingested).toEqual({ outcome: 'report', taskId, reportId: 'dual-report-1', deduped: false });
    expect(ledger.task(taskId)?.status).toBe('reported');

    const verdict = reconcileTaskByCriteria(ledger, taskId, { checkedBy: supervisor.name, now: 3 });
    expect(verdict.action).toBe('accepted');
    expect(ledger.task(taskId)?.status).toBe('accepted');
    expect(ledger.read().map((event) => event.type)).toEqual(['TaskDispatched', 'TaskReported', 'TaskAccepted']);
    expect(ledger.task(taskId)?.reports[0]).toMatchObject({
      reportId: 'dual-report-1',
      verdict: 'accepted',
      checkedBy: supervisor.name,
    });
    expect(bus.messages.map((message) => message.rawText)).toEqual(expect.arrayContaining([
      expect.stringContaining('[botmux-dispatch v1]'),
      expect.stringContaining('[botmux-report v1]'),
    ]));
  });

  it('routes repo miss → structured help, short-circuits worker startup, and rejects an unassigned sender', async () => {
    const supervisorData = tempRoot('supervisor-miss');
    const workerData = tempRoot('worker-miss');
    const emptyScanRoot = tempRoot('worker-empty-repos');
    const ledger = openLedger({ baseDir: join(supervisorData, 'verified-delivery') });
    const bus = new FakeLarkBus();
    const supervisor: DeploymentIdentity = {
      appId: 'cli_supervisor', name: 'codex-loopy', unionId: 'on_supervisor', peerScopedOpenId: 'ou_supervisor_seen_by_worker',
    };
    const worker: DeploymentIdentity = {
      appId: 'cli_worker', name: 'seed-loopy', unionId: 'on_worker_stable', peerScopedOpenId: 'ou_worker_seen_by_supervisor',
    };
    const taskId = 'dual-repo-miss';
    const missingRepo = 'https://example.invalid/acme/not-installed.git';

    ledger.append({
      type: 'TaskDispatched', actor: 'orchestrator', taskId, chatId: 'oc_dual_deploy', ts: 10,
      idempotencyKey: `dispatched:${taskId}`,
      payload: {
        taskId,
        title: '跨设备项目缺失',
        workerOpenIds: ['ou_stale_app_scoped_id'],
        workerNames: [worker.name],
        workerLarkAppIds: [worker.appId],
        workerCliIds: ['seed'],
        workerBotUnionIds: [worker.unionId],
        requiredRepo: missingRepo,
      },
    });

    const dispatch = buildDispatchMessages({
      title: '跨设备项目缺失',
      brief: '验证缺少项目环境时快速求助。',
      bots: [{ openId: worker.peerScopedOpenId, name: worker.name, role: '执行者' }],
      repoRequirement: { taskId, repo: missingRepo },
    });
    const inboundDispatch = bus.deliver(supervisor, worker, dispatch.kickoffText);
    let inboundHelp: ReturnType<FakeLarkBus['deliver']> | undefined;

    const daemon = await import('../src/daemon.js');
    const preflight = await daemon.__testOnly_preflightDispatchRepo({
      parsed: inboundDispatch,
      larkAppId: worker.appId,
      chatId: 'oc_dual_deploy',
      scope: 'chat',
      anchor: 'oc_dual_deploy',
    }, {
      scanDirs: [emptyScanRoot],
      dataDir: workerData,
      sendAccessHelp: async (help) => {
        const blocker = help.blocker ?? buildMissingRepoBlocker(help.repo, help.detail);
        const text = buildReportText({
          orchOpenId: supervisor.peerScopedOpenId,
          content: formatHelpEnvelope({ taskId: help.taskId, helpKind: help.helpKind ?? 'access', blocker }),
        });
        inboundHelp = bus.deliver(worker, supervisor, text);
      },
    });
    expect(preflight).toEqual({ handled: true });
    expect(inboundHelp).toBeDefined();

    const helpEnvelope = parseDeliveryEnvelope(inboundHelp!.content);
    expect(helpEnvelope).toMatchObject({ kind: 'help', taskId, helpKind: 'access' });
    expect(helpEnvelope && 'blocker' in helpEnvelope ? helpEnvelope.blocker : '').toContain('缺少项目环境');
    if (!helpEnvelope) throw new Error('expected help envelope');
    const ingested = ingestParsedDeliveryEnvelope({
      envelope: helpEnvelope,
      ledger,
      goalChatId: 'oc_dual_deploy',
      senderOpenId: inboundHelp!.senderId,
      senderUnionId: inboundHelp!.senderUnionId,
      messageId: inboundHelp!.messageId,
      now: 11,
    });
    expect(ingested).toEqual({ outcome: 'help', taskId, deduped: false });
    expect(ledger.task(taskId)).toMatchObject({ status: 'blocked', help: { kind: 'access' } });
    expect(classifyTaskDisposition(ledger.task(taskId)!)).toMatchObject({
      bucket: 'blocked',
      reason: 'help:missing_repo',
    });

    const attackerEnvelope = parseDeliveryEnvelope(formatHelpEnvelope({
      taskId,
      helpKind: 'other',
      blocker: '伪造求助',
    }));
    if (!attackerEnvelope) throw new Error('expected attacker envelope');
    const unauthorized = ingestParsedDeliveryEnvelope({
      envelope: attackerEnvelope,
      ledger,
      goalChatId: 'oc_dual_deploy',
      senderOpenId: 'ou_attacker',
      senderUnionId: 'on_attacker',
      messageId: 'om_attacker',
      now: 12,
    });
    expect(unauthorized).toMatchObject({ outcome: 'unauthorized', taskId });
    expect(ledger.read().map((event) => event.type)).toEqual(['TaskDispatched', 'TaskHelpRequested']);
  });
});
