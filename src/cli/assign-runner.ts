/**
 * `botmux assign` CLI 执行入口。
 *
 * 两条路径：
 * 1. 会话内调用（含 `--session-id`、环境变量 `BOTMUX_SESSION_ID`，以及防删 env 绕过的 Linux
 *    祖先进程探测）：一律走所属 daemon 的 `POST /api/sessions/:sessionId/task-routing`，
 *    由 daemon 执行与 `botmux dispatch` 同口径的 owner / 管家回合鉴权与宿主机落盘，
 *    沙箱会话同样可用。
 * 2. 本机终端直接调用（非沙箱、无 BotMux 会话祖先）：以 `callerKind='host_cli'` 直接执行。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolveCliSpawn } from '../core/self-spawn.js';
import {
  deriveTaskGroupTitle,
  type CandidateDispatchResult,
} from '../core/task-routing/executor.js';
import type {
  CandidateEvaluation,
  TaskRoutingAttempt,
  TaskRoutingDecision,
  TaskRoutingOutcome,
  TaskRoutingRecord,
} from '../core/task-routing/model.js';
import {
  TaskRoutingError,
  getTaskRoutingStatus,
  listTaskRoutingHistory,
  recommendBotForTask,
  runTaskRouting,
} from '../core/task-routing/service.js';
import { detectSandboxContext } from './sandbox-host-hint.js';
import { validateWorkingDir } from '../core/working-dir.js';
import { resolveBotmuxAncestorContext } from './current-actor.js';
import {
  ASSIGN_HELP_TEXT,
  formatAssignHistory,
  formatAssignRecommend,
  formatAssignRun,
  formatAssignStatus,
  parseAssignArgs,
  type ParsedAssignArgs,
} from './assign-command.js';

export interface SessionIpcTransport {
  /** Detect an active BotMux session id (from env / ancestor session markers). */
  detectSessionId: () => string | null;
  /** Resolve the larkAppId for a session id (returns undefined if unknown). */
  resolveSessionAppId: (sessionId: string) => Promise<string | undefined>;
  /** Post to `POST /api/sessions/:sessionId/task-routing` using host secret or rotating capability. */
  postSessionTaskRouting: (input: {
    sessionId: string;
    larkAppId: string;
    body: Record<string, unknown>;
  }) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface TopicDispatchExecutor {
  (input: {
    targetAppId: string;
    title: string;
    task: string;
    chatId?: string;
    sessionId: string;
  }): Promise<CandidateDispatchResult>;
}

export interface AssignCommandDeps {
  dataDir: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sessionTransport: SessionIpcTransport;
  dispatchTopic?: TopicDispatchExecutor;
  detectSandbox?: () => { inSandbox: boolean };
  detectLinuxAncestorSession?: () => { sessionId: string; larkAppId: string } | null;
}

function defaultDetectLinuxAncestorSession(): { sessionId: string; larkAppId: string } | null {
  try {
    const ctx = resolveBotmuxAncestorContext();
    return { sessionId: ctx.sessionId, larkAppId: ctx.larkAppId };
  } catch {
    return null;
  }
}

/**
 * Default `--mode topic` dispatcher: delegates directly to existing `botmux dispatch --bot-app <appId>`,
 * using `resolveCliSpawn` so it works in dev, dist, AND compiled standalone binary.
 */
