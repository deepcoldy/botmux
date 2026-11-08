import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { floatingPortalContainer } from './floating-host.js';
import type { FeedGroupPickerImplProps } from './feed-group-picker.js';

/** FeedGroupPicker on Base UI Popover. Loaded on demand by FeedGroupPicker. */
export default function FeedGroupPickerPopover(props: FeedGroupPickerImplProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement>();
  const creating = Boolean(props.newName.trim());

  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);

  function changeOpen(next: boolean): void {
    if (next) setContainer(floatingPortalContainer(rootRef.current));
    setOpen(next);
  }

  function choose(selectedId: string, newName: string): void {
    props.onChange(selectedId, newName);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={`feed-group-picker${props.disabled ? ' is-disabled' : ''}`}>
      <Popover.Root open={open} onOpenChange={changeOpen}>
        <Popover.Trigger
          className="feed-group-picker-trigger"
          aria-label={`飞书标签，当前：${props.label}`}
          disabled={props.disabled}
          // A <div>, like the <summary> it replaces: page CSS styles `button` broadly.
          render={<div />}
          nativeButton={false}
        >
          <span>{props.label}</span>
        </Popover.Trigger>
        <Popover.Portal container={container}>
          {/* fixed: both pickers sit in scrolling modal dialogs that would crop an absolute popup. */}
          <Popover.Positioner
            className="feed-group-picker-positioner"
            positionMethod="fixed"
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
          >
            <Popover.Popup className="feed-group-picker-pop">
              <label className="feed-group-picker-new">
                <span>新建标签</span>
                <input
                  type="text"
                  maxLength={60}
                  value={props.newName}
                  placeholder="输入新标签名称"
                  onChange={event => props.onChange('', event.currentTarget.value.trimStart())}
                />
              </label>
              <button
                type="button"
                aria-current={!props.selectedId && !creating ? 'true' : undefined}
                onClick={() => choose('', '')}
              >
                不选择标签
              </button>
              {props.groups.map(group => (
                <button
                  key={group.groupId}
                  type="button"
                  aria-current={props.selectedId === group.groupId && !creating ? 'true' : undefined}
                  onClick={() => choose(group.groupId, '')}
                >
                  {group.name}
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
