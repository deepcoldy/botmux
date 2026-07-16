import type { VcMeetingRef } from './types.js';
import type { VcMeetingConsumerAgentConfig } from '../bot-registry.js';
import type { VcMeetingConsumerProfileConfig } from '../types.js';

export type VcMeetingConfirmCardStatus = 'pending' | 'started' | 'declined' | 'expired' | 'failed';
export type VcMeetingConsumerCardStatus = 'pending' | 'processing' | 'listenOnly' | 'agent' | 'expired' | 'failed';
export type VcMeetingConsumerRecoveryCardStatus = 'pending' | 'recovered' | 'abandoned' | 'failed';
export type VcMeetingListenerRejoinCardStatus = 'pending' | 'rejoined' | 'expired' | 'failed';
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

interface VcMeetingConsumerCardBaseInput {
  status: VcMeetingConsumerCardStatus;
  meeting: VcMeetingRef;
  nonce: string;
  syncIntervalMs?: number;
  stagedIntervalMs?: number;
  error?: string;
}

export interface VcMeetingLegacyConsumerCardInput extends VcMeetingConsumerCardBaseInput {
  /** Omitted by existing callers; the absent discriminator is the legacy branch. */
  selectionMode?: 'legacy';
  candidates: VcMeetingConsumerAgentConfig[];
  defaultMode: 'listenOnly' | 'agent';
  defaultAgentAppId?: string;
  selectedAgentAppId?: string;
  selectedAgentLabel?: string;
  // 暂存态（pending 状态下已选但未确认的组合）：下拉只暂存，点"确认"才生效。
  stagedMode?: 'agent' | 'listenOnly';
  stagedAgentAppId?: string;
  stagedAgentLabel?: string;
}

export type VcMeetingConsumerProfileActivationStatus = 'activating' | 'active' | 'failed';

export interface VcMeetingConsumerProfileCardItem extends VcMeetingConsumerProfileConfig {
  activationStatus?: VcMeetingConsumerProfileActivationStatus;
  activationError?: string;
  /** 绑定 agent 的展示名（bot 真名），缺省回退 agentAppId。 */
  agentLabel?: string;
}

export interface VcMeetingProfileConsumerCardInput extends VcMeetingConsumerCardBaseInput {
  selectionMode: 'profiles';
  profiles: VcMeetingConsumerProfileCardItem[];
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds?: string[];
  /** Current committed selection, used when reopening a profile card. */
  selectedProfileIds?: string[];
  /** undefined = no staged edit; [] = explicitly staged listen-only. */
  stagedSelectedProfileIds?: string[];
}

export type VcMeetingConsumerCardInput =
  | VcMeetingLegacyConsumerCardInput
  | VcMeetingProfileConsumerCardInput;

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

export interface VcMeetingConsumerRecoveryCardInput {
  status: VcMeetingConsumerRecoveryCardStatus;
  meeting: VcMeetingRef;
  nonce: string;
  memberEpoch: number;
  /** P1 profile stream identity. Legacy single-consumer cards omit it. */
  memberId?: string;
  memberLabel?: string;
  missingItemVersionKey?: string;
  error?: string;
}

