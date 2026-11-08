import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Select } from '@base-ui/react/select';
import {
  commitDropdownChoice,
  DEFAULT_POPUP_PLACEMENT,
  DropdownOptionContent,
  dropdownPopupPlacement,
  dropdownRootClassName,
  DropdownTriggerValue,
  swallowClosedTypeahead,
  type DropdownMenuProps,
} from './dropdown-shared.js';

/** DropdownMenu without a search box: Base UI Select. Loaded on demand by DropdownMenu. */
export default function DropdownSelect(props: DropdownMenuProps<string>): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(DEFAULT_POPUP_PLACEMENT);

  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);

  function changeOpen(next: boolean): void {
    if (next) setPlacement(dropdownPopupPlacement(rootRef.current));
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
      <Select.Root<string>
        value={props.value}
        onValueChange={next => { if (next !== null) commitDropdownChoice(props, next); }}
        open={open}
        onOpenChange={changeOpen}
        // Modal would lock page scroll and swallow the first outside click.
        modal={false}
        disabled={props.disabled}
      >
        <Select.Trigger
          className="sect-sort-trigger"
          aria-label={props.ariaLabel}
          // A <div>, like the <summary> it replaces: page CSS styles `button`
          // broadly and would restyle a native trigger.
          render={<div />}
          nativeButton={false}
        >
          <DropdownTriggerValue label={props.label} />
        </Select.Trigger>
        <Select.Portal container={placement.container}>
          {/* fixed: the dashboard's scroll areas and modal dialogs crop an absolute popup. */}
          <Select.Positioner
            className="sect-sort-positioner"
            positionMethod="fixed"
            side="bottom"
            align={placement.align}
            sideOffset={8}
            collisionPadding={8}
            alignItemWithTrigger={false}
          >
            <Select.Popup className="sect-sort-pop" data-menu={props.className}>
              {props.options.map(option => (
                <Select.Item
                  key={option.value}
                  className="sect-sort-item"
                  value={option.value}
                  disabled={option.disabled}
                  label={typeof option.label === 'string' ? option.label : undefined}
                >
                  <DropdownOptionContent option={option} />
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
