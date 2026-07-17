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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function cli(command: string, args: string[]): { json: any; status: number; raw: string } {
  try {
    const raw = execFileSync('node', [CLI_PATH, command, ...args], {
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

function delivery(args: string[]): { json: any; status: number; raw: string } {
  return cli('delivery', args);
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
  it('`dispatch --after` 只登记依赖任务，不触发飞书发送', () => {
    const sessionId = 'session-planning-supervisor';
    writeFileSync(join(dataDir, 'sessions-cli_sup.json'), JSON.stringify({
      [sessionId]: {
        sessionId,
        chatId: GOAL_CHAT,
        rootMessageId: GOAL_CHAT,
        title: 'goal supervisor',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: 'cli_sup',
        ownerOpenId: 'ou_owner',
      },
    }));
    seedDispatched('task-upstream', 'Upstream');

    const out = cli('dispatch', [
      '--session-id', sessionId,
      '--title', 'Downstream',
      '--bot', 'ou_worker:Worker:coder',
      '--brief', 'Use the upstream result.',
      '--task-id', 'task-downstream',
      '--after', 'task-upstream',
      '--needs-repo', 'https://github.com/acme/project.git',
    ]);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({
      mode: 'planned',
      taskId: 'task-downstream',
      dependsOnTaskIds: ['task-upstream'],
      planGeneration: 1,
      released: false,
      contactedWorkers: false,
    });
    const task = delivery(['show', '--task', 'task-downstream']).json.task;
    expect(task).toMatchObject({
      status: 'planned',
      plan: {
        dependsOnTaskIds: ['task-upstream'],
        plannedBy: 'ou_owner',
        dispatchSpec: {
          title: 'Downstream',
          briefBase: 'Use the upstream result.',
          senderLarkAppId: 'cli_sup',
          requiredRepo: 'github.com/acme/project',
          workers: [{ openId: 'ou_worker', name: 'Worker', role: 'coder' }],
        },
      },
    });
    expect(delivery(['list', '--status', 'planned']).json.tasks[0].dependsOnTaskIds).toEqual(['task-upstream']);
  });

  it('`report` 缺少监管者坐标时先失败且不写入交付记录', () => {
    const sessionId = 'session-without-report-target';
    writeFileSync(join(dataDir, 'sessions-cli_test.json'), JSON.stringify({
      [sessionId]: {
        sessionId,
        chatId: 'oc_test',
        rootMessageId: 'oc_test',
        title: 'not dispatched',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: 'cli_test',
      },
    }));

    const out = cli('report', [
      '--session-id', sessionId,
      '--task', 'task-no-route',
      'should not persist',
      '--artifact-text', 'evidence=PASS',
    ]);

    expect(out.status).toBe(1);
    expect(out.raw).toContain('未写入交付记录');
    expect(existsSync(join(ledgerBase, 'ledger.ndjson'))).toBe(false);
  });

  it('`report` 发送失败时不留下本地半成功记录', () => {
    const sessionId = 'session-with-unreachable-target';
    writeFileSync(join(dataDir, 'sessions-cli_missing_app.json'), JSON.stringify({
      [sessionId]: {
        sessionId,
        chatId: 'oc_test',
        rootMessageId: 'oc_test',
        title: 'dispatched elsewhere',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: 'cli_missing_app',
        creatorOpenId: 'ou_supervisor',
      },
    }));

    const out = cli('report', [
      '--session-id', sessionId,
      '--task', 'task-send-fails',
      'should remain retryable',
      '--artifact-text', 'evidence=PASS',
    ]);

    expect(out.status).toBe(1);
    expect(out.raw).toContain('"delivered":false');
    expect(out.raw).toContain('"localRecorded":false');
    expect(out.raw).toContain('"retryable":true');
    expect(existsSync(join(ledgerBase, 'ledger.ndjson'))).toBe(false);
  });

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

  it('`help` 真跑（无 daemon 也成功）→ 账本 blocked，watchdog 作为 best-effort', () => {
    seedDispatched('task-help', 'help');
    const out = cli('help', ['--task', 'task-help', '--blocker', '缺测试账号权限', '--kind', 'access']);
    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ taskId: 'task-help', blocked: true, goalChatId: GOAL_CHAT });
    expect(out.json.watchdog.contacted).toBe(0);
    const show = delivery(['show', '--task', 'task-help']);
    expect(show.json.task.status).toBe('blocked');
    expect(show.json.task.help).toMatchObject({ blocker: '缺测试账号权限', kind: 'access' });
  });

  it('`delivery escalate --no-notify-parent` 真跑（零 daemon）→ 账本 escalated', () => {
    seedDispatched('task-esc', 'esc');
    cli('help', ['--task', 'task-esc', '--blocker', '需求范围冲突', '--kind', 'ambiguous']);
    const out = delivery(['escalate', '--task', 'task-esc', '--reason', '需要人决定范围', '--retry-brief', '请确认是否包含移动端', '--by', 'l2-test', '--no-notify-parent']);
    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ taskId: 'task-esc', escalated: true });
    const show = delivery(['show', '--task', 'task-esc']);
    expect(show.json.task.status).toBe('escalated');
    expect(show.json.task.escalation).toMatchObject({ reason: '需要人决定范围', by: 'l2-test', retryBrief: '请确认是否包含移动端' });
  });

  it('`delivery cancel` 真跑（零 daemon）→ 任务终态取消且保留原因', () => {
    seedDispatched('task-cancel', 'cancel me');
    seedReported('task-cancel');
    const out = delivery(['cancel', '--task', 'task-cancel', '--reason', '临时诊断已结束', '--by', 'l2-test']);
    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ taskId: 'task-cancel', cancelled: true, pendingReports: 1 });
    const show = delivery(['show', '--task', 'task-cancel']);
    expect(show.json.task.status).toBe('cancelled');
    expect(show.json.task.cancellation).toEqual({ reason: '临时诊断已结束', by: 'l2-test' });
    expect(delivery(['list', '--status', 'cancelled']).json.tasks.map((task: any) => task.taskId)).toContain('task-cancel');
    expect(delivery(['accept', '--task', 'task-cancel']).raw).toContain('已取消');
    expect(delivery(['escalate', '--task', 'task-cancel', '--reason', 'late', '--no-notify-parent']).raw).toContain('已取消');

    openLedger({ baseDir: ledgerBase }).append({
      type: 'TaskDispatched', actor: 'orchestrator', taskId: 'task-cancel', chatId: GOAL_CHAT,
      ts: TS + 2000, idempotencyKey: 'reassign:task-cancel:second',
      payload: { taskId: 'task-cancel', title: 'second attempt' },
    });
    const second = delivery(['cancel', '--task', 'task-cancel', '--reason', '第二轮也停止', '--by', 'l2-test']);
    expect(second.json).toMatchObject({ taskId: 'task-cancel', cancelled: true, deduped: false });
    expect(delivery(['show', '--task', 'task-cancel']).json.task.cancellation.reason).toBe('第二轮也停止');
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
