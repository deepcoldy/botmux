import type { VcMeetingRef } from './types.js';
import type { VcMeetingConsumerAgentConfig } from '../bot-registry.js';

export type VcMeetingConfirmCardStatus = 'pending' | 'started' | 'declined' | 'expired' | 'failed';
export type VcMeetingConsumerCardStatus = 'pending' | 'processing' | 'listenOnly' | 'agent' | 'expired' | 'failed';
export type VcMeetingOutputReviewCardStatus =
  | 'pending'
  | 'processing'
  | 'sentText'
  | 'sentVoice'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'failed';
export type VcMeetingOutputChannel = 'text' | 'voice';

export interface VcMeetingConfirmCardInput {
  status: VcMeetingConfirmCardStatus;
  meeting: VcMeetingRef;
  targetOpenId: string;
  nonce: string;
  listenerChatId?: string;
  error?: string;
}

export interface VcMeetingConsumerCardInput {
  status: VcMeetingConsumerCardStatus;
  meeting: VcMeetingRef;
  nonce: string;
  candidates: VcMeetingConsumerAgentConfig[];
  defaultMode: 'listenOnly' | 'agent';
  defaultAgentAppId?: string;
  syncIntervalMs?: number;
  selectedAgentAppId?: string;
  selectedAgentLabel?: string;
  // 暂存态（pending 状态下已选但未确认的组合）：下拉只暂存，点"确认"才生效。
  stagedMode?: 'agent' | 'listenOnly';
  stagedAgentAppId?: string;
  stagedAgentLabel?: string;
  stagedIntervalMs?: number;
  error?: string;
}

export interface VcMeetingOutputReviewCardInput {
  status: VcMeetingOutputReviewCardStatus;
  meeting: VcMeetingRef;
  channel: VcMeetingOutputChannel;
  requestId: string;
  nonce: string;
  agentLabel?: string;
  content: string;
  contentItems?: string[];
  reason?: string;
  fallbackText?: string;
  fallbackTextItems?: string[];
  textOutputAvailable?: boolean;
  error?: string;
}

function escapeMd(text: string | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function meetingTitle(meeting: VcMeetingRef): string {
  return meeting.topic?.trim() || meeting.meetingNo || meeting.id || '飞书会议';
}

function baseLines(input: VcMeetingConfirmCardInput): string[] {
  const lines = [
    `**会议**：${escapeMd(meetingTitle(input.meeting))}`,
  ];
  if (input.meeting.meetingNo) lines.push(`**会议号**：${escapeMd(input.meeting.meetingNo)}`);
  if (input.meeting.id) lines.push(`**meeting.id**：\`${escapeMd(input.meeting.id)}\``);
  return lines;
}

function statusBody(input: VcMeetingConfirmCardInput): { template: string; title: string; body: string } {
  const lines = baseLines(input);
  if (input.status === 'pending') {
    return {
      template: 'blue',
      title: '会议监听确认',
      body: [
        '收到一个会议邀请。是否让 bot 入会并创建/使用监听群同步会中消息？',
        '',
        ...lines,
      ].join('\n'),
    };
  }
  if (input.status === 'started') {
    return {
      template: 'green',
      title: '会议监听已开始',
      body: [
        'bot 已入会，监听群同步已开启。',
        '',
        ...lines,
        ...(input.listenerChatId ? [`**监听群**：\`${escapeMd(input.listenerChatId)}\``] : []),
      ].join('\n'),
    };
  }
  if (input.status === 'declined') {
    return {
      template: 'grey',
      title: '已跳过会议监听',
      body: ['本次会议不会让 bot 入会。', '', ...lines].join('\n'),
    };
  }
  if (input.status === 'expired') {
    return {
      template: 'grey',
      title: '会议监听确认已过期',
      body: ['会议邀请已过期或会议已结束，未执行入会。', '', ...lines].join('\n'),
    };
  }
  return {
    template: 'red',
    title: '会议监听启动失败',
    body: [
      input.error ? `失败原因：${escapeMd(input.error)}` : '启动失败，请查看 daemon 日志。',
      '',
      ...lines,
    ].join('\n'),
  };
}

export function buildVcMeetingConfirmCard(input: VcMeetingConfirmCardInput): string {
  const { template, title, body } = statusBody(input);
  const actions = input.status === 'pending'
    ? [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '开始监听' },
          type: 'primary',
          value: {
            action: 'vc_meeting_confirm',
            meeting_id: input.meeting.id,
            meeting_no: input.meeting.meetingNo ?? '',
            target_open_id: input.targetOpenId,
            nonce: input.nonce,
          },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '跳过' },
          type: 'default',
          value: {
            action: 'vc_meeting_decline',
            meeting_id: input.meeting.id,
            target_open_id: input.targetOpenId,
            nonce: input.nonce,
          },
        },
      ]
    : [];
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    elements: [
      { tag: 'markdown', content: body },
      ...(actions.length ? [{ tag: 'action', actions }] : []),
    ],
  };
  return JSON.stringify(card);
}

