import { describe, expect, it } from 'vitest';
import { buildProjectGroupCard } from '../src/im/lark/project-group-card.js';
import type { ProjectGroupState } from '../src/services/project-group-store.js';

function makeProject(overrides: Partial<ProjectGroupState> = {}): ProjectGroupState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    chatId: 'oc_test',
    larkAppId: 'cli_test',
    coordinatorSessionId: 'sess-1',
    title: '测试项目',
    goal: '目标',
    phase: '进行中',
    focus: '当前焦点',
    status: 'in_progress',
    blockers: [],
    workstreams: [{
      dispatchRoot: 'om_root',
      title: '子任务一',
      purpose: '需要换行的较长子任务说明'.repeat(10),
      owners: [],
      status: 'in_progress',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }],
    milestones: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('buildProjectGroupCard workstream table', () => {
  it('auto-sizes rows with the shared cap while keeping its own blue header style', () => {
    const card = buildProjectGroupCard(makeProject()) as any;
    const table = card.body.elements.find((e: any) => e.tag === 'table');
    expect(table).toBeTruthy();

    // 行高封顶复用共享片段（回归：该表原本只有 row_height:'auto'，
    // 仍吃组件默认 124px 上限，长 purpose 会被裁）。
    expect(table.row_height).toBe('auto');
    expect(table.row_max_height).toBe('300px');

    // 蓝底表头是该卡自有样式，不能被共享灰底表头片段（含 lines:2）覆盖。
    expect(table.header_style).toMatchObject({
      text_align: 'left',
      background_style: 'blue-50',
      text_color: 'blue',
      bold: true,
    });
    expect(table.header_style).not.toHaveProperty('lines');
  });

  it('omits the table when there are no workstreams', () => {
    const card = buildProjectGroupCard(makeProject({ workstreams: [] })) as any;
    expect(card.body.elements.some((e: any) => e.tag === 'table')).toBe(false);
  });

  it('keeps runtime identity in ProjectStore but hides it from the compact card copy', () => {
    const marker = '[task:0917f0d4099c854321c8aca3f1459c31]';
    const title = `社区编辑器丰富度检测终态刷新修复 ${marker}`;
    const goal = '页面从隐藏或休眠恢复时先拉取服务端最新状态，优先展示真实终态，不修改服务端检测标准；'.repeat(4);
    const project = makeProject({ title, goal });
    const card = buildProjectGroupCard(project) as any;
    const serialized = JSON.stringify(card);
    const goalText = card.body.elements[0].elements[1].content;

    expect(project.title).toBe(title);
    expect(card.header.title.content).toBe('社区编辑器丰富度检测终态刷新修复');
    expect(card.config.summary.content).not.toContain('[task:');
    expect(serialized).not.toContain(marker);
    expect(goalText).toContain('…');
    expect(goalText).not.toContain(goal);
  });
});
