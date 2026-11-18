import { appendFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { topicSearchCommand,parseTopicArguments } from '../src/cli/topic-search.js';
import { topicIndexPath,TopicIndexError } from '../src/services/topic-search/index-store.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { _resetGroupContextStoreForTest, upsertGroupContextMessage } from '../src/services/group-context-store.js';
import * as readonlySource from '../src/services/topic-search/readonly-sqlite.js';
import * as indexStore from '../src/services/topic-search/index-store.js';
import { readTopicStatus } from '../src/services/topic-search/status.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { writeFleetState } from '../src/core/fleet-state-store.js';
import { freshProc } from '../src/core/fleet-supervisor-policy.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(homedir(),'topic-cli-')); vi.stubEnv('SESSION_DATA_DIR',dataDir);
  vi.stubEnv('BOTMUX_TOPIC_SEARCH','1');
  vi.stubEnv('BOTMUX_SESSION_ID','');
});
afterEach(() => { _resetGroupContextStoreForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dataDir,{ recursive: true,force: true }); });
async function command(args: string[]) {
  let out = ''; let err = '';
  const code = await topicSearchCommand(args,{ out: text => { out += text; },err: text => { err += text; } });
  return { code,out,err };
}
function seed() {
  mkdirSync(join(dataDir,'queues'));
  writeFileSync(join(dataDir,'queues/om_root.jsonl'),JSON.stringify({ messageId: 'om_message',content: '风险 needle',createTime: 1000 })+'\n{bad\n');
}

