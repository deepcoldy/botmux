/**
 * agent worker：一个 attempt 一个进程，由 runner 放进容器后才起 CLI（设计文档 §5.5、§6.3）。
 *
 * 握手顺序（都由 runner 驱动）：
 *   hello ──▶ 等 `contained`（10 秒等不到自行退出：runner 没能把我放进容器，我不能起 CLI）
 *   contained ──▶ 等 `open`：建 adapter + PtyBackend + PtyTurnRunner，open() → `ready {pid, cliPid}`
 *   ready ──▶ 等 `authorize {gen, attempt, outboxFile, prompt}`：只接受与登记一致的授权 → runTurn
 *   ──▶ `submitted`（尽力）──▶ `settled`
 *   任何时候 `cancel` 打断当前回合；`close` 或 IPC 断开 → 杀 CLI 退出。
 *
 * 这里不做任何 journal 写入、不知道 lease。所有权只在 runner；worker 只认授权里的 gen/attempt。
 */
import { mkdirSync } from 'node:fs';
import { PtyBackend } from '../adapters/backend/pty-backend.js';
import { createCliAdapter } from '../adapters/cli/registry.js';
import type { CliAdapter, CliId } from '../adapters/cli/types.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';
import { ensureClaudeFolderTrust } from '../utils/claude-folder-trust.js';
import { PtyOpenError, PtyTurnRunner, type PtyTurnOutcome } from './pty-turn-runner.js';
import {
  CONTAINED_HANDSHAKE_TIMEOUT_MS,
  FLOW_ATTEMPT_ENV_KEY,
  type AgentSettledFailure,
  type AgentSettledResult,
  type AgentToRunnerMessage,
  type AgentWorkerOpenInput,
  type Evidence,
  type RunnerToAgentMessage,
} from './types.js';

export interface AgentTransport {
  send(message: AgentToRunnerMessage): void;
  onMessage(handler: (message: RunnerToAgentMessage) => void): void;
  onDisconnect(handler: () => void): void;
}

export interface AgentWorkerDeps {
  createAdapter?: (cli: CliId, cliPath?: string) => Promise<CliAdapter>;
  createBackend?: () => PtyBackend;
  createRunner?: (adapter: CliAdapter, backend: PtyBackend, opts: ConstructorParameters<typeof PtyTurnRunner>[2]) => PtyTurnRunner;
  handshakeTimeoutMs?: number;
  /** 退出钩子（进程入口传 process.exit；测试传记录函数）。 */
  exit?: (code: number) => void;
}

export type AgentWorkerExit = 'handshake_timeout' | 'closed' | 'disconnected' | 'open_failed';

