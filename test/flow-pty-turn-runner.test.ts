import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOutputContract } from '../src/flow/output-contract.js';
import { PtyOpenError, PtyTurnRunner } from '../src/flow/pty-turn-runner.js';
import type { SessionBackend, SpawnOpts } from '../src/adapters/backend/types.js';
import type { CliAdapter, PtyHandle } from '../src/adapters/cli/types.js';

/** 假 CLI 的「回合完成」标记；命中 completionPattern 后 IdleDetector 500ms 内判 idle。 */
const DONE = '⏺ turn-done';

class FakeBackend implements SessionBackend {
  spawned: { bin: string; args: string[]; opts: SpawnOpts } | null = null;
  written: string[] = [];
  killed = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.spawned = { bin, args, opts };
  }
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  resize(): void {}
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
  }
  getChildPid(): number | null {
    return 4242;
  }

  emit(data: string): void {
    this.dataCb?.(data);
  }
  exit(code: number | null, signal: string | null = null): void {
    this.exitCb?.(code, signal);
  }
  get allWritten(): string {
    return this.written.join('');
  }
}

function fakeAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    id: 'fake-cli',
    resolvedBin: '/opt/fake/bin/fake-cli',
    buildArgs({ sessionId, resume, resumeSessionId, disableCliBypass }) {
      const args = resume ? ['--resume', resumeSessionId ?? sessionId] : ['--new', sessionId];
      if (!disableCliBypass) args.push('--yolo');
      return args;
    },
    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content);
      pty.write('\r');
    },
    completionPattern: /⏺ turn-done/,
    systemHints: [],
    altScreen: false,
    ...overrides,
  };
}

const FAST = {
  contractGraceMs: 400,
  contractPollMs: 25,
  readyTimeoutMs: 5_000,
  readyConfirmMs: 100,
  busyProbeMs: 50,
};

const CLEAR_SCREEN = '\x1b[2J\x1b[H';

