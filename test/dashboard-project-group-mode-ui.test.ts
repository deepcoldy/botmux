import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectGroupModeSection } from '../src/dashboard/web/groups-page.js';
import type { GroupChat } from '../src/dashboard/web/groups-api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tr = (key: string, values?: Record<string, unknown>) => {
  let result = key;
  for (const [name, value] of Object.entries(values ?? {})) result = result.replace(`{${name}}`, String(value));
  return result;
};

const members: GroupChat['memberBots'] = [
  { larkAppId: 'cli_coordinator', botName: 'Coordinator', inChat: true },
  { larkAppId: 'cli_worker', botName: 'Worker', inChat: true },
];

const chat: GroupChat = {
  chatId: 'oc_project',
  chatMode: 'group',
  collaborationMode: 'standard',
  memberBots: members,
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

describe('Dashboard project group mode section', () => {
  it('configures group nature without collecting goal or progress fields', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => init?.method === 'PUT'
        ? {
            ok: true,
            config: {
              chatId: 'oc_project', mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
              autoEnrollWorkers: true,
              progressCard: {
                schemaVersion: 1, templateId: 'compact-list',
                sections: ['goal', 'blockers', 'workstreams', 'milestones'], milestonesExpanded: false,
              },
            },
            project: null,
          }
        : { ok: true, config: { chatId: 'oc_project', mode: 'standard' }, project: null },
    })) as any;
    globalThis.fetch = fetchMock;
    const onSaved = vi.fn(async () => ({ chats: [], bots: [] }));
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ProjectGroupModeSection, { chat, members, tr, onSaved }));
    });
    await settle();

    act(() => renderer.root.findByProps({ value: 'project' }).props.onChange());
    act(() => renderer.root.findByProps({ value: 'compact-list' }).props.onChange());
    const save = renderer.root.findAllByType('button').find(button => button.children.join('') === 'groups.projectModeSave');
    expect(save).toBeTruthy();
    await act(async () => { save!.props.onClick(); });

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/api/groups/oc_project/collaboration-mode');
    const requestBody = JSON.parse(String(put?.[1]?.body));
    expect(requestBody).toEqual({
      mode: 'project', coordinatorAppId: 'cli_coordinator', workerAppIds: ['cli_worker'],
      autoEnrollWorkers: true,
      progressCard: {
        schemaVersion: 1, templateId: 'compact-list',
        sections: ['goal', 'blockers', 'workstreams', 'milestones'], milestonesExpanded: false,
      },
    });
    expect(requestBody).not.toHaveProperty('goal');
    expect(requestBody).not.toHaveProperty('progress');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
    const roleLink = renderer.root.findAllByType('a').find(link => String(link.props.href).includes('botId=cli_coordinator'));
    expect(roleLink?.props.href).toContain('#/roles?chatId=oc_project');
  });

  it('shows current project as a read-only runtime summary', async () => {
    globalThis.fetch = vi.fn() as any;
    const projectChat: GroupChat = {
      ...chat,
      collaborationMode: 'project',
      projectCoordinatorAppId: 'cli_coordinator',
      projectWorkerAppIds: ['cli_worker'],
      projectAutoEnrollWorkers: false,
      projectProgressCard: {
        schemaVersion: 1, templateId: 'compact-list', sections: ['workstreams', 'milestones'], milestonesExpanded: true,
      },
      projectRuntime: {
        status: 'active', phase: '联调', focus: '验证回报', progress: 60, remaining: '2 个子任务',
        workstreamCount: 2, completedWorkstreamCount: 1, blockerCount: 0, cardPinned: true,
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ProjectGroupModeSection, {
        chat: projectChat, members, tr, onSaved: async () => ({ chats: [], bots: [] }),
      }));
    });
    await settle();

    expect(renderer.root.findByProps({ 'data-project-runtime': 'active' })).toBeTruthy();
    expect(renderer.root.findByProps({ value: 'compact-list' }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'data-project-auto-enroll-workers': 'oc_project' }).props.checked).toBe(false);
    expect(renderer.root.findAllByType('input').every(input => input.props.type === 'radio' || input.props.type === 'checkbox')).toBe(true);
  });
});