export function serveAgentWorker(transport: AgentTransport, deps: AgentWorkerDeps = {}): Promise<AgentWorkerExit> {
  const createAdapter = deps.createAdapter ?? ((cli, cliPath) => createCliAdapter(cli, cliPath));
  const createBackend = deps.createBackend ?? (() => new PtyBackend());
  const createRunner = deps.createRunner ?? ((adapter, backend, opts) => new PtyTurnRunner(adapter, backend, opts));
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? CONTAINED_HANDSHAKE_TIMEOUT_MS;

  let container: string | null = null;
  let input: AgentWorkerOpenInput | null = null;
  let runner: PtyTurnRunner | null = null;
  let activeTurn: string | null = null;
  let currentOutboxFile: string | null = null;
  let finished = false;

  return new Promise<AgentWorkerExit>((resolve) => {
    const finish = (how: AgentWorkerExit): void => {
      if (finished) return;
      finished = true;
      clearTimeout(handshakeTimer);
      runner?.close();
      resolve(how);
      deps.exit?.(how === 'closed' ? 0 : 1);
    };

    const handshakeTimer = setTimeout(() => {
      if (container === null) finish('handshake_timeout');
    }, handshakeTimeoutMs);

    const evidenceOf = (extra: Partial<Evidence>): Evidence => ({
      attemptDir: input?.attemptDir,
      ...extra,
    });

    const open = async (message: Extract<RunnerToAgentMessage, { t: 'open' }>): Promise<void> => {
      if (container === null) {
        transport.send({ t: 'open_failed', code: 'adapter_error', message: 'open before contained handshake', evidence: {} });
        return;
      }
      if (input) return;
      input = message.input;
      try {
        mkdirSync(input.attemptDir, { recursive: true });
        const adapter = await createAdapter(input.cli as CliId, input.cliPath);
        if (adapter.id === 'claude-code') ensureClaudeFolderTrust(input.cwd, adapter.claudeStateJsonPath);
        const env: Record<string, string> = { ...input.env, [FLOW_ATTEMPT_ENV_KEY]: `${input.runId}/${input.identity}/${input.gen}-${input.attempt}` };
        // 与 worker 的会话 spawn 同一条规则：Claude 家族在 root/sudo 下拒绝
        // --dangerously-skip-permissions 并立即退出（真 CLI 冒烟踩过：屏幕只有一行红字，
        // 归为 spawn_failed）。flow 同样没法交互审批，root 时走 IS_SANDBOX=1 逃生舱；
        // 已显式设置的不覆盖。
        if (adapter.claudeDataDir && process.getuid?.() === 0 && env.IS_SANDBOX === undefined) env.IS_SANDBOX = '1';
        // 所有可配置 env 合并完成之后注入并冻结 owner 身份；ownerless 时删除两个变量（CLAUDE.md）
        applySessionOwnerEnv(env, input.ownerOpenId);
        const backend = createBackend();
        runner = createRunner(adapter, backend, {
          sessionId: input.sessionId,
          stateDir: input.attemptDir,
          cwd: input.cwd,
          env,
          model: input.model,
          contractFileName: () => {
            if (!currentOutboxFile) throw new Error('contract file name is only known after authorize');
            return currentOutboxFile;
          },
          onSubmitted: () => {
            transport.send({ t: 'submitted', gen: input!.gen, attempt: input!.attempt });
          },
        });
        const opened = await runner.open();
        transport.send({ t: 'ready', pid: process.pid, cliPid: opened.cliPid });
      } catch (err) {
        if (err instanceof PtyOpenError) {
          transport.send({ t: 'open_failed', code: err.code, message: err.message, evidence: evidenceOf({ ...err.evidence, source: 'screen', confidence: 'low' }) });
        } else {
          transport.send({ t: 'open_failed', code: 'adapter_error', message: err instanceof Error ? err.message : String(err), evidence: evidenceOf({ source: 'none' }) });
        }
        finish('open_failed');
      }
    };

    const authorize = async (message: Extract<RunnerToAgentMessage, { t: 'authorize' }>): Promise<void> => {
      if (!runner || !input) return;
      if (message.gen !== input.gen || message.attempt !== input.attempt) {
        // 与登记不一致的授权：不是发给我的（旧代次 runner 或串号），拒绝执行
        transport.send({
          t: 'settled',
          gen: message.gen,
          attempt: message.attempt,
          outcome: { status: 'failed', code: 'cancelled', detail: `authorization for gen ${message.gen} attempt ${message.attempt} does not match registration gen ${input.gen} attempt ${input.attempt}`, evidence: evidenceOf({ source: 'none' }) },
        });
        return;
      }
      if (activeTurn) return;
      const turnId = `${message.gen}-${message.attempt}`;
      activeTurn = turnId;
      currentOutboxFile = message.outboxFile;
      let outcome: PtyTurnOutcome;
      try {
        outcome = await runner.runTurn({ turnId, prompt: message.prompt });
      } catch (err) {
        outcome = { status: 'failed', failure: { code: 'provider_exit', exitCode: null, signal: null, screenTail: err instanceof Error ? err.message : String(err) } };
      } finally {
        activeTurn = null;
      }
      transport.send({ t: 'settled', gen: message.gen, attempt: message.attempt, outcome: translate(outcome, evidenceOf) });
    };

    transport.onMessage((message) => {
      if (finished) return;
      switch (message.t) {
        case 'contained':
          if (container === null) {
            container = message.container;
            clearTimeout(handshakeTimer);
          }
          break;
        case 'open':
          void open(message);
          break;
        case 'authorize':
          void authorize(message);
          break;
        case 'cancel':
          if (runner && activeTurn) runner.cancel(activeTurn, 'operator');
          break;
        case 'close':
          transport.send({ t: 'closed' });
          finish('closed');
          break;
        default:
          break;
      }
    });
    transport.onDisconnect(() => finish('disconnected'));
    transport.send({ t: 'hello', pid: process.pid });
  });
}

function translate(outcome: PtyTurnOutcome, evidenceOf: (extra: Partial<Evidence>) => Evidence): AgentSettledResult | AgentSettledFailure {
  if (outcome.status === 'completed') {
    return {
      status: 'completed',
      finalResponse: outcome.finalResponse,
      evidence: evidenceOf({ source: outcome.settlement.source, confidence: outcome.settlement.confidence, screenTail: outcome.screenTail, reason: outcome.settlement.reason }),
    };
  }
  if (outcome.status === 'cancelled') {
    return { status: 'failed', code: 'cancelled', detail: `turn cancelled (${outcome.reason})`, evidence: evidenceOf({ source: 'screen', confidence: 'low', screenTail: outcome.screenTail }) };
  }
  const f = outcome.failure;
  switch (f.code) {
    case 'provider_exit':
      return { status: 'failed', code: 'provider_exit', detail: `CLI exited (code ${f.exitCode}, signal ${f.signal})`, evidence: evidenceOf({ source: 'screen', confidence: 'low', screenTail: f.screenTail, exitCode: f.exitCode, signal: f.signal }) };
    case 'submit_unconfirmed':
      return { status: 'failed', code: 'submit_unconfirmed', detail: f.detail, evidence: evidenceOf({ source: 'screen', confidence: 'low', screenTail: f.screenTail }) };
    case 'turn_busy':
      return { status: 'failed', code: 'turn_busy', detail: f.detail, evidence: evidenceOf({ source: 'none' }) };
    case 'cli_needs_setup':
      return { status: 'failed', code: 'cli_needs_setup', detail: f.detail, evidence: evidenceOf({ source: 'screen', confidence: 'low', screenTail: f.screenTail }) };
    default:
      return { status: 'failed', code: 'provider_exit', detail: 'unknown failure', evidence: evidenceOf({ source: 'none' }) };
  }
}
