import type React from 'react';

export interface BotPickerChip {
  larkAppId: string;
  botName?: string;
}

/**
 * 群选择器触发器里展示已选 Bot 的 chip（最多 4 个，其余折叠成 +N），每个带 × 移除。
 *
 * 渲染在 SearchableGroupPicker 的触发器（Base UI Combobox.Trigger）内部：触发器在
 * mousedown 阶段就打开浮层，所以 × 必须在 mousedown 上停止冒泡，只拦 click 拦不住。
 */
export function BotPickerChips(props: {
  bots: BotPickerChip[];
  onRemove(larkAppId: string): void;
}): React.JSX.Element | null {
  if (!props.bots.length) return null;
  const visible = props.bots.slice(0, 4);
  const hidden = props.bots.slice(4);
  const botLabel = (bot: BotPickerChip) => bot.botName || bot.larkAppId;
  const botTitle = (bot: BotPickerChip) => `${botLabel(bot)} (${bot.larkAppId})`;
  return (
    <span className="connector-bot-picker-chips">
      {visible.map(bot => (
        <span key={bot.larkAppId} className="connector-bot-picker-chip" data-full={botTitle(bot)} title={botTitle(bot)}>
          <span className="connector-bot-picker-chip-label">{botLabel(bot)}</span>
          <span
            className="connector-bot-picker-chip-remove"
            aria-label={`取消选择 ${botLabel(bot)}`}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              props.onRemove(bot.larkAppId);
            }}
          >
            &times;
          </span>
        </span>
      ))}
      {hidden.length ? (
        <span
          className="connector-bot-picker-chip connector-bot-picker-chip-overflow"
          data-full={hidden.map(botTitle).join('\n')}
          title={hidden.map(botTitle).join('\n')}
        >
          <span className="connector-bot-picker-chip-label">+{hidden.length}</span>
        </span>
      ) : null}
    </span>
  );
}
