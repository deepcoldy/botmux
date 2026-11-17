import { useRef, type ReactNode } from 'react';

/** Mount a tab on its first visit, then retain its editor state while hidden. */
export function LazyTabPanel(props: { id: string; active: boolean; children: ReactNode }) {
  const visited = useRef(false);
  if (props.active) visited.current = true;
  return <div id={`bd-panel-${props.id}`} role="tabpanel" aria-labelledby={`bd-tab-${props.id}`}
    className="bd-tab-panel" hidden={!props.active}>
    {visited.current ? props.children : null}
  </div>;
}
