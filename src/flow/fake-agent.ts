/**
 * 测试专用的假 agent（`BOTMUX_FLOW_FAKE_AGENT`）：不起真实 CLI，但走完 worker 的全部握手与
 * 契约文件路径。进程级故障注入测试靠它在真实的 runner / script host / worker 三进程拓扑与
 * 真实 cgroup 下跑，而不依赖任何 CLI 登录态。
 *
 *   BOTMUX_FLOW_FAKE_AGENT=echo        回复 `echo:<prompt 首行>`（写契约文件）
 *   BOTMUX_FLOW_FAKE_AGENT=json        回复一个匹配常见 schema 的 JSON：{"slogan":"<prompt 首行>"}
 *   BOTMUX_FLOW_FAKE_AGENT=hang        提交后永不结算（配合 kill -9 与超时用例）
 *   BOTMUX_FLOW_FAKE_AGENT=open-fail   open() 失败（spawn_failed）
 *   BOTMUX_FLOW_FAKE_AGENT=setup       open() 失败（cli_needs_setup）
 *   BOTMUX_FLOW_FAKE_AGENT=exit        提交后 CLI「退出」（provider_exit）
 *   BOTMUX_FLOW_FAKE_AGENT=slow:<ms>   提交后等 ms 再结算
 *   BOTMUX_FLOW_FAKE_AGENT=slow-if:<substr>:<ms>   prompt 首行含 substr 时才等 ms（制造确定的完成顺序）
 *   BOTMUX_FLOW_FAKE_AGENT=big:<n>     回复 n 个 'x'（验证大结果落盘）
 *
 * 另外 `BOTMUX_FLOW_FAKE_AGENT_SPAWN=1` 让假 worker 额外起一个 `sleep` 子进程留在容器里，
 * 用来验证回收确实杀干净了后代。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PtyBackend } from '../adapters/backend/pty-backend.js';
import type { CliAdapter } from '../adapters/cli/types.js';
import { PtyOpenError, type PtyTurnInput, type PtyTurnOutcome, type PtyTurnRunner, type PtyTurnRunnerOptions } from './pty-turn-runner.js';
import type { AgentWorkerDeps } from './agent-worker.js';

export function fakeAgentDeps(mode: string): AgentWorkerDeps {
  return {
    createAdapter: async (cli) => ({ id: cli } as unknown as CliAdapter),
    createBackend: () => ({ kill() {}, write() {} }) as unknown as PtyBackend,
    createRunner: (_adapter, _backend, opts) => new FakePtyTurnRunner(mode, opts) as unknown as PtyTurnRunner,
  };
}

class FakePtyTurnRunner {
  private cancelled: string | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private lastPromptLine = '';

  constructor(private readonly mode: string, private readonly opts: PtyTurnRunnerOptions) {}

  async open(): Promise<{ projectionRef: string; cliPid: number | null }> {
    if (this.mode === 'open-fail') throw new PtyOpenError('spawn_failed', 'fake: cli binary not found', { screenTail: 'execvp(3) failed.: No such file or directory' });
    if (this.mode === 'setup') throw new PtyOpenError('cli_needs_setup', 'fake: login wizard', { screenTail: 'Please sign in to continue' });
    if (process.env.BOTMUX_FLOW_FAKE_AGENT_SPAWN === '1') {
      // 留一个后代在容器里（它继承本进程的 cgroup）
      this.child = spawn('sleep', ['300'], { stdio: 'ignore', env: this.opts.env });
      this.child.unref();
    }
    writeFileSync(join(this.opts.stateDir, 'pty.log'), `fake agent ${this.mode}\n`);
    return { projectionRef: join(this.opts.stateDir, 'pty.log'), cliPid: this.child?.pid ?? null };
  }

  contractPathFor(turnId: string): string {
    return join(this.opts.stateDir, this.opts.contractFileName?.(turnId) ?? `turn-${turnId}.response.md`);
  }

  async runTurn(input: PtyTurnInput): Promise<PtyTurnOutcome> {
    this.opts.onSubmitted?.(input.turnId, false);
    const firstLine = input.prompt.split('\n')[0] ?? '';
    const settle = (finalResponse: string): PtyTurnOutcome => {
      writeFileSync(this.contractPathFor(input.turnId), finalResponse);
      return { status: 'completed', finalResponse, settlement: { source: 'contract_file', confidence: 'high', idleSource: 'screen' }, screenTail: `> ${firstLine}\n${finalResponse}` };
    };
    if (this.mode === 'hang') {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (this.cancelled) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      return { status: 'cancelled', reason: 'operator', screenTail: 'hung' };
    }
    if (this.mode === 'exit') return { status: 'failed', failure: { code: 'provider_exit', exitCode: 1, signal: null, screenTail: 'fake CLI crashed' } };
    const sleepUnlessCancelled = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (this.cancelled) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return !!this.cancelled;
    };
    if (this.mode.startsWith('slow:')) {
      if (await sleepUnlessCancelled(Number(this.mode.slice(5)))) return { status: 'cancelled', reason: 'operator', screenTail: 'cancelled while slow' };
    }
    if (this.mode.startsWith('slow-if:')) {
      const [, substr, msText] = this.mode.split(':');
      if (substr && firstLine.includes(substr) && (await sleepUnlessCancelled(Number(msText)))) {
        return { status: 'cancelled', reason: 'operator', screenTail: 'cancelled while slow' };
      }
    }
    if (this.mode.startsWith('big:')) return settle('x'.repeat(Number(this.mode.slice(4))));
    if (this.mode === 'json') {
      // repair 用例：prompt 里含 “repair-me” 时第一次故意回非 JSON；repair 轮回答的是原 prompt 的首行
      const isRepair = input.prompt.includes('did not satisfy');
      if (!isRepair) this.lastPromptLine = firstLine;
      if (firstLine.includes('repair-me') && !isRepair) return settle('not json at all');
      return settle(`Sure! Here it is:\n{"slogan": ${JSON.stringify(this.lastPromptLine)}}`);
    }
    return settle(`echo:${firstLine}`);
  }

  cancel(_turnId: string, reason: string): boolean {
    this.cancelled = reason;
    return true;
  }

  close(): void {
    this.cancelled = 'closed';
  }

  async screenTail(): Promise<string> {
    return '';
  }
}
