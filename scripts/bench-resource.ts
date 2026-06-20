#!/usr/bin/env tsx
/**
 * 资源占用优化基准：量化 perf/resource-optimization 一批改动的实际收益。
 *
 * 三个口径，各自构造「修复前」与「修复后」两条等价路径在同一进程里对比，
 * 只测被改动的那一段成本（read/parse 等两条路径都做的工作不计入差值）。
 *
 *   A. 无界 Map vs BoundedMap —— chat 缓存 / lastRepoScan / 各内存表的封顶
 *   B. session-store 冗余 save —— 写盘+rename(前) vs 读+比对跳过(后)
 *   C. worker 屏幕刷新 —— 每个空闲 tick 的 capture 成本（修复后 PTY 静默时跳过）
 *
 * 运行：
 *   pnpm bench:resource              # 完整三项
 *   pnpm bench:resource --json       # 额外输出机器可读 JSON 到 stdout 末尾
 *
 * 堆数字需要 --expose-gc（pnpm 脚本已带）。缺了会跳过 A 的堆测量。
 *
 * 注意：这是受控微基准，规模与机器相关；用于「改动方向是否省资源」的量化，
 * 不等同于端到端 daemon profiling。
 */
import { writeFileSync, renameSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import xtermHeadless from '@xterm/headless';
import { BoundedMap } from '../src/utils/bounded-map.js';
import { readViewportText } from '../src/utils/terminal-renderer.js';

const { Terminal } = xtermHeadless;
const WANT_JSON = process.argv.includes('--json');

function mb(bytes: number): string { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }
function kb(bytes: number): string { return (bytes / 1024).toFixed(1) + ' KB'; }
function ms(n: number): string { return n.toFixed(0) + ' ms'; }

const results: Record<string, unknown> = {};

// ─── A. 内存封顶：无界 Map（修复前）vs BoundedMap（修复后）────────────────────
// 代表 client.ts 的 chatInfo/chatMode/chatStats 缓存、daemon 的 lastRepoScan
// —— 这些此前按 (appId, chatId) 无限累积，daemon 生命周期内永不回收。
function benchMemoryBound(): void {
  console.log('\n=== A. 无界 Map（修复前）vs BoundedMap（修复后） ===');
  if (!global.gc) {
    console.log('  (跳过：未用 --expose-gc 启动，拿不到稳定堆数字)');
    return;
  }
  const N = 200_000; // 模拟长跑 daemon 见过的不同 chat/session 规模
  const CAP = 1000;  // 与生产里 BoundedMap 容量一致

  global.gc();
  const b1 = process.memoryUsage().heapUsed;
  const leaky = new Map<string, { v: number; t: number }>();
  for (let i = 0; i < N; i++) leaky.set('larkapp::chat_' + i, { v: i, t: i });
  global.gc();
  const leakyHeap = process.memoryUsage().heapUsed - b1;

  global.gc();
  const b2 = process.memoryUsage().heapUsed;
  const bounded = new BoundedMap<string, { v: number; t: number }>(CAP);
  for (let i = 0; i < N; i++) bounded.set('larkapp::chat_' + i, { v: i, t: i });
  global.gc();
  const boundedHeap = process.memoryUsage().heapUsed - b2;

  console.log(`  插入 ${N.toLocaleString()} 个不同 key（cap=${CAP}）：`);
  console.log(`    修复前(裸 Map):     保留 ${leaky.size.toLocaleString()} 条, 堆 +${mb(leakyHeap)}  ← 永不回收`);
  console.log(`    修复后(BoundedMap): 保留 ${bounded.size.toLocaleString()} 条, 堆 +${kb(boundedHeap)}`);
  console.log(`    → 堆占用约 ${(leakyHeap / Math.max(boundedHeap, 1)).toFixed(0)}× 更省，且封顶不随时间增长`);
  results.memoryBound = { n: N, cap: CAP, leakyEntries: leaky.size, leakyHeapBytes: leakyHeap, boundedEntries: bounded.size, boundedHeapBytes: boundedHeap };
}

// ─── B. session-store 冗余 save：写盘(前) vs 读+比对跳过(后)──────────────────
// 两条路径都做 read+parse+serialize（真实 save 为 merge 本就要读盘），差值只在
// 末段：修复前 write-tmp+rename，修复后字符串比对相同则 return。
function makeSessions(n: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    obj['sess_' + i] = {
      sessionId: 'sess_' + i, chatId: 'oc_' + i, rootMessageId: 'om_' + i,
      title: '话题 ' + i, status: 'active', createdAt: '2026-06-08T00:00:00.000Z',
      workingDir: '/Users/x/proj/' + i, cliId: 'claude-code', scope: 'thread',
      streamCardId: 'card_' + i, displayMode: 'screenshot',
    };
  }
  return obj;
}
function benchSaveSkip(): void {
  console.log('\n=== B. session-store 冗余 save：写盘(修复前) vs 读+比对跳过(修复后) ===');
  const dir = mkdtempSync(join(tmpdir(), 'bench-save-'));
  const ITERS = 2000;
  const out: unknown[] = [];
  try {
    for (const N of [50, 200]) {
      const fp = join(dir, `sessions-${N}.json`);
      const obj = makeSessions(N);
      writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf-8'); // 初始落盘

      // 修复前：read+parse + serialize + write-tmp + rename（每次都写）
      let t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
        void parsed;
        const j = JSON.stringify(obj, null, 2);
        const tmp = `${fp}.${i}.tmp`;
        writeFileSync(tmp, j, 'utf-8');
        renameSync(tmp, fp);
      }
      const beforeMs = performance.now() - t0;

      // 修复后：read(raw)+parse + serialize + 比对，相同则 return（不写）
      t0 = performance.now();
      let skipped = 0;
      for (let i = 0; i < ITERS; i++) {
        const raw = readFileSync(fp, 'utf-8');
        JSON.parse(raw);
        const j = JSON.stringify(obj, null, 2);
        if (j === raw) { skipped++; continue; }
        const tmp = `${fp}.${i}.tmp`;
        writeFileSync(tmp, j, 'utf-8'); renameSync(tmp, fp);
      }
      const afterMs = performance.now() - t0;

      console.log(`  文件含 ${N} 个会话，${ITERS} 次内容不变的 save：`);
      console.log(`    修复前: ${ms(beforeMs)}  (${ITERS} 次 write+rename)`);
      console.log(`    修复后: ${ms(afterMs)}  (跳过 ${skipped}/${ITERS} 次写, 0 次 rename)`);
      console.log(`    → 单次冗余 save 提速 ${(beforeMs / Math.max(afterMs, 0.01)).toFixed(1)}×，磁盘写入 ${ITERS}→0`);
      out.push({ sessions: N, iters: ITERS, beforeMs, afterMs, skipped });
    }
    results.saveSkip = out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── C. worker 屏幕刷新：每个空闲 tick 的 capture 成本 ────────────────────────
// 修复后：自上次快照以来 PTY 无新输出 ⇒ 跳过整个 capture。这里测被跳过的那段
// （xterm-headless 生命周期 + 读视口）。真实 capture 还含一次 tmux capture-pane
// 子进程/socket 往返，比这更贵，所以这是收益下限。
async function benchCaptureCost(): Promise<void> {
  console.log('\n=== C. worker 屏幕刷新：每个空闲 tick 的 capture 成本（修复后跳过） ===');
  let ansi = '\x1b[2J\x1b[H';
  for (let r = 0; r < 50; r++) {
    ansi += `\x1b[${r + 1};1H\x1b[3${r % 8}m● line ${r} `.padEnd(60) + 'some output text here\x1b[0m';
  }
  const ITERS = 500;
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    const term = new Terminal({ cols: 160, rows: 50, allowProposedApi: true });
    await new Promise<void>(res => term.write(ansi, () => res()));
    readViewportText(term, { filter: true });
    term.dispose();
  }
  const perTick = (performance.now() - t0) / ITERS;
  const TICKS_PER_MIN = 30; // SCREEN_UPDATE_INTERVAL_MS = 2_000

  console.log(`  单次 capture(new Terminal + write + readViewport + dispose): ${perTick.toFixed(2)} ms`);
  console.log(`  修复前: 每个空闲会话 ${TICKS_PER_MIN} 次/分 = ${ms(perTick * TICKS_PER_MIN)}/分钟 CPU（PTY 没动也照跑）`);
  console.log(`  修复后: PTY 静默时 0 次`);
  console.log(`  → 10 个空闲会话省 ${(perTick * TICKS_PER_MIN * 10 / 1000).toFixed(2)} s/分钟；100 个省 ${(perTick * TICKS_PER_MIN * 100 / 1000).toFixed(1)} s/分钟（下限，未含 tmux 子进程）`);
  results.captureCost = { perTickMs: perTick, ticksPerMin: TICKS_PER_MIN };
}

(async () => {
  console.log('botmux 资源基准 — Node ' + process.version + (global.gc ? ' (--expose-gc on)' : ' (无 --expose-gc，A 跳过)'));
  benchMemoryBound();
  benchSaveSkip();
  await benchCaptureCost();
  if (WANT_JSON) console.log('\n__BENCH_JSON__ ' + JSON.stringify(results));
})();
