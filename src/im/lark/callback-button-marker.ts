/**
 * botmux callback-button ownership marker.
 *
 * WHY: botmux reply/session/config cards carry callback buttons (🔊 语音总结 /
 * 关闭会话 / 重启 / 配置 …). When another bot reads such a card (history /
 * cross-bot relay / quote), a plain-text flattening renders them as
 * `[🔊 语音总结]` chrome it can never click — prompt pollution. The parser
 * strips any button it can PROVE is botmux's own callback; proof must not
 * depend on a hand-maintained action wordlist, because every new botmux
 * button added later would silently leak again until someone updates the list.
 *
 * HOW: every card botmux sends is stamped at the single egress choke point
 * (client.ts send/reply/ephemeral/update — all interactive traffic flows
 * through those four). Each `tag:'button'` gets a `__bm_cb:1` marker on its
 * callback payload — both real payload shapes: legacy top-level `value` and
 * v2 `behaviors:[{type:'callback', value}]`. Jump buttons (open_url) are left
 * unmarked so their URLs keep surfacing in flattened text.
 *
 * The marker round-trips to card-handler on click as an unknown key and is
 * ignored there; it is additive only. Cards sent by older botmux builds have
 * no marker — the parser's legacy action wordlist covers those.
 */

export const BOTMUX_CALLBACK_MARKER_KEY = '__bm_cb';

/** True when a button payload object carries the botmux callback marker. */
function markPayload(value: unknown): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    (value as Record<string, unknown>)[BOTMUX_CALLBACK_MARKER_KEY] = 1;
  }
}

function stampElement(el: unknown): void {
  if (!el || typeof el !== 'object') return;
  if (Array.isArray(el)) {
    for (const child of el) stampElement(child);
    return;
  }
  const node = el as Record<string, unknown>;
  if (node.tag === 'button') {
    // Do NOT stamp open_url jump buttons: their link is real, followable
    // content and must keep surfacing in flattened text. A button whose
    // behaviors are callback-only (or legacy top-level value) gets stamped.
    const hasOpenUrl = (Array.isArray(node.behaviors)
      && node.behaviors.some((b: any) => b?.type === 'open_url'))
      || typeof node.url === 'string' && (node.url as string).length > 0
      || !!(node.multi_url && typeof node.multi_url === 'object'
        && Object.values(node.multi_url as Record<string, unknown>).some(v => typeof v === 'string' && v));
    if (!hasOpenUrl) {
      markPayload(node.value);
      if (Array.isArray(node.behaviors)) {
        for (const b of node.behaviors as any[]) {
          if (b && typeof b === 'object' && b.type === 'callback') markPayload(b.value);
        }
      }
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') stampElement(value);
  }
}

/**
 * Stamp every callback button in an interactive card's JSON. Idempotent and
 * total: on any JSON anomaly the input string is returned unchanged (a stamp
 * failure must never block an outbound message). Non-interactive content
 * should not be passed here at all (callers gate on msgType === 'interactive'),
 * but a non-card JSON body is tolerated harmlessly.
 */
export function stampBotmuxCallbackMarkers(cardJson: string): string {
  let card: unknown;
  try {
    card = JSON.parse(cardJson);
  } catch {
    return cardJson;
  }
  stampElement(card);
  try {
    return JSON.stringify(card);
  } catch {
    return cardJson;
  }
}

/** True when `el` is a button stamped by stampBotmuxCallbackMarkers. */
export function hasBotmuxCallbackMarker(el: any): boolean {
  if (!el || typeof el !== 'object') return false;
  const marked = (v: unknown): boolean =>
    !!v && typeof v === 'object' && !Array.isArray(v)
    && (v as Record<string, unknown>)[BOTMUX_CALLBACK_MARKER_KEY] === 1;
  if (marked(el.value)) return true;
  if (Array.isArray(el.behaviors)) {
    return el.behaviors.some((b: any) => b?.type === 'callback' && marked(b.value));
  }
  return false;
}
