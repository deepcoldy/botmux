import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Codex worker structured-bridge ownership gate', () => {
  // 源码结构护栏(K2)：Codex 的 history.jsonl 是整个 CODEX_HOME 共享的单文件，writeInput 报回的 session id
  // 可能属于另一个 pane（#726 共享 history 跨进程误绑）；不校验属主就 re-attach / 首次 attach，会把别的会话的
  // rollout 回答投递进本话题。codexBridgeNotifyCliSessionId 是 worker 闭包里的模块态函数，没有行为 seam，只能
  // 读源码确认 pid rollout 属主校验先于 detach / re-attach、也先于末尾的 initial attach。纯判据
  // codexHistorySidIsOwned / findCodexRolloutSetByPid 另由 codex-transcript.test.ts 与
  // codex-coco-pid-discovery.smoke.test.ts 行为覆盖。
  it('checks pid rollout ownership before re-attaching or first-attaching a Codex session id', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId(');
    expect(start).toBeGreaterThan(-1);
    const fn = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    const gates = [...fn.matchAll(/codexHistorySidOwnedByCurrentPid\(cliSessionId\)/g)].map(m => m.index!);
    const firstDetach = fn.indexOf('codexBridgeDetachFile();');
    const finalAttach = fn.lastIndexOf('codexBridgeAttach(');
    expect(gates.length).toBeGreaterThanOrEqual(2);
    expect(firstDetach).toBeGreaterThan(-1);
    expect(finalAttach).toBeGreaterThan(-1);
    expect(gates[0]).toBeLessThan(firstDetach);
    expect(gates[gates.length - 1]).toBeLessThan(finalAttach);
  });
});

describe('zero-prompt capability under the machine-wide sandbox switch', () => {
  it('refuses a zero-prompt Cursor spawn when BOTMUX_SANDBOX=scratch resolves the sandbox, before launching the CLI', async () => {
    // BOTMUX_SANDBOX never reaches cfg, so only the spawn-time re-check can see
    // that zero-prompt Cursor would run under the full-root COW overlay, where
    // its final-reply harvest is unsupported and every reply would be dropped.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-zero-prompt-scratch-')));
    const launched = join(root, 'cli-launched');
    const cli = join(root, 'fake-cursor');
    writeFileSync(cli, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(launched)}, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: root, SESSION_DATA_DIR: join(root, 'data'), BOTMUX_SANDBOX: 'scratch', BOTMUX_NO_CLAIM: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    try {
      child.send({ type: 'init', sessionId: 'zero-prompt-scratch', chatId: 'oc_fixture', rootMessageId: 'om_fixture',
        workingDir: root, cliId: 'cursor', cliPathOverride: cli, backendType: 'pty', prompt: '', promptInjection: 'none',
        larkAppId: 'app_test', larkAppSecret: 'fixture-secret' } satisfies DaemonToWorker);
      const deadline = Date.now() + 15_000;
      while (!messages.some(m => m.type === 'error' || m.type === 'ready') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
      const error = messages.find(m => m.type === 'error');
      expect(error, logs.join('')).toBeDefined();
      expect(error && 'message' in error ? error.message : '').toContain('零注入');
      expect(messages.some(m => m.type === 'ready')).toBe(false);
      const launches = existsSync(launched) ? readFileSync(launched, 'utf8').trim().split('\n') : [];
      expect(launches.filter(line => !line.includes('--version'))).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