/** Resolves to 'pending' if the promise has not settled within `ms`. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

describe('PtyTurnRunner', () => {
  let stateDir: string;
  let backend: FakeBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'flow-pty-runner-'));
    backend = new FakeBackend();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeRunner(adapter = fakeAdapter(), extra: Partial<ConstructorParameters<typeof PtyTurnRunner>[2]> = {}) {
    return new PtyTurnRunner(adapter, backend, {
      sessionId: 'sess-1',
      stateDir,
      cwd: stateDir,
      env: { PATH: '/usr/bin' },
      ...FAST,
      ...extra,
    });
  }

  async function openReady(runner: PtyTurnRunner): Promise<void> {
    const opening = runner.open();
    backend.emit('Welcome to fake-cli\r\n');
    backend.emit(`${DONE}\r\n❯ `);
    await opening;
  }

  it('opens the CLI through the adapter, waits for the first idle and records the pty log', async () => {
    const runner = makeRunner();
    const opening = runner.open();
    expect(backend.spawned?.bin).toBe('/opt/fake/bin/fake-cli');
    expect(backend.spawned?.args).toEqual(['--new', 'sess-1', '--yolo']);
    expect(backend.spawned?.opts.cwd).toBe(stateDir);

    backend.emit('Welcome to fake-cli\r\n');
    backend.emit(`${DONE}\r\n❯ `);
    const opened = await opening;

    expect(opened.projectionRef).toBe(join(stateDir, 'pty.log'));
    expect(opened.cliPid).toBe(4242);
    expect(readFileSync(opened.projectionRef, 'utf8')).toContain('Welcome to fake-cli');
    runner.close();
    expect(backend.killed).toBe(true);
  });

  it('honours permissionMode by dropping adapter bypass flags when disableCliBypass is set', async () => {
    const runner = makeRunner(fakeAdapter(), { disableCliBypass: true, resume: true, resumeSessionId: 'cli-native-7' });
    const opening = runner.open();
    expect(backend.spawned?.args).toEqual(['--resume', 'cli-native-7']);
    backend.emit(`${DONE}\r\n`);
    await opening;
    runner.close();
  });

  it('fails open with provider_exit evidence when the CLI dies before its prompt is ready', async () => {
    const runner = makeRunner();
    const opening = runner.open();
    backend.emit('fake-cli: command not found\r\n');
    backend.exit(127);
    const err = await opening.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PtyOpenError);
    const open = err as PtyOpenError;
    expect(open.code).toBe('provider_exit');
    expect(open.evidence.exitCode).toBe(127);
    expect(open.evidence.screenTail).toContain('command not found');
    runner.close();
  });

  it('classifies a node-pty exec failure (missing binary) as spawn_failed rather than provider_exit', async () => {
    const runner = makeRunner();
    const opening = runner.open();
    backend.emit('execvp(3) failed.: No such file or directory\r\n');
    backend.exit(1);
    const err = await opening.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PtyOpenError);
    const open = err as PtyOpenError;
    expect(open.code).toBe('spawn_failed');
    expect(open.message).toContain('/opt/fake/bin/fake-cli');
    expect(open.message).toContain('No such file or directory');
    runner.close();
  });

  it('completes a turn from the output contract file with high confidence', async () => {
    const runner = makeRunner();
    await openReady(runner);
    const contract = createOutputContract(stateDir, 'turn-1');

    const turn = runner.runTurn({ turnId: 'turn-1', prompt: 'Summarize the repo.' });
    await Promise.resolve();
    expect(backend.allWritten).toContain('Summarize the repo.');
    expect(backend.allWritten).toContain(contract.path);

    backend.emit('Reading files...\r\n');
    writeFileSync(contract.path, '# Summary\n\nThree modules, one daemon.\n');
    backend.emit(`${DONE}\r\n❯ `);

    const outcome = await turn;
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.finalResponse).toBe('# Summary\n\nThree modules, one daemon.');
    expect(outcome.settlement).toMatchObject({ source: 'contract_file', confidence: 'high', idleSource: 'screen' });
    expect(typeof outcome.screenTail).toBe('string');
    runner.close();
  });

  it('keeps waiting through the grace window when the contract file lands after idle', async () => {
    const runner = makeRunner();
    await openReady(runner);
    const contract = createOutputContract(stateDir, 'turn-late');

    const turn = runner.runTurn({ turnId: 'turn-late', prompt: 'Do it.' });
    backend.emit(`${DONE}\r\n❯ `);
    // idle 已触发但文件未落盘：宽限期内写入必须被捡到，而不是退回屏幕 fallback
    setTimeout(() => writeFileSync(contract.path, 'late but complete'), 650);

    const outcome = await turn;
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.finalResponse).toBe('late but complete');
    expect(outcome.settlement.source).toBe('contract_file');
    runner.close();
  });

  it('falls back to the terminal viewport with an explicit low-confidence settlement', async () => {
    const runner = makeRunner();
    await openReady(runner);

    const turn = runner.runTurn({ turnId: 'turn-2', prompt: 'What is the answer?' });
    backend.emit('\r\nThe answer is 42\r\n');
    backend.emit(`${DONE}\r\n❯ `);

    const outcome = await turn;
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.finalResponse).toContain('The answer is 42');
    expect(outcome.settlement.source).toBe('screen');
    expect(outcome.settlement.confidence).toBe('low');
    expect(outcome.settlement.reason).toMatch(/contract file was not written/);
    runner.close();
  });

  it('reports provider_exit with the screen tail when the CLI dies mid-turn', async () => {
    const runner = makeRunner();
    await openReady(runner);

    const turn = runner.runTurn({ turnId: 'turn-3', prompt: 'Crash please.' });
    backend.emit('\r\nSegmentation fault (core dumped)\r\n');
    backend.exit(139, 'SIGSEGV');

    const outcome = await turn;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.code).toBe('provider_exit');
    if (outcome.failure.code !== 'provider_exit') return;
    expect(outcome.failure.exitCode).toBe(139);
    expect(outcome.failure.signal).toBe('SIGSEGV');
    expect(outcome.failure.screenTail).toContain('Segmentation fault');

    // 进程已死：后续回合不得假装运行，直接以同一证据失败
    const next = await runner.runTurn({ turnId: 'turn-4', prompt: 'again' });
    expect(next.status).toBe('failed');
    runner.close();
  });

  it('cancels the active turn with the interrupt key and keeps the session usable (steer semantics)', async () => {
    const runner = makeRunner();
    await openReady(runner);

    const turn = runner.runTurn({ turnId: 'turn-5', prompt: 'Long task' });
    await Promise.resolve();
    expect(runner.cancel('other-turn', 'operator')).toBe(false);
    expect(runner.cancel('turn-5', 'steer')).toBe(true);

    const outcome = await turn;
    expect(outcome).toMatchObject({ status: 'cancelled', reason: 'steer' });
    expect(backend.written).toContain('\x1b');

    const contract = createOutputContract(stateDir, 'turn-6');
    const next = runner.runTurn({ turnId: 'turn-6', prompt: 'Steered task' });
    writeFileSync(contract.path, 'steered result');
    backend.emit(`${DONE}\r\n❯ `);
    const nextOutcome = await next;
    expect(nextOutcome.status).toBe('completed');
    if (nextOutcome.status === 'completed') expect(nextOutcome.finalResponse).toBe('steered result');
    runner.close();
  });

  it('uses the per-CLI interrupt key from cli-quirks (grok wants Ctrl-C, not ESC)', async () => {
    const runner = makeRunner(fakeAdapter({ id: 'grok' }));
    await openReady(runner);
    const turn = runner.runTurn({ turnId: 'turn-g', prompt: 'Long task' });
    await Promise.resolve();
    expect(runner.cancel('turn-g', 'operator')).toBe(true);
    await turn;
    expect(backend.written).toContain('\x03');
    expect(backend.written).not.toContain('\x1b');
    runner.close();
  });

  it('refuses a second concurrent turn with turn_busy', async () => {
    const runner = makeRunner();
    await openReady(runner);

    const first = runner.runTurn({ turnId: 'a', prompt: 'one' });
    const second = await runner.runTurn({ turnId: 'b', prompt: 'two' });
    expect(second).toMatchObject({ status: 'failed', failure: { code: 'turn_busy' } });

    runner.cancel('a', 'operator');
    await first;
    runner.close();
  });

  it('surfaces an unconfirmed submission as submit_unconfirmed instead of waiting forever', async () => {
    const adapter = fakeAdapter({
      async writeInput(pty: PtyHandle) {
        pty.write('garbled');
        return { submitted: false, failureReason: 'composer rejected paste' };
      },
    });
    const runner = makeRunner(adapter);
    await openReady(runner);

    const outcome = await runner.runTurn({ turnId: 'turn-7', prompt: 'hello' });
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { code: 'submit_unconfirmed', detail: 'composer rejected paste' },
    });
    runner.close();
  });

  it('records the CLI-native session id observed by the adapter for later resume', async () => {
    const adapter = fakeAdapter({
      async writeInput(pty: PtyHandle, content: string) {
        pty.write(content);
        return { submitted: true, cliSessionId: 'rotated-99' };
      },
    });
    const runner = makeRunner(adapter);
    await openReady(runner);
    expect(runner.observedCliSessionId).toBeUndefined();

    const turn = runner.runTurn({ turnId: 'turn-8', prompt: 'hi' });
    backend.emit(`${DONE}\r\n`);
    await turn;
    expect(runner.observedCliSessionId).toBe('rotated-99');
    runner.close();
  });
  it('holds ready while the startup screen still shows a busy marker (codex MCP startup)', async () => {
    const runner = makeRunner(fakeAdapter({ id: 'codex' }));
    const opening = runner.open();
    backend.emit('model: gpt · Context 100% left\r\n• Starting MCP servers (0/2): botmux, codex_apps (0s • esc to interrupt)\r\n');
    backend.emit(`${DONE}\r\n`);
    expect(await settledWithin(opening, 900)).toBe('pending');

    backend.emit(`${CLEAR_SCREEN}» Ask Codex to do anything   gpt · Ready · Context 100% left\r\n${DONE}\r\n`);
    const opened = await opening;
    expect(opened.cliPid).toBe(4242);
    runner.close();
  });

  it('holds ready on the very first codex frame (model: loading) even though the composer is drawn', async () => {
    // 真 runtime 上踩过：codex 最早一帧已经画出 `› Ask Codex to do anything`，readyPattern
    // 命中，但随后整屏重绘会把此时粘贴的 prompt 丢掉。
    const runner = makeRunner(fakeAdapter({ id: 'codex', readyPattern: /›(?!\s*\d+\.)|\d+% left/ }));
    const opening = runner.open();
    backend.emit('>_ OpenAI Codex\r\n model: loading /model to change\r\n› Ask Codex to do anything\r\n ? for shortcuts\r\n');
    backend.emit(`${DONE}\r\n`);
    expect(await settledWithin(opening, 900)).toBe('pending');

    backend.emit(`${CLEAR_SCREEN}>_ OpenAI Codex\r\n model: gpt /model to change\r\n» Ask Codex to do anything\r\n gpt · Starting · Context 100% left\r\n${DONE}\r\n`);
    expect(await settledWithin(opening, 600)).toBe('pending');

    backend.emit(`${CLEAR_SCREEN}» Ask Codex to do anything\r\n gpt · Ready · Context 100% left\r\n${DONE}\r\n`);
    await opening;
    runner.close();
  });

  it('auto-accepts the codex directory-trust dialog once (Enter after a short delay) and then waits for the composer', async () => {
    // 真 runtime 上踩过（真 codex 0.153 在陌生 cwd）：`Do you trust the contents of this directory?`
    // 带 `› 1. Yes, continue`，readyPattern 刻意不认带编号的 `›`，不接受就一直等到 ready_timeout。
    // 主 worker 对同一对话框的策略是延迟一拍自动回车；这里同策略、只做一次。
    const runner = makeRunner(fakeAdapter({ id: 'codex', readyPattern: /›(?!\s*\d+\.)|\d+% left/ }));
    const opening = runner.open();
    const dialog = '> You are in /tmp/work\r\n\r\n Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.\r\n\r\n› 1. Yes, continue\r\n  2. No, quit\r\n\r\n Press enter to continue\r\n';
    backend.emit(dialog);
    backend.emit(`${DONE}\r\n`);
    expect(await settledWithin(opening, 300)).toBe('pending');
    expect(backend.allWritten).toBe('');
    // idle 判定（~500ms）+ 确认窗口 + 延迟一拍后回车；对话框未消失前不会再按第二次
    await new Promise((r) => setTimeout(r, 1500));
    expect(backend.written).toEqual(['\r']);
    backend.emit(dialog);
    backend.emit(`${DONE}\r\n`);
    expect(await settledWithin(opening, 400)).toBe('pending');
    expect(backend.written).toEqual(['\r']);

    backend.emit(`${CLEAR_SCREEN}» Ask Codex to do anything\r\n gpt · Ready · Context 100% left\r\n${DONE}\r\n`);
    await opening;
    expect(backend.written).toEqual(['\r']);
    runner.close();
  });

  it('fails open with cli_needs_setup when the CLI shows its login wizard instead of the composer', async () => {
    // 真 runtime 上踩过（空 HOME 的 claude）：登录菜单带 `❯ 1. Claude account…`，readyPattern
    // 命中后 prompt 被当成菜单输入吞掉，CLI 停在 OAuth 粘贴码页，上游只看到 running。
    const runner = makeRunner(fakeAdapter({ id: 'claude-code', readyPattern: /❯/ }));
    const opening = runner.open();
    backend.emit('Welcome to Claude Code\r\nSelect login method:\r\n❯ 1. Claude account with subscription\r\n  2. Anthropic Console account\r\n');
    backend.emit(`${DONE}\r\n`);
    const err = await opening.catch((e) => e);
    expect(err).toBeInstanceOf(PtyOpenError);
    expect((err as PtyOpenError).code).toBe('cli_needs_setup');
    expect((err as PtyOpenError).message).toContain('Select login method');
    expect((err as PtyOpenError).message).toContain('/opt/fake/bin/fake-cli');
    expect((err as PtyOpenError).evidence.screenTail).toContain('Claude account with subscription');
    expect(backend.allWritten).toBe('');
    runner.close();
  });

  it('refuses to scrape a login screen as the turn response (cli_needs_setup mid-turn)', async () => {
    const runner = makeRunner(fakeAdapter({ id: 'claude-code', readyPattern: /❯/ }));
    await openReady(runner);
    const turn = runner.runTurn({ turnId: 't1', prompt: 'hello' });
    backend.emit(`${CLEAR_SCREEN}Browser didn't open? Use the url below to sign in (c to copy)\r\nhttps://claude.com/oauth\r\nPaste code here if prompted >\r\n${DONE}\r\n`);
    const outcome = await turn;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.code).toBe('cli_needs_setup');
    expect('detail' in outcome.failure && outcome.failure.detail).toContain('Use the url below to sign in');
    expect('screenTail' in outcome.failure && outcome.failure.screenTail).toContain('Paste code here if prompted');
    runner.close();
  });

  it('holds ready while a transitional redraw has no input prompt on screen (readyPattern gate)', async () => {
    const runner = makeRunner(fakeAdapter({ readyPattern: /❯/ }));
    const opening = runner.open();
    backend.emit(`banner only, no prompt yet\r\n${DONE}\r\n`);
    expect(await settledWithin(opening, 900)).toBe('pending');

    backend.emit(`${DONE}\r\n❯ `);
    await opening;
    runner.close();
  });

  it('hands the adapter the real CLI pid behind an npm-shim launcher, falling back to the launcher pid', async () => {
    // codex 的 `codex` 是 codex.js wrapper，rollout 归属校验必须拿原生二进制的 pid，
    // 否则提交验证永远 fail closed、resumeSessionId 永远学不到。
    const seenPids: Array<number | undefined> = [];
    const adapter = fakeAdapter({
      async writeInput(pty: PtyHandle, content: string) {
        seenPids.push(pty.cliPid);
        pty.write(content);
        pty.write('\r');
      },
    });
    const calls: number[] = [];
    const runner = makeRunner(adapter, {
      resolveCliPid: (launcherPid) => {
        calls.push(launcherPid);
        return calls.length === 1 ? null : 9001;
      },
    });
    const opening = runner.open();
    backend.emit(`${DONE}\r\n❯ `);
    const opened = await opening;
    expect(opened.cliPid).toBe(4242); // 首次解析不到 → 退回 launcher pid，不缓存

    const turn = runner.runTurn({ turnId: 't-pid', prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    backend.emit(`${DONE}\r\n❯ `);
    await turn;
    expect(seenPids).toEqual([9001]); // 提交时再解析 → 命中后代 pid
    expect(calls).toEqual([4242, 4242]);

    const second = runner.runTurn({ turnId: 't-pid-2', prompt: 'again' });
    await new Promise((r) => setTimeout(r, 50));
    backend.emit(`${DONE}\r\n❯ `);
    await second;
    expect(calls).toHaveLength(2); // 解析成功后缓存，不再探测进程树
    runner.close();
  });

  it('does not settle a turn while the adapter busy marker is still on screen', async () => {
    const runner = makeRunner(fakeAdapter({ busyPattern: /Working[^\r\n]{0,160}esc to interrupt/i }));
    await openReady(runner);
    const contract = createOutputContract(stateDir, 'turn-busy');

    const turn = runner.runTurn({ turnId: 'turn-busy', prompt: 'Think hard.' });
    backend.emit(`\r\n• Working (12s • esc to interrupt)\r\n${DONE}\r\n`);
    // idle 已触发，但屏幕仍是 Working：不能结算
    expect(await settledWithin(turn, 900)).toBe('pending');

    writeFileSync(contract.path, 'thought through');
    backend.emit(`${CLEAR_SCREEN}• Done\r\n${DONE}\r\n`);
    const outcome = await turn;
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.finalResponse).toBe('thought through');
    expect(outcome.settlement.source).toBe('contract_file');
    runner.close();
  });
  it('treats an unconfirmed submission as advisory when the contract file proves the turn ran', async () => {
    const adapter = fakeAdapter({
      async writeInput(pty: PtyHandle, content: string) {
        pty.write(content);
        return { submitted: false };
      },
    });
    const runner = makeRunner(adapter);
    await openReady(runner);
    const contract = createOutputContract(stateDir, 'turn-adv');

    const turn = runner.runTurn({ turnId: 'turn-adv', prompt: 'go' });
    writeFileSync(contract.path, 'ran anyway');
    backend.emit(`${DONE}\r\n`);
    const outcome = await turn;
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') expect(outcome.finalResponse).toBe('ran anyway');
    runner.close();
  });

  it('fails an unconfirmed submission that never produced a contract file instead of scraping an empty composer', async () => {
    const adapter = fakeAdapter({
      async writeInput(pty: PtyHandle, content: string) {
        pty.write(content);
        return { submitted: false };
      },
    });
    const runner = makeRunner(adapter);
    await openReady(runner);

    const turn = runner.runTurn({ turnId: 'turn-lost', prompt: 'go' });
    backend.emit(`${DONE}\r\n» Ask me anything`);
    const outcome = await turn;
    expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'submit_unconfirmed' } });
    if (outcome.status === 'failed' && outcome.failure.code === 'submit_unconfirmed') {
      expect(outcome.failure.screenTail).toContain('Ask me anything');
    }
    runner.close();
  });
});