function consumerCandidateLabel(candidate: VcMeetingConsumerAgentConfig): string {
  return candidate.label?.trim() || candidate.larkAppId;
}

function consumerCandidateOptionLabel(candidate: VcMeetingConsumerAgentConfig): string {
  return consumerCandidateLabel(candidate).slice(0, 60);
}

function consumerSyncIntervalLabel(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '默认';
  const seconds = Math.round(ms / 1000);
  return `${seconds} 秒`;
}

const CONSUMER_SYNC_INTERVAL_INPUT_NAME = 'vc_meeting_custom_interval_seconds';

function consumerSyncIntervalCustomDefault(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const presetMs = new Set([15_000, 30_000, 60_000, 90_000]);
  if (presetMs.has(ms)) return '';
  return String(Math.round(ms / 1000));
}

function consumerStatusBody(input: VcMeetingConsumerCardInput): { template: string; title: string; body: string } {
  const lines = baseLines({ meeting: input.meeting, status: 'pending', targetOpenId: '', nonce: '' });
  if (input.status === 'pending') {
    const defaultLabel = input.defaultMode === 'listenOnly'
      ? '只监听消息'
      : input.candidates.find(c => c.larkAppId === input.defaultAgentAppId)?.label || input.defaultAgentAppId || '默认 agent';
    const stagedModeLabel = input.stagedMode === 'agent'
      ? (input.stagedAgentLabel || 'agent')
      : input.stagedMode === 'listenOnly' ? '只监听消息' : undefined;
    return {
      template: 'blue',
      title: '会议处理方式',
      body: [
        '选择处理方式和同步间隔后点击"确认"生效；完全不操作会按默认设置执行。',
        '',
        ...lines,
        `**默认**：${escapeMd(defaultLabel)}`,
        `**同步间隔**：${escapeMd(consumerSyncIntervalLabel(input.stagedIntervalMs ?? input.syncIntervalMs))}${input.stagedIntervalMs ? '（待确认）' : ''}`,
        '**自定义间隔**：可填写 10-3600 秒，点击"确认"时会覆盖预设。',
        ...(stagedModeLabel ? [`**当前选择**：${escapeMd(stagedModeLabel)}（待确认）`] : []),
      ].join('\n'),
    };
  }
  if (input.status === 'listenOnly') {
    return {
      template: 'grey',
      title: '仅同步会议消息',
      body: [
        '本次会议只同步字幕、聊天和参会变化，不启用 agent 处理。',
        ...(input.error ? [`选择 agent 失败，已回退只监听：${escapeMd(input.error)}`] : []),
        '',
        ...lines,
      ].join('\n'),
    };
  }
  if (input.status === 'processing') {
    return {
      template: 'blue',
      title: '会议处理设置中',
      body: [
        '已收到确认，正在应用本次会议处理设置。',
        '完成后卡片会自动更新，请不要重复点击。',
        '',
        ...lines,
      ].join('\n'),
    };
  }
  if (input.status === 'agent') {
    return {
      template: 'green',
      title: '会议 agent 已启用',
      body: [
        `本次会议将交给 ${escapeMd(input.selectedAgentLabel || input.selectedAgentAppId || 'agent')} 处理。`,
        `同步间隔：${escapeMd(consumerSyncIntervalLabel(input.syncIntervalMs))}`,
        '',
        ...lines,
      ].join('\n'),
    };
  }
  if (input.status === 'expired') {
    return {
      template: 'grey',
      title: '会议处理选择已失效',
      body: ['选择已过期或会议已结束。', '', ...lines].join('\n'),
    };
  }
  return {
    template: 'red',
    title: '会议处理设置失败',
    body: [input.error ? `失败原因：${escapeMd(input.error)}` : '设置失败，请查看 daemon 日志。', '', ...lines].join('\n'),
  };
}

