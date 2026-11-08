import type React from 'react';
import { useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { floatingPortalContainer } from './floating-host.js';
import { infoTipClassName, infoTipLabel, infoTipTrigger, TIP_OPEN_DELAY_MS, type InfoTipProps } from './tip-shared.js';

/**
 * InfoTip on Base UI Popover: hover or tap opens it, a click pins it open,
 * Enter / Space opens it from the keyboard. Loaded on demand by InfoTip.
 */
export default function InfoTipPopover(props: InfoTipProps): React.JSX.Element {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [container, setContainer] = useState<HTMLElement>();

  return (
    <Popover.Root onOpenChange={open => { if (open) setContainer(floatingPortalContainer(triggerRef.current)); }}>
      <Popover.Trigger
        openOnHover
        delay={TIP_OPEN_DELAY_MS}
        // Time to carry the pointer over to the popup and select its text.
        closeDelay={160}
        nativeButton={false}
        render={<span ref={triggerRef} className={infoTipClassName(props)} aria-label={infoTipLabel(props)} />}
        // Sits inside another control (the sidebar nav link), so it is no tab stop of its own.
        {...(props.focusable === false ? { tabIndex: undefined, role: undefined } : null)}
        onClick={props.preventClick === false
          // The click belongs to the surrounding link; it must not pin the popup either.
          ? event => event.preventBaseUIHandler()
          // Inside a <label> the click would also toggle the labelled checkbox.
          : event => event.preventDefault()}
      >
        {infoTipTrigger(props)}
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner
          className="ui-info-positioner"
          positionMethod="fixed"
          side="top"
          sideOffset={8}
          collisionPadding={24}
        >
          <Popover.Popup className="ui-info-pop">{props.children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
