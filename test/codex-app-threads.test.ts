import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCodexAppThreadName } from '../src/services/codex-app-threads.js';

const FAKE_CODEX = resolve('test/fixtures/fake-codex-app-server.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  it('waits until the automatic Codex title is readable before setting the final title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-codex-thread-title-barrier-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'requests.jsonl');

    await setCodexAppThreadName({
      threadId: 'thread-delayed-title',
      name: '[BotMux·Lark] 最终标题',
      codexBin: FAKE_CODEX,
      cwd: dir,
      env: {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_TITLE_DELAY_READS: '2',
      },
      timeoutMs: 20_000,
      waitForExistingName: true,
    });

    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).method);
    const setIndex = methods.indexOf('thread/name/set');
    expect(methods.slice(0, setIndex).filter(method => method === 'thread/read')).toHaveLength(3);
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