export function createCliTopicDispatcher(cliEntryPath = process.argv[1] ?? ''): TopicDispatchExecutor {
  return async input => {
    const subArgs = [
      'dispatch',
      '--title', input.title,
      '--bot-app', input.targetAppId,
      '--brief', input.task,
      '--session-id', input.sessionId,
      ...(input.chatId ? ['--chat-id', input.chatId] : []),
    ];
    const { command, args } = resolveCliSpawn(cliEntryPath, subArgs);

    return new Promise<CandidateDispatchResult>(resolve => {
      const child = execFile(
        command,
        args,
        { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const rawOut = String(stdout ?? '').trim();
          const rawErr = String(stderr ?? '').trim();
          let parsed: Record<string, unknown> | null = null;
          for (const raw of [rawOut, rawErr]) {
            if (!raw) continue;
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const candidate = JSON.parse(lines[i]!);
                if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                  parsed = candidate as Record<string, unknown>;
                  break;
                }
              } catch { /* scan earlier lines */ }
            }
            if (parsed) break;
          }

          if (!err && parsed?.success === true) {
            resolve({
              ok: true,
              chatId: typeof parsed.chatId === 'string' ? parsed.chatId : input.chatId,
              rootMessageId: typeof parsed.threadRootId === 'string'
                ? parsed.threadRootId
                : typeof parsed.seedMessageId === 'string'
                  ? parsed.seedMessageId
                  : undefined,
              threadId: typeof parsed.threadId === 'string' ? parsed.threadId : null,
            });
            return;
          }

          const threadRootId = typeof parsed?.threadRootId === 'string'
            ? parsed.threadRootId
            : typeof parsed?.seedMessageId === 'string'
              ? parsed.seedMessageId
              : undefined;
          const transportState = typeof parsed?.transportState === 'string' ? parsed.transportState : undefined;
          const detail = typeof parsed?.detail === 'string'
            ? parsed.detail
            : typeof parsed?.errorCode === 'string'
              ? parsed.errorCode
              : rawErr.split('\n').slice(-2).join(' ') || err?.message || 'dispatch 失败';

          // Fail-closed: ONLY safe to fall back when dispatch exited normally (not killed/signaled)
          // with structured JSON explicitly proving nothing was posted (`transportState === 'failed'`
          // and no `threadRootId`). Crashes, timeouts, or missing JSON are treated as ambiguous.
          const execErr = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
          const retryable = Boolean(
            parsed
            && !execErr?.killed
            && !execErr?.signal
            && !threadRootId
            && transportState === 'failed',
          );
          resolve({
            ok: false,
            retryable,
            error: detail,
            ...(typeof parsed?.chatId === 'string' ? { chatId: parsed.chatId } : {}),
            ...(threadRootId ? { rootMessageId: threadRootId } : {}),
          });
        },
      );
      child.stdin?.end();
    });
  };
}

