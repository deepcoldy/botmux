/**
 * `--check-replay`（设计文档 §5.2、§5.6）：对已完成的 run 做只读重放。
 *
 * 不取 lease、不写 journal。起一个 script host，每个 `agent()` 都必须命中缓存
 * （`result` 或已裁决的 `failed`），否则报告「不可只读重放」；脚本返回值与
 * `run.finished.returned` 深度比较——不相等就是违反了 §5.2 编程约束的脚本。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './identity.js';
import { loadJournal } from './journal.js';
import { decideReplay } from './replay.js';
import { linkChildProcess, readRunJson, resolveFlowEntry, type ScriptLink } from './runner.js';
import { SCRIPT_SNAPSHOT_FILE, type ScriptToRunnerMessage } from './types.js';

export interface CheckReplayOptions {
  runDir: string;
  distDir: string;
  spawnScriptHost?: () => ScriptLink;
  timeoutMs?: number;
}

export interface CheckReplayReport {
  ok: boolean;
  /** 只读重放是否走完（false 时 `blocked` 说明卡在哪个 identity）。 */
  completed: boolean;
  blocked: { identity: string; reason: string } | null;
  returnedMatches: boolean | null;
  expected: unknown;
  actual: unknown;
  cacheHits: number;
  error: string | null;
}

export async function checkReplay(opts: CheckReplayOptions): Promise<CheckReplayReport> {
  const { runDir } = opts;
  const loaded = loadJournal(runDir);
  const projection = loaded.projection;
  const runJson = readRunJson(runDir);
  if (!projection.finished) {
    return { ok: false, completed: false, blocked: null, returnedMatches: null, expected: null, actual: null, cacheHits: 0, error: 'run has not finished; --check-replay only applies to finished runs' };
  }
  if (loaded.integrity.dropped.length > 0) {
    return { ok: false, completed: false, blocked: null, returnedMatches: null, expected: null, actual: null, cacheHits: 0, error: `journal integrity: ${loaded.integrity.dropped.length} row(s) dropped` };
  }
  const source = readFileSync(join(runDir, SCRIPT_SNAPSHOT_FILE), 'utf8');
  const started = projection.started;
  const link = (opts.spawnScriptHost ?? (() => defaultSpawn(opts.distDir)))();
  let cacheHits = 0;
  let blocked: CheckReplayReport['blocked'] = null;

  const result = await new Promise<{ kind: 'done'; value: unknown } | { kind: 'error'; message: string }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ kind: 'error', message: `script host did not finish within ${opts.timeoutMs ?? 60_000}ms` });
    }, opts.timeoutMs ?? 60_000);
    link.onExit((code) => {
      clearTimeout(timer);
      resolve({ kind: 'error', message: `script host exited (${code}) before reporting a result` });
    });
    link.onMessage((message: ScriptToRunnerMessage) => {
      switch (message.t) {
        case 'hello':
          link.send({
            t: 'start',
            source,
            input: started?.input ?? runJson?.input ?? null,
            cwd: started?.cwd ?? runJson?.cwd ?? process.cwd(),
            execConfigDigest: started?.execConfigDigest ?? '',
            filename: started?.script ?? 'flow-script.mjs',
          });
          break;
        case 'call': {
          if (message.op === 'position') {
            link.send({ t: 'reply', id: message.id, result: undefined });
            break;
          }
          if (message.op === 'log') {
            link.send({ t: 'reply', id: message.id, result: undefined });
            break;
          }
          if (message.op === 'signal') {
            // signal 且 content 相同 → 直接返回（§5.5）；其它情况只读重放不可能拿到人的输入
            const wait = projection.waits.get(message.identity);
            if (wait && wait.state === 'consumed' && wait.content === message.content && wait.signal) {
              cacheHits++;
              link.send({ t: 'reply', id: message.id, result: { ok: true, value: wait.signal.value, identity: message.identity, attempt: wait.version, evidence: { source: 'signal', confidence: 'high', by: wait.signal.by, version: wait.version } } });
            } else {
              blocked = { identity: message.identity, reason: `signal ${message.identity} has no consumed submission with this content (${wait ? wait.state : 'no wait'})` };
              link.send({ t: 'reject', id: message.id, code: 'not_replayable', message: blocked.reason });
            }
            break;
          }
          const disposition = decideReplay(projection, message.identity, message.content);
          if (disposition.action === 'cached' || disposition.action === 'accept_failed') {
            cacheHits++;
            link.send({ t: 'reply', id: message.id, result: materialize(disposition.outcome) });
          } else {
            blocked = { identity: message.identity, reason: `identity ${message.identity} is not cached (disposition ${disposition.action}${disposition.action === 'run' ? `: ${disposition.reason}` : ''})` };
            link.send({ t: 'reject', id: message.id, code: 'not_replayable', message: blocked.reason });
          }
          break;
        }
        case 'done':
          clearTimeout(timer);
          resolve({ kind: 'done', value: message.value });
          break;
        case 'error':
          clearTimeout(timer);
          resolve({ kind: 'error', message: `${message.code}: ${message.message}` });
          break;
        default:
          break;
      }
    });
  });
  link.kill('SIGTERM');

  if (result.kind === 'error') {
    return { ok: false, completed: false, blocked, returnedMatches: null, expected: projection.finished.returned, actual: null, cacheHits, error: blocked ? null : result.message };
  }
  const expected = projection.finished.returned;
  const returnedMatches = canonicalJson(expected) === canonicalJson(result.value);
  return { ok: returnedMatches, completed: true, blocked: null, returnedMatches, expected, actual: result.value, cacheHits, error: null };
}

function materialize<T extends { ok: boolean; value?: unknown }>(outcome: T): T {
  const value = (outcome as { value?: { $file?: string } }).value;
  if (outcome.ok && value && typeof value === 'object' && typeof value.$file === 'string') {
    return { ...outcome, value: JSON.parse(readFileSync(value.$file, 'utf8')) as unknown };
  }
  return outcome;
}

function defaultSpawn(distDir: string): ScriptLink {
  const { command, args } = resolveFlowEntry('flow-script', distDir);
  return linkChildProcess(spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
}
