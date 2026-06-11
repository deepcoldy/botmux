// HD2D office tab: embeds the Godot web build served from /game/.
// The game polls /api/sessions on the same origin and mirrors each
// session's screen status onto an office robot.
//
// The page escapes main's max-width/padding so the game fills the whole
// area right of the sidebar; styles are restored when the tab is left.

export function renderOfficePage(host: HTMLElement): (() => void) | void {
  const prev = {
    maxWidth: host.style.maxWidth,
    padding: host.style.padding,
    flex: host.style.flex,
    minHeight: host.style.minHeight,
    display: host.style.display,
  };
  host.style.maxWidth = 'none';
  host.style.padding = '0';
  host.style.flex = '1 1 auto';
  host.style.minHeight = '0';
  host.style.display = 'flex';
  host.innerHTML = `
    <iframe
      src="/game/index.html"
      title="HD2D Office"
      style="flex:1;width:100%;min-height:0;border:none;display:block;background:#0b0d12;"
      allow="autoplay"
    ></iframe>`;
  const iframe = host.querySelector('iframe');
  return () => {
    iframe?.remove();
    host.style.maxWidth = prev.maxWidth;
    host.style.padding = prev.padding;
    host.style.flex = prev.flex;
    host.style.minHeight = prev.minHeight;
    host.style.display = prev.display;
  };
}
