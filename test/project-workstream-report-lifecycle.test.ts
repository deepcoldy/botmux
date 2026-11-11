import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import {
  localProjectAttachmentSource, setProjectWorkstreamPool, validateProjectAttachmentReport,
} from '../src/services/project-workstream-runtime.js';
import { createProjectWorkstreamAttachments } from '../src/services/project-workstream-attachments.js';
import { ProjectCoordinator, type ProjectCoordinatorTransport } from '../src/services/project-coordinator.js';
import { readProjectGroup } from '../src/services/project-group-store.js';
import { readGroupCollaborationMode, writeGroupCollaborationMode } from '../src/services/group-collaboration-mode-store.js';
import { loadOrCreateDispatchReportBindingSecret } from '../src/core/dispatch-report-binding.js';

// Real source projection, attachment service, journal, registry and project
// stores; only the daemon worker pool is synthetic. A worker's idle suspension
// clears ds.cliReady while the session itself stays active.
const oldDataDir = config.session.dataDir;
const roots: string[] = [];
afterEach(() => {
  setProjectWorkstreamPool(undefined);
  config.session.dataDir = oldDataDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(patch: Record<string, unknown>) {
  return {
    sessionId: 'source-one', larkAppId: 'cli_worker', chatId: 'oc_group', rootMessageId: 'om_topic',
    scope: 'thread', chatType: 'group', status: 'active', ownerUnionId: 'on_owner',
    projectRouteRevision: 1, projectImportSource: 'relay', cliSessionId: 'native-source', title: '已有话题',
    ...patch,
  };
}

async function fixture(sourceCliReady: boolean) {
  const dataDir = mkdtempSync(join(process.env.SESSION_DATA_DIR!, 'workstream-lifecycle-'));
  roots.push(dataDir);
  config.session.dataDir = dataDir;
  const live = new Map<string, any>([
    ['source-one', { larkAppId: 'cli_worker', chatId: 'oc_group', scope: 'thread', session: session({}), cliReady: sourceCliReady }],
    ['main-one', {
      larkAppId: 'cli_main', chatId: 'oc_group', scope: 'chat', cliReady: true,
      session: session({ sessionId: 'main-one', larkAppId: 'cli_main', scope: 'chat', rootMessageId: 'om_main', cliSessionId: 'native-main' }),
    }],
  ]);
  setProjectWorkstreamPool({ findActiveBySessionId: id => live.get(id) });
  const transport: ProjectCoordinatorTransport = {
    sendCard: vi.fn(async () => 'om_card'), updateCard: vi.fn(async () => {}),
    pinMessage: vi.fn(async () => true), unpinMessage: vi.fn(async () => true),
    resolveThreadId: vi.fn(async () => null),
    isMessageWithdrawn: () => false, isMessageUpdateExpired: () => false, brand: () => 'feishu',
  };
  const coordinator = new ProjectCoordinator(transport);
  await writeGroupCollaborationMode(dataDir, {
    chatId: 'oc_group', mode: 'project', coordinatorAppId: 'cli_main', workerAppIds: ['cli_worker'],
  });
  await coordinator.run(
    { dataDir, chatId: 'oc_group', larkAppId: 'cli_main', coordinatorSessionId: 'main-one' },
    { action: 'init', title: '项目', goal: '合成' },
  );
  const service = createProjectWorkstreamAttachments({
    dataDir,
    getSource: localProjectAttachmentSource,
    getProject: chatId => readProjectGroup(dataDir, chatId),
    getMode: chatId => readGroupCollaborationMode(dataDir, chatId),
    projectRun: (ctx, action, beforeApply) => coordinator.run(ctx, action, beforeApply),
    reportSecret: () => loadOrCreateDispatchReportBindingSecret(dataDir),
  });
  const actor = { sessionId: 'main-one', larkAppId: 'cli_main', chatId: 'oc_group', scope: 'chat' as const, ownerKey: 'union:on_owner' };
  const request = { sourceSessionId: 'source-one', sourceLarkAppId: 'cli_worker', rootMessageId: 'om_topic', title: '迁入任务' };
  const registry = () => JSON.parse(readFileSync(join(dataDir, 'orchestrate-dispatch.json'), 'utf8'));
  const report = () => validateProjectAttachmentReport(registry(), 'om_topic', 'cli_worker', 'source-one');
  const sourceWorker = live.get('source-one');
  return { service, actor, request, report, sourceWorker };
}

describe('imported workstream reporting across source worker suspension', () => {
  it('keeps the association reportable when status runs while the source worker is suspended', async () => {
    const f = await fixture(true);
    await f.service.attach(f.actor, f.request);
    expect(await f.report()).toMatchObject({ ok: true });
    f.sourceWorker.cliReady = false;
    const status = await f.service.reconcile(f.actor, {});
    expect(status.attachments).toEqual([expect.objectContaining({ rootMessageId: 'om_topic', state: 'active' })]);
    f.sourceWorker.cliReady = true;
    expect(await f.report()).toMatchObject({ ok: true });
  });

  it('registers a reportable association while the source worker is suspended', async () => {
    const f = await fixture(false);
    const attached = await f.service.attach(f.actor, f.request);
    expect(attached).toMatchObject({ registered: true, attachment: { state: 'active', reportCapability: 'verified' } });
    f.sourceWorker.cliReady = true;
    expect(await f.report()).toMatchObject({ ok: true });
  });

  it('still refuses a report while the source CLI generation is not ready', async () => {
    const f = await fixture(true);
    await f.service.attach(f.actor, f.request);
    f.sourceWorker.cliReady = false;
    expect(await f.report()).toEqual({ ok: false, error: 'dispatch_attachment_inactive' });
  });
});
