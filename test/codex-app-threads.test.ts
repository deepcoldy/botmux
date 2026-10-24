import { mockCleanupRelease } from './helpers/codex-cleanup-release.js';
import { freezeCodexCleanupLaunch } from '../src/core/codex-cleanup-launch.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPidFile } from './helpers/pid-file.js';
import {
  generateCodexAppThreadTitle,
  setCodexAppThreadName,
} from '../src/services/codex-app-threads.js';

const FAKE_CODEX = resolve('test/fixtures/fake-codex-app-server.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCodexEnv(
  dir: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const sourceCodexHome = join(dir, 'source-codex-home');
  mkdirSync(sourceCodexHome, { recursive: true });
  writeFileSync(join(sourceCodexHome, 'auth.json'), '{}');
  writeFileSync(join(sourceCodexHome, 'config.toml'), '[mcp_servers.dangerous]\ncommand = "false"\n');
  return {
    ...process.env,
    CODEX_HOME: sourceCodexHome,
    ...extra,
  };
}

describe('generateCodexAppThreadTitle', () => {
  it('generates a structured semantic title in an isolated ephemeral thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-title-generate-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');
    const envLogPath = join(dir, 'env.json');

    const title = await generateCodexAppThreadTitle({
      sourceText: '请排查 image_safety 为什么没有返回错误码 12008',
      codexBin: FAKE_CODEX,
      env: fakeCodexEnv(dir, {
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_ENV_LOG: envLogPath,
      }),
      model: 'fake-low-cost-model',
      timeoutMs: 5000,
    });

    expect(title).toBe('排查图片安全错误码');
    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const threadStart = requests.find(request => request.method === 'thread/start');
    expect(threadStart.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      threadSource: 'system',
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      environments: [],
      dynamicTools: null,
      developerInstructions: expect.stringContaining('不得调用工具'),
      config: {
        model: 'fake-low-cost-model',
        model_reasoning_effort: 'low',
        shell_environment_policy: { inherit: 'none' },
        project_doc_max_bytes: 0,
        project_doc_fallback_filenames: [],
        tools: { web_search: false },
        features: {
          apps: false,
          browser_use: false,
          browser_use_external: false,
          browser_use_full_cdp_access: false,
          code_mode: false,
          code_mode_host: false,
          computer_use: false,
          enable_mcp_apps: false,
          hooks: false,
          image_generation: false,
          in_app_browser: false,
          memories: false,
          multi_agent: false,
          multi_agent_v2: false,
          plugin_sharing: false,
          plugins: false,
          remote_plugin: false,
          skill_mcp_dependency_install: false,
          shell_tool: false,
          shell_snapshot: false,
          standalone_web_search: false,
          unified_exec: false,
          workspace_dependencies: false,
        },
      },
    });
    expect(threadStart.params.cwd).toMatch(/botmux-codex-title-/);
    expect(existsSync(threadStart.params.cwd)).toBe(false);

    const turnStart = requests.find(request => request.method === 'turn/start');
    expect(turnStart.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: 'low',
      environments: [],
      runtimeWorkspaceRoots: [],
      outputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 36 },
        },
        required: ['title'],
        additionalProperties: false,
      },
    });
    expect(turnStart.params.input[0].text).toContain(
      JSON.stringify({ source_text: '请排查 image_safety 为什么没有返回错误码 12008' }),
    );
    expect(requests).toContainEqual(expect.objectContaining({
      id: 9001,
      result: { contentItems: [], success: false },
    }));
    expect(requests.map(request => request.method)).toContain('thread/unsubscribe');
    const isolatedEnv = JSON.parse(readFileSync(envLogPath, 'utf8'));
    expect(isolatedEnv.codexHome).not.toBe(join(dir, 'source-codex-home'));
    expect(isolatedEnv.authExists).toBe(true);
    expect(isolatedEnv.configExists).toBe(false);
  });

  it('returns undefined for invalid structured output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-title-invalid-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    const title = await generateCodexAppThreadTitle({
      sourceText: '排查登录失败',
      codexBin: FAKE_CODEX,
      env: fakeCodexEnv(dir, {
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_FINAL_TEXT: JSON.stringify({ title: 'x'.repeat(37) }),
      }),
      timeoutMs: 5000,
    });

    expect(title).toBeUndefined();
    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods).toContain('thread/unsubscribe');
  });

  it('times out, interrupts the temporary turn, and reaps the app-server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-title-timeout-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');
    const pidPath = join(dir, 'pid');

    // Keep the deadline still while the real subprocess starts. Its response to
    // the fixture's tool request proves turn/started has reached the client;
    // only then expire the title deadline, independently of machine load.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let forceClose: (() => void) | undefined;
    let completed = false;
    const pendingTitle = generateCodexAppThreadTitle({
      sourceText: '这个标题生成永远不会完成',
      codexBin: FAKE_CODEX,
      env: fakeCodexEnv(dir, {
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_PID_PATH: pidPath,
        FAKE_CODEX_BEHAVIOR: 'hang-turn-completion',
      }),
      timeoutMs: 100,
      detached: true,
      registerForceClose: close => {
        forceClose = close;
        return () => { forceClose = undefined; };
      },
    });
    try {
      const readyDeadline = performance.now() + 5000;
      let ready = false;
      while (performance.now() < readyDeadline) {
        if (existsSync(logPath)) {
          // The fixture is still appending: the file can exist empty, or end in a
          // half-written record. Only newline-terminated records are complete.
          ready = readFileSync(logPath, 'utf8').split('\n').slice(0, -1)
            .some(line => JSON.parse(line).id === 9001);
          if (ready) break;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(ready, 'fake app-server must reach the active title turn').toBe(true);
      vi.advanceTimersByTime(100);
      // Cleanup still exercises real RPC and process reaping with real timers.
      vi.useRealTimers();
      expect(await pendingTitle).toBeUndefined();
      completed = true;
    } finally {
      vi.useRealTimers();
      if (!completed) forceClose?.();
      await pendingTitle;
    }
    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(expect.arrayContaining([
      'turn/interrupt',
      'thread/unsubscribe',
    ]));

    const pid = await waitForPidFile(pidPath);
    const reapDeadline = Date.now() + 2000;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(pid, 0);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      } catch {
        return;
      }
    }
    throw new Error(`title generator fake Codex app-server ${pid} was not reaped`);
  }, 15_000);
});

