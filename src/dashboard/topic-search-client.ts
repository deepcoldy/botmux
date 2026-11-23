import { spawn } from 'node:child_process';
import { chmodSync,mkdtempSync,readFileSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntrySpawn } from '../core/self-spawn.js';
import { fleetDistDir } from '../core/fleet-runtime.js';
import type { searchTopics, SearchRequest, TopicSearchOptions } from '../services/topic-search/query.js';

const QUERY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_QUERIES = 2;
let activeQueries = 0;

type SearchResult = ReturnType<typeof searchTopics>;

/** Run the synchronous SQLite query in a one-shot child. The 250 ms browser
 * debounce keeps process creation bounded; timeout/output/concurrency caps keep
 * a pathological corpus from becoming a Dashboard-wide resource failure. */
export async function queryTopicSearchOffMainThread(
  dataDir: string, request: SearchRequest, options: TopicSearchOptions,
  injectedEntry?: { command: string;args: string[] },
): Promise<SearchResult> {
  if (activeQueries >= MAX_CONCURRENT_QUERIES) throw new Error('topic_search_query_busy');
  activeQueries++;
  let scratch: string | undefined;
  try {
    const { command,args } = injectedEntry ?? resolveEntrySpawn('topic-search-query',fleetDistDir());
    const input = JSON.stringify({
      dataDir,request,
      options: { ...options,anchors: options.anchors === undefined ? undefined : [...options.anchors],
        visibleSessionIds: options.visibleSessionIds === undefined ? undefined : [...options.visibleSessionIds] },
    });
    scratch = mkdtempSync(join(tmpdir(),'botmux-topic-query-'));
    chmodSync(scratch,0o700);
    const resultPath = join(scratch,'result.json');
    return await new Promise<SearchResult>((resolve,reject) => {
      const child = spawn(command,[...args,resultPath],{ env: process.env,stdio: ['pipe','ignore','ignore'] });
      let settled = false;
      const timer = setTimeout(() => finish(new Error('topic_search_query_timeout')),QUERY_TIMEOUT_MS);
      const finish = (error?: Error,result?: SearchResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { child.kill('SIGKILL'); reject(error); }
        else if (result) resolve(result);
        else reject(new Error('topic_search_query_empty_result'));
      };
      child.once('error',error => finish(error));
      child.once('close',(code,signal) => {
        if (settled) return;
        if (code !== 0) { finish(new Error(`topic_search_query_exit_${code ?? signal ?? 'unknown'}`)); return; }
        try {
          if (statSync(resultPath).size > MAX_OUTPUT_BYTES) { finish(new Error('topic_search_query_output_limit')); return; }
          const envelope = JSON.parse(readFileSync(resultPath,'utf8')) as { ok?: boolean;result?: SearchResult;error?: string };
          if (envelope.ok !== true || !envelope.result) { finish(new Error(envelope.error ?? 'topic_search_query_invalid_result')); return; }
          finish(undefined,envelope.result);
        } catch { finish(new Error('topic_search_query_invalid_result')); }
      });
      child.stdin.on('error',error => finish(error));
      child.stdin.end(input);
    });
  } finally {
    activeQueries--;
    if (scratch) rmSync(scratch,{ recursive: true,force: true });
  }
}
