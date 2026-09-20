import type { FrozenCommandActionRecord } from '../../services/frozen-command-action.js';

export const FROZEN_COMMAND_ACTION_CONFIRM = 'frozen_command_run_confirm' as const;
export const FROZEN_COMMAND_ACTION_CANCEL = 'frozen_command_run_cancel' as const;

export interface FrozenCommandCenterRow {
  command: string;
  usage?: string;
  description?: string;
  datasource?: string;
  state: 'active' | 'retired' | 'revoked' | 'invalid' | 'unapproved';
  reason?: string;
}

function escapeMd(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

function card(body: Record<string, unknown>): string {
  return JSON.stringify({ schema: '2.0', ...body });
}

export function buildFrozenCommandCenterCard(input: {
  rows: readonly FrozenCommandCenterRow[];
  roleLabel: string;
}): string {
  const elements: unknown[] = [{
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `当前角色：**${escapeMd(input.roleLabel)}**\n只展示命令元数据，不展示 SQL。`,
    },
  }, { tag: 'hr' }];
  if (input.rows.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '当前角色还没有固化命令。' },
    });
  } else {
    for (const row of input.rows) {
      const status = row.state === 'active'
        ? '🟢 可用'
        : row.state === 'retired'
          ? '🟠 已废弃'
          : row.state === 'revoked'
            ? '🔴 已撤销'
            : row.state === 'unapproved'
              ? '🟡 待批准'
              : '⚠️ 不可用';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**/${escapeMd(row.command)}** · ${status}`,
            row.description ? escapeMd(row.description) : undefined,
            row.usage ? `用法：${escapeMd(row.usage)}` : undefined,
            `数据源：${escapeMd(row.datasource ?? '默认数据源')}`,
            row.reason ? `说明：${escapeMd(row.reason)}` : undefined,
          ].filter(Boolean).join('\n'),
        },
      });
    }
  }
  elements.push({ tag: 'hr' }, {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '需要执行时直接说“运行 /命令 参数”。系统会先展示确认卡，不会直接查数。',
    },
  });
  return card({
    header: { title: { tag: 'plain_text', content: '固化命令中心' }, template: 'blue' },
    body: { elements },
  });
}

export function buildFrozenCommandPreviewCard(input: {
  action: FrozenCommandActionRecord;
  nonce: string;
  initiatorLabel: string;
}): string {
  const args = input.action.normalizedArgs.length > 0
    ? input.action.normalizedArgs
      .map(item => `- ${escapeMd(item.label)}：**${escapeMd(item.value)}**`)
      .join('\n')
    : '- 无参数';
  return card({
    header: { title: { tag: 'plain_text', content: '确认运行固化命令' }, template: 'orange' },
    body: {
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `命令：**/${escapeMd(input.action.command)}**`,
            `参数：\n${args}`,
            `数据源：**${escapeMd(input.action.datasource ?? '默认数据源')}**`,
            `发起人：${escapeMd(input.initiatorLabel)}`,
            '',
            '确认后将以你的真实账号权限执行一次查询；SQL 不会在卡片中展示。',
          ].join('\n'),
        },
      }, {
        tag: 'action',
        actions: [{
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: '确认运行' },
          value: {
            action: FROZEN_COMMAND_ACTION_CONFIRM,
            transition_id: input.action.id,
            nonce: input.nonce,
          },
        }, {
          tag: 'button',
          type: 'default',
          text: { tag: 'plain_text', content: '取消' },
          value: {
            action: FROZEN_COMMAND_ACTION_CANCEL,
            transition_id: input.action.id,
            nonce: input.nonce,
          },
        }],
      }],
    },
  });
}

export function buildFrozenCommandActionStatusCard(
  action: Pick<FrozenCommandActionRecord, 'command' | 'status' | 'queryId' | 'errorCode'>,
): Record<string, unknown> {
  const state = action.status === 'executing'
    ? { title: '正在执行', template: 'blue', text: '请求已受理，请勿重复点击。查询结果会发送到原会话。' }
    : action.status === 'completed'
      ? { title: '执行完成', template: 'green', text: `/${action.command} 已完成${action.queryId ? `（query_id: ${action.queryId}）` : ''}。` }
      : action.status === 'expired'
        ? { title: '确认已过期', template: 'grey', text: '本次确认已过期，请重新发起。' }
        : action.errorCode === 'user_cancelled'
          ? { title: '已取消', template: 'grey', text: `/${action.command} 未执行查询。` }
        : { title: '执行失败', template: 'red', text: `/${action.command} 未完成${action.errorCode ? `（${action.errorCode}）` : ''}。请重新发起。` };
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: state.title }, template: state.template },
    body: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: state.text } }] },
  };
}