/** 轮询夹具 requests.jsonl 直到出现包含 needle 的行。用真实计时器轮询
 *  （不能用 vi.useFakeTimers：bun 测试腿下它会把真实 setTimeout 一起劫持，
 *  子进程 IPC 等待会永久挂起）。 */
async function waitForLogContaining(logPath: string, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      if (readFileSync(logPath, 'utf8').includes(needle)) return;
    } catch { /* 日志文件尚未创建 */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`fake Codex log never contained ${needle}`);
}

describe('setCodexAppThreadName', () => {
  it('sets a persisted thread name through the Codex app-server API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-name-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-existing',
      name: '[BotMux·Lark] 排查这个问题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: { ...process.env, FAKE_CODEX_LOG: logPath },
      timeoutMs: 20_000,
    });

    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'thread/name/set',
      params: {
        threadId: 'thread-existing',
        name: '[BotMux·Lark] 排查这个问题',
      },
    }));
  });

  it('waits until the first-message preview is readable before setting the final title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-title-barrier-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-delayed-preview',
      name: '[BotMux·Lark] 最终标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_PREVIEW_DELAY_READS: '2',
      },
      timeoutMs: 20_000,
      waitForExistingPreview: true,
    });

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    const setIndex = methods.indexOf('thread/name/set');
    expect(methods.slice(0, setIndex).filter(method => method === 'thread/read')).toHaveLength(3);
    expect(methods.slice(setIndex + 1)).toContain('thread/read');
  });

  it('retries while a fresh thread is not loaded before setting the final title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-load-race-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-loading',
      name: '[BotMux·Lark] 离线推荐任务',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_THREAD_NOT_LOADED_READS: '2',
      },
      timeoutMs: 20_000,
      waitForExistingPreview: true,
    });

    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const methods = requests.map(request => request.method);
    const setIndex = methods.indexOf('thread/name/set');
    expect(methods.slice(0, setIndex).filter(method => method === 'thread/read')).toHaveLength(3);
    expect(requests[setIndex]).toEqual(expect.objectContaining({
      method: 'thread/name/set',
      params: {
        threadId: 'thread-loading',
        name: '[BotMux·Lark] 离线推荐任务',
      },
    }));
    expect(methods.slice(setIndex + 1)).toContain('thread/read');
  });

  it('does not retry a non-transient thread read failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-read-error-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await expect(setCodexAppThreadName({
      threadId: 'thread-unavailable',
      name: '[BotMux·Lark] 不应写入',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_BEHAVIOR: 'thread-read-error',
      },
      timeoutMs: 20_000,
      waitForExistingPreview: true,
    })).rejects.toThrow('thread unavailable: thread-unavailable');

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods.filter(method => method === 'thread/read')).toHaveLength(1);
    expect(methods).not.toContain('thread/name/set');
  });

  it('sets the final title when the first-message preview remains unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-title-fallback-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-without-preview',
      name: '[BotMux·Lark] 最终标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_PREVIEW_DELAY_READS: '999999',
      },
      timeoutMs: 200,
      initializeTimeoutMs: 2_000,
      waitForExistingPreview: true,
    });

    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const methods = requests.map(request => request.method);
    const setIndex = methods.indexOf('thread/name/set');
    expect(methods.slice(0, setIndex)).toContain('thread/read');
    expect(requests[setIndex]).toEqual(expect.objectContaining({
      method: 'thread/name/set',
      params: {
        threadId: 'thread-without-preview',
        name: '[BotMux·Lark] 最终标题',
      },
    }));
    expect(methods.slice(setIndex + 1)).toContain('thread/read');
  });

  it('still writes the fallback title when a slow thread/read exhausts the preview wait budget', async () => {
    // 繁忙机器上单次 thread/read 慢于整段等待预算时，withTimeout 在 deadline
    // 处 reject。waitForThreadPreview 必须按「预览不可用」降级返回，让兜底
    // 标题照常写入，而不是把超时错误抛给 setCodexAppThreadName（CI 上同一
    // 缺陷以 "timed out after 1ms" 的尾窗竞态形状出现）。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-slow-preview-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-slow-preview',
      name: '[BotMux·Lark] 慢响应兜底标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_THREAD_READ_DELAY_MS: '300',
        FAKE_CODEX_PREVIEW_DELAY_READS: '999999',
      },
      timeoutMs: 200,
      initializeTimeoutMs: 2_000,
      waitForExistingPreview: true,
    });

    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const nameSet = requests.find(request => request.method === 'thread/name/set');
    expect(nameSet).toEqual(expect.objectContaining({
      params: { threadId: 'thread-slow-preview', name: '[BotMux·Lark] 慢响应兜底标题' },
    }));
  });

  it('issues no thread/read when the preview wait budget is below the poll floor', async () => {
    // MIN_POLL_REQUEST_BUDGET_MS=50：总预算低于下限时一次请求都不该发出——
    // 任何 sub-floor 客户端超时的 thread/read 注定在响应落地前超时。用快速
    // 假 app-server 即可区分：有 floor 时等待阶段零请求；删掉 floor 就会发出
    // 1 次请求（请求被服务器接收即入账，与是否赶上超时无关）。40ms 低于
    // 50ms floor，同时给随后即时返回的 thread/name/set 与校验 read 留出
    // localhost IPC 余量。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-floor-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-floor-budget',
      name: '[BotMux·Lark] 短预算兜底标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_PREVIEW_DELAY_READS: '999999',
      },
      timeoutMs: 40,
      initializeTimeoutMs: 2_000,
      waitForExistingPreview: true,
    });

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    const setIndex = methods.indexOf('thread/name/set');
    expect(methods.slice(0, setIndex).filter(method => method === 'thread/read')).toHaveLength(0);
    expect(methods).toContain('thread/name/set');
  });

  it('still writes the title when a slow thread/read exhausts the updatedAfter wait budget', async () => {
    // waitForThreadUpdatedAfter 的 catch 与 preview 等待同形：deadline 处的
    // 客户端超时必须按「等待结束」返回，让标题写入继续，而不是穿透抛出。
    // 慢响应（300ms）> 整段预算（200ms），且 baseline 永不可达双保险。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-updatedafter-slow-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-slow-updated',
      name: '[BotMux·Lark] 更新等待兜底标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_THREAD_READ_DELAY_MS: '300',
      },
      timeoutMs: 200,
      initializeTimeoutMs: 2_000,
      waitForUpdatedAfter: 999_999,
    });

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods).toContain('thread/name/set');
  });

  it('still writes the fallback title when the preview budget timeout fires with the wall clock pinned 1ms before deadline', async () => {
    // P2 守卫：尾窗降级判据必须是「我自己这条 thread/read 的客户端预算超时」
    // 本身，不能是 catch 时刻的 Date.now() >= deadline。超时定时器由单调时钟
    // 调度、Date.now 是量化墙钟，机器忙时 catch 可能在 deadline 前 1ms 读到
    // 墙钟——墙钟判据会让超时穿透成 throw、兜底标题不写（CI "timed out after
    // 1ms" 的同一形状）。夹具收到第一次 read 后把 Date.now 钉在 deadline-1
    //（子进程有独立时钟不受影响；真实 setTimeout 仍在 ~200ms 触发自己的
    // 预算超时）。判据若改回比墙钟，本用例必红。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-preview-clock-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');
    const timeoutMs = 200;
    const base = 1_700_000_000_000;

    const originalNow = Date.now;
    let pinnedNow = base;
    Date.now = () => pinnedNow;
    try {
      const completion = setCodexAppThreadName({
        threadId: 'thread-preview-clock-race',
        name: '[BotMux·Lark] 时钟竞态兜底标题',
        codexBin: FAKE_CODEX,
        cwd: dir,
        env: {
          ...process.env,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_THREAD_READ_DELAY_MS: '300',
          FAKE_CODEX_PREVIEW_DELAY_READS: '999999',
        },
        timeoutMs,
        initializeTimeoutMs: 2_000,
        waitForExistingPreview: true,
      });
      await waitForLogContaining(logPath, 'thread/read');
      pinnedNow = base + timeoutMs - 1;
      await completion;
    } finally {
      Date.now = originalNow;
    }

    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(requests.find(request => request.method === 'thread/name/set')).toEqual(expect.objectContaining({
      params: { threadId: 'thread-preview-clock-race', name: '[BotMux·Lark] 时钟竞态兜底标题' },
    }));
  });

  it('still writes the title when the updatedAfter budget timeout fires with the wall clock pinned 1ms before deadline', async () => {
    // 同形守卫 waitForThreadUpdatedAfter：catch 不比墙钟，只认自己这次 read
    // 的整段预算超时；慢响应 300ms > 预算 200ms，baseline 999999 永不可达。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-updatedafter-clock-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');
    const timeoutMs = 200;
    const base = 1_700_000_000_000;

    const originalNow = Date.now;
    let pinnedNow = base;
    Date.now = () => pinnedNow;
    try {
      const completion = setCodexAppThreadName({
        threadId: 'thread-updatedafter-clock-race',
        name: '[BotMux·Lark] 更新等待时钟竞态兜底标题',
        codexBin: FAKE_CODEX,
        cwd: dir,
        env: {
          ...process.env,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_THREAD_READ_DELAY_MS: '300',
        },
        timeoutMs,
        initializeTimeoutMs: 2_000,
        waitForUpdatedAfter: 999_999,
      });
      await waitForLogContaining(logPath, 'thread/read');
      pinnedNow = base + timeoutMs - 1;
      await completion;
    } finally {
      Date.now = originalNow;
    }

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods).toContain('thread/name/set');
  });

  it('still propagates a non-timeout read error when it lands in the final-budget window', async () => {
    // 尾窗降级只认「自己这条 read 的客户端预算超时」：短预算（60ms ≥ floor）
    // 下第一次迭代就拿满整段预算（exhaustsBudget=true），但服务器立即回的
    // -32600 非「thread not loaded」错误必须照常穿透，不能因为处在尾窗就被
    // 当成预算耗尽吞掉。守卫把谓词放宽成「尾窗任何错误都降级」的变异。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-final-window-error-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await expect(setCodexAppThreadName({
      threadId: 'thread-final-window-error',
      name: '[BotMux·Lark] 不应写入',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_BEHAVIOR: 'thread-read-error',
      },
      timeoutMs: 60,
      initializeTimeoutMs: 2_000,
      waitForExistingPreview: true,
    })).rejects.toThrow('thread unavailable: thread-final-window-error');

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods.filter(method => method === 'thread/read')).toHaveLength(1);
    expect(methods).not.toContain('thread/name/set');
  });

  it('propagates a mid-window read timeout instead of degrading when the 2000ms cap truncates the request budget', async () => {
    // exhaustsBudget 守卫：单次 read 超时被 2000ms cap 截断（总预算 10s）时，
    // 这次超时发生在等待窗口中部、不是预算耗尽点，必须抛出而不是降级写兜底
    // 标题——否则真 wedged 的 app-server 在中窗就被当成「预览等不到」。
    // 去掉 exhaustsBudget 只留 isOwnThreadReadTimeout 的变异会让本用例变红
    // （超时被降级、thread/name/set 照常发出）。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-preview-midwindow-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await expect(setCodexAppThreadName({
      threadId: 'thread-preview-midwindow',
      name: '[BotMux·Lark] 不应写入',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_THREAD_READ_DELAY_MS: '3000',
        FAKE_CODEX_PREVIEW_DELAY_READS: '999999',
      },
      timeoutMs: 10_000,
      initializeTimeoutMs: 2_000,
      waitForExistingPreview: true,
    })).rejects.toThrow(/timed out after 2000ms/);

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods.filter(method => method === 'thread/read')).toHaveLength(1);
    expect(methods).not.toContain('thread/name/set');
  });

  it('propagates a mid-window read timeout in the updatedAfter wait instead of returning early', async () => {
    // 同形守卫 waitForThreadUpdatedAfter：被 2000ms cap 截断的中窗超时必须
    // 穿透，不能被当成「等待结束」提前去写标题。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-updatedafter-midwindow-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await expect(setCodexAppThreadName({
      threadId: 'thread-updatedafter-midwindow',
      name: '[BotMux·Lark] 不应写入',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_THREAD_READ_DELAY_MS: '3000',
      },
      timeoutMs: 10_000,
      initializeTimeoutMs: 2_000,
      waitForUpdatedAfter: 999_999,
    })).rejects.toThrow(/timed out after 2000ms/);

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    expect(methods.filter(method => method === 'thread/read')).toHaveLength(1);
    expect(methods).not.toContain('thread/name/set');
  });

  it('waits for the first resume append metadata update before restoring the managed title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-resume-barrier-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-resumed-title',
      name: '[BotMux·Lark] 恢复后的最终标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_UPDATED_DELAY_READS: '2',
        FAKE_CODEX_UPDATED_BEFORE: '100',
        FAKE_CODEX_UPDATED_AFTER: '101',
      },
      timeoutMs: 20_000,
      waitForUpdatedAfter: 100,
    });

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    const setIndex = methods.indexOf('thread/name/set');
    expect(methods.slice(0, setIndex).filter(method => method === 'thread/read')).toHaveLength(3);
    expect(methods.slice(setIndex + 1)).toContain('thread/read');
  });

  it('aborts a stuck app-server request and reaps its process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-abort-'));
    tempDirs.push(dir);
    const pidPath = join(dir, 'pid');
    const controller = new AbortController();
    const request = setCodexAppThreadName({
      threadId: 'thread-stuck',
      name: '[BotMux·Lark] 不应卡住',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_BEHAVIOR: 'hang-name',
        FAKE_CODEX_PID_PATH: pidPath,
      },
      timeoutMs: 5000,
      signal: controller.signal,
    });

    const pid = await waitForPidFile(pidPath);

    controller.abort();
    await expect(request).rejects.toThrow(/closed/);
    const reapDeadline = Date.now() + 2000;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(pid, 0);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      } catch {
        return;
      }
    }
    throw new Error(`fake Codex app-server ${pid} was not reaped`);
  });

  it('rejects instead of crashing when the app-server stops reading its stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-stdin-closed-'));
    tempDirs.push(dir);
    const pidPath = join(dir, 'pid');
    // Every write after initialize hits a pipe nobody reads: EPIPE. Without a
    // stdin error listener that is thrown at process level, which takes the
    // daemon down. Bun only reports EPIPE for writes the pipe buffer cannot
    // absorb, so the request is made larger than that.
    await expect(setCodexAppThreadName({
      threadId: 'thread-stdin-closed',
      name: 'x'.repeat(256 * 1024),
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_BEHAVIOR: 'close-stdin-after-initialize',
        FAKE_CODEX_PID_PATH: pidPath,
      },
      timeoutMs: 20_000,
    })).rejects.toThrow(/stdin/);

    const pid = await waitForPidFile(pidPath);
    const reapDeadline = Date.now() + 2000;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(pid, 0);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      } catch {
        return;
      }
    }
    throw new Error(`fake Codex app-server ${pid} with closed stdin was not reaped`);
  });

  it('supports synchronous force-close for worker exit cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-force-close-'));
    tempDirs.push(dir);
    const pidPath = join(dir, 'pid');
    let forceClose: (() => void) | undefined;
    const request = setCodexAppThreadName({
      threadId: 'thread-force-close',
      name: '[BotMux·Lark] 进程退出回收',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_BEHAVIOR: 'hang-name',
        FAKE_CODEX_PID_PATH: pidPath,
      },
      timeoutMs: 5000,
      registerForceClose: cleanup => {
        forceClose = cleanup;
        return () => { forceClose = undefined; };
      },
    });

    const pid = await waitForPidFile(pidPath);
    expect(forceClose).toBeTypeOf('function');

    forceClose?.();
    await expect(request).rejects.toThrow(/force-closed/);
    const reapDeadline = Date.now() + 2000;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(pid, 0);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      } catch {
        return;
      }
    }
    throw new Error(`force-closed fake Codex app-server ${pid} was not reaped`);
  });
});

