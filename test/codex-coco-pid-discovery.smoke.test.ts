/**
 * 跨平台冒烟测试：`findCodexRolloutByPid` / `findCocoSessionByPid` 必须在
 * Linux 和 macOS 上都能定位一个真实子进程持有的伪 rollout / events 文件。
 *
 * 这里不 mock —— spawn 一个 Node 子进程，让它 `fs.openSync()` 几个事先在
 * tmp 下伪造好的 jsonl / log 文件（路径里 anchor 子串与生产路径一致），
 * 然后用待测函数按 pid 反查。配合 `coco-transcript.test.ts` / `codex-
 * transcript.test.ts` 的纯逻辑单测，这套 smoke 覆盖 macOS lsof 兜底回归
 * （没有这个测试，Linux CI 永远绿、macOS 上 /adopt 实际坏掉也察觉不到）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findCodexRolloutByPid, findCodexRolloutSetByPid } from '../src/services/codex-transcript.js';
import { findCocoSessionByPid } from '../src/services/coco-transcript.js';

const CODEX_SID = '019dd80d-d922-7a11-8339-0208d8c5b4ec';
const CODEX_SIBLING_SID = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
const COCO_SID = '8db7d911-96f3-4764-a310-e42ae4cb626f';

let dir: string;
let codexRollout: string;
let codexSiblingRollout: string;
let cocoSessionLog: string;
let child: ChildProcessWithoutNullStreams;
let ambiguousChild: ChildProcessWithoutNullStreams;
let customHomeChild: ChildProcessWithoutNullStreams;
let customHomeRollout: string;
const CUSTOM_HOME_SID = '019dd80d-d922-7a11-8339-0208d8c5b4ea';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-pid-disc-'));
  // 伪 Codex rollout：路径里必须含 `.codex/sessions/`，文件名要满足
  // codexSessionIdFromRolloutPath 的 `rollout-<ts>-<uuid>.jsonl` 正则。
  const codexDir = join(dir, '.codex', 'sessions', '2026', '05', '15');
  mkdirSync(codexDir, { recursive: true });
  codexRollout = join(codexDir, `rollout-2026-05-15T07-04-39-${CODEX_SID}.jsonl`);
  codexSiblingRollout = join(codexDir, `rollout-2026-05-15T07-04-40-${CODEX_SIBLING_SID}.jsonl`);
  writeFileSync(codexRollout, '');
  writeFileSync(codexSiblingRollout, '');
  // 伪 CoCo 会话目录：路径里必须含 `/.cache/coco/sessions/<uuid>/`。session.log
  // 模拟 CoCo 长持有的 fd（events.jsonl 是 open-write-close，不靠谱）。
  const cocoDir = join(dir, '.cache', 'coco', 'sessions', COCO_SID);
  mkdirSync(cocoDir, { recursive: true });
  cocoSessionLog = join(cocoDir, 'session.log');
  writeFileSync(cocoSessionLog, '');

  child = spawn(
    process.execPath,
    [
      '-e',
      `
        const fs = require('fs');
        fs.openSync(${JSON.stringify(codexRollout)}, 'a');
        fs.openSync(${JSON.stringify(cocoSessionLog)}, 'a');
        process.stdout.write('ready\\n');
        setTimeout(() => {}, 60000);
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child not ready in 5s')), 5000);
    child.stdout.once('data', (buf: Buffer) => {
      if (buf.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });

  ambiguousChild = spawn(
    process.execPath,
    [
      '-e',
      `
        const fs = require('fs');
        fs.openSync(${JSON.stringify(codexRollout)}, 'a');
        fs.openSync(${JSON.stringify(codexSiblingRollout)}, 'a');
        process.stdout.write('ready\\n');
        setTimeout(() => {}, 60000);
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ambiguous child not ready in 5s')), 5000);
    ambiguousChild.stdout.once('data', (buf: Buffer) => {
      if (buf.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    ambiguousChild.once('error', reject);
  });

  // Custom CODEX_HOME: rollout path has NO `/.codex/` segment. Verifies the
  // ownership probe recognizes it by the structural `/sessions/rollout-…` shape
  // (an adopted external Codex may run under a CODEX_HOME the worker never
  // inherited; the fd already comes from the pid, so the path anchor must be
  // env-independent). `customhome` deliberately omits `.codex`.
  const customHomeDir = join(dir, 'customhome', 'sessions', '2026', '05', '15');
  mkdirSync(customHomeDir, { recursive: true });
  customHomeRollout = join(customHomeDir, `rollout-2026-05-15T07-04-41-${CUSTOM_HOME_SID}.jsonl`);
  writeFileSync(customHomeRollout, '');
  customHomeChild = spawn(
    process.execPath,
    ['-e', `require('fs').openSync(${JSON.stringify(customHomeRollout)}, 'a'); process.stdout.write('ready\\n'); setTimeout(() => {}, 60000);`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('custom-home child not ready in 5s')), 5000);
    customHomeChild.stdout.once('data', (buf: Buffer) => {
      if (buf.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    customHomeChild.once('error', reject);
  });
});

afterAll(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  if (ambiguousChild && !ambiguousChild.killed) ambiguousChild.kill('SIGKILL');
  if (customHomeChild && !customHomeChild.killed) customHomeChild.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('findCodexRolloutByPid', () => {
  it('locates the rollout fd a live process has open and extracts sid', () => {
    const hit = findCodexRolloutByPid(child.pid!);
    expect(hit).toBeDefined();
    expect(hit!.cliSessionId).toBe(CODEX_SID);
    // macOS lsof 会把 tmp 路径解析成 /private/tmp/... —— 用文件名 anchor
    // 而不是完整路径比较。
    expect(hit!.path.endsWith(`rollout-2026-05-15T07-04-39-${CODEX_SID}.jsonl`)).toBe(true);
  });

  it('does not guess when one process holds multiple rollout files', () => {
    expect(findCodexRolloutByPid(ambiguousChild.pid!)).toBeUndefined();
  });

  it('returns undefined for a non-existent pid', () => {
    expect(findCodexRolloutByPid(2_000_000)).toBeUndefined();
  });

  it('rejects invalid pids', () => {
    expect(findCodexRolloutByPid(0)).toBeUndefined();
    expect(findCodexRolloutByPid(-1)).toBeUndefined();
    expect(findCodexRolloutByPid(1.5 as any)).toBeUndefined();
  });
});

// findCodexRolloutSetByPid is the ownership gate for post-submit rollout
// re-attach: it must NOT collapse the parent+sibling multi-rollout case to
// undefined (that's the case the bridge must ALLOW), and it must let a caller
// prove a history-derived sid is foreign (not in this pid's fd set) so a
// shared-CODEX_HOME sibling's identical-text history line can't hijack the
// binding. Same real-subprocess strategy as above so macOS lsof stays covered.
describe('findCodexRolloutSetByPid', () => {
  it('returns the single sid a one-rollout process holds', () => {
    const set = findCodexRolloutSetByPid(child.pid!);
    expect(set).toBeDefined();
    expect(set!.has(CODEX_SID.toLowerCase())).toBe(true);
    expect(set!.size).toBe(1);
  });

  it('returns BOTH sids for the parent+sibling multi-rollout process (does not collapse to undefined)', () => {
    const set = findCodexRolloutSetByPid(ambiguousChild.pid!);
    expect(set).toBeDefined();
    // The exact case findCodexRolloutByPid refuses to guess — here we must see
    // every open rollout so `historySid ∈ set` can admit the authoritative one.
    expect(set!.has(CODEX_SID.toLowerCase())).toBe(true);
    expect(set!.has(CODEX_SIBLING_SID.toLowerCase())).toBe(true);
    expect(set!.size).toBe(2);
  });

  it('does not contain a foreign sid (shared-CODEX_HOME poison is rejectable)', () => {
    const foreignSid = '019dd80d-d922-7a11-8339-0208d8c5b4ff';
    const set = findCodexRolloutSetByPid(child.pid!);
    expect(set).toBeDefined();
    expect(set!.has(foreignSid.toLowerCase())).toBe(false);
  });

  it('returns undefined (fail-closed) for a non-existent or invalid pid', () => {
    expect(findCodexRolloutSetByPid(2_000_000)).toBeUndefined();
    expect(findCodexRolloutSetByPid(0)).toBeUndefined();
    expect(findCodexRolloutSetByPid(-1)).toBeUndefined();
    expect(findCodexRolloutSetByPid(1.5 as any)).toBeUndefined();
  });

  it('recognizes a rollout under a custom CODEX_HOME with no /.codex/ segment', () => {
    // Env-independent structural anchor: the path came from the pid's fd, so it
    // must be recognized by its `/sessions/rollout-<ts>-<uuid>.jsonl` shape even
    // when CODEX_HOME is a custom/isolated root the worker never inherited.
    const set = findCodexRolloutSetByPid(customHomeChild.pid!);
    expect(set).toBeDefined();
    expect(set!.has(CUSTOM_HOME_SID.toLowerCase())).toBe(true);
  });
});

describe('findCocoSessionByPid', () => {
  it('locates a coco session via an open file under the session dir', () => {
    const hit = findCocoSessionByPid(child.pid!);
    expect(hit).toBeDefined();
    expect(hit!.sessionId).toBe(COCO_SID);
    // eventsPath 是从 sessionId 由 cocoEventsPathForSession 推出来的，绑到
    // 真实 homedir 下；这里只断言尾段。跨平台两条形态（macOS Library/Caches
    // vs Linux .cache）都接受。
    const tail = `coco/sessions/${COCO_SID}/events.jsonl`;
    expect(hit!.eventsPath.endsWith(tail)).toBe(true);
  });

  it('returns undefined for a non-existent pid', () => {
    expect(findCocoSessionByPid(2_000_000)).toBeUndefined();
  });

  it('rejects invalid pids', () => {
    expect(findCocoSessionByPid(0)).toBeUndefined();
    expect(findCocoSessionByPid(-1)).toBeUndefined();
    expect(findCocoSessionByPid(1.5 as any)).toBeUndefined();
  });
});