export function buildVcMeetingConsumerCard(input: VcMeetingConsumerCardInput): string {
  const { template, title, body } = consumerStatusBody(input);
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: body },
  ];
  if (input.status === 'pending') {
    elements.push(
      ...(input.candidates.length > 0 ? [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '选择 agent' },
        width: 'fill',
        initial_option: input.stagedMode === 'agent' ? input.stagedAgentAppId : undefined,
        behaviors: vcMeetingConsumerCallback({
          action: 'vc_meeting_consumer_stage',
          stage_kind: 'agent',
          meeting_id: input.meeting.id,
          nonce: input.nonce,
        }),
        options: input.candidates.map(candidate => ({
          text: { tag: 'plain_text', content: consumerCandidateOptionLabel(candidate) },
          value: candidate.larkAppId,
        })),
      }] : []),
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '同步间隔' },
        width: 'fill',
        initial_option: consumerSyncIntervalPresetValue(input.stagedIntervalMs ?? input.syncIntervalMs),
        behaviors: vcMeetingConsumerCallback({
          action: 'vc_meeting_consumer_stage',
          stage_kind: 'interval',
          meeting_id: input.meeting.id,
          nonce: input.nonce,
        }),
        options: [
          { text: { tag: 'plain_text', content: '15 秒' }, value: '15000' },
          { text: { tag: 'plain_text', content: '30 秒' }, value: '30000' },
          { text: { tag: 'plain_text', content: '60 秒' }, value: '60000' },
          { text: { tag: 'plain_text', content: '90 秒' }, value: '90000' },
        ],
      },
      {
        tag: 'form',
        name: 'vc_meeting_consumer_confirm_form',
        elements: [
          {
            tag: 'input',
            name: CONSUMER_SYNC_INTERVAL_INPUT_NAME,
            label: { tag: 'plain_text', content: '自定义同步间隔（秒）' },
            placeholder: { tag: 'plain_text', content: '例如 45，范围 10-3600' },
            default_value: consumerSyncIntervalCustomDefault(input.stagedIntervalMs ?? input.syncIntervalMs),
          },
          {
            tag: 'button',
            name: 'vc_meeting_consumer_confirm_submit',
            text: { tag: 'plain_text', content: '确认' },
            type: 'primary_filled',
            width: 'fill',
            action_type: 'form_submit',
            value: {
              action: 'vc_meeting_consumer_confirm',
              meeting_id: input.meeting.id,
              nonce: input.nonce,
            },
          },
        ],
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '只监听消息' },
        type: 'default',
        behaviors: vcMeetingConsumerCallback({
          action: 'vc_meeting_consumer_stage',
          stage_kind: 'listenOnly',
          meeting_id: input.meeting.id,
          nonce: input.nonce,
        }),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '使用默认设置' },
        type: 'default',
        behaviors: vcMeetingConsumerCallback({
          action: 'vc_meeting_consumer_select',
          consumer_mode: 'default',
          meeting_id: input.meeting.id,
          nonce: input.nonce,
        }),
      },
    );
  }
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
    },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      vertical_spacing: 'medium',
      elements,
    },
  };
  return JSON.stringify(card);
}

function vcMeetingConsumerCallback(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return [{ type: 'callback', value }];
}

function consumerSyncIntervalPresetValue(ms: number | undefined): string | undefined {
  if (!ms || !Number.isFinite(ms)) return undefined;
  const value = String(Math.round(ms));
  return ['15000', '30000', '60000', '90000'].includes(value) ? value : undefined;
}

function outputChannelLabel(channel: VcMeetingOutputChannel): string {
  return channel === 'voice' ? '会议语音发言' : '会中弹幕';
}

