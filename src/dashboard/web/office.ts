// HD2D office tab: embeds the Godot web build served from /game/.
// The game polls /api/sessions on the same origin and mirrors each
// session's screen status onto an office robot.

export function renderOfficePage(host: HTMLElement): (() => void) | void {
  host.innerHTML = `
    <div class="office-page" style="display:flex;flex-direction:column;height:100%;min-height:0;">
      <div style="flex:1;min-height:0;border-radius:12px;overflow:hidden;background:#0b0d12;">
        <iframe
          src="/game/index.html"
          title="HD2D Office"
          style="width:100%;height:100%;border:none;display:block;"
          allow="autoplay"
        ></iframe>
      </div>
    </div>`;
  const iframe = host.querySelector('iframe');
  return () => {
    // Drop the iframe explicitly so the game (and its polling) stops with the tab.
    iframe?.remove();
  };
}
