import { groupModelSettings } from '../../core/group-default-models.js';
import type { GroupMemberBot } from './groups-api.js';
import { MODE_LABEL_KEY } from './group-reply-mode.js';

type Tr = (key: string, params?: Record<string, string | number>) => string;

/** on = 本群有生效的覆盖/开启；off = 关闭或沿用默认；warn = 想开但被 Bot 级开关挡住。 */
export type SettingTone = 'on' | 'off' | 'warn';

export interface SettingCell {
  text: string;
  tone: SettingTone;
  /** 悬停全文；缺省同 text。 */
  detail?: string;
}

/** 群管理「概览」矩阵的列，顺序即展示顺序。 */
export const BOT_SETTING_COLUMNS = [
  'role',
  'replyMode',
  'oncall',
  'model',
  'serialInput',
  'idleClose',
  'cardMode',
  'pin',
] as const;

export type BotSettingColumn = typeof BOT_SETTING_COLUMNS[number];

/**
 * 把一个 bot 在本群的各项设置压成一格短文本，供概览矩阵一眼扫完；
 * 读的是 /api/groups 快照里已有的字段，不额外发请求。
 */
export function summarizeBotSettings(
  member: GroupMemberBot,
  tr: Tr,
): Record<BotSettingColumn, SettingCell> {
  const off = (text: string): SettingCell => ({ text, tone: 'off' });
  const on = (text: string): SettingCell => ({ text, tone: 'on' });

  const reply = member.replyMode;
  const replyMode = !reply
    ? off('—')
    : reply.inherited
      ? { text: tr('groups.summary.roleInherit'), tone: 'off' as const, detail: tr('groups.summary.inherit', { value: tr(MODE_LABEL_KEY[reply.effective]) }) }
      : on(tr(MODE_LABEL_KEY[reply.effective]));

  const dir = member.oncallChat?.workingDir?.trim();
  const oncall = dir ? on(dir) : off(tr('groups.summary.off'));

  let model: SettingCell;
  if (member.agentCliId === 'codex' || member.agentCliId === 'claude-code') {
    const settings = groupModelSettings(member.defaultModels?.[member.agentCliId]);
    const parts = [settings.model, settings.reasoningEffort].filter(Boolean);
    model = parts.length
      ? on(parts.join(' · '))
      : off(tr('groups.summary.inherit', { value: member.agentModel || tr('groups.summary.agentDefault') }));
  } else {
    model = off(tr('groups.summary.unsupported'));
  }

  const idle = member.idleClose;
  const idleClose = idle?.enabled
    ? on(tr(idle.unit === 'hours' ? 'groups.summary.hours' : 'groups.summary.days', { n: idle.duration }))
    : off(tr('groups.summary.off'));

  const cardMode = member.streamingCardChatEnabled === false
    ? off(tr('groups.summary.chatOff'))
    : member.streamingCardMasterEnabled === false
      ? { text: tr('groups.summary.botOff'), tone: 'warn' as const }
      : on(tr('groups.summary.on'));

  const pin = member.pinStreamingCardEffectiveEnabled === true
    ? on(tr('groups.summary.on'))
    : member.pinStreamingCardChatEnabled === true && member.pinStreamingCardMasterEnabled !== true
      ? { text: tr('groups.summary.botOff'), tone: 'warn' as const }
      : off(tr('groups.summary.off'));

  return {
    role: member.hasRole ? on(tr('groups.summary.roleChat')) : off(tr('groups.summary.roleInherit')),
    replyMode,
    oncall,
    model,
    serialInput: member.serialInput ? on(tr('groups.summary.on')) : off(tr('groups.summary.off')),
    idleClose,
    cardMode,
    pin,
  };
}
