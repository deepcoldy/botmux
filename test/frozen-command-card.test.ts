import { describe, expect, it } from 'vitest';
import {
  buildFrozenCommandActionStatusCard,
  buildFrozenCommandCenterCard,
  buildFrozenCommandLifecyclePreviewCard,
  buildFrozenCommandLifecycleStatusCard,
  buildFrozenCommandPreviewCard,
} from '../src/im/lark/frozen-command-card.js';
import type { FrozenCommandActionRecord } from '../src/services/frozen-command-action.js';

const action: FrozenCommandActionRecord = {
  id: 'action-id',
  status: 'pending',
  targetBotId: 'cli_app',
  chatId: 'oc_chat',
  chatType: 'group',
  rootMessageId: 'om_root',
  scope: 'thread',
  sessionId: 'session',
  turnId: 'om_source',
  dispatchAttempt: 1,
  workingDir: '/repo',
  sourceMessageId: 'om_source',
  sourceContentHash: 'a'.repeat(64),
  intentSchemaVersion: 'botmux.frozen-command-intent.v1',
  parserVersion: 'frozen-command-args.v1',
  actorOpenId: 'ou_actor',
  actorUnionId: 'on_actor',
  command: '日报',
  rawArgs: '7',
  normalizedArgs: [{ name: 'days', label: '天数', value: '7' }],
  datasource: 'warehouse',
  specHash: 'b'.repeat(64),
  revisionId: 'revision',
  createdAt: '2026-09-20T00:00:00.000Z',
  expiresAt: '2026-09-20T00:10:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

describe('Frozen Command business cards', () => {
  it('shows metadata only in the command center', () => {
    const rendered = buildFrozenCommandCenterCard({
      botLabel: '财务助手',
      workingDirLabel: 'finance',
      rows: [{
        command: '日报',
        usage: '/日报 [天数]',
        description: '经营日报',
        datasource: 'warehouse',
        state: 'active',
      }, {
        command: '旧日报',
        state: 'retired',
        reason: '口径升级',
      }],
    });
    expect(rendered).toContain('固化命令中心');
    expect(rendered).toContain('当前机器人');
    expect(rendered).toContain('财务助手');
    expect(rendered).toContain('工作目录');
    expect(rendered).toContain('已废弃');
    expect(rendered).not.toContain('SELECT');
    expect(rendered).not.toContain('sql');
  });

  it('uses Card 2.0 buttons and puts only opaque action id and nonce in callback values', () => {
    const parsed = JSON.parse(buildFrozenCommandPreviewCard({
      action,
      nonce: 'nonce-1',
      initiatorLabel: '本人',
    })) as any;
    expect(parsed.schema).toBe('2.0');
    expect(parsed.body.elements.some((element: any) => element.tag === 'action')).toBe(false);
    const buttonRow = parsed.body.elements[1];
    expect(buttonRow).toMatchObject({ tag: 'column_set', flex_mode: 'flow' });
    const buttons = buttonRow.columns.map((column: any) => column.elements[0]);
    expect(buttons.every((button: any) => button.tag === 'button' && button.value === undefined)).toBe(true);
    const values = buttons.map((button: any) => button.behaviors[0].value);
    expect(values).toEqual([
      { action: 'frozen_command_run_confirm', transition_id: 'action-id', nonce: 'nonce-1' },
      { action: 'frozen_command_run_cancel', transition_id: 'action-id', nonce: 'nonce-1' },
    ]);
    const serializedValues = JSON.stringify(values);
    expect(serializedValues).not.toContain('warehouse');
    expect(serializedValues).not.toContain('日报');
    expect(serializedValues).not.toContain('ou_actor');
  });

  it('renders executing/completed/expired/cancelled terminal states', () => {
    expect(buildFrozenCommandActionStatusCard({ ...action, status: 'executing' })).toMatchObject({
      header: { template: 'blue' },
    });
    const completed = buildFrozenCommandActionStatusCard({ ...action, status: 'completed', queryId: 'q_1' });
    expect(completed).toMatchObject({
      header: { template: 'green' },
    });
    expect(JSON.stringify(completed)).not.toContain('q_1');
    expect(JSON.stringify(completed)).not.toContain('query_id');
    expect(buildFrozenCommandActionStatusCard({ ...action, status: 'expired' })).toMatchObject({
      header: { template: 'grey' },
    });
    expect(buildFrozenCommandActionStatusCard({ ...action, status: 'failed', errorCode: 'user_cancelled' })).toMatchObject({
      header: { template: 'grey' },
    });
  });

  it('does not expose internal error codes in failed status cards', () => {
    const rendered = buildFrozenCommandActionStatusCard({
      ...action,
      status: 'failed',
      errorCode: 'data_mcp_not_enabled',
    });
    expect(rendered).toMatchObject({
      header: { template: 'red', title: { content: '执行失败' } },
      body: { elements: [{ text: { content: expect.stringContaining('查询未完成') } }] },
    });
    expect(JSON.stringify(rendered)).not.toContain('data_mcp_not_enabled');
  });

  it('renders a one-click lifecycle card with only an opaque token in callbacks', () => {
    const parsed = JSON.parse(buildFrozenCommandLifecyclePreviewCard({
      transition: {
        token: 'opaque-token',
        expiresAt: '2026-09-21T12:00:00.000Z',
        command: '日报',
        action: 'approve',
        reason: '更新经营口径',
        specHash: 'b'.repeat(64),
        previousSpecHash: 'a'.repeat(64),
        expectedRevisionId: 'revision-old',
      },
      workingDirLabel: 'finance',
    })) as any;
    expect(parsed.header).toMatchObject({ template: 'orange', title: { content: '确认更新固化命令' } });
    expect(JSON.stringify(parsed)).toContain('aaaaaaaaaaaa');
    expect(JSON.stringify(parsed)).toContain('bbbbbbbbbbbb');
    const buttons = parsed.body.elements[1].columns.map((column: any) => column.elements[0]);
    expect(buttons.map((button: any) => button.behaviors[0].value)).toEqual([
      { action: 'frozen_command_lifecycle_confirm', transition_token: 'opaque-token' },
      { action: 'frozen_command_lifecycle_cancel', transition_token: 'opaque-token' },
    ]);
    const values = JSON.stringify(buttons.map((button: any) => button.behaviors[0].value));
    expect(values).not.toContain('日报');
    expect(values).not.toContain('finance');
    expect(values).not.toContain('revision-old');
  });

  it('uses a danger card for retirement and freezes terminal lifecycle cards', () => {
    const parsed = JSON.parse(buildFrozenCommandLifecyclePreviewCard({
      transition: {
        token: 'retire-token',
        expiresAt: '2026-09-21T12:00:00.000Z',
        command: '旧日报',
        action: 'retire',
        reason: '口径迁移',
        replacement: '/新日报',
      },
      workingDirLabel: 'finance',
    })) as any;
    expect(parsed.header.template).toBe('red');
    expect(parsed.body.elements[1].columns[0].elements[0].type).toBe('danger');
    expect(buildFrozenCommandLifecycleStatusCard({
      command: '旧日报', action: 'retire', status: 'confirmed',
    })).toMatchObject({ header: { template: 'green' } });
    expect(buildFrozenCommandLifecycleStatusCard({
      command: '旧日报', action: 'retire', status: 'cancelled',
    })).toMatchObject({ header: { template: 'grey' } });
  });
});