export interface VcMeetingListenerRejoinCardInput {
  status: VcMeetingListenerRejoinCardStatus;
  meeting: VcMeetingRef;
  nonce: string;
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

export function buildVcMeetingConsumerRecoveryCard(
  input: VcMeetingConsumerRecoveryCardInput,
): string {
  const pending = input.status === 'pending';
  const title = pending
    ? '会议 agent 恢复需要处理'
    : input.status === 'recovered'
      ? '会议 agent 已恢复'
      : input.status === 'abandoned'
        ? '会议 agent 已从当前时点继续'
        : '会议 agent 恢复失败';
  const template = pending ? 'orange' : input.status === 'failed' ? 'red' : 'green';
  const body = pending
    ? [
        'daemon 重启后无法从事件源恢复一个已冻结投递的正文。旧流保持隔离，不会静默跳过。',
        '',
        `**会议**：${escapeMd(meetingTitle(input.meeting))}`,
        `**member epoch**：${input.memberEpoch}`,
        ...(input.memberLabel || input.memberId
          ? [`**profile member**：${escapeMd(input.memberLabel ?? input.memberId)}`]
          : []),
        ...(input.missingItemVersionKey
          ? [`**缺失版本**：\`${escapeMd(input.missingItemVersionKey)}\``]
          : []),
        ...(input.error ? [`**最近一次尝试**：${escapeMd(input.error)}`] : []),
        '',
        '可以再次尝试回补；若确认事件源已无法恢复，可隔离旧 epoch，并让同一 agent 从当前时点开启新 epoch。',
      ].join('\n')
    : [
        input.status === 'recovered'
          ? '缺失正文已回补，原冻结投递将继续。'
          : input.status === 'abandoned'
            ? '旧投递流已隔离，新 epoch 从当前时点继续；缺失区间不会伪装成已处理。'
            : `处理失败：${escapeMd(input.error ?? '请稍后重试')}`,
        '',
        `**会议**：${escapeMd(meetingTitle(input.meeting))}`,
      ].join('\n');
  const actions = pending ? [{
    tag: 'button',
    text: { tag: 'plain_text', content: '再次回补' },
    type: 'primary',
    value: {
      action: 'vc_meeting_consumer_recovery',
      decision: 'retry',
      meeting_id: input.meeting.id,
      nonce: input.nonce,
      ...(input.memberId ? { member_id: input.memberId } : {}),
    },
  }, {
    tag: 'button',
    text: { tag: 'plain_text', content: '隔离旧流并从现在继续' },
    type: 'danger',
    value: {
      action: 'vc_meeting_consumer_recovery',
      decision: 'abandon_from_now',
      meeting_id: input.meeting.id,
      nonce: input.nonce,
      ...(input.memberId ? { member_id: input.memberId } : {}),
    },
  }] : [];
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [
      { tag: 'markdown', content: body },
      ...(actions.length > 0 ? [{ tag: 'action', actions }] : []),
    ],
  });
}

export function buildVcMeetingListenerRejoinCard(
  input: VcMeetingListenerRejoinCardInput,
): string {
  const retryable = input.status === 'pending' || input.status === 'failed';
  const title = input.status === 'rejoined'
    ? '会议监听已恢复'
    : input.status === 'expired'
      ? '会议重新加入已失效'
      : input.status === 'failed'
        ? '重新加入会议失败'
        : '会议监听已中断';
  const template = input.status === 'rejoined'
    ? 'green'
    : input.status === 'expired'
      ? 'grey'
      : input.status === 'failed'
        ? 'red'
        : 'orange';
  const body = input.status === 'rejoined'
    ? '监听 bot 已重新入会，已有的监听群和会议 agent 状态已保留。'
    : input.status === 'expired'
      ? '会议已结束、监听状态已变更，或该卡片已被新卡片替代。'
      : input.status === 'failed'
        ? `重新入会失败：${escapeMd(input.error ?? '请稍后重试')}`
        : '检测到监听 bot 被移出本场会议。为避免被踢后立即自动重入，需由本场授权人确认。';
  const actions = retryable ? [{
    tag: 'button',
    text: { tag: 'plain_text', content: '重新加入会议' },
    type: 'primary',
    value: {
      action: 'vc_meeting_listener_rejoin',
      meeting_id: input.meeting.id,
      nonce: input.nonce,
    },
  }] : [];
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [
      {
        tag: 'markdown',
        content: [
          body,
          '',
          `**会议**：${escapeMd(meetingTitle(input.meeting))}`,
          ...(input.meeting.meetingNo ? [`**会议号**：${escapeMd(input.meeting.meetingNo)}`] : []),
        ].join('\n'),
      },
      ...(actions.length > 0 ? [{ tag: 'action', actions }] : []),
    ],
  });
}

function consumerCandidateLabel(candidate: VcMeetingConsumerAgentConfig): string {
  return candidate.label?.trim() || candidate.larkAppId;
}

function consumerCandidateOptionLabel(candidate: VcMeetingConsumerAgentConfig): string {
  return consumerCandidateLabel(candidate).slice(0, 60);
}

function isProfileConsumerCard(
  input: VcMeetingConsumerCardInput,
): input is VcMeetingProfileConsumerCardInput {
  return input.selectionMode === 'profiles';
}

function consumerProfileLabel(profile: VcMeetingConsumerProfileCardItem): string {
  return profile.label?.trim() || profile.id;
}

function consumerProfileResponseModeLabel(profile: VcMeetingConsumerProfileCardItem): string {
  return profile.responseMode === 'silent' ? '静默' : '监听群回复';
}

