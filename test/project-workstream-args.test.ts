import { describe, expect, it } from 'vitest';
import { parseProjectArgs } from '../src/cli/project-args.js';

describe('project workstream CLI actions', () => {
  it('parses explicit attach without conflating actor and source session', () => {
    const result = parseProjectArgs('workstream', [
      'attach', '--root', 'om_task', '--source-session', 'worker-session',
      '--source-app', 'cli_worker', '--title', '迁入任务', '--session-id', 'main-session',
    ]);
    expect(result).toMatchObject({
      ok: true, sessionId: 'main-session', workstream: {
        action: 'attach', sourceSessionId: 'worker-session', sourceLarkAppId: 'cli_worker',
        rootMessageId: 'om_task', title: '迁入任务',
      },
    });
  });
  it('supports item rename without dispatching another prompt', () => {
    expect(parseProjectArgs('workstream', ['rename', '--root', 'om_task', '--title', '实现迁入登记']))
      .toMatchObject({ ok: true, workstream: { action: 'rename', title: '实现迁入登记' } });
  });
  it.each(['', '子任务', '子项目', '一'.repeat(25)])('rejects invalid rename title %s', title => {
    expect(parseProjectArgs('workstream', ['rename', '--root', 'om_task', '--title', title])).toMatchObject({ ok: false });
  });
  it.each([
    ['attach', '--root', 'om_task'],
    ['inspect', '--root', 'oc_chat', '--source-app', 'cli_worker', '--source-session', 'worker'],
    ['rename', '--root', 'om_task', '--title', '迁入', '--owner', 'ou_forged'],
    ['attach', '--root', 'om_task', '--source-app', 'cli_worker', '--source-session', 'worker', '--revision', '-1'],
    ['update', '--root', 'om_task', '--status', 'done'],
    ['update', '--root', 'om_task', '--status', 'completed', '--progress', '101'],
  ])('rejects incomplete or forged options', args => {
    expect(parseProjectArgs('workstream', args)).toMatchObject({ ok: false });
  });
  it('uses source-local grant and bounded status without mandatory root', () => {
    expect(parseProjectArgs('workstream', ['grant'])).toMatchObject({ ok: true, workstream: { action: 'grant' } });
    expect(parseProjectArgs('workstream', ['status'])).toMatchObject({ ok: true, workstream: { action: 'status' } });
  });
});