describe('Codex archive lifecycle RPC', () => {
  // These cases assert what the RPC does, not how fast it is. The deadline also
  // covers cold-starting the fixture, which a saturated runner stretches past
  // 500ms, so only the hang case (which needs it to fire) gets a short one.
  const RPC_TIMEOUT_MS = 10_000;
  async function probe(archived: boolean, storedArchived: boolean, behavior = 'success', outside = false) {
    const { setCodexAppThreadArchived } = await import('../src/services/codex-app-threads.js');
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-archive-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');
    const env = fakeCodexEnv(dir, { FAKE_CODEX_LOG: logPath, FAKE_CODEX_BEHAVIOR: behavior,
      FAKE_CODEX_THREAD_PATH: outside ? join(dir, 'foreign', 'rollout.jsonl')
        : join(dir, 'source-codex-home', storedArchived ? 'archived_sessions' : 'sessions', 'rollout.jsonl') });
    mkdirSync(join(env.FAKE_CODEX_THREAD_PATH!, '..'), { recursive: true });
    writeFileSync(env.FAKE_CODEX_THREAD_PATH!, '{}');
    const promise = setCodexAppThreadArchived({ threadId: 'native-thread', archived,
      codexHome: env.CODEX_HOME!, codexBin: FAKE_CODEX, env, timeoutMs: behavior === 'hang-archive' ? 500 : RPC_TIMEOUT_MS });
    return { promise, requests: () => readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  }
  it.each([[true, false, 'thread/archive'], [false, true, 'thread/unarchive']] as const)(
    'uses official RPC for archived=%s', async (archived, previous, method) => {
      const p = await probe(archived, previous); await p.promise;
      expect(p.requests().find(r => r.method === method)?.params).toEqual({ threadId: 'native-thread' });
      expect(p.requests().some(r => r.method === 'thread/resume' || r.method === 'turn/start')).toBe(false);
    });
  it.each([true, false])('already in desired state is a no-op (%s)', async state => {
    const p = await probe(state, state); await p.promise;
    expect(p.requests().some(r => r.method === 'thread/archive' || r.method === 'thread/unarchive')).toBe(false);
  });
  it('rejects a foreign storage path before mutation', async () => {
    const p = await probe(true, false, 'success', true);
    await expect(p.promise).rejects.toThrow('outside the frozen session home');
    expect(p.requests().some(r => r.method === 'thread/archive')).toBe(false);
  });
  it.each([true, false])('accepts a symlinked home for archive/recovery (%s)', async archived => {
    const { setCodexAppThreadArchived } = await import('../src/services/codex-app-threads.js');
    const dir = mkdtempSync(join(tmpdir(), 'botmux-home-alias-')); tempDirs.push(dir);
    const env = fakeCodexEnv(dir); const realHome = realpathSync(env.CODEX_HOME!);
    const alias = join(dir, 'home-alias'); symlinkSync(realHome, alias, 'dir');
    const rollout = join(realHome, archived ? 'sessions' : 'archived_sessions', 'rollout.jsonl');
    mkdirSync(join(rollout, '..'), { recursive: true }); writeFileSync(rollout, '{}');
    await expect(setCodexAppThreadArchived({ threadId: 'native-thread', archived, codexHome: alias,
      codexBin: FAKE_CODEX, env: { ...env, FAKE_CODEX_THREAD_PATH: rollout }, timeoutMs: RPC_TIMEOUT_MS })).resolves.toBeUndefined();
  });
  it('restores with the frozen executable after its temporary symlink disappears', async () => {
    const { setCodexAppThreadArchived } = await import('../src/services/codex-app-threads.js');
    const dir = mkdtempSync(join(tmpdir(), 'botmux-bin-alias-')); tempDirs.push(dir);
    const alias = join(dir, 'codex'); symlinkSync(FAKE_CODEX, alias);
    const frozenBin = freezeCodexCleanupLaunch('codex-app', process.execPath, ['--codex-bin', alias],
      join(dir, 'source-codex-home'))!.codexBin;
    const env = fakeCodexEnv(dir);
    for (const folder of ['sessions', 'archived_sessions']) {
      mkdirSync(join(env.CODEX_HOME!, folder), { recursive: true });
      writeFileSync(join(env.CODEX_HOME!, folder, 'rollout.jsonl'), '{}');
    }
    const opts = { threadId: 'native-thread', codexHome: env.CODEX_HOME!, codexBin: frozenBin, env, timeoutMs: RPC_TIMEOUT_MS };
    const { archiveCodexForCleanup, restoreCodexCleanupArchive } = await import('../src/services/codex-cleanup-archive.js');
    const row = { sessionId: 'mock-bin-recovery', status: 'closed', cliId: 'codex-app', backendType: 'tmux',
      cliSessionId: opts.threadId, codexCleanupTarget: { threadId: opts.threadId, codexHome: opts.codexHome, codexBin: frozenBin } } as import('../src/types.js').Session;
    const rpc: typeof setCodexAppThreadArchived = request => setCodexAppThreadArchived({ ...request,
      env: { ...request.env, ...env, FAKE_CODEX_THREAD_PATH: join(env.CODEX_HOME!, request.archived ? 'sessions' : 'archived_sessions', 'rollout.jsonl') } });
    expect(await archiveCodexForCleanup(row, true, () => {}, rpc, async () => mockCleanupRelease(row))).toBeUndefined();
    expect(row.codexCleanupArchive?.state).toBe('archived');
    unlinkSync(alias);
    await expect(restoreCodexCleanupArchive(row, () => {}, rpc)).resolves.toBeUndefined();
    expect(row.codexCleanupArchive).toBeUndefined();
  });
  it('rejects a rollout symlink escaping the canonical home before mutation', async () => {
    const { setCodexAppThreadArchived } = await import('../src/services/codex-app-threads.js');
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rollout-escape-')); tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl'); const env = fakeCodexEnv(dir, { FAKE_CODEX_LOG: logPath });
    mkdirSync(join(env.CODEX_HOME!, 'sessions')); const outside = join(dir, 'outside.jsonl'); writeFileSync(outside, '{}');
    const rollout = join(env.CODEX_HOME!, 'sessions', 'rollout.jsonl'); symlinkSync(outside, rollout);
    await expect(setCodexAppThreadArchived({ threadId: 'native-thread', archived: true, codexHome: env.CODEX_HOME!,
      codexBin: FAKE_CODEX, env: { ...env, FAKE_CODEX_THREAD_PATH: rollout }, timeoutMs: RPC_TIMEOUT_MS })).rejects.toThrow('outside the frozen session home');
    expect(readFileSync(logPath, 'utf8')).not.toContain('thread/archive');
  });
  it('rejects a sessions-directory symlink escaping the canonical home', async () => {
    const { setCodexAppThreadArchived } = await import('../src/services/codex-app-threads.js');
    const dir = mkdtempSync(join(tmpdir(), 'botmux-directory-escape-')); tempDirs.push(dir);
    const env = fakeCodexEnv(dir); const outside = join(dir, 'foreign'); mkdirSync(outside); writeFileSync(join(outside, 'rollout.jsonl'), '{}');
    symlinkSync(outside, join(env.CODEX_HOME!, 'sessions'), 'dir');
    await expect(setCodexAppThreadArchived({ threadId: 'native-thread', archived: true, codexHome: env.CODEX_HOME!,
      codexBin: FAKE_CODEX, env: { ...env, FAKE_CODEX_THREAD_PATH: join(env.CODEX_HOME!, 'sessions', 'rollout.jsonl') }, timeoutMs: RPC_TIMEOUT_MS })).rejects.toThrow('outside the frozen session home');
  });
  it.each(['archive-error', 'hang-archive'])('propagates bounded RPC failure (%s)', async behavior => {
    const p = await probe(true, false, behavior);
    await expect(p.promise).rejects.toThrow();
  });
});
