import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectGroupMode, putProjectGroupMode } from '../src/dashboard/project-group-mode-api.js';
import {
  addProjectWorkerIfNeeded,
  evaluateProjectDispatchPolicy,
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
  writeProjectOnboardingCard,
} from '../src/services/group-collaboration-mode-store.js';
import { renderProjectGroupModeBlock } from '../src/core/session-manager.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-project-mode-'));
  roots.push(dataDir);
  const groups = vi.fn(async () => ({
    chats: [{
      chatId: 'oc_project',
      chatMode: 'group',
      memberBots: [
        { larkAppId: 'cli_coordinator', botName: 'nodex', inChat: true },
        { larkAppId: 'cli_worker', botName: 'Seed Bot', inChat: true },
        { larkAppId: 'cli_elsewhere', inChat: false },
      ],
    }],
  }));
  return { dataDir, groups };
}

describe('project group mode dashboard API', () => {
  it('creates the waiting-to-start guide for a configured group without project content', async () => {
    const f = fixture();
    const ensureOnboardingCard = vi.fn(async (chatId: string, coordinatorAppId: string) => {
      await writeProjectOnboardingCard(f.dataDir, chatId, {
        messageId: 'om_guide', larkAppId: coordinatorAppId, pinned: true,
        createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      });
    });
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], autoEnrollWorkers: true,
    }, { ...f, ensureOnboardingCard });
    expect(result.status).toBe(200);
    expect(result.body.cardRefresh).toBe('updated');
    expect(ensureOnboardingCard).toHaveBeenCalledWith('oc_project', 'cli_coordinator', {
      coordinatorName: 'nodex', workerNames: ['Seed Bot'],
    });
    expect(result.body.config).not.toHaveProperty('onboardingCard');
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')?.onboardingCard?.messageId).toBe('om_guide');
  });

  it('stores only group nature and bot policy, never project content', async () => {
    const f = fixture();
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], autoEnrollWorkers: true,
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['goal', 'workstreams'], milestonesExpanded: false,
      },
    }, f);
    expect(result.status).toBe(200);
    expect(result.body.config).toMatchObject({
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      autoEnrollWorkers: true,
      progressCard: { templateId: 'compact-list', sections: ['goal', 'workstreams'] },
    });
    const raw = readFileSync(join(f.dataDir, 'group-collaboration-modes.json'), 'utf8');
    const stored = JSON.parse(raw).configs.oc_project;
    expect(stored).not.toHaveProperty('goal');
    expect(stored).not.toHaveProperty('progress');
    expect(stored.progressCard).toEqual({
      schemaVersion: 1, templateId: 'compact-list', sections: ['goal', 'workstreams'], milestonesExpanded: false,
    });
    expect(statSync(join(f.dataDir, 'group-collaboration-modes.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects project content fields and bots outside the group', async () => {
    const f = fixture();
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], goal: 'not config',
    }, f)).toMatchObject({ status: 400, body: { error: 'unsupported_field' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_elsewhere'],
    }, f)).toMatchObject({ status: 409, body: { error: 'worker_not_in_chat' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      progressCard: { schemaVersion: 1, templateId: 'raw-json', sections: [], milestonesExpanded: false },
    }, f)).toMatchObject({ status: 400, body: { error: 'invalid_progress_card_config' } });
    expect(await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'], autoEnrollWorkers: 'yes',
    }, f)).toMatchObject({ status: 400, body: { error: 'invalid_auto_enroll_workers' } });
  });

  it('refreshes an existing pinned card immediately after display configuration changes', async () => {
    const f = fixture();
    const project = {
      schemaVersion: 1, revision: 2, chatId: 'oc_project', larkAppId: 'cli_coordinator',
      coordinatorSessionId: 'session_main', title: '项目', goal: '完成交付', phase: '联调', focus: '刷新卡片',
      status: 'active' as const, blockers: [], workstreams: [], milestones: [],
      card: { messageId: 'om_card', pinned: true, updatedAt: '2026-09-07T00:00:00.000Z' },
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
    };
    const refreshProjectCard = vi.fn(async () => project);
    const result = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      progressCard: {
        schemaVersion: 1, templateId: 'status-dashboard', sections: ['goal', 'milestones'], milestonesExpanded: true,
      },
    }, {
      ...f,
      readProject: () => project,
      refreshProjectCard,
    });
    expect(result.status).toBe(200);
    expect(result.body.cardRefresh).toBe('updated');
    expect(refreshProjectCard).toHaveBeenCalledWith('oc_project', 'cli_coordinator');
  });

  it('persists an explicit standard mode so disabling cannot look unconfigured', async () => {
    const f = fixture();
    await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['workstreams'], milestonesExpanded: false,
      },
    }, f);
    const result = await putProjectGroupMode('oc_project', { mode: 'standard' }, f);
    expect(result.body.config).toMatchObject({ mode: 'standard' });
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')).toMatchObject({
      mode: 'standard', progressCard: { templateId: 'compact-list', sections: ['workstreams'] },
    });
    expect((await getProjectGroupMode('oc_project', f)).body.config).toMatchObject({ mode: 'standard' });
    const restored = await putProjectGroupMode('oc_project', {
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
    }, f);
    expect(restored.body.config).toMatchObject({
      mode: 'project', progressCard: { templateId: 'compact-list', sections: ['workstreams'] },
    });
  });

  it('unpins the waiting guide before switching back to standard mode', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
    });
    await writeProjectOnboardingCard(f.dataDir, 'oc_project', {
      messageId: 'om_guide', larkAppId: 'cli_coordinator', pinned: true,
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    });
    const clearOnboardingCard = vi.fn(async (chatId: string) => {
      await writeProjectOnboardingCard(f.dataDir, chatId, undefined);
    });
    const result = await putProjectGroupMode('oc_project', { mode: 'standard' }, {
      ...f, clearOnboardingCard,
    });
    expect(result.status).toBe(200);
    expect(clearOnboardingCard).toHaveBeenCalledWith('oc_project', 'cli_coordinator');
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')).not.toHaveProperty('onboardingCard');
  });
});