function loadTaskText(parsed: ParsedAssignArgs): { ok: true; text: string } | { ok: false; error: string } {
  if (parsed.taskFile) {
    if (!existsSync(parsed.taskFile)) {
      return { ok: false, error: `任务文件不存在：${parsed.taskFile}` };
    }
    try {
      const content = readFileSync(parsed.taskFile, 'utf8').trim();
      if (!content) return { ok: false, error: `任务文件为空：${parsed.taskFile}` };
      return { ok: true, text: content };
    } catch (err) {
      return { ok: false, error: `读取任务文件失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const text = parsed.task?.trim() ?? '';
  if (!text) return { ok: false, error: '任务描述不能为空' };
  return { ok: true, text };
}

export async function runAssignCommand(argv: readonly string[], deps: AssignCommandDeps): Promise<number> {
  const out = deps.stdout ?? (text => process.stdout.write(`${text}\n`));
  const errOut = deps.stderr ?? (text => process.stderr.write(`${text}\n`));

  const parsedRes = parseAssignArgs(argv);
  if (!parsedRes.ok) {
    errOut(`botmux assign: ${parsedRes.error}`);
    errOut('运行 `botmux assign --help` 查看用法。');
    return 2;
  }
  const args = parsedRes.value;
  if (args.help) {
    out(ASSIGN_HELP_TEXT.trimEnd());
    return 0;
  }

  let taskText = '';
  if (args.subcommand === 'recommend' || args.subcommand === 'run') {
    const loaded = loadTaskText(args);
    if (!loaded.ok) {
      errOut(`botmux assign: ${loaded.error}`);
      return 2;
    }
    taskText = loaded.text;
  }

  if (args.subcommand === 'run' && args.workingDir) {
    const v = validateWorkingDir(args.workingDir);
    if (!v.ok) {
      errOut(`botmux assign: --working-dir ${v.error}`);
      return 2;
    }
  }

  // Kernel `/proc` ancestor session is highest authority so a session cannot pass
  // `--session-id <other>` or mutate `BOTMUX_SESSION_ID` to impersonate an owner/steward session.
  const ancestorCtx = (deps.detectLinuxAncestorSession ?? defaultDetectLinuxAncestorSession)();
  const envSessionId = deps.sessionTransport.detectSessionId();
  if (ancestorCtx && args.sessionId && args.sessionId !== ancestorCtx.sessionId) {
    errOut(`botmux assign: 会话内禁止通过 --session-id 冒充其他会话（当前会话 ${ancestorCtx.sessionId}）`);
    return 2;
  }
  if (!ancestorCtx && envSessionId && args.sessionId && args.sessionId !== envSessionId) {
    errOut(`botmux assign: 会话内禁止通过 --session-id 冒充其他会话（当前会话 ${envSessionId}）`);
    return 2;
  }
  const detectedSessionId = ancestorCtx?.sessionId
    ?? envSessionId
    ?? args.sessionId
    ?? null;

  const inSandbox = (deps.detectSandbox ?? detectSandboxContext)().inSandbox;

  // ── Path A: Session-scoped execution via daemon IPC ──
  if (detectedSessionId) {
    const larkAppId = ancestorCtx
      ? ancestorCtx.larkAppId
      : await deps.sessionTransport.resolveSessionAppId(detectedSessionId);
    if (!larkAppId) {
      errOut(`botmux assign: 未找到会话 ${detectedSessionId} 对应的 Bot`);
      return 1;
    }

    const body: Record<string, unknown> = {
      action: args.subcommand,
      ...(taskText ? { task: taskText } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.subcommand === 'run' ? { mode: args.mode } : {}),
      ...(args.chatId ? { chatId: args.chatId } : {}),
      ...(args.workingDir ? { workingDir: args.workingDir } : {}),
      ...(args.prefer ? { prefer: args.prefer } : {}),
      ...(args.only.length ? { only: args.only } : {}),
      ...(args.exclude.length ? { exclude: args.exclude } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.noLlm ? { noLlm: true } : {}),
      ...(args.subcommand === 'history' ? { limit: args.limit, ...(args.botFilter ? { botRef: args.botFilter } : {}) } : {}),
    };

    let resp: { status: number; body: Record<string, unknown> };
    try {
      resp = await deps.sessionTransport.postSessionTaskRouting({
        sessionId: detectedSessionId,
        larkAppId,
        body,
      });
    } catch (err) {
      errOut(`botmux assign ${args.subcommand} 失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    if (resp.status < 200 || resp.status >= 300 || resp.body.ok !== true) {
      // Group run returns HTTP 200 with ok:false when all candidates failed cleanly.
      if (args.subcommand === 'run' && resp.body.record) {
        const record = resp.body.record as TaskRoutingRecord;
        const result = {
          ok: false,
          record,
          chatId: typeof resp.body.chatId === 'string' ? resp.body.chatId : undefined,
          error: typeof resp.body.error === 'string' ? resp.body.error : record.error,
        };
        out(args.json ? JSON.stringify(result, null, 2) : formatAssignRun(result));
        return 1;
      }
      const msg = String(resp.body.detail ?? resp.body.error ?? `HTTP ${resp.status}`);
      errOut(`botmux assign ${args.subcommand} 失败：${msg}`);
      return 1;
    }

    if (args.subcommand === 'status') {
      const payload = {
        enabled: resp.body.enabled === true,
        matcherMode: String(resp.body.matcherMode ?? 'rule'),
        ...(typeof resp.body.matcherBotAppId === 'string' ? { matcherBotAppId: resp.body.matcherBotAppId } : {}),
        ...(typeof resp.body.policy === 'string' ? { policy: resp.body.policy } : {}),
        eligible: (resp.body.eligible ?? []) as CandidateEvaluation[],
        excluded: (resp.body.excluded ?? []) as CandidateEvaluation[],
      };
      out(args.json ? JSON.stringify(payload, null, 2) : formatAssignStatus(payload));
      return 0;
    }

    if (args.subcommand === 'recommend') {
      const decision = resp.body.decision as TaskRoutingDecision;
      out(args.json ? JSON.stringify(decision, null, 2) : formatAssignRecommend(decision));
      return decision.selectedAppId ? 0 : 1;
    }

    if (args.subcommand === 'history') {
      const records = (resp.body.records ?? []) as TaskRoutingRecord[];
      out(args.json ? JSON.stringify({ records }, null, 2) : formatAssignHistory(records));
      return 0;
    }

    // args.subcommand === 'run'
    if (args.mode === 'topic' && resp.body.planned === true) {
      const record = resp.body.record as TaskRoutingRecord;
      const decision = resp.body.decision as TaskRoutingDecision;
      const settlementToken = typeof resp.body.settlementToken === 'string'
        ? resp.body.settlementToken
        : undefined;
      if (decision.fallbackOrder.length === 0) {
        const result = { ok: false, record, error: decision.reason };
        out(args.json ? JSON.stringify(result, null, 2) : formatAssignRun(result));
        return 1;
      }

      const topicExec = deps.dispatchTopic ?? createCliTopicDispatcher();
      const title = deriveTaskGroupTitle(args.title, taskText);
      const nameByApp = new Map(decision.candidates.map(c => [c.larkAppId, c.name]));
      const attempts: TaskRoutingAttempt[] = [];
      let finalRecord = record;
      let finalOk = false;
      let finalChatId: string | undefined;
      let finalRootId: string | undefined;
      let finalSelectedAppId: string | undefined;
      let finalSelectedName: string | undefined;
      let finalError = '所有候选 Bot 均派发失败';
      let settlementWarning: string | undefined;

      for (let i = 0; i < decision.fallbackOrder.length; i++) {
        const appId = decision.fallbackOrder[i]!;
        const name = nameByApp.get(appId) ?? appId;

        // Live preflight via daemon before each candidate: respects mid-flight global kill-switch & bot opt-out.
        let preflightResp: { status: number; body: Record<string, unknown> } | null = null;
        try {
          preflightResp = await deps.sessionTransport.postSessionTaskRouting({
            sessionId: detectedSessionId,
            larkAppId,
            body: {
              action: 'preflight-topic-candidate',
              recordId: record.id,
              candidateAppId: appId,
              ...(settlementToken ? { settlementToken } : {}),
            },
          });
        } catch (err) {
          finalError = `派发前复检通信失败：${err instanceof Error ? err.message : String(err)}`;
          attempts.push({ appId, name, outcome: 'skipped', reason: finalError, at: Date.now() });
          break;
        }
        if (preflightResp.status < 200 || preflightResp.status >= 300 || preflightResp.body.ok !== true) {
          const reason = String(preflightResp.body.detail ?? preflightResp.body.error ?? `HTTP ${preflightResp.status}`);
          finalError = `派发前复检被拒绝：${reason}`;
          attempts.push({ appId, name, outcome: 'skipped', reason: finalError, at: Date.now() });
          break;
        }
        if (preflightResp.body.allowed === false) {
          const skipReason = typeof preflightResp.body.reason === 'string'
            ? preflightResp.body.reason
            : '派发前实时状态不可用';
          attempts.push({ appId, name, outcome: 'skipped', reason: skipReason, at: Date.now() });
          finalError = preflightResp.body.abortAll === true ? skipReason : `${name}：${skipReason}`;
          if (preflightResp.body.abortAll === true) break;
          continue;
        }

        let r: CandidateDispatchResult;
        try {
          r = await topicExec({
            targetAppId: appId,
            title,
            task: taskText,
            chatId: args.chatId,
            sessionId: detectedSessionId,
          });
        } catch (err) {
          r = {
            ok: false,
            retryable: false,
            error: `子话题派发异常：${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (r.ok) {
          attempts.push({
            appId,
            name,
            outcome: 'dispatched',
            reason: i === 0 ? '首选命中并成功派发子话题' : `前面 ${i} 个候选失败，兜底改派子话题成功`,
            at: Date.now(),
            ...(r.chatId ? { chatId: r.chatId } : {}),
            ...(r.rootMessageId ? { rootMessageId: r.rootMessageId } : {}),
          });
          const outcome: TaskRoutingOutcome = i === 0 ? 'dispatched' : 'fallback_dispatched';
          const settled = await deps.sessionTransport.postSessionTaskRouting({
            sessionId: detectedSessionId,
            larkAppId,
            body: {
              action: 'record-topic-attempt',
              recordId: record.id,
              ...(settlementToken ? { settlementToken } : {}),
              selectedAppId: appId,
              selectedName: name,
              attempts,
              outcome,
              targetChatId: r.chatId ?? null,
              targetRootMessageId: r.rootMessageId ?? null,
              error: null,
            },
          }).catch(err => ({
            status: 0,
            body: { ok: false, error: err instanceof Error ? err.message : String(err) } as Record<string, unknown>,
          }));
          if (settled.status >= 200 && settled.status < 300 && settled.body.ok === true && settled.body.record) {
            finalRecord = settled.body.record as TaskRoutingRecord;
          } else {
            const settleErr = String(settled.body.detail ?? settled.body.error ?? `HTTP ${settled.status}`);
            settlementWarning = `子话题已派发，但分配记录 ${record.id} 结算回写失败（${settleErr}）`;
            errOut(`botmux assign: 警告：${settlementWarning}`);
            finalRecord = {
              ...record,
              selectedAppId: appId,
              selectedName: name,
              attempts,
              outcome,
              ...(r.chatId ? { targetChatId: r.chatId } : {}),
              ...(r.rootMessageId ? { targetRootMessageId: r.rootMessageId } : {}),
            };
          }
          finalOk = true;
          finalChatId = r.chatId;
          finalRootId = r.rootMessageId;
          break;
        }

        attempts.push({
          appId,
          name,
          outcome: 'failed',
          reason: r.error,
          at: Date.now(),
          ...(r.chatId ? { chatId: r.chatId } : {}),
          ...(r.rootMessageId ? { rootMessageId: r.rootMessageId } : {}),
        });
        finalError = `${name}：${r.error}`;
        if (!r.retryable) {
          finalSelectedAppId = appId;
          finalSelectedName = name;
          finalChatId = r.chatId;
          finalRootId = r.rootMessageId;
          break;
        }
      }

      if (!finalOk) {
        const settled = await deps.sessionTransport.postSessionTaskRouting({
          sessionId: detectedSessionId,
          larkAppId,
          body: {
            action: 'record-topic-attempt',
            recordId: record.id,
            ...(settlementToken ? { settlementToken } : {}),
            ...(finalSelectedAppId ? { selectedAppId: finalSelectedAppId, selectedName: finalSelectedName } : {}),
            attempts,
            outcome: 'failed',
            ...(finalChatId ? { targetChatId: finalChatId } : {}),
            ...(finalRootId ? { targetRootMessageId: finalRootId } : {}),
            error: finalError,
          },
        }).catch(err => ({
          status: 0,
          body: { ok: false, error: err instanceof Error ? err.message : String(err) } as Record<string, unknown>,
        }));
        if (settled.status >= 200 && settled.status < 300 && settled.body.ok === true && settled.body.record) {
          finalRecord = settled.body.record as TaskRoutingRecord;
        } else {
          const settleErr = String(settled.body.detail ?? settled.body.error ?? `HTTP ${settled.status}`);
          settlementWarning = `分配记录 ${record.id} 失败结算回写失败（${settleErr}）`;
          errOut(`botmux assign: 警告：${settlementWarning}`);
          finalRecord = {
            ...record,
            ...(finalSelectedAppId ? { selectedAppId: finalSelectedAppId, selectedName: finalSelectedName } : {}),
            attempts,
            outcome: 'failed',
            ...(finalChatId ? { targetChatId: finalChatId } : {}),
            ...(finalRootId ? { targetRootMessageId: finalRootId } : {}),
            error: finalError,
          };
        }
      }

      const result = {
        ok: finalOk,
        record: finalRecord,
        ...(finalChatId ? { chatId: finalChatId } : {}),
        ...(finalRootId ? { rootMessageId: finalRootId } : {}),
        ...(!finalOk ? { error: finalError } : {}),
        ...(settlementWarning ? { settlementWarning } : {}),
      };
      out(args.json ? JSON.stringify(result, null, 2) : formatAssignRun(result));
      return finalOk && !settlementWarning ? 0 : 1;
    }

    const groupResult = {
      ok: resp.body.ok === true,
      record: resp.body.record as TaskRoutingRecord,
      chatId: typeof resp.body.chatId === 'string' ? resp.body.chatId : undefined,
      sessionId: typeof resp.body.sessionId === 'string' ? resp.body.sessionId : undefined,
      shareLink: typeof resp.body.shareLink === 'string' ? resp.body.shareLink : null,
      error: typeof resp.body.error === 'string' ? resp.body.error : undefined,
    };
    out(args.json ? JSON.stringify(groupResult, null, 2) : formatAssignRun(groupResult));
    return groupResult.ok ? 0 : 1;
  }

  // ── Path B: Direct Host CLI execution ──
  if (inSandbox) {
    errOut('botmux assign: 沙箱内未识别到所属会话，不能以宿主机身份直接运行。');
    return 1;
  }

  if (args.subcommand === 'run' && args.mode === 'topic') {
    errOut('botmux assign run --mode topic 需要在已有会话内运行或提供 --session-id <id>；直接本机派发请用默认的 --mode group。');
    return 2;
  }

  try {
    if (args.subcommand === 'status') {
      const status = await getTaskRoutingStatus({ dataDir: deps.dataDir });
      out(args.json ? JSON.stringify(status, null, 2) : formatAssignStatus(status));
      return 0;
    }
    if (args.subcommand === 'history') {
      const records = await listTaskRoutingHistory(
        { limit: args.limit, botRef: args.botFilter },
        { dataDir: deps.dataDir },
      );
      out(args.json ? JSON.stringify({ records }, null, 2) : formatAssignHistory(records));
      return 0;
    }
    if (args.subcommand === 'recommend') {
      const { decision } = await recommendBotForTask(
        {
          task: taskText,
          constraints: {
            prefer: args.prefer,
            only: args.only,
            exclude: args.exclude,
          },
          noLlm: args.noLlm,
        },
        { dataDir: deps.dataDir },
      );
      out(args.json ? JSON.stringify(decision, null, 2) : formatAssignRecommend(decision));
      return decision.selectedAppId ? 0 : 1;
    }

    const result = await runTaskRouting(
      {
        mode: 'group',
        task: taskText,
        title: args.title,
        workingDir: args.workingDir,
        constraints: {
          prefer: args.prefer,
          only: args.only,
          exclude: args.exclude,
          workingDir: args.workingDir,
        },
        noLlm: args.noLlm,
        callerReason: args.reason,
        callerKind: 'host_cli',
      },
      { dataDir: deps.dataDir },
    );
    out(args.json ? JSON.stringify(result, null, 2) : formatAssignRun(result));
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof TaskRoutingError) {
      errOut(`botmux assign ${args.subcommand} 失败：${err.message}`);
      return err.status === 400 ? 2 : 1;
    }
    errOut(`botmux assign ${args.subcommand} 失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
