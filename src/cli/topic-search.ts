import { existsSync,lstatSync,readdirSync,rmSync } from 'node:fs';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { parseTopicQuery,searchTopics,showTopic,TopicQueryError,type SearchRequest } from '../services/topic-search/query.js';
import { openTopicIndex,syncTopicIndex,topicIndexPath,TopicIndexError,assertTopicIndexEngine } from '../services/topic-search/index-store.js';
import { readTopicStatus,topicSearchEnabled } from '../services/topic-search/status.js';

type Format = 'json'|'text';
export type TopicArguments = { command: 'search'; request: SearchRequest; format: Format }
  | { command: 'show'; target: string; limit: number; format: Format }
  | { command: 'status' } | { command: 'reindex'; rebuild: boolean };
export function parseTopicArguments(args: readonly string[]): TopicArguments {
  const command = args[0];
  if (!['search','show','status','reindex'].includes(command ?? '')) throw new TopicQueryError('用法：botmux topic search|show|status|reindex');
  const words: string[] = [];
  const values = new Map<string,string>();
  let rebuild = false;
  for (let i=1;i<args.length;i++) {
    const arg = args[i];
    if (arg === '--rebuild' && command === 'reindex' && !rebuild) { rebuild = true; continue; }
    if (!arg.startsWith('-')) { words.push(arg); continue; }
    const allowed = command === 'search' ? ['--limit','--hits','--since','--until','--bot','--format']
      : command === 'show' ? ['--limit','--format'] : [];
    if (!allowed.includes(arg) || values.has(arg)) throw new TopicQueryError(`未知或重复参数：${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new TopicQueryError(`参数缺少值：${arg}`);
    values.set(arg,value);
  }
  const format = values.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'text') throw new TopicQueryError('format 只能为 json 或 text');
  const number = (name: string, fallback: number): number => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new TopicQueryError(`无效数字：${name}`);
    return Number(value);
  };
  if (command === 'search') {
    const request: SearchRequest = { query: words,limit: number('--limit',20),hits: number('--hits',3),
      since: values.get('--since'),until: values.get('--until'),bot: values.get('--bot') };
    parseTopicQuery(request); return { command,request,format };
  }
  if (command === 'show') {
    const limit = number('--limit',200);
    if (words.length !== 1 || limit < 1 || limit > 2000) throw new TopicQueryError('show 需要一个 anchor/messageId，limit 为 1..2000');
    return { command,target: words[0],limit,format };
  }
  if (words.length) throw new TopicQueryError('多余的位置参数');
  if (command === 'status') return { command };
  return { command: 'reindex',rebuild };
}
function localTime(value: number | null | undefined): string {
  if (value == null) return '';
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function prepareRebuild(dataDir: string): void {
  const path = topicIndexPath(dataDir);
  if (!existsSync(path)) return;
  try { openTopicIndex(dataDir,{ readOnly: true }).close(); return; }
  catch (error) {
    if (error instanceof TopicIndexError && error.message === 'topic_index_schema_mismatch') return;
    if (!/not a database|malformed|corrupt/i.test(String(error))) throw error;
    // Only recognizable corruption authorizes file replacement. A valid foreign
    // database, a busy connection, and an unreadable file are never unlinked.
    for (const candidate of [path,`${path}-wal`,`${path}-shm`]) {
      if (existsSync(candidate) && !lstatSync(candidate).isFile()) throw new TopicIndexError('unsafe_topic_index_file');
    }
    for (const candidate of [path,`${path}-wal`,`${path}-shm`]) rmSync(candidate,{ force: true });
  }
}
export async function topicSearchCommand(args: readonly string[], io: {
  out(text: string): void; err(text: string): void;
} = { out: text => { process.stdout.write(text); },err: text => { process.stderr.write(text); } }): Promise<number> {
  let parsed: TopicArguments;
  try { parsed = parseTopicArguments(args); }
  catch (error) { io.err(`${error instanceof Error ? error.message : String(error)}\n`); return 2; }
  const dataDir = resolveBotmuxDataDir();
  try {
    if (parsed.command === 'status') { io.out(JSON.stringify({ schema: 'botmux.topic-search.v1',...readTopicStatus(dataDir) })+'\n'); return 0; }
    readdirSync(dataDir);
    if (parsed.command === 'reindex') {
      if (!topicSearchEnabled()) throw new TopicIndexError('话题检索已关闭');
      assertTopicIndexEngine();
      if (parsed.rebuild) prepareRebuild(dataDir);
      const sync = await syncTopicIndex(dataDir,{ rebuild: parsed.rebuild });
      io.out(JSON.stringify({ schema: 'botmux.topic-search.v1',...sync,...readTopicStatus(dataDir,'query') })+'\n'); return 0;
    }
    const status = readTopicStatus(dataDir,'query');
    if (!status.available) throw new TopicIndexError('索引尚未建立或不可用：确认 botmux status 里有 topic-index，或执行 botmux topic reindex --rebuild');
    if (parsed.command === 'search') {
      const value = searchTopics(dataDir,parsed.request);
      if (parsed.format === 'json') io.out(JSON.stringify({ schema: 'botmux.topic-search.v1',...value,index: status.index,coverage: status.coverage })+'\n');
      else for (const result of value.results) {
        io.out(`${result.title}\t${result.chatName ?? ''}\t${localTime(result.lastActiveAt)}\t${result.status}\n${result.link ?? ''}\n`);
        for (const hit of result.hits.items) io.out(`  ${localTime(hit.time)} ${hit.bot ?? hit.senderType ?? ''} ${hit.snippet}\n`);
      }
      return value.results.length ? 0 : 1;
    }
    const value = showTopic(dataDir,parsed.target,parsed.limit);
    if (parsed.format === 'json') io.out(JSON.stringify({ schema: 'botmux.topic-search.v1',...value,index: status.index,coverage: status.coverage })+'\n');
    else if (value) for (const doc of value.documents) io.out(`${localTime(doc.time_ms)} ${doc.kind} ${doc.sender_name ?? doc.sender_type ?? ''}\n${doc.text}\n`);
    return value ? 0 : 1;
  } catch (error) {
    if (error instanceof TopicQueryError) { io.err(error.message+'\n'); return 2; }
    const denied = error instanceof Error && 'code' in error && ['EACCES','EPERM'].includes(String(error.code));
    io.err(`${denied ? '当前环境无法读取 botmux 数据目录' : error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof TopicIndexError ? error.exitCode : parsed.command === 'reindex' && /busy|locked/i.test(String(error)) ? 5 : 4;
  }
}