describe('project dispatch policy', () => {
  const config = {
    schemaVersion: 1 as const,
    chatId: 'oc_project',
    mode: 'project' as const,
    coordinatorAppId: 'cli_coordinator',
    workerAppIds: ['cli_worker'],
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  };

  it('allows only the configured coordinator and worker set', () => {
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false,
    })).toEqual({ ok: true, projectMode: true });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_other', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false,
    })).toEqual({ ok: false, error: 'project_coordinator_required' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_other'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false,
    })).toEqual({ ok: false, error: 'project_worker_not_allowed', disallowedAppIds: ['cli_other'] });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_elsewhere',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '移动端验收', existingDispatch: false,
    })).toEqual({ ok: false, error: 'project_cross_chat_dispatch_forbidden' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: [], hasLegacyBots: true, title: '移动端验收', existingDispatch: false,
    })).toEqual({ ok: false, error: 'project_dispatch_requires_app_ids' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '子任务', existingDispatch: false,
    })).toEqual({ ok: false, error: 'project_dispatch_title_required' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '这是一个明显超过二十四个字符并且不适合展示在项目卡片里的标题', existingDispatch: false,
    })).toEqual({ ok: false, error: 'project_dispatch_title_too_long' });
    expect(evaluateProjectDispatchPolicy({
      config, sourceAppId: 'cli_coordinator', sourceChatId: 'oc_project', targetChatId: 'oc_project',
      targetAppIds: ['cli_worker'], hasLegacyBots: false, title: '', existingDispatch: true,
    })).toEqual({ ok: true, projectMode: true });
  });

  it('keeps legacy dispatch unrestricted until a group mode is explicitly configured', () => {
    expect(evaluateProjectDispatchPolicy({
      config: undefined, sourceAppId: 'cli_any', sourceChatId: 'oc_project', targetChatId: 'oc_elsewhere',
      targetAppIds: [], hasLegacyBots: true,
    })).toEqual({ ok: true, projectMode: false });
  });
});

describe('project worker membership sync', () => {
  it('preserves an explicitly curated worker subset when automatic enrollment is disabled', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker'],
    });

    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new')).toBeUndefined();
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')?.workerAppIds).toEqual(['cli_worker']);
  });

  it('atomically adds newly joined local bots when automatic enrollment is enabled', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator',
      workerAppIds: ['cli_worker'],
      autoEnrollWorkers: true,
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['workstreams'], milestonesExpanded: false,
      },
    });

    await Promise.all([
      addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new_a'),
      addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new_b'),
    ]);

    const config = readGroupCollaborationMode(f.dataDir, 'oc_project');
    expect(config).toMatchObject({
      coordinatorAppId: 'cli_coordinator',
      progressCard: { templateId: 'compact-list', sections: ['workstreams'] },
    });
    expect(config?.workerAppIds).toHaveLength(3);
    expect(new Set(config?.workerAppIds)).toEqual(new Set(['cli_worker', 'cli_new_a', 'cli_new_b']));
    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new_a')).toBeUndefined();
    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_coordinator')).toBeUndefined();
  });

  it('does not enroll a bot when the group is not in project mode', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, { chatId: 'oc_project', mode: 'standard' });

    expect(await addProjectWorkerIfNeeded(f.dataDir, 'oc_project', 'cli_new')).toBeUndefined();
    expect(readGroupCollaborationMode(f.dataDir, 'oc_project')?.workerAppIds).toBeUndefined();
  });
});

describe('project coordinator prompt context', () => {
  it('injects the fixed project protocol only for the configured coordinator', async () => {
    const f = fixture();
    await writeGroupCollaborationMode(f.dataDir, {
      chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
    });
    const coordinator = renderProjectGroupModeBlock('cli_coordinator', 'oc_project', f.dataDir);
    expect(coordinator).toContain('<project_group_mode');
    expect(coordinator).toContain('botmux project init/update/status/close/resume');
    expect(coordinator).toContain('independent of custom &lt;role&gt; content');
    expect(coordinator).toContain('At the start of every substantive project turn');
    expect(coordinator).toContain('immediately persist it with `botmux project update`');
    expect(coordinator).toContain('discussion is a valid project phase');
    expect(coordinator).toContain('worker_app_ids="cli_worker"');
    expect(coordinator).toContain('specific title of at most 24 characters');
    expect(renderProjectGroupModeBlock('cli_worker', 'oc_project', f.dataDir)).toBe('');
  });
});
