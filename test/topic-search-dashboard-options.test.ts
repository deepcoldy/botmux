import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTopicIndex, topicIndexPath } from '../src/services/topic-search/index-store.js';
import { searchTopics } from '../src/services/topic-search/query.js';
import * as sources from '../src/services/topic-search/sources.js';
import { createSession, init } from '../src/services/session-store.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(), 'topic-dashboard-options-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  mkdirSync(join(dataDir, 'queues'));
  writeFileSync(join(dataDir, 'queues/om_root.jsonl'), JSON.stringify({
    messageId: 'om_message', content: 'dashboard needle', createTime: 1000,
  }) + '\n');
});
afterEach(() => {
  init('cli_detached', { owner: false });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('topic query options for Dashboard', () => {
  it('uses the supplied session snapshot without reading stores, including an empty snapshot', async () => {
    init('cli_dashboard');
    const session = createSession('oc_chat', 'om_root', 'stored title', 'group', 'thread');
    init('cli_detached', { owner: false });
    await syncTopicIndex(dataDir);
    const read = vi.spyOn(sources, 'readTopicSessions').mockImplementation(() => { throw new Error('unexpected session read'); });
    const snapshot = [{ ...session, title: 'cached title' }];
    const result = searchTopics(dataDir, { query: 'needle' }, [], { sessions: snapshot });
    expect(result.results[0]).toMatchObject({ title: 'cached title', sessions: [{ sessionId: session.sessionId }] });
    const empty = searchTopics(dataDir, { query: 'needle' }, [], { sessions: [] });
    expect(empty.results[0].sessions).toEqual([]);
    expect(empty.results[0].notes).toContain('meta_missing');
    expect(read).not.toHaveBeenCalled();
  });

  // No parent opens this index: Bun's closed connections retain shared locks until GC.
  it('expires a 250ms read wait during a transient lock for both direct opens and searches', async () => {
    async function child(source: string, whileLocked?: () => Promise<void>): Promise<string> {
      const proc = spawnTsEvalWithRepoImports(source, {
        cwd: process.cwd(), env: { ...process.env, SESSION_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = new Promise<number | null>(resolve => proc.once('close', resolve));
      let output = ''; let stderr = '';
      proc.stdout?.on('data', data => { output += String(data); });
      proc.stderr?.on('data', data => { stderr += String(data); });
      proc.on('error', error => { stderr += error.message; });
      try {
        if (whileLocked) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(`lock holder not ready: ${stderr}`)), 10_000);
            const onData = () => { if (output.includes('locked\n')) finish(); };
            const onClose = () => finish(new Error(`lock holder exited: ${stderr}`));
            const finish = (error?: Error) => {
              clearTimeout(timer); proc.stdout?.off('data', onData);
              proc.off('close', onClose); proc.off('error', finish);
              if (error) reject(error); else resolve();
            };
            proc.stdout?.on('data', onData); proc.once('close', onClose); proc.once('error', finish);
          });
          await whileLocked();
        }
        expect(await closed, stderr).toBe(0);
        return output;
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        await closed;
      }
    }
    const dir = JSON.stringify(dataDir);
    const imports = "import { openTopicIndex,syncTopicIndex } from './src/services/topic-search/index-store.js'; import { searchTopics } from './src/services/topic-search/query.js';";
    await child(`${imports} await syncTopicIndex(${dir});`);
    for (const operation of [
      `openTopicIndex(${dir},{ readOnly: true,busyTimeoutMs: 250 }).close();`,
      `searchTopics(${dir},{ query: 'needle' },[],{ sessions: [],busyTimeoutMs: 250 });`,
    ]) {
      await child(`
        import { openDatabaseSyncOrThrow } from './src/services/sqlite-compat.js';
        const db = openDatabaseSyncOrThrow(${JSON.stringify(topicIndexPath(dataDir))});
        db.exec('PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE sync_meta SET last_sync_started_at=0 WHERE singleton=1; COMMIT');
        process.stdout.write('locked\\n');
        setTimeout(() => db.close(),3000);
      `, async () => {
        const result = await child(`${imports}
          try { ${operation} process.stdout.write('unexpected_open'); }
          catch (error) {
            if (!/busy|locked/i.test(String(error))) throw error;
            process.stdout.write('read_wait_expired');
          }
        `);
        expect(result).toBe('read_wait_expired');
      });
    }
  }, 30_000);
});
