/**
 * Opt-in real Doubao CLI smoke; never starts a daemon or edits a bot config.
 * Requires an installed, logged-in `doubao` (2.31+). Drives the real adapter
 * through the real PtyBackend / TmuxPipeBackend and the real IdleDetector.
 * Run: BOTMUX_DOUBAO_E2E=1 vitest run --project e2e test/doubao-input.e2e.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDoubaoAdapter, doubaoSessionRoots, DOUBAO_BUSY_FOOTER } from '../src/adapters/cli/doubao.js';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { SessionBackend } from '../src/adapters/backend/types.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const roots: string[] = [];
const cleanup: Array<() => void> = [];

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  await pause(800);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function trajectory(sessionId: string): string {
  for (const root of doubaoSessionRoots()) {
    try {
      const agents = join(root, sessionId, 'agents');
      for (const agent of readdirSync(agents)) {
        try { return readFileSync(join(agents, agent, 'system', 'trajectory.jsonl'), 'utf8'); } catch { /* next */ }
      }
    } catch { /* next root */ }
  }
  return '';
}

async function waitFor(probe: () => boolean, what: string, screen: () => string, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (probe()) return;
    await pause(250);
  }
  throw new Error(`Doubao smoke timed out: ${what}\n${screen()}`);
}

async function launch(opts: { tmux?: boolean; resumeId?: string } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-doubao-e2e-')));
  roots.push(cwd);
  const adapter = createDoubaoAdapter(process.env.DOUBAO_E2E_BIN);
  const args = adapter.buildArgs({ sessionId: randomUUID(), resume: !!opts.resumeId, resumeSessionId: opts.resumeId });
  const renderer = new TerminalRenderer(150, 44);
  const backend: SessionBackend = opts.tmux
    ? new TmuxPipeBackend(`doubao-${randomUUID().slice(0, 8)}`, { createSession: true, ownsSession: true, socketName: 'doubao-native-e2e' })
    : new PtyBackend();
  cleanup.push(() => renderer.dispose());
  cleanup.push(() => backend.kill());
  const idle = new IdleDetector(adapter, () => renderer.rawSnapshot());
  let idleCount = 0;
  idle.onIdle(() => { idleCount++; });
  cleanup.push(() => idle.dispose());
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, ...adapter.spawnEnv };
  backend.spawn(adapter.resolvedBin, args, { cwd, cols: 150, rows: 44, env });
  renderer.xterm.onData(data => backend.write(data));
  backend.onData(data => { renderer.write(data); idle.feed(data); });
  let exited = false;
  backend.onExit(() => { exited = true; });
  const screen = () => renderer.rawSnapshot();
  await waitFor(() => idleCount > 0, 'composer ready (IdleDetector)', screen, 60_000);
  expect(exited, screen()).toBe(false);
  return {
    adapter, backend, idle, screen, alive: () => !exited,
    /** Submit and wait for the NEXT idle edge reported by the real detector. */
    async turn(content: string) {
      const before = idleCount;
      idle.reset();
      const result = await adapter.writeInput(backend, content);
      await waitFor(() => idleCount > before, 'turn idle', screen, 120_000);
      return result;
    },
  };
}

describe.runIf(process.env.BOTMUX_DOUBAO_E2E === '1')('Doubao real terminal', () => {
  it('multiline submit, idle detection, native id capture and exact resume', async () => {
    const marker = `DB_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const first = await launch();
    const result = await first.turn(`<botmux_routing>\n- 测试路由提示\n</botmux_routing>\n本测试对话的临时字符串是 ${marker}，只用于当前会话，不要保存到长期记忆或用户偏好。\n只回复 SAVED`);
    const sid = typeof result === 'object' ? result.cliSessionId : undefined;
    expect(sid, first.screen()).toMatch(/^\d{10,24}$/);
    expect(first.screen()).toContain('SAVED');
    expect(DOUBAO_BUSY_FOOTER.test(first.screen())).toBe(false);
    expect(trajectory(sid!)).toContain('SAVED');
    first.backend.kill();
    await pause(1500);

    const resumed = await launch({ resumeId: sid });
    expect(resumed.adapter.checkResumeTargetExists?.({ sessionId: 'x', cliSessionId: sid })).toBe(true);
    const second = await resumed.turn('本测试对话第一轮提到的临时字符串是什么？只回复字符串本身，不读取长期记忆');
    // A precise resume already knows its id; no capture result is returned.
    expect(second).toBeUndefined();
    await waitFor(() => resumed.screen().includes(marker), 'restored memory', resumed.screen, 30_000);
  }, 360_000);

  it('Esc interrupts a running tool turn without exiting the CLI', async () => {
    const s = await launch();
    s.idle.reset();
    await s.adapter.writeInput(s.backend, '运行 shell 命令 sleep 60，完成后回复 SLE + PT 拼接成的单词');
    // Wait until the shell tool itself is running (not just the model responding).
    await waitFor(() => /Running tool… \(\d+s • esc to interrupt\)/.test(s.screen()), 'tool running', s.screen, 60_000);
    const escAt = Date.now();
    s.backend.write('\x1b');
    await waitFor(() => s.screen().includes('Stopped') && !DOUBAO_BUSY_FOOTER.test(s.screen()), 'interrupted', s.screen, 20_000);
    expect(s.alive()).toBe(true);
    // The prompt never spells the reply word, so it can only come from a turn that was NOT interrupted.
    expect(s.screen()).not.toContain('SLEPT');
    expect(s.screen()).toContain('Stopped');
    // Returned to the composer long before the 60s sleep could have finished.
    expect(Date.now() - escAt).toBeLessThan(20_000);
  }, 180_000);

  it('submits through the real tmux backend', async () => {
    const s = await launch({ tmux: true });
    await s.turn('第一行：这是 tmux 多行测试\n第二行：只回复 TMUX_DOUBAO_OK');
    expect(s.screen()).toContain('TMUX_DOUBAO_OK');
  }, 240_000);
});