function consumerProfileSinkLabel(profile: VcMeetingConsumerProfileCardItem): string {
  const labels = (profile.ownedSinks ?? []).map((sink) => {
    if (sink === 'meeting_text') return '会中文字';
    return '会议语音';
  });
  return labels.length > 0 ? labels.join('、') : '无';
}

function consumerProfileActivationLabel(profile: VcMeetingConsumerProfileCardItem): string | undefined {
  if (profile.activationStatus === 'activating') return '启用中';
  if (profile.activationStatus === 'active') return '已启用';
  if (profile.activationStatus === 'failed') {
    return profile.activationError?.trim()
      ? `启用失败：${profile.activationError.trim()}`
      : '启用失败';
  }
  return undefined;
}

function consumerProfileNames(
  input: VcMeetingProfileConsumerCardInput,
  profileIds: readonly string[],
): string[] {
  const byId = new Map(input.profiles.map(profile => [profile.id, profile] as const));
  return profileIds.map(id => consumerProfileLabel(byId.get(id) ?? {
    id,
    agentAppId: id,
    role: id,
    responseMode: 'silent',
    capabilities: [],
  }));
}

function consumerProfileDefaultLabel(input: VcMeetingProfileConsumerCardInput): string {
  if (input.defaultMode === 'listenOnly') return '只监听消息';
  const names = consumerProfileNames(input, input.defaultConsumerIds ?? []);
  return names.length > 0 ? names.join('、') : '未配置默认 profile';
}

function consumerProfileAgentLabel(profile: VcMeetingConsumerProfileCardItem): string {
  return profile.agentLabel?.trim() || profile.agentAppId;
}

function truncateCardText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * Toggle 按钮文案：profile 名与 agent 名分别截断，为 agent 后缀保留预算，
 * 超长 profile 名不会把「· agent」整段挤掉；完整名称在详情面板里。
 */
function consumerProfileToggleText(
  profile: VcMeetingConsumerProfileCardItem,
  isSelected: boolean,
): string {
  const name = truncateCardText(consumerProfileLabel(profile), 30);
  const agent = truncateCardText(consumerProfileAgentLabel(profile), 22);
  return `${isSelected ? '☑' : '☐'} ${name} · ${agent}`;
}

function consumerProfileDetailMarkdown(profiles: readonly VcMeetingConsumerProfileCardItem[]): string {
  return profiles.map((profile) => {
    const activation = consumerProfileActivationLabel(profile);
    return [
      `**${escapeMd(consumerProfileLabel(profile))}**（profile: \`${escapeMd(profile.id)}\`）`,
      `agent：${escapeMd(consumerProfileAgentLabel(profile))} · 角色：\`${escapeMd(profile.role)}\` · 回复：${escapeMd(consumerProfileResponseModeLabel(profile))} · 受管输出：${escapeMd(consumerProfileSinkLabel(profile))}`,
      ...(activation ? [`状态：${escapeMd(activation)}`] : []),
    ].join('\n');
  }).join('\n');
}

/** 每行最多 2 个 toggle，避免自定义预设名在手机端被截断。 */
function consumerToggleGrid(buttons: Record<string, unknown>[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'bisect',
      horizontal_spacing: 'small',
      columns: buttons.slice(i, i + 2).map(button => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [button],
      })),
    });
  }
  return rows;
}

