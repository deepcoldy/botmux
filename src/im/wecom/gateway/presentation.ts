import type { TriggerResponse } from '../../../services/trigger-types.js';
import type { WecomMessageConfig } from '../config/message-config.js';
import type { CoreOnlyProgress } from '../../../core/core-only-progress.js';
import { cliSupportsCompactAction } from '../../../core/passthrough-commands.js';
import type { WecomTemplateCard } from '../protocol/types.js';
import { wecomPromptLine } from './prompt-lines.js';

export type WecomProgress = CoreOnlyProgress;

export function renderWecomProgress(progress: WecomProgress, policy: WecomMessageConfig): string {
  const goal = policy.goalStatusCard && progress.goal
    ? `目标：${progress.goal.objective}\n状态：${progress.goal.status} · CLI 累计 ${progress.goal.timeUsedSeconds} 秒`
    : '';
  const usage = policy.usageDisplay === 'streaming' && progress.usage
    ? [
      progress.usage.context
        ? `上下文 ${progress.usage.context.usedTokens}${progress.usage.context.windowTokens ? ` / ${progress.usage.context.windowTokens}` : ''} tokens`
        : '',
      progress.usage.tokens
        ? `会话累计 输入 ${progress.usage.tokens.in} / 输出 ${progress.usage.tokens.out} tokens`
        : '',
      progress.usage.turnTokens
        ? `本轮 输入 ${progress.usage.turnTokens.in} / 输出 ${progress.usage.turnTokens.out} tokens`
        : '',
    ].filter(Boolean).join(' · ')
    : '';
  return [
    goal,
    usage,
    ...progress.entries.flatMap(entry => {
      if (entry.kind === 'thinking') {
        return policy.cotEnabled !== true ? [] : [`思考：${entry.text}`];
      }
      if (entry.kind === 'text') {
        return policy.disableStreamingCard === false ? [entry.text] : [];
      }
      if (policy.replyCardShowTools !== true) {
        return [];
      }
      return entry.kind === 'tool_call'
        ? [`工具 ${entry.name}：${entry.subject ?? entry.args}`]
        : [`工具结果：${entry.result}`];
    }),
  ].filter(Boolean).join('\n\n');
}

export function renderWecomFinal(content: string, policy: WecomMessageConfig, facts: {
  usage?: TriggerResponse['usage'];
  elapsedMs?: number;
  model?: string;
  recipient: string;
}): string {
  const metadata: string[] = [];
  if (policy.showReplyTiming && facts.elapsedMs !== undefined) {
    metadata.push(`耗时 ${(facts.elapsedMs / 1000).toFixed(1)} 秒`);
  }
  const usage = facts.usage
    && `输入 ${facts.usage.inputTokens} / 输出 ${facts.usage.outputTokens} tokens${facts.usage.cacheReadTokens ? ` / 缓存读取 ${facts.usage.cacheReadTokens}` : ''}${facts.usage.cacheCreateTokens ? ` / 缓存写入 ${facts.usage.cacheCreateTokens}` : ''}`;
  if (policy.usageDisplay === 'streaming' && usage) {
    metadata.push(usage);
  }
  if (policy.replyFooterEnabled === true) {
    if (policy.replyFooterBrand !== false && policy.brandLabel !== '') {
      metadata.push(policy.brandLabel ?? 'botmux');
    }
    if (policy.replyFooterModel !== false && facts.model) {
      metadata.push(`模型 ${facts.model}`);
    }
    if (policy.replyFooterUsage !== false
      && policy.usageDisplay !== 'off'
      && policy.usageDisplay !== 'streaming'
      && usage) {
      metadata.push(usage);
    }
    if (policy.replyFooterRecipients !== false) {
      metadata.push(`发送给 ${facts.recipient}`);
    }
  }
  return metadata.length ? `${content}\n\n---\n${metadata.join(' · ')}` : content;
}

export function buildWecomTaskCard(input: {
  taskId: string;
  running: boolean;
  policy: WecomMessageConfig & {
    cli?: string;
    writableTerminalLinkInCard?: boolean;
  };
  feedback?: boolean;
  status?: string;
}): WecomTemplateCard | undefined {
  const buttons: NonNullable<WecomTemplateCard['button_list']> = [];
  if (input.feedback && input.policy.feedback?.enabled) {
    for (const button of input.policy.feedback.buttons) {
      buttons.push({
        text: button.label,
        key: `feedback:${button.key}`,
        style: button.style === 'primary' ? 1 : button.style === 'danger' ? 4 : 2,
      });
    }
  }
  if (input.policy.replyCardActions === true) {
    // The Dashboard builds terminal links on its own address (dashboard/wecom/terminal-access.ts).
    if (!input.policy.hiddenStreamingCardButtons?.includes('terminal')) {
      buttons.push({ text: '只读终端', key: 'action:terminal', style: 2 });
    }
    if (input.policy.writableTerminalLinkInCard
      && !input.policy.hiddenStreamingCardButtons?.includes('writeLink')) {
      buttons.push({ text: '申请终端写权', key: 'action:writeLink', style: 2 });
    }
    if (input.running && !input.policy.hiddenStreamingCardButtons?.includes('stop')) {
      buttons.push({ text: '停止任务', key: 'action:stop', style: 4 });
    }
    if (!input.running && !input.policy.hiddenStreamingCardButtons?.includes('output')) {
      buttons.push({ text: '查看输出', key: 'action:output', style: 2 });
    }
    if (!input.running
      && cliSupportsCompactAction(input.policy.cli as any)
      && !input.policy.hiddenStreamingCardButtons?.includes('compact')) {
      buttons.push({ text: '压缩上下文', key: 'action:compact', style: 2 });
    }
    if (!input.running && !input.policy.hiddenStreamingCardButtons?.includes('close')) {
      buttons.push({ text: '关闭会话', key: 'action:close', style: 2 });
    }
  }
  if (!buttons.length) {
    return;
  }
  return {
    card_type: 'button_interaction',
    task_id: input.taskId,
    main_title: {
      title: input.running ? '任务处理中' : '任务已结束',
      ...(input.status ? { desc: input.status } : {}),
    },
    button_list: buttons.slice(0, 6),
  };
}

/**
 * The fixed channel line of every admitted chat turn: whose request it is, who
 * reads the reply, and that the gateway delivers it. The audience follows where
 * the gateway really delivers (bridge/addressing.ts `recipient`): a private chat
 * reaches only the requester; a group chat reaches the group's members.
 */
export function wecomTurnChannelInstruction(chatType: 'single' | 'group'): string {
  // One editable line per audience (contract/prompt-fragments.ts).
  return wecomPromptLine(chatType === 'single' ? 'wecom.task.channel_private' : 'wecom.task.channel_group');
}
