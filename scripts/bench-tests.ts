#!/usr/bin/env tsx
/**
 * 单元测试套件基准测试（test benchmark）。
 *
 * 测量 `pnpm test`（unit project）的墙钟耗时、最慢文件分布，以及并行效率
 * （= 各文件耗时之和 / 墙钟）。用于：
 *   1. 量化一次性优化（串行 → 并行、热点文件缩放）的收益；
 *   2. 作为 CI 回归闸：单文件占比过高或总时长超阈值时报警。
 *
 * 用法：
 *   pnpm test:bench                  # 跑一次（生产配置：并行），打印 top 文件 + 效率
 *   pnpm test:bench --compare        # 串行 vs 并行 vs 并行+缩放，三档对比表
 *   pnpm test:bench --top 25         # 调整最慢文件展示条数
 *   pnpm test:bench --json out.json  # 结果写文件，供 CI 消费
 *   pnpm test:bench --threshold 30   # 墙钟（秒）超过阈值则 exit 1
 *
 * 注意：基准只统计 unit project。真实 CLI / 浏览器 e2e 由 `pnpm test:e2e*`
 * 单独触发，不计入此基准（它们受真实进程/网络支配，不是代码可优化项）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FileTiming {
  file: string;
  ms: number;
  tests: number;
}

interface RunResult {
  label: string;
  wallMs: number;
  fileSumMs: number;
  files: FileTiming[];
  totalTests: number;
  failedTests: number;
}

interface RunOpts {
  /** false → add --no-file-parallelism (serial). */
  parallel: boolean;
  /** Overrides BOTMUX_TIME_SCALE in the child env (e.g. '1' to un-scale). */
  timeScale?: string;
}

const REPO = process.cwd();

/** Run the unit project once under the given knobs, parse the JSON report. */
function runOnce(label: string, opts: RunOpts): RunResult {
  const reportDir = mkdtempSync(join(tmpdir(), 'botmux-bench-'));
  const reportFile = join(reportDir, 'report.json');
  const args = [
    'vitest',
    'run',
    '--project',
    'unit',
    '--reporter=json',
    `--outputFile=${reportFile}`,
  ];
  if (!opts.parallel) args.push('--no-file-parallelism');

  const env = { ...process.env };
  if (opts.timeScale !== undefined) env.BOTMUX_TIME_SCALE = opts.timeScale;

  const started = process.hrtime.bigint();
  // Discard stdout (the suite emits MBs of logs over a slow serial run — the
  // default 1MB maxBuffer would ENOBUFS-kill vitest before it writes the JSON
  // report). We only need the report file; keep stderr for error diagnostics.
  const proc = spawnSync('npx', args, {
    cwd: REPO,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  let report: any;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    rmSync(reportDir, { recursive: true, force: true });
    throw new Error(
      `vitest produced no parseable JSON report for "${label}".\n` +
        `stderr tail:\n${(proc.stderr || '').split('\n').slice(-20).join('\n')}`,
    );
  }
  rmSync(reportDir, { recursive: true, force: true });

  const files: FileTiming[] = [];
  let totalTests = 0;
  let failedTests = 0;
  for (const f of report.testResults ?? []) {
    const ms = (f.endTime ?? 0) - (f.startTime ?? 0);
    const tests = (f.assertionResults ?? []).length;
    files.push({ file: f.name.replace(`${REPO}/`, ''), ms, tests });
    for (const a of f.assertionResults ?? []) {
      totalTests++;
      if (a.status === 'failed') failedTests++;
    }
  }
  files.sort((a, b) => b.ms - a.ms);
  const fileSumMs = files.reduce((s, f) => s + f.ms, 0);
  return { label, wallMs, fileSumMs, files, totalTests, failedTests };
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function printRun(r: RunResult, topN: number): void {
  const efficiency = r.fileSumMs / r.wallMs;
  console.log(`\n── ${r.label} ─────────────────────────────────────`);
  console.log(`  wall time      : ${fmt(r.wallMs)}`);
  console.log(`  Σ file time    : ${fmt(r.fileSumMs)}  (parallel efficiency ${efficiency.toFixed(1)}×)`);
  console.log(`  files / tests  : ${r.files.length} files, ${r.totalTests} tests` +
    (r.failedTests ? `  (${r.failedTests} failed)` : ''));
  console.log(`  top ${topN} slowest files:`);
  for (const f of r.files.slice(0, topN)) {
    const share = ((f.ms / r.wallMs) * 100).toFixed(0).padStart(3);
    console.log(`    ${fmt(f.ms).padStart(7)}  ${share}% wall  ${f.file}  (${f.tests} tests)`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const compare = argv.includes('--compare');
  const topN = Number(argv[argv.indexOf('--top') + 1]) || 15;
  const jsonIdx = argv.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined;
  const thrIdx = argv.indexOf('--threshold');
  const thresholdSec = thrIdx >= 0 ? Number(argv[thrIdx + 1]) : undefined;

  const results: RunResult[] = [];

  if (compare) {
    console.log('Running 3 configurations (this runs the unit suite 3×)…');
    results.push(runOnce('serial, time-scale OFF (baseline)', { parallel: false, timeScale: '1' }));
    results.push(runOnce('parallel, time-scale OFF', { parallel: true, timeScale: '1' }));
    results.push(runOnce('parallel, time-scale ON (shipping config)', { parallel: true }));
  } else {
    console.log('Running unit suite (shipping config: parallel + time-scale)…');
    results.push(runOnce('parallel, time-scale ON (shipping config)', { parallel: true }));
  }

  for (const r of results) printRun(r, topN);

  if (results.length > 1) {
    const base = results[0].wallMs;
    console.log('\n── speedup vs baseline ────────────────────────────');
    for (const r of results) {
      console.log(`  ${(base / r.wallMs).toFixed(2)}×   ${fmt(r.wallMs).padStart(8)}   ${r.label}`);
    }
  }

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        results.map(r => ({
          label: r.label,
          wallMs: Math.round(r.wallMs),
          fileSumMs: Math.round(r.fileSumMs),
          parallelEfficiency: Number((r.fileSumMs / r.wallMs).toFixed(2)),
          files: r.files.length,
          tests: r.totalTests,
          failedTests: r.failedTests,
          slowest: r.files.slice(0, topN).map(f => ({ file: f.file, ms: Math.round(f.ms) })),
        })),
        null,
        2,
      ),
    );
    console.log(`\nWrote ${jsonOut}`);
  }

  if (thresholdSec !== undefined) {
    const shipping = results[results.length - 1];
    const sec = shipping.wallMs / 1000;
    if (sec > thresholdSec) {
      console.error(`\n✗ wall time ${sec.toFixed(2)}s exceeds threshold ${thresholdSec}s`);
      process.exit(1);
    }
    console.log(`\n✓ wall time ${sec.toFixed(2)}s within threshold ${thresholdSec}s`);
  }
}

main();
