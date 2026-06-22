/**
 * verified-delivery CLI 层 e2e —— 真跑 `node dist/cli.js delivery ...`，验证可信交付
 * 验收回路端到端走 CLI 入口（参数解析 → 读写账本 → JSON 输出），**零飞书副作用、零部署**。
 *
 * 飞书侧被刻意绕开：dispatch / report 的真命令会发飞书消息，所以这里用 openLedger 直接
 * seed TaskDispatched / TaskReported（= 那两个命令的账本效果），再真跑只读 / 纯账本的
 * delivery 子命令：list / show / accept 无飞书；reject 用 --no-push 跳过回推。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLedger } from '../src/verified-delivery/ledger.js';
import { buildReport } from '../src/verified-delivery/report.js';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
const GOAL_CHAT = 'oc_goal_e2e';
const TS = 1_700_000_000_000;

let dataDir: string;     // SESSION_DATA_DIR handed to the CLI subprocess
let ledgerBase: string;  // dataDir/verified-delivery — where seeding writes

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'vd-cli-e2e-'));
  ledgerBase = join(dataDir, 'verified-delivery');
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function delivery(args: string[]): { json: any; status: number; raw: string } {
  try {
    const raw = execFileSync('node', [CLI_PATH, 'delivery', ...args], {
      env: { ...process.env, SESSION_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { json: JSON.parse(raw), status: 0, raw };
  } catch (err: any) {
    const stdout = err.stdout ?? '';
    let json: any = null;
    try { json = JSON.parse(stdout); } catch { /* non-JSON error path */ }
    return { json, status: err.status ?? 1, raw: stdout + (err.stderr ?? '') };
  }
}

function seedDispatched(taskId: string, title: string, ts = TS, chatId = GOAL_CHAT): void {
  openLedger({ baseDir: ledgerBase }).append({
    type: 'TaskDispatched', actor: 'orchestrator', taskId, chatId, ts,
    idempotencyKey: `dispatched:${taskId}`,
    payload: { taskId, title, workerTopicRoot: `om_seed_${taskId}`, workerOpenIds: ['ou_worker'] },
  });
}

function seedReported(taskId: string, ts = TS + 1000): void {
  const led = openLedger({ baseDir: ledgerBase });
  const { draft } = buildReport({
    taskId, summary: 'done', ts, chatId: GOAL_CHAT, workerOpenId: 'ou_worker',
    inline: [{ name: 'check', content: 'PASS: 3/3 tests green\n' }],
  }, led);
  led.append(draft);
}

describe('verified-delivery CLI e2e（delivery 回路，零飞书）', () => {
  it('dispatched → `list --goal` 按 goal 群查到任务，status=dispatched', () => {
    seedDispatched('task-a', 'Goal A 子任务1');
    const out = delivery(['list', '--goal', GOAL_CHAT]);
    expect(out.status).toBe(0);
    expect(out.json.count).toBe(1);
    expect(out.json.tasks[0]).toMatchObject({ taskId: 'task-a', chatId: GOAL_CHAT, status: 'dispatched' });
  });

  it('reported → `show --task` 看得到证据，`list --status reported` 命中', () => {
    seedDispatched('task-b', 'b'); seedReported('task-b');
    const show = delivery(['show', '--task', 'task-b']);
    expect(show.status).toBe(0);
    expect(show.json.task.status).toBe('reported');
    expect(show.json.task.reports[0].evidence.length).toBeGreaterThan(0);
    const list = delivery(['list', '--status', 'reported']);
    expect(list.json.count).toBe(1);
    expect(list.json.tasks[0].taskId).toBe('task-b');
  });

  it('`accept` 真跑（无飞书）→ 账本推进到 accepted，验收留痕入账', () => {
    seedDispatched('task-c', 'c'); seedReported('task-c');
    const acc = delivery(['accept', '--task', 'task-c', '--checked-by', 'tester',
      '--evidence-checked', 'read PASS output', '--ran-command', 'npm test']);
    expect(acc.status).toBe(0);
    expect(acc.json).toMatchObject({ taskId: 'task-c', accepted: true });
    const show = delivery(['show', '--task', 'task-c']);
    expect(show.json.task.status).toBe('accepted');
  });

  it('`reject --no-push` 真跑（零飞书）→ 账本 rejected，pushed:false', () => {
    seedDispatched('task-d', 'd'); seedReported('task-d');
    const rej = delivery(['reject', '--task', 'task-d', '--reason', 'check_failed',
      '--retry-brief', '补齐失败用例', '--no-push', '--checked-by', 'tester']);
    expect(rej.status).toBe(0);
    expect(rej.json).toMatchObject({ taskId: 'task-d', rejected: true, pushed: false });
    const show = delivery(['show', '--task', 'task-d']);
    expect(show.json.task.status).toBe('rejected');
  });

  it('liveness：`list --status dispatched --older-than` 扫出卡住任务，新任务排除', () => {
    const now = Date.now();
    seedDispatched('task-stuck', 'stuck', now - 3 * 3600_000);  // 3h 前派出、一直没回报
    seedDispatched('task-recent', 'recent', now);               // 刚派出
    const stuck = delivery(['list', '--status', 'dispatched', '--older-than', '2h']);
    expect(stuck.status).toBe(0);
    expect(stuck.json.count).toBe(1);
    expect(stuck.json.tasks[0].taskId).toBe('task-stuck');
  });

  it('goal 隔离：`list --goal` 只返回该 goal 群的任务', () => {
    seedDispatched('task-g1', 'g1');                       // GOAL_CHAT
    seedDispatched('task-other', 'other', TS, 'oc_other'); // 另一个 goal 群
    const out = delivery(['list', '--goal', GOAL_CHAT]);
    expect(out.json.count).toBe(1);
    expect(out.json.tasks[0].taskId).toBe('task-g1');
  });
});
