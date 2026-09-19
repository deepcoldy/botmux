import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReportTaskLineage } from '../src/core/report-task-lineage.js';

const roots: string[] = [];

function taskFixture(overrides: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-report-lineage-')));
  roots.push(root);
  const contextDir = join(root, 'context');
  mkdirSync(contextDir);
  const contentFile = join(contextDir, 'review.txt');
  const bindingFile = join(contextDir, 'botmux-task.json');
  writeFileSync(contentFile, 'Review handoff');
  writeFileSync(bindingFile, JSON.stringify({
    schemaVersion: 1,
    status: 'dispatched',
    taskSlug: 'task-a',
    taskRoot: root,
    taskChatId: 'oc_task_group',
    dispatch: { mode: 'chat', success: true, chatId: 'oc_task_group', messageId: 'om_task_a_dispatch' },
    ...overrides,
  }));
  return { root, contentFile, bindingFile };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveReportTaskLineage', () => {
  it('resolves the task binding of the report artifact', () => {
    const fixture = taskFixture();
    expect(resolveReportTaskLineage({ contentFile: fixture.contentFile, chatId: 'oc_task_group' })).toEqual({
      id: 'agent-task:task-a:om_task_a_dispatch', taskRoot: fixture.root,
      chatId: 'oc_task_group', dispatchRootMessageId: 'om_task_a_dispatch',
    });
  });

  it.each([
    { schemaVersion: 2 }, { taskSlug: ' ' }, { taskRoot: '/not-this-task' },
    { status: 'group_created' }, { taskChatId: 'oc_other' },
    { dispatch: { mode: 'thread', success: true, chatId: 'oc_task_group', messageId: 'om_task_a_dispatch' } },
    { dispatch: { mode: 'chat', success: false, chatId: 'oc_task_group', messageId: 'om_task_a_dispatch' } },
    { dispatch: { mode: 'chat', success: true, chatId: 'oc_other', messageId: 'om_task_a_dispatch' } },
    { dispatch: { mode: 'chat', success: true, chatId: 'oc_task_group', messageId: 'invalid' } },
  ])('fails closed for invalid binding fields: %j', overrides => {
    const fixture = taskFixture(overrides);
    expect(resolveReportTaskLineage({ contentFile: fixture.contentFile, chatId: 'oc_task_group' })).toBeUndefined();
  });

  it.each(['null', '[]', 'true', '42', '"binding"', '{'])('fails closed for invalid binding JSON: %s', json => {
    const fixture = taskFixture();
    writeFileSync(fixture.bindingFile, json);
    expect(resolveReportTaskLineage({ contentFile: fixture.contentFile, chatId: 'oc_task_group' })).toBeUndefined();
  });

  it('requires the current chat to match', () => {
    const fixture = taskFixture();
    expect(resolveReportTaskLineage({ contentFile: fixture.contentFile, chatId: 'oc_other' })).toBeUndefined();
  });

  it('does not infer lineage without an artifact', () => {
    expect(resolveReportTaskLineage({ chatId: 'oc_task_group' })).toBeUndefined();
    expect(resolveReportTaskLineage({ contentFile: '/nonexistent-report', chatId: 'oc_task_group' })).toBeUndefined();
  });

  it('does not inherit a parent task through an invalid nested binding', () => {
    const fixture = taskFixture();
    const nested = join(fixture.root, 'child', 'context');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'botmux-task.json'), 'null');
    const contentFile = join(nested, 'review.txt');
    writeFileSync(contentFile, 'Nested review');
    expect(resolveReportTaskLineage({ contentFile, chatId: 'oc_task_group' })).toBeUndefined();
  });

  it('does not use a task binding for a symlinked artifact outside that task', () => {
    const fixture = taskFixture();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-unbound-report-')));
    roots.push(outside);
    const contentFile = join(outside, 'review.txt');
    writeFileSync(contentFile, 'External review');
    const link = join(fixture.root, 'linked-review.txt');
    symlinkSync(contentFile, link);
    expect(resolveReportTaskLineage({ contentFile: link, chatId: 'oc_task_group' })).toBeUndefined();
  });
});
