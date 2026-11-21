import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createSession,init } from '../src/services/session-store.js';
import { queryTopicSearchOffMainThread } from '../src/dashboard/topic-search-client.js';
import { syncTopicIndex } from '../src/services/topic-search/index-store.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(homedir(),'topic-query-worker-')); vi.stubEnv('SESSION_DATA_DIR',dataDir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dataDir,{ recursive: true,force: true }); });

describe('Dashboard topic query worker', () => {
  it('runs the real query in a child and preserves anchor/candidate options across the protocol', async () => {
    mkdirSync(join(dataDir,'queues'),{ recursive: true });
    for (const [anchor,id,text] of [['om_other','om_other','needle other'],['om_visible','om_visible','needle visible']] as const) {
      writeFileSync(join(dataDir,'queues',`${anchor}.jsonl`),JSON.stringify({ messageId: id,content: text,createTime: 1000 })+'\n');
    }
    await syncTopicIndex(dataDir);
    init('cli_worker');
    const visible = createSession('oc_chat','om_visible','visible','group','thread');
    createSession('oc_chat','om_other','other','group','thread');
    init('cli_detached',{ owner: false });
    const { command,prefixArgs } = tsRunnerPrefix();
    const entry = { command,args: [...prefixArgs,join(process.cwd(),'src/index-topic-search-query.ts')] };
    const result = await queryTopicSearchOffMainThread(dataDir,{ query: 'needle',limit: 20,hits: 1 },{
      visibleSessionIds: new Set([visible.sessionId]),candidateLimit: 5,busyTimeoutMs: 250,
    },entry);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ anchor: 'om_visible',hits: { items: [{ snippet: 'needle visible' }] } });
  });

  it('lets the parent event loop run before a slow worker completes', async () => {
    const { command,prefixArgs } = tsRunnerPrefix();
    const entry = { command,args: [...prefixArgs,join(process.cwd(),'test/fixtures/topic-search-query-slow-worker.ts')] };
    const pending = queryTopicSearchOffMainThread(dataDir,{ query: 'slow' },{ sessions: [] },entry);
    const winner = await Promise.race([
      pending.then(() => 'worker'),
      new Promise<string>(resolve => setImmediate(() => resolve('sibling'))),
    ]);
    expect(winner).toBe('sibling');
    expect((await pending).query).toBe('slow');
  });
});
