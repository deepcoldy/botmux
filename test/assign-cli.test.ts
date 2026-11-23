import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAssignArgs } from '../src/cli/assign-command.js';
import { createCliTopicDispatcher, runAssignCommand } from '../src/cli/assign-runner.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { taskRoutingDbPath } from '../src/services/task-routing-store.js';

describe('botmux assign CLI parser and runner', () => {
  const savedCfg = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  const tempDirs: string[] = [];

  function makeEnv(): { dataDir: string; cfgPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-assign-cli-'));
    tempDirs.push(dir);
    const cfgPath = join(dir, 'config.json');
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = cfgPath;
    invalidateGlobalConfigCache();
    return { dataDir: dir, cfgPath };
  }

  afterEach(() => {
    if (savedCfg === undefined) {
      delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    } else {
      process.env.BOTMUX_GLOBAL_CONFIG_FILE = savedCfg;
    }
    invalidateGlobalConfigCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses valid subcommands and rejects invalid flags cleanly', () => {
    const okRun = parseAssignArgs([
      'run', '--task', '修 bug', '--title', 'Bug修复', '--mode', 'topic',
      '--prefer', 'cli_a', '--exclude', 'cli_b', '--json',
    ]);
    expect(okRun.ok).toBe(true);
    if (okRun.ok) {
      expect(okRun.value).toMatchObject({
        subcommand: 'run',
        task: '修 bug',
        title: 'Bug修复',
        mode: 'topic',
        prefer: 'cli_a',
        exclude: ['cli_b'],
        json: true,
      });
    }

    expect(parseAssignArgs(['recommend']).ok).toBe(false);
    expect(parseAssignArgs(['run', '--task', 'a', '--mode', 'invalid']).ok).toBe(false);
    expect(parseAssignArgs(['recommend', '--task', 'a', '--working-dir', '/tmp']).ok).toBe(false);
    expect(parseAssignArgs(['unknown-sub']).ok).toBe(false);
  });

  it('refuses cleanly when taskRouting is disabled by default and never creates sqlite', async () => {
    const { dataDir } = makeEnv();
    const errs: string[] = [];
    const code = await runAssignCommand(['status'], {
      dataDir,
      stderr: line => errs.push(line),
      detectSandbox: () => ({ inSandbox: false }),
      detectLinuxAncestorSession: () => null,
      sessionTransport: {
        detectSessionId: () => null,
        resolveSessionAppId: async () => undefined,
        postSessionTaskRouting: async () => ({ status: 500, body: {} }),
      },
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('默认关闭');
    expect(existsSync(taskRoutingDbPath(dataDir))).toBe(false);
  });

  it('catches ancestor BotMux session even when BOTMUX_SESSION_ID is unset and routes through daemon authority gate', async () => {
    const { dataDir } = makeEnv();
    const ipcCalls: any[] = [];
    const errs: string[] = [];

    const code = await runAssignCommand(['run', '--task', '越权测试'], {
      dataDir,
      stderr: line => errs.push(line),
      detectSandbox: () => ({ inSandbox: false }),
      // Simulates an agent that unset BOTMUX_SESSION_ID in its subshell, caught via /proc ancestor walk.
      detectLinuxAncestorSession: () => ({ sessionId: 'sess_group_member', larkAppId: 'cli_bot1' }),
      sessionTransport: {
        detectSessionId: () => null,
        resolveSessionAppId: async () => 'cli_bot1',
        postSessionTaskRouting: async req => {
          ipcCalls.push(req);
          return {
            status: 403,
            body: { ok: false, error: 'assign_run_forbidden', detail: '普通群非 owner 禁止执行 assign run' },
          };
        },
      },
    });

    expect(code).toBe(1);
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].sessionId).toBe('sess_group_member');
    expect(errs.join('\n')).toContain('禁止执行 assign run');
  });

  it('runs session-scoped topic dispatch with fallback and reports settled attempts back to daemon', async () => {
    const { dataDir } = makeEnv();
    const outs: string[] = [];
    const settledBodies: Record<string, unknown>[] = [];
    const dispatchCalls: string[] = [];

    const code = await runAssignCommand(
      ['run', '--task', '补齐单测', '--mode', 'topic', '--json'],
      {
        dataDir,
        stdout: line => outs.push(line),
        detectSandbox: () => ({ inSandbox: false }),
        detectLinuxAncestorSession: () => null,
        sessionTransport: {
          detectSessionId: () => 'sess_owner_1',
          resolveSessionAppId: async () => 'cli_orch',
          postSessionTaskRouting: async req => {
            if (req.body.action === 'run') {
              return {
                status: 200,
                body: {
                  ok: true,
                  planned: true,
                  record: {
                    id: 'tr_topic_1',
                    createdAt: 1000,
                    updatedAt: 1000,
                    mode: 'topic',
                    taskSummary: '补齐单测',
                    callerKind: 'owner_turn',
                    constraints: {},
                    selectedAppId: 'cli_first',
                    selectedName: 'First',
                    matcherKind: 'rule',
                    confidence: 'medium',
                    reason: '经济优先',
                    candidates: [
                      { larkAppId: 'cli_first', name: 'First', cliId: 'claude-code', costTier: 'low', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
                      { larkAppId: 'cli_second', name: 'Second', cliId: 'claude-code', costTier: 'medium', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
                    ],
                    excluded: [],
                    attempts: [],
                    outcome: 'pending',
                  },
                  decision: {
                    selectedAppId: 'cli_first',
                    selectedName: 'First',
                    fallbackOrder: ['cli_first', 'cli_second'],
                    matcherKind: 'rule',
                    confidence: 'medium',
                    reason: '经济优先',
                    candidates: [
                      { larkAppId: 'cli_first', name: 'First', cliId: 'claude-code', costTier: 'low', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
                      { larkAppId: 'cli_second', name: 'Second', cliId: 'claude-code', costTier: 'medium', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
                    ],
                    excluded: [],
                  },
                  settlementToken: 'tok_test_1',
                },
              };
            }
            if (req.body.action === 'preflight-topic-candidate') {
              return { status: 200, body: { ok: true, allowed: true } };
            }
            settledBodies.push(req.body);
            return {
              status: 200,
              body: {
                ok: true,
                record: {
                  id: 'tr_topic_1',
                  createdAt: 1000,
                  updatedAt: 2000,
                  mode: 'topic',
                  taskSummary: '补齐单测',
                  callerKind: 'owner_turn',
                  constraints: {},
                  selectedAppId: req.body.selectedAppId,
                  selectedName: req.body.selectedName,
                  matcherKind: 'rule',
                  confidence: 'medium',
                  reason: '经济优先',
                  candidates: [],
                  excluded: [],
                  attempts: req.body.attempts,
                  outcome: req.body.outcome,
                  targetChatId: req.body.targetChatId,
                  targetRootMessageId: req.body.targetRootMessageId,
                },
              },
            };
          },
        },
        dispatchTopic: async input => {
          dispatchCalls.push(input.targetAppId);
          if (input.targetAppId === 'cli_first') {
            return { ok: false, retryable: true, error: 'target_not_in_chat' };
          }
          return { ok: true, chatId: 'oc_proj', rootMessageId: 'om_seed_2', threadId: 'omt_2' };
        },
      },
    );

    expect(code).toBe(0);
    expect(dispatchCalls).toEqual(['cli_first', 'cli_second']);
    expect(settledBodies).toHaveLength(1);
    expect(settledBodies[0]).toMatchObject({
      action: 'record-topic-attempt',
      recordId: 'tr_topic_1',
      settlementToken: 'tok_test_1',
      selectedAppId: 'cli_second',
      outcome: 'fallback_dispatched',
      targetChatId: 'oc_proj',
      targetRootMessageId: 'om_seed_2',
    });
    const outJson = JSON.parse(outs.join('\n'));
    expect(outJson.ok).toBe(true);
    expect(outJson.rootMessageId).toBe('om_seed_2');
  });

  it('blocks --session-id spoofing and prioritizes kernel ancestor session over tampered env', async () => {
    const { dataDir } = makeEnv();
    const errs: string[] = [];
    const ipcCalls: any[] = [];

    // 1. Passing --session-id pointing to another session while inside an ancestor session is rejected (exit 2).
    const spoofCode = await runAssignCommand(['run', '--task', '冒充owner', '--session-id', 'sess_owner'], {
      dataDir,
      stderr: line => errs.push(line),
      detectSandbox: () => ({ inSandbox: false }),
      detectLinuxAncestorSession: () => ({ sessionId: 'sess_guest', larkAppId: 'cli_guest_bot' }),
      sessionTransport: {
        detectSessionId: () => 'sess_owner',
        resolveSessionAppId: async () => 'cli_owner_bot',
        postSessionTaskRouting: async req => {
          ipcCalls.push(req);
          return { status: 200, body: { ok: true } };
        },
      },
    });
    expect(spoofCode).toBe(2);
    expect(ipcCalls).toHaveLength(0);
    expect(errs.join('\n')).toContain('禁止通过 --session-id 冒充');

    // 2. Without --session-id, tampered BOTMUX_SESSION_ID is ignored in favor of kernel ancestorCtx.
    const envSpoofCode = await runAssignCommand(['status'], {
      dataDir,
      stderr: () => {},
      detectSandbox: () => ({ inSandbox: false }),
      detectLinuxAncestorSession: () => ({ sessionId: 'sess_guest', larkAppId: 'cli_guest_bot' }),
      sessionTransport: {
        detectSessionId: () => 'sess_owner',
        resolveSessionAppId: async () => 'cli_owner_bot',
        postSessionTaskRouting: async req => {
          ipcCalls.push(req);
          return { status: 403, body: { ok: false, error: 'assign_run_forbidden' } };
        },
      },
    });
    expect(envSpoofCode).toBe(1);
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].sessionId).toBe('sess_guest');
    expect(ipcCalls[0].larkAppId).toBe('cli_guest_bot');
  });

  it('createCliTopicDispatcher fails closed on crash without JSON and preserves threadRootId on partial failure', async () => {
    const { dataDir } = makeEnv();

    // 1. Subprocess crashes non-zero without structured JSON -> retryable MUST be false.
    const crashEntry = join(dataDir, 'fake-cli-crash.mjs');
    writeFileSync(crashEntry, 'process.stderr.write("fatal: unexpected ECONNRESET\\n"); process.exit(1);\n');
    const crashDispatcher = createCliTopicDispatcher(crashEntry);
    const crashRes = await crashDispatcher({
      targetAppId: 'cli_first',
      title: 'T',
      task: 'task',
      sessionId: 'sess_1',
    });
    expect(crashRes.ok).toBe(false);
    if (!crashRes.ok) expect(crashRes.retryable).toBe(false);

    // 2. Subprocess returns structured failure WITH threadRootId -> retryable false AND preserves rootMessageId.
    const partialEntry = join(dataDir, 'fake-cli-partial.mjs');
    writeFileSync(
      partialEntry,
      'process.stdout.write(JSON.stringify({ success: false, chatId: "oc_g1", threadRootId: "om_orphan_99", detail: "ack timeout" }) + "\\n"); process.exit(1);\n',
    );
    const partialDispatcher = createCliTopicDispatcher(partialEntry);
    const partialRes = await partialDispatcher({
      targetAppId: 'cli_first',
      title: 'T',
      task: 'task',
      sessionId: 'sess_1',
    });
    expect(partialRes).toMatchObject({
      ok: false,
      retryable: false,
      chatId: 'oc_g1',
      rootMessageId: 'om_orphan_99',
    });

    // 3. Subprocess returns JSON without explicit transportState:'failed' -> retryable MUST be false.
    const unknownStateEntry = join(dataDir, 'fake-cli-unknown-state.mjs');
    writeFileSync(
      unknownStateEntry,
      'process.stdout.write(JSON.stringify({ success: false, detail: "ambiguous post error" }) + "\\n"); process.exit(1);\n',
    );
    const unknownStateRes = await createCliTopicDispatcher(unknownStateEntry)({
      targetAppId: 'cli_first',
      title: 'T',
      task: 'task',
      sessionId: 'sess_1',
    });
    expect(unknownStateRes).toMatchObject({ ok: false, retryable: false });

    // 4. Subprocess exits cleanly with transportState:'failed' and no threadRootId -> retryable true.
    const failedEntry = join(dataDir, 'fake-cli-failed.mjs');
    writeFileSync(
      failedEntry,
      'process.stderr.write(JSON.stringify({ success: false, transportState: "failed", detail: "target offline" }) + "\\n"); process.exit(1);\n',
    );
    const failedDispatcher = createCliTopicDispatcher(failedEntry);
    const failedRes = await failedDispatcher({
      targetAppId: 'cli_first',
      title: 'T',
      task: 'task',
      sessionId: 'sess_1',
    });
    expect(failedRes).toMatchObject({ ok: false, retryable: true });
  });

  it('aborts topic fallback on mid-flight preflight kill-switch and surfaces settlement failures instead of exit 0', async () => {
    const { dataDir } = makeEnv();
    const errs: string[] = [];
    const dispatchCalls: string[] = [];
    const settledBodies: Record<string, unknown>[] = [];

    const basePlan = {
      ok: true,
      planned: true,
      settlementToken: 'tok_abort',
      record: {
        id: 'tr_topic_abort',
        createdAt: 1000,
        updatedAt: 1000,
        mode: 'topic',
        taskSummary: '测试中途关闭',
        callerKind: 'owner_turn',
        constraints: {},
        selectedAppId: 'cli_first',
        selectedName: 'First',
        matcherKind: 'rule',
        confidence: 'medium',
        reason: 'rule',
        candidates: [
          { larkAppId: 'cli_first', name: 'First', cliId: 'claude-code', costTier: 'low', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
          { larkAppId: 'cli_second', name: 'Second', cliId: 'claude-code', costTier: 'high', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
        ],
        excluded: [],
        attempts: [],
        outcome: 'pending',
      },
      decision: {
        selectedAppId: 'cli_first',
        selectedName: 'First',
        fallbackOrder: ['cli_first', 'cli_second'],
        matcherKind: 'rule',
        confidence: 'medium',
        reason: 'rule',
        candidates: [
          { larkAppId: 'cli_first', name: 'First', cliId: 'claude-code', costTier: 'low', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
          { larkAppId: 'cli_second', name: 'Second', cliId: 'claude-code', costTier: 'high', participating: true, eligible: true, runtimeSummary: '在线 · 空闲', runtime: {} },
        ],
        excluded: [],
      },
    };

    // Case 1: preflight aborts before cli_second when global kill-switch is flipped.
    const abortCode = await runAssignCommand(['run', '--task', '测试中途关闭', '--mode', 'topic', '--json'], {
      dataDir,
      stdout: () => {},
      stderr: line => errs.push(line),
      detectSandbox: () => ({ inSandbox: false }),
      detectLinuxAncestorSession: () => null,
      sessionTransport: {
        detectSessionId: () => 'sess_owner_1',
        resolveSessionAppId: async () => 'cli_orch',
        postSessionTaskRouting: async req => {
          if (req.body.action === 'run') return { status: 200, body: basePlan };
          if (req.body.action === 'preflight-topic-candidate') {
            if (req.body.candidateAppId === 'cli_second') {
              return { status: 200, body: { ok: true, allowed: false, abortAll: true, reason: '任务分配已被全局关闭' } };
            }
            return { status: 200, body: { ok: true, allowed: true } };
          }
          settledBodies.push(req.body);
          return { status: 200, body: { ok: true, record: { ...basePlan.record, outcome: 'failed', attempts: req.body.attempts } } };
        },
      },
      dispatchTopic: async input => {
        dispatchCalls.push(input.targetAppId);
        return { ok: false, retryable: true, error: 'offline' };
      },
    });
    expect(abortCode).toBe(1);
    expect(dispatchCalls).toEqual(['cli_first']);
    expect(settledBodies[0]).toMatchObject({ action: 'record-topic-attempt', outcome: 'failed' });

    // Case 2: settlement returns 409 -> CLI surfaces warning and returns exit 1 (never silently exits 0).
    const warnErrs: string[] = [];
    const warnCode = await runAssignCommand(['run', '--task', '测试结算失败告警', '--mode', 'topic', '--json'], {
      dataDir,
      stdout: () => {},
      stderr: line => warnErrs.push(line),
      detectSandbox: () => ({ inSandbox: false }),
      detectLinuxAncestorSession: () => null,
      sessionTransport: {
        detectSessionId: () => 'sess_owner_1',
        resolveSessionAppId: async () => 'cli_orch',
        postSessionTaskRouting: async req => {
          if (req.body.action === 'run') return { status: 200, body: basePlan };
          if (req.body.action === 'preflight-topic-candidate') return { status: 200, body: { ok: true, allowed: true } };
          return { status: 409, body: { ok: false, error: 'routing_record_turn_mismatch' } };
        },
      },
      dispatchTopic: async () => ({ ok: true, chatId: 'oc_1', rootMessageId: 'om_1' }),
    });
    expect(warnCode).toBe(1);
    expect(warnErrs.join('\n')).toContain('结算回写失败');
  });
});
