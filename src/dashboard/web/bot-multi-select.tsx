import type React from 'react';
import { useMemo, useState } from 'react';

/** Minimal bot shape shared by the group picker (`GroupBot`) and the
 *  create-session picker (`PickerBot`): both carry `larkAppId` + a display name. */
export interface BotMultiSelectOption {
  larkAppId: string;
  botName?: string;
}

/**
 * Searchable, scrollable multi-select for bots. Fully controlled: the caller
 * owns the `selected` Set and toggles via `onToggle`, and MUST read the final
 * selection from that Set — never from the DOM.
 *
 * Why the caller state is the only source of truth: the list renders only the
 * rows matching the current search query; rows filtered out are unmounted, so
 * their checkboxes leave the DOM entirely. A caller that harvested the checked
 * ids via `FormData.getAll(...)` at submit time would silently drop any bot
 * that was selected earlier but is not matching the search box at that moment.
 * `selected` survives filtering; the DOM does not.
 *
 * The list area has a fixed max-height and scrolls internally, so a long roster
 * (dozens of bots) never grows the surrounding dialog past the viewport — the
 * dialog's own action buttons stay reachable.
 */
export function BotMultiSelect(props: {
  bots: BotMultiSelectOption[];
  selected: Set<string>;
  onToggle(larkAppId: string, checked: boolean): void;
  searchPlaceholder: string;
  noMatchLabel: string;
  emptyLabel: string;
  selectedCountLabel(n: number): string;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const queryNorm = query.trim().toLowerCase();
  const visibleBots = useMemo(() => {
    if (!queryNorm) return props.bots;
    return props.bots.filter(bot =>
      (bot.botName ?? bot.larkAppId).toLowerCase().includes(queryNorm) ||
      bot.larkAppId.toLowerCase().includes(queryNorm));
  }, [props.bots, queryNorm]);
  const selectedCount = props.selected.size;

  if (!props.bots.length) {
    return <p className="bot-multi-select-empty">{props.emptyLabel}</p>;
  }

  return (
    <div className="bot-multi-select">
      <input
        className="bot-multi-select-search"
        type="search"
        placeholder={props.searchPlaceholder}
        aria-label={props.searchPlaceholder}
        value={query}
        onChange={event => setQuery(event.currentTarget.value)}
      />
      {visibleBots.length ? (
        <div className="bot-multi-select-list" role="group">
          {visibleBots.map(bot => (
            <label key={bot.larkAppId} className="bot-multi-select-row">
              <input
                type="checkbox"
                value={bot.larkAppId}
                checked={props.selected.has(bot.larkAppId)}
                onChange={event => props.onToggle(bot.larkAppId, event.currentTarget.checked)}
              />
              <span className="bot-multi-select-main">
                <strong>{bot.botName ?? bot.larkAppId}</strong>
                <small>({bot.larkAppId})</small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="bot-multi-select-empty">{props.noMatchLabel}</p>
      )}
      {selectedCount ? (
        <small className="bot-multi-select-count">{props.selectedCountLabel(selectedCount)}</small>
      ) : null}
    </div>
  );
}