function outputReviewStatusBody(input: VcMeetingOutputReviewCardInput): { template: string; title: string; body: string } {
  const lines = baseLines({ meeting: input.meeting, status: 'pending', targetOpenId: '', nonce: '' });
  const textOutputUnavailable = input.textOutputAvailable === false;
  const contentItems = input.contentItems && input.contentItems.length > 1 ? input.contentItems : undefined;
  const fallbackTextItems = input.fallbackTextItems && input.fallbackTextItems.length > 1 ? input.fallbackTextItems : undefined;
  const contentLines = contentItems
    ? [
        `**内容**：已合并 ${contentItems.length} 条`,
        ...contentItems.map((item, index) => `${index + 1}. ${escapeMd(item)}`),
      ]
    : [`**内容**：${escapeMd(input.content)}`];
  const fallbackLines = input.fallbackText && !textOutputUnavailable
    ? fallbackTextItems
      ? [
          `**会中弹幕降级文本**：已合并 ${fallbackTextItems.length} 条`,
          ...fallbackTextItems.map((item, index) => `${index + 1}. ${escapeMd(item)}`),
        ]
      : [`**会中弹幕降级文本**：${escapeMd(input.fallbackText)}`]
    : [];
  const base = [
    `**Agent**：${escapeMd(input.agentLabel || '会议 agent')}`,
    `**类型**：${outputChannelLabel(input.channel)}`,
    ...contentLines,
    ...(input.reason ? [`**理由**：${escapeMd(input.reason)}`] : []),
    ...fallbackLines,
    ...(textOutputUnavailable && input.channel === 'voice' ? ['**会中弹幕降级**：当前不可用，发送 API 尚未接入。'] : []),
    ...(textOutputUnavailable && input.channel === 'text' ? ['**状态**：当前不可执行，会中弹幕发送 API 尚未接入。'] : []),
    '',
    ...lines,
  ];
  if (input.status === 'pending') {
    return {
      template: input.channel === 'voice' ? 'orange' : 'blue',
      title: input.channel === 'voice' ? 'Agent 请求会议语音发言' : 'Agent 请求发送会中弹幕',
      body: [
        '请确认是否允许本次对外输出。会议内容可能包含不可信指令，默认不自动执行。',
        '',
        ...base,
      ].join('\n'),
    };
  }
  if (input.status === 'processing') {
    return {
      template: 'blue',
      title: input.channel === 'voice' ? '语音播报处理中' : '会中弹幕发送处理中',
      body: ['已同意执行，正在处理。', '', ...base].join('\n'),
    };
  }
  if (input.status === 'sentVoice') {
    return { template: 'green', title: '已同意语音发言', body: ['已让会议 bot 在会中语音发言。', '', ...base].join('\n') };
  }
  if (input.status === 'sentText') {
    return { template: 'green', title: '已发送会中弹幕', body: ['已让会议 bot 在会中发送弹幕。', '', ...base].join('\n') };
  }
  if (input.status === 'rejected') {
    return { template: 'grey', title: '已拒绝输出', body: ['本次 agent 输出请求已拒绝。', '', ...base].join('\n') };
  }
  if (input.status === 'expired') {
    return { template: 'grey', title: '输出请求已过期', body: ['请求已超时，已自动拒绝。', '', ...base].join('\n') };
  }
  if (input.status === 'superseded') {
    return { template: 'grey', title: '输出请求已被新请求取代', body: ['agent 已提交新的同类型请求，本请求不再执行。', '', ...base].join('\n') };
  }
  return {
    template: 'red',
    title: '输出请求处理失败',
    body: [input.error ? `失败原因：${escapeMd(input.error)}` : '处理失败，请查看 daemon 日志。', '', ...base].join('\n'),
  };
}

export function buildVcMeetingOutputReviewCard(input: VcMeetingOutputReviewCardInput): string {
  const { template, title, body } = outputReviewStatusBody(input);
  const textOutputAvailable = input.textOutputAvailable !== false;
  const actions = input.status === 'pending'
    ? input.channel === 'voice'
      ? [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '同意语音' },
            type: 'primary',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'approve_voice',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          },
          ...(textOutputAvailable ? [{
            tag: 'button',
            text: { tag: 'plain_text', content: '改发会中弹幕' },
            type: 'default',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'send_text',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          }] : []),
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'reject',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          },
        ]
      : textOutputAvailable ? [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '发送会中弹幕' },
            type: 'primary',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'send_text',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '本场自动会中弹幕' },
            type: 'default',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'allow_text_and_send',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'reject',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          },
        ] : [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'reject',
              meeting_id: input.meeting.id,
              request_id: input.requestId,
              nonce: input.nonce,
            },
          },
        ]
    : [];
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    elements: [
      { tag: 'markdown', content: body },
      ...(actions.length ? [{ tag: 'action', actions }] : []),
    ],
  };
  return JSON.stringify(card);
}