describe('topic CLI', () => {
  it('strictly accepts only the specified commands, options and argument ranges', async () => {
    for (const args of [[],['other'],['search'],['search','x','--unknown'],['search','x','--limit','101'],
      ['show','a','b'],['show','a','--hits','1'],['status','--format','text'],['reindex','--bot','x'],['reindex','--rebuild','--rebuild']]) {
      expect((await command(args)).code,args.join(' ')).toBe(2);
    }
    expect(parseTopicArguments(['search','风险','needle','--hits','1','--format','text'])).toMatchObject({ command: 'search',format: 'text' });
  });
  it('reports an absent index through status with exit zero and search with exit four', async () => {
    expect((await command(['status'])).code).toBe(0);
    expect((await command(['search','needle'])).code).toBe(4);
  });
  it('reindexes, returns the JSON schema and coverage, detects changed/deleted sources, and shows documents', async () => {
    seed(); expect((await command(['reindex'])).code).toBe(0);
    const db = openDatabaseSyncOrThrow(topicIndexPath(dataDir));
    try {
      // Bun may defer closing the index writer until GC finalizes its statements;
      // checkpoint before the byte snapshot so that close cannot rewrite it mid-assertion.
      expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
    } finally { db.close(); }
    const result = await command(['search','风险','needle']);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.out);
    expect(value).toMatchObject({ schema: 'botmux.topic-search.v1',query: '风险 needle',index: { stale: false,indexer: 'unknown' },
      coverage: { skipped: 0,malformedLines: 1,sources: { queues: 1,groupContext: 'absent',outputJournal: 'absent' } } });
    expect(value.results[0].anchor).toBe('om_root');
    const before = readFileSync(topicIndexPath(dataDir)); const time = statSync(topicIndexPath(dataDir)).mtimeMs;
    expect((await command(['show','om_message'])).code).toBe(0);
    expect((await command(['show','missing'])).code).toBe(1);
    expect((await command(['search','notfound'])).code).toBe(1);
    expect((await command(['search','needle','--format','text'])).out).toContain('needle');
    expect(readFileSync(topicIndexPath(dataDir))).toEqual(before); expect(statSync(topicIndexPath(dataDir)).mtimeMs).toBe(time);
    appendFileSync(join(dataDir,'queues/om_root.jsonl'),'\n');
    expect(readTopicStatus(dataDir).index).toMatchObject({ stale: true,staleSources: 1 });
    rmSync(join(dataDir,'queues/om_root.jsonl'));
    expect(readTopicStatus(dataDir).index.staleSources).toBe(1);
  });
  it('keeps queries lightweight and ignores session-store revisions when reporting freshness', async () => {
    seed(); await command(['reindex']);
    mkdirSync(join(dataDir,'session-stores/cli_other'),{ recursive: true });
    writeFileSync(join(dataDir,'session-stores/cli_other/sessions.db'),'unreadable session fixture');
    new OutputDeliveryJournal(dataDir,'cli_other').close();
    upsertGroupContextMessage('cli_other',{ messageId: 'om_optional',chatId: 'oc_chat',rootId: 'om_optional',
      threadId: 'omt_optional',conversationScope: 'thread',senderId: 'ou_sender',senderType: 'user',msgType: 'text',
      text: 'optional source',createTime: Date.now(),resourceRefs: [],sourceAppId: 'cli_other' });
    _resetGroupContextStoreForTest();
    const opened = vi.spyOn(readonlySource,'openReadonlySource');
    const engine = vi.spyOn(indexStore,'assertTopicIndexEngine');
    const result = await command(['search','needle']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ index: { stale: true,staleSources: 2 },
      coverage: { sources: { groupContext: 'empty',outputJournal: 'empty' } } });
    expect((await command(['show','om_message'])).code).toBe(0);
    expect(opened).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled();
    rmSync(join(dataDir,'group-context'),{ recursive: true });
    rmSync(join(dataDir,'output-delivery-journals'),{ recursive: true });
    expect(readTopicStatus(dataDir,'query').index).toMatchObject({ stale: false,staleSources: 0 });
  });
  it('prints local minute-resolution time in text output while JSON keeps milliseconds', async () => {
    seed(); await command(['reindex']);
    const date = new Date(1000);
    const pad = (value: number) => String(value).padStart(2,'0');
    const expected = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    expect((await command(['search','needle','--format','text'])).out).toContain(expected);
    expect((await command(['show','om_message','--format','text'])).out).toContain(expected);
    expect(JSON.parse((await command(['search','needle'])).out).results[0].hits.items[0].time).toBe(1000);
  });
  it('keeps the existing inode on rebuild, replaces recognizable corruption and refuses foreign databases', async () => {
    seed(); await command(['reindex']);
    const path = topicIndexPath(dataDir); const inode = statSync(path).ino;
    expect((await command(['reindex','--rebuild'])).code).toBe(0);
    expect(statSync(path).ino).toBe(inode);
    writeFileSync(path,'corrupt sqlite bytes');
    expect((await command(['reindex','--rebuild'])).code).toBe(0);
    rmSync(path); const foreign = openDatabaseSyncOrThrow(path); foreign.exec('CREATE TABLE secrets(value TEXT)'); foreign.close();
    const before = readFileSync(path);
    expect((await command(['reindex','--rebuild'])).code).toBe(4);
    expect(readFileSync(path)).toEqual(before);
  });
  it('recognizes only zero as disabled and maps write-lock timeouts to exit five', async () => {
    vi.stubEnv('BOTMUX_TOPIC_SEARCH','0'); expect((await command(['reindex'])).code).toBe(4);
    vi.stubEnv('BOTMUX_TOPIC_SEARCH','false');
    vi.spyOn(indexStore,'syncTopicIndex').mockRejectedValueOnce(new TopicIndexError('lock timeout',5));
    expect((await command(['reindex'])).code).toBe(5);
  });
  it('uses the same persisted lifecycle setting as supervisor startup', async () => {
    const directory = join(homedir(),'.botmux'); mkdirSync(directory,{ recursive: true });
    const path = join(directory,'.env');
    const previous = (() => { try { return readFileSync(path); } catch { return undefined; } })();
    try {
      writeFileSync(path,'BOTMUX_TOPIC_SEARCH=0\n');
      vi.stubEnv('BOTMUX_SESSION_ID','managed_session'); vi.stubEnv('BOTMUX_TOPIC_SEARCH','1');
      expect((await command(['reindex'])).code).toBe(4);
      expect(readTopicStatus(dataDir).index.indexer).toBe('disabled');
    } finally { if (previous) writeFileSync(path,previous); else rmSync(path,{ force: true }); }
  });
  it('reports running, stopped, errored and disabled indexers from the fleet state', () => {
    const directory = join(homedir(),'.botmux'); mkdirSync(directory,{ recursive: true });
    const path = join(directory,'fleet-state.json');
    const previous = (() => { try { return readFileSync(path); } catch { return undefined; } })();
    try {
      const proc = freshProc('topic-index','',process.pid,'T');
      writeFleetState(path,{ supervisorPid: process.pid,supervisorStartedAt: 'T',procs: [proc] });
      expect(readTopicStatus(dataDir).indexer).toMatchObject({ state: 'running',pid: process.pid,restarts: 0 });
      writeFleetState(path,{ supervisorPid: process.pid,supervisorStartedAt: 'T',procs: [{ ...proc,status: 'stopped',pid: 0 }] });
      expect(readTopicStatus(dataDir).index.indexer).toBe('stopped');
      writeFleetState(path,{ supervisorPid: process.pid,supervisorStartedAt: 'T',procs: [{ ...proc,status: 'errored',pid: 0,restarts: 3 }] });
      expect(readTopicStatus(dataDir).indexer).toMatchObject({ state: 'errored',restarts: 3 });
      vi.stubEnv('BOTMUX_TOPIC_SEARCH','0'); expect(readTopicStatus(dataDir).index.indexer).toBe('disabled');
    } finally { if (previous) writeFileSync(path,previous); else rmSync(path,{ force: true }); }
  });
});
