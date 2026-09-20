import { describe, expect, it } from 'vitest';
import {
  buildFrozenCommandActionStatusCard,
  buildFrozenCommandCenterCard,
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

  it('puts only opaque action id and nonce in callback values', () => {
    const parsed = JSON.parse(buildFrozenCommandPreviewCard({
      action,
      nonce: 'nonce-1',
      initiatorLabel: '本人',
    })) as any;
    const values = parsed.body.elements[1].actions.map((button: any) => button.value);
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
    expect(buildFrozenCommandActionStatusCard({ ...action, status: 'completed', queryId: 'q_1' })).toMatchObject({
      header: { template: 'green' },
    });
    expect(buildFrozenCommandActionStatusCard({ ...action, status: 'expired' })).toMatchObject({
      header: { template: 'grey' },
    });
    expect(buildFrozenCommandActionStatusCard({ ...action, status: 'failed', errorCode: 'user_cancelled' })).toMatchObject({
      header: { template: 'grey' },
    });
  });
});
