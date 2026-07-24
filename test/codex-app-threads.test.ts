import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

    const title = await generateCodexAppThreadTitle({
      sourceText: '这个标题生成永远不会完成',
      codexBin: FAKE_CODEX,
      env: fakeCodexEnv(dir, {
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_PID_PATH: pidPath,
        FAKE_CODEX_BEHAVIOR: 'hang-turn-completion',
      }),
      timeoutMs: 100,
      detached: true,
    });

    expect(title).toBeUndefined();
    expect(existsSync(pidPath)).toBe(true);
    const requests = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(expect.arrayContaining([
      'turn/interrupt',
      'thread/unsubscribe',
    ]));

    const pid = Number(readFileSync(pidPath, 'utf8'));
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
  });
});

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

    const deadline = Date.now() + 2000;
    while (!existsSync(pidPath) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, 'utf8'));

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

    const deadline = Date.now() + 2000;
    while (!existsSync(pidPath) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    expect(forceClose).toBeTypeOf('function');
    const pid = Number(readFileSync(pidPath, 'utf8'));

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
