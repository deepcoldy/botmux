import { describe, expect, it } from 'vitest';
import { planSlashCommandSync, type LarkSlashCommand } from '../src/core/lark-slash-command-sync.js';

const cmd = (command: string, text: string): LarkSlashCommand =>
  ({ command, description: { default_value: text, i18n: { zh_cn: text, en_us: text } } });

describe('planSlashCommandSync', () => {
  it('creates missing, updates changed and deletes only commands botmux published before', () => {
    const ops = planSlashCommandSync(
      [cmd('group', '建群'), cmd('close', '关闭会话')],
      [
        { commandId: 'id-close', command: 'close', description: cmd('close', '旧描述').description },
        { commandId: 'id-old', command: 'work-bind', description: cmd('work-bind', 'x').description },
        { commandId: 'id-manual', command: 'deploy', description: cmd('deploy', '运维手加').description },
      ],
      ['close', 'work-bind'],
    );

    expect(ops).toEqual([
      { op: 'create', command: cmd('group', '建群') },
      { op: 'update', commandId: 'id-close', command: cmd('close', '关闭会话') },
      { op: 'delete', commandId: 'id-old', command: 'work-bind' },
    ]);
  });
});
