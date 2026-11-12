// 项目卡运行态解析：按本机在线 daemon 描述符找到源 Bot，经宿主签名 IPC 读迁入会话的任务事实，
// 并把负责人里的原始 App ID 换成 Bot 显示名。用真实本地 HTTP 服务充当源 daemon，不打桩发现与签名。
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateDashboardSecret } from '../src/dashboard/auth.js';
import { buildProjectGroupCard } from '../src/im/lark/project-group-card.js';
import { resolveProjectGroupCardRuntime } from '../src/services/project-coordinator-runtime.js';
import type { ProjectGroupState, ProjectWorkstream } from '../src/services/project-group-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const AT = '2026-11-10T00:00:00.000Z';

function row(
  dispatchRoot: string,
  patch: Partial<ProjectWorkstream> & { session?: string; state?: NonNullable<ProjectWorkstream['attachment']>['state'] },
): ProjectWorkstream {
  const { session, state, ...rest } = patch;
  return {
    dispatchRoot, title: dispatchRoot, purpose: '', owners: [], status: 'pending', progress: 0,
    createdAt: AT, updatedAt: AT,
    ...(session ? {
      attachment: {
        sourceSessionId: session, sourceLarkAppId: 'cli_worker', revision: 1, routeRevision: 1,
        state: state ?? 'active', reportCapability: 'verified',
      },
    } : {}),
    ...rest,
  };
}

async function sourceDaemon(): Promise<{ port: number; requested: string[] }> {
  const requested: string[] = [];
  const server: Server = createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').replace(/^\/api\/sessions\//, ''));
    requested.push(id);
    if (id === 's-working') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ session: { status: 'working', busySinceAt: Date.now() } }));
    } else if (id === 's-gone') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } else {
      res.writeHead(500);
      res.end('boom');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { port: address.port, requested };
}

function descriptor(dataDir: string, larkAppId: string, ipcPort: number, botName: string, lastHeartbeat: number): void {
  const dir = join(dataDir, 'dashboard-daemons');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${larkAppId}.json`), JSON.stringify({ larkAppId, ipcPort, botName, lastHeartbeat }));
}

describe('resolveProjectGroupCardRuntime', () => {
  it('只探测仍在推进的已连接迁入会话；404 记为已探测无事实，读失败不记；负责人按在线描述符→旧描述符→原值解析', async () => {
    loadOrCreateDashboardSecret(join(homedir(), '.botmux', '.dashboard-secret'));
    const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'card-runtime-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const source = await sourceDaemon();
    descriptor(dataDir, 'cli_worker', source.port, 'BotAlpha', Date.now());
    descriptor(dataDir, 'cli_stale', 1, 'BotStale', 1);

    const project: ProjectGroupState = {
      schemaVersion: 1, revision: 3, chatId: 'oc_group', larkAppId: 'cli_main', coordinatorSessionId: 'main-one',
      title: '项目', goal: '目标', phase: '推进', focus: '推进', status: 'active', blockers: [], milestones: [],
      createdAt: AT, updatedAt: AT,
      workstreams: [
        row('om_running', { title: '任务甲', session: 's-working', owners: ['cli_worker'] }),
        row('om_gone', { title: '任务乙', session: 's-gone', owners: ['cli_stale'] }),
        row('om_error', { title: '任务丙', session: 's-error', owners: ['cli_unknown'] }),
        row('om_done', { session: 's-done', status: 'completed', progress: 100 }),
        row('om_failed', { session: 's-failed', status: 'failed' }),
        row('om_blocked', { session: 's-blocked', status: 'blocked' }),
        row('om_closed', { session: 's-closed', state: 'closed' }),
        row('om_pending', { session: 's-pending', state: 'pending' }),
        row('om_moved', { title: '任务已迁走', session: 's-moved', state: 'moved', owners: ['cli_moved'] }),
        row('om_plain', { owners: ['人工负责人'] }),
      ],
    };

    const runtime = await resolveProjectGroupCardRuntime(project, dataDir);

    expect([...source.requested].sort()).toEqual(['s-error', 's-gone', 's-working']);
    expect(Object.keys(runtime.sessionFactsByRoot ?? {}).sort()).toEqual(['om_gone', 'om_running']);
    expect(runtime.sessionFactsByRoot?.om_running).toMatchObject({ status: 'working' });
    expect(runtime.sessionFactsByRoot?.om_gone).toBeUndefined();
    expect(runtime.ownerDisplayNames).toEqual({
      cli_worker: 'BotAlpha',
      cli_stale: 'BotStale',
      cli_unknown: 'cli_unknown',
    });

    const card = JSON.stringify(buildProjectGroupCard(project, 'feishu', {
      schemaVersion: 1, templateId: 'compact-list', sections: ['workstreams'], milestonesExpanded: false,
    }, runtime));
    const line = (title: string) => card.split('\\n').find(text => text.includes(`>${title}<`)) ?? '';
    expect(line('任务甲')).toContain('在跑');
    expect(line('任务甲')).toContain('BotAlpha');
    expect(line('任务乙')).toContain('空闲');
    expect(line('任务乙')).toContain('BotStale');
    // 读失败的会话不臆测运行态，退回业务状态。
    expect(line('任务丙')).toContain('未开始');
    expect(card).not.toContain('任务已迁走');
    expect(card).not.toContain('cli_worker');
  });
});
