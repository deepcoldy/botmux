import type { FrozenCommandActionRecord } from '../../services/frozen-command-action.js';
import type {
  FrozenCommandLifecycleAction,
  FrozenCommandPreparedTransition,
} from '../../services/frozen-command-lifecycle.js';

export const FROZEN_COMMAND_ACTION_CONFIRM = 'frozen_command_run_confirm' as const;
export const FROZEN_COMMAND_ACTION_CANCEL = 'frozen_command_run_cancel' as const;
export const FROZEN_COMMAND_LIFECYCLE_CONFIRM = 'frozen_command_lifecycle_confirm' as const;
export const FROZEN_COMMAND_LIFECYCLE_CANCEL = 'frozen_command_lifecycle_cancel' as const;

export interface FrozenCommandCenterRow {
  command: string;
  usage?: string;
  description?: string;
  executor?: string;
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
  botLabel: string;
  workingDirLabel: string;
}): string {
  const elements: unknown[] = [{
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: [
        `当前机器人：**${escapeMd(input.botLabel)}**`,
        `工作目录：**${escapeMd(input.workingDirLabel)}**`,
        '只展示命令元数据，不展示 SQL 或敏感输入。',
      ].join('\n'),
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
            row.executor ? `执行器：${escapeMd(row.executor)}` : undefined,
            row.datasource ? `数据源：${escapeMd(row.datasource)}` : undefined,
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
      content: '需要执行时直接说“运行 /命令 参数”。系统会先展示操作确认卡，不会直接执行。',
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
            `执行器：**${escapeMd(input.action.executorId)}**`,
            ...(input.action.datasource ? [`数据源：**${escapeMd(input.action.datasource)}**`] : []),
            `发起人：${escapeMd(input.initiatorLabel)}`,
            '',
            input.action.executorId === 'builtin.data-mcp.readonly'
              ? '确认后将以你的真实账号权限执行一次查询；SQL 不会在卡片中展示。'
              : '确认后将运行一次已批准的只读白名单能力。确认卡是本次操作确认，不是额外授权；身份与权限仍由执行路径校验。',
          ].join('\n'),
        },
      }, {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: '8px',
        columns: [{
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '确认运行' },
            behaviors: [{
              type: 'callback',
              value: {
                action: FROZEN_COMMAND_ACTION_CONFIRM,
                transition_id: input.action.id,
                nonce: input.nonce,
              },
            }],
          }],
        }, {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '取消' },
            behaviors: [{
              type: 'callback',
              value: {
                action: FROZEN_COMMAND_ACTION_CANCEL,
                transition_id: input.action.id,
                nonce: input.nonce,
              },
            }],
          }],
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
      ? { title: '执行完成', template: 'green', text: `/${action.command} 已完成。` }
      : action.status === 'expired'
        ? { title: '确认已过期', template: 'grey', text: '本次确认已过期，请重新发起。' }
        : action.errorCode === 'user_cancelled'
          ? { title: '已取消', template: 'grey', text: `/${action.command} 未执行查询。` }
        : {
            title: '执行失败',
            template: 'red',
            text: `/${action.command} 执行未完成，请重新发起；如持续失败请联系管理员。`,
          };
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: state.title }, template: state.template },
    body: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: state.text } }] },
  };
}

function lifecyclePresentation(
  transition: Pick<FrozenCommandPreparedTransition, 'action' | 'expectedRevisionId' | 'previousSpecHash'>,
): { verb: string; title: string; template: string; warning: string } {
  if (transition.action === 'approve') {
    const updating = !!transition.expectedRevisionId || !!transition.previousSpecHash;
    return updating
      ? { verb: '更新', title: '确认更新固化命令', template: 'orange', warning: '确认后才会替换当前生效版本。' }
      : { verb: '创建', title: '确认创建固化命令', template: 'blue', warning: '确认后才会安装并启用。' };
  }
  if (transition.action === 'retire') {
    return { verb: '废弃', title: '确认废弃固化命令', template: 'red', warning: '确认后该命令将停止执行，但仍保留可恢复的审计记录。' };
  }
  if (transition.action === 'restore') {
    return { verb: '恢复', title: '确认恢复固化命令', template: 'orange', warning: '确认后将恢复最近一次已批准版本。' };
  }
  return { verb: '彻底撤销', title: '确认彻底撤销固化命令', template: 'red', warning: '此操作不可逆，确认后会删除可执行定义。' };
}

export function buildFrozenCommandLifecyclePreviewCard(input: {
  transition: FrozenCommandPreparedTransition;
  workingDirLabel: string;
}): string {
  const presentation = lifecyclePresentation(input.transition);
  const currentHash = input.transition.previousSpecHash?.slice(0, 12);
  const nextHash = input.transition.specHash?.slice(0, 12);
  return card({
    header: {
      title: { tag: 'plain_text', content: presentation.title },
      template: presentation.template,
    },
    body: {
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `操作：**${presentation.verb}**`,
            `命令：**/${escapeMd(input.transition.command)}**`,
            `目录：**${escapeMd(input.workingDirLabel)}**`,
            `原因：${escapeMd(input.transition.reason)}`,
            ...(input.transition.replacement ? [`替代命令：**${escapeMd(input.transition.replacement)}**`] : []),
            ...(input.transition.expectedRevisionId
              ? [`当前 revision：\`${escapeMd(input.transition.expectedRevisionId)}\``]
              : []),
            ...(currentHash && nextHash && currentHash !== nextHash
              ? [`定义变更：\`${currentHash}\` → \`${nextHash}\``]
              : nextHash ? [`定义 hash：\`${nextHash}\``] : []),
            `有效期至：${escapeMd(input.transition.expiresAt)}`,
            '',
            presentation.warning,
          ].join('\n'),
        },
      }, {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: '8px',
        columns: [{
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            type: input.transition.action === 'retire' || input.transition.action === 'revoke' ? 'danger' : 'primary',
            text: { tag: 'plain_text', content: `确认${presentation.verb}` },
            behaviors: [{
              type: 'callback',
              value: {
                action: FROZEN_COMMAND_LIFECYCLE_CONFIRM,
                transition_token: input.transition.token,
              },
            }],
          }],
        }, {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '取消' },
            behaviors: [{
              type: 'callback',
              value: {
                action: FROZEN_COMMAND_LIFECYCLE_CANCEL,
                transition_token: input.transition.token,
              },
            }],
          }],
        }],
      }],
    },
  });
}

export function buildFrozenCommandLifecycleStatusCard(input: {
  command: string;
  action: FrozenCommandLifecycleAction;
  status: 'confirmed' | 'cancelled' | 'expired' | 'failed';
}): Record<string, unknown> {
  const presentation = lifecyclePresentation({ action: input.action });
  const state = input.status === 'confirmed'
    ? { title: `${presentation.verb}完成`, template: 'green', text: `/${input.command} 已完成${presentation.verb}。` }
    : input.status === 'cancelled'
      ? { title: '已取消', template: 'grey', text: `/${input.command} 未执行${presentation.verb}。` }
      : input.status === 'expired'
        ? { title: '确认已过期', template: 'grey', text: '本次确认已过期，请重新发起。' }
        : { title: '状态变更失败', template: 'red', text: `/${input.command} 未完成${presentation.verb}，请重新发起。` };
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: state.title }, template: state.template },
    body: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: state.text } }] },
  };
}
