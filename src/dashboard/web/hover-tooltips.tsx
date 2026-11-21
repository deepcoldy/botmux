import type React from 'react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { floatingPortalContainer } from './floating-host.js';
import {
  OverflowTextScroll,
  overflowTextRootProps,
  TIP_OPEN_DELAY_MS,
  useOverflowText,
  type OverflowTextProps,
} from './tip-shared.js';

/** OverflowText with its full-text tooltip, which opens only while the text is cut off. Loaded on demand. */
export function OverflowTextTooltip(props: OverflowTextProps): React.JSX.Element {
  const { ref, overflowing, measure } = useOverflowText(props.text);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement>();

  useEffect(() => { if (!overflowing) setOpen(false); }, [overflowing]);

  function changeOpen(next: boolean): void {
    if (next) {
      if (!props.text.trim() || !measure()) return;
      setContainer(floatingPortalContainer(ref.current));
    }
    setOpen(next);
  }

  return (
    <Tooltip.Root open={open} onOpenChange={changeOpen}>
      <Tooltip.Trigger
        delay={TIP_OPEN_DELAY_MS}
        render={<span ref={ref} {...overflowTextRootProps(props, overflowing)} onMouseEnter={measure} />}
      >
        <OverflowTextScroll {...props} />
      </Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Positioner
          className="ui-info-positioner"
          positionMethod="fixed"
          side="top"
          sideOffset={8}
          collisionPadding={24}
        >
          <Tooltip.Popup className={['ui-info-pop', 'ui-overflow-popover', props.popoverClassName].filter(Boolean).join(' ')}>
            {props.text}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** IconTip's tooltip: hover or keyboard focus shows it, a click hides it. Loaded on demand. */
export function IconTipTooltip(props: { label: string; children: ReactElement }): React.JSX.Element {
  const triggerRef = useRef<HTMLElement | null>(null);
  // The child element may hold a ref of its own; Base UI merges this one in.
  const setTrigger = useCallback((element: HTMLElement | null) => { triggerRef.current = element; }, []);
  const [container, setContainer] = useState<HTMLElement>();

  return (
    <Tooltip.Root
      disableHoverablePopup
      onOpenChange={open => { if (open) setContainer(floatingPortalContainer(triggerRef.current)); }}
    >
      <Tooltip.Trigger ref={setTrigger} delay={TIP_OPEN_DELAY_MS} render={props.children} />
      <Tooltip.Portal container={container}>
        <Tooltip.Positioner
          className="icon-tip-positioner"
          positionMethod="fixed"
          side="top"
          sideOffset={8}
          collisionPadding={6}
        >
          <Tooltip.Popup className="icon-tip">
            {props.label}
            <Tooltip.Arrow className="icon-tip-arrow" />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