function consumerProfileDisplayElements(
  input: VcMeetingProfileConsumerCardInput,
): Record<string, unknown>[] {
  if (input.status !== 'pending') {
    return input.profiles.length > 0
      ? [{ tag: 'markdown', content: consumerProfileDetailMarkdown(input.profiles) }]
      : [];
  }
  const stagedIds = input.stagedSelectedProfileIds ?? input.selectedProfileIds ?? [];
  const selected = new Set(stagedIds);
  // “只监听”只在显式暂存空集合时高亮；默认 agents 且未操作时（staged 为
  // undefined、合并选择为空）绝不能误亮，否则超时实际会跑默认 agents。
  const listenOnlySelected = input.stagedSelectedProfileIds !== undefined
    && input.stagedSelectedProfileIds.length === 0;
  const toggles = input.profiles.map((profile): Record<string, unknown> => {
    const isSelected = selected.has(profile.id);
    return {
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: consumerProfileToggleText(profile, isSelected),
      },
      type: isSelected ? 'primary' : 'default',
      width: 'fill',
      behaviors: vcMeetingConsumerCallback({
        action: 'vc_meeting_consumer_profile_toggle',
        meeting_id: input.meeting.id,
        profile_id: profile.id,
        operation: isSelected ? 'deselect' : 'select',
        selected: !isSelected,
        nonce: input.nonce,
      }),
    };
  });
  toggles.push({
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: `${listenOnlySelected ? '☑' : '☐'} 只监听（不启用 agent）`,
    },
    type: listenOnlySelected ? 'primary' : 'default',
    width: 'fill',
    behaviors: vcMeetingConsumerCallback({
      action: 'vc_meeting_consumer_profile_clear',
      operation: 'clear',
      meeting_id: input.meeting.id,
      nonce: input.nonce,
    }),
  });
  return [
    ...consumerToggleGrid(toggles),
    {
      tag: 'collapsible_panel',
      expanded: true,
      header: {
        title: { tag: 'markdown', content: '**预设详情与高级设置**' },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      padding: '8px 8px 8px 8px',
      vertical_spacing: '8px',
      elements: [
        ...(input.profiles.length > 0
          ? [{ tag: 'markdown', content: consumerProfileDetailMarkdown(input.profiles) }, { tag: 'hr' }]
          : []),
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
      ],
    },
  ];
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
    if (isProfileConsumerCard(input)) {
      const staged = input.stagedSelectedProfileIds;
      const stagedNames = staged === undefined ? undefined : consumerProfileNames(input, staged);
      const currentNames = staged === undefined
        ? consumerProfileNames(input, input.selectedProfileIds ?? [])
        : [];
      return {
        template: 'blue',
        title: '会议多 agent 处理方式',
        body: [
          '点击预设按钮多选，选好后点「确认」生效；完全不操作会按默认设置执行。',
          '',
          ...lines,
          `**默认**：${escapeMd(consumerProfileDefaultLabel(input))}`,
          `**同步间隔**：${escapeMd(consumerSyncIntervalLabel(input.stagedIntervalMs ?? input.syncIntervalMs))}${input.stagedIntervalMs ? '（待确认）' : ''}`,
          ...(stagedNames !== undefined
            ? [`**当前选择**：${escapeMd(stagedNames.length > 0 ? stagedNames.join('、') : '只监听消息（空 profile 集合）')}（待确认）`]
            : currentNames.length > 0
              ? [`**已启用**：${escapeMd(currentNames.join('、'))}`]
              : []),
          ...(input.error ? [`**提示**：${escapeMd(input.error)}`] : []),
        ].join('\n'),
      };
    }
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
    if (isProfileConsumerCard(input)) {
      return {
        template: 'blue',
        title: '会议多 agent 设置中',
        body: [
          '已收到确认，正在逐项激活本次会议的 agent profile。',
          '已成功的 profile 会保留；失败项会单独显示，不会让整场回退。',
          '',
          ...lines,
        ].join('\n'),
      };
    }
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
    if (isProfileConsumerCard(input)) {
      const active = input.profiles.filter(profile => profile.activationStatus === 'active');
      return {
        template: active.length > 0 ? 'green' : 'red',
        title: active.length > 0 ? '会议 agents 已启用' : '会议 agents 启用失败',
        body: [
          active.length > 0
            ? `本次会议已启用 ${active.length} 个 agent profile。`
            : '没有 agent profile 成功启用。',
          `同步间隔：${escapeMd(consumerSyncIntervalLabel(input.syncIntervalMs))}`,
          ...(input.error ? [`部分失败：${escapeMd(input.error)}`] : []),
          '',
          ...lines,
        ].join('\n'),
      };
    }
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
  if (isProfileConsumerCard(input)) {
    elements.push(...consumerProfileDisplayElements(input));
  }
  if (input.status === 'pending') {
    if (isProfileConsumerCard(input)) {
      elements.push(
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
                consumer_mode: 'profiles',
                meeting_id: input.meeting.id,
                nonce: input.nonce,
              },
            },
          ],
        },
        {
          tag: 'button',
          // 仅暂存默认组合，仍需点“确认”生效，命名避免“立即生效”误读。
          text: { tag: 'plain_text', content: '恢复默认选择' },
          type: 'default',
          behaviors: vcMeetingConsumerCallback({
            action: 'vc_meeting_consumer_profile_default',
            operation: 'use_default',
            meeting_id: input.meeting.id,
            nonce: input.nonce,
          }),
        },
      );
    } else {
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
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '本场自动语音' },
            type: 'default',
            value: {
              action: 'vc_meeting_output_review',
              decision: 'allow_voice_and_approve',
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
