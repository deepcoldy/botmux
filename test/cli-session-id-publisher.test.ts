import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTsScript } from './helpers/ts-runner.js';

const children = new Set<ChildProcess>();

function waitForMessage(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 10_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`publisher child exited before ${type}: ${code}`));
    };
    const onMessage = (message: any) => {
      if (message?.type !== type) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('message', onMessage);
      resolve(message);
    };
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
});

describe('CLI session id persistence ownership', () => {
  it('publishes through daemon IPC without letting a stale worker projection overwrite Riff lineage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cli-session-owner-'));
    const path = join(dir, 'sessions.json');
    const sessionId = 'session-riff-lineage';
    writeFileSync(path, JSON.stringify({
      [sessionId]: { sessionId, riffParentTaskId: 'task-parent' },
    }));

    // fork(…, { execArgv: ['--import','tsx'] }) is Node-only; the runtime-aware
    // spawn keeps the same IPC channel via the explicit 'ipc' stdio slot.
    const child = spawnTsScript(join(process.cwd(), 'test/fixtures/cli-session-id-publisher-child.ts'), [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.add(child);
    const loaded = waitForMessage(child, 'loaded');
    child.send({ type: 'load', path, sessionId });
    await expect(loaded).resolves.toMatchObject({
      riffParentTaskId: 'task-parent',
    });

    // The daemon commits a newer Riff child while the separate worker process
    // still holds the old full projection in memory.
    writeFileSync(path, JSON.stringify({
      [sessionId]: { sessionId, riffParentTaskId: 'task-child' },
    }));
    const published = waitForMessage(child, 'published');
    child.send({
      type: 'publish',
      sessionId,
      cliSessionId: 'cli-native-child',
      turnId: 'turn-1',
      dispatchAttempt: 2,
    });

    await expect(published).resolves.toMatchObject({
      published: true,
      initCliSessionId: 'cli-native-child',
      publishedMessage: {
        type: 'cli_session_id',
        cliSessionId: 'cli-native-child',
        turnId: 'turn-1',
        dispatchAttempt: 2,
      },
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))[sessionId].riffParentTaskId).toBe('task-child');

    child.kill('SIGKILL');
    children.delete(child);
    rmSync(dir, { recursive: true, force: true });
  });
});
