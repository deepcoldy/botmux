import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import {
  commitDropdownChoice,
  DEFAULT_POPUP_PLACEMENT,
  DropdownOptionContent,
  dropdownPopupPlacement,
  dropdownRootClassName,
  DropdownTriggerValue,
  filterDropdownOptions,
  swallowClosedTypeahead,
  type DropdownMenuProps,
} from './dropdown-shared.js';

/** DropdownMenu with a search box (`searchable`): Base UI Combobox. Loaded on demand by DropdownMenu. */
export default function DropdownCombobox(props: DropdownMenuProps<string>): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const [placement, setPlacement] = useState(DEFAULT_POPUP_PLACEMENT);
  const visibleOptions = filterDropdownOptions(props.options, query);

  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);

  function changeOpen(next: boolean): void {
    if (next) {
      setPlacement(dropdownPopupPlacement(rootRef.current));
      setQuery('');
    }
    setOpen(next);
  }

  return (
    <div
      ref={rootRef}
      id={props.id}
      className={dropdownRootClassName(props, open)}
      hidden={props.hidden}
      style={props.style}
      onKeyDownCapture={event => swallowClosedTypeahead(event, open)}
    >
      <Combobox.Root
        value={props.value}
        onValueChange={next => { if (next !== null) commitDropdownChoice(props, next); }}
        open={open}
        onOpenChange={changeOpen}
        inputValue={query}
        onInputValueChange={setQuery}
        // Filtering is ours (value + plain-text label); Base UI only navigates and selects.
        filter={null}
        autoHighlight
        onItemHighlighted={value => setHighlighted(value)}
        disabled={props.disabled}
      >
        <Combobox.Trigger
          className="sect-sort-trigger"
          aria-label={props.ariaLabel}
          // A <div>, like the <summary> it replaces: page CSS styles `button`
          // broadly and would restyle a native trigger.
          render={<div />}
          nativeButton={false}
        >
          <DropdownTriggerValue label={props.label} />
        </Combobox.Trigger>
        <Combobox.Portal container={placement.container}>
          {/* fixed: the dashboard's scroll areas and modal dialogs crop an absolute popup. */}
          <Combobox.Positioner
            className="sect-sort-positioner"
            positionMethod="fixed"
            side="bottom"
            align={placement.align}
            sideOffset={8}
            collisionPadding={8}
          >
            <Combobox.Popup className="sect-sort-pop" data-menu={props.className}>
              <Combobox.Input
                className="sect-sort-search"
                type="search"
                placeholder={props.searchPlaceholder}
                aria-label={props.searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={event => {
                  if (event.key !== 'Enter') return;
                  const current = visibleOptions.find(option => option.value === highlighted);
                  if (current && !current.disabled) return;
                  // autoHighlight lands on the first match even when it is disabled, and
                  // with nothing highlighted Base UI closes and lets Enter submit the
                  // surrounding <form>. Either way Enter takes the first enabled match.
                  event.preventDefault();
                  event.preventBaseUIHandler();
                  const first = visibleOptions.find(option => !option.disabled);
                  if (!first) return;
                  setOpen(false);
                  commitDropdownChoice(props, first.value);
                }}
              />
              <Combobox.List className="sect-sort-list">
                {visibleOptions.map(option => (
                  <Combobox.Item
                    key={option.value}
                    className="sect-sort-item"
                    value={option.value}
                    disabled={option.disabled}
                  >
                    <DropdownOptionContent option={option} />
                  </Combobox.Item>
                ))}
              </Combobox.List>
              {visibleOptions.length === 0 ? <p className="sect-sort-empty">{props.searchEmptyLabel}</p> : null}
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}
