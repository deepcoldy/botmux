/**
 * The page the OAuth loopback listener (127.0.0.1:9768) shows the browser.
 *
 * Three outcomes, because "授权链接无效或已过期" was shown for all failures —
 * including a callback that was never this BotMux's to begin with (the link
 * came from a bot deployed on another machine, and the person's own local
 * BotMux owns the port). That person then believed the authorization failed,
 * when pasting the address bar back to the topic would have finished it.
 */
export type OAuthLoopbackOutcome = 'ok' | 'failed' | 'foreign';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

export function renderOAuthLoopbackPage(outcome: OAuthLoopbackOutcome, callbackUrl: string): { status: number; html: string } {
  const title = outcome === 'ok' ? '授权成功' : outcome === 'foreign' ? '这条授权不是本机 BotMux 发起的' : '授权失败';
  const body = outcome === 'ok'
    ? '<p>BotMux 已完成授权。你可以关闭此页面并返回 Dashboard。</p>'
    : outcome === 'foreign'
      ? '<p>这台电脑上的 BotMux 接住了这次授权回调，但它没有发起过这次授权。通常是因为你在飞书里对部署在别的机器上的机器人发了 /login。授权码没有在这里使用。</p>'
        + '<p>请复制下面这条完整网址（与地址栏相同），在 5 分钟内发回你发起 /login 的那个飞书话题，即可完成授权。超时的话重新发一次 /login。</p>'
        + `<textarea readonly rows="4" style="width:100%;font-family:monospace;font-size:13px" onclick="this.select()">${escapeHtml(callbackUrl)}</textarea>`
      : '<p>授权链接无效或已过期。请返回 Dashboard 后重新发起授权。</p>';
  return {
    status: outcome === 'ok' ? 200 : outcome === 'foreign' ? 409 : 400,
    html: `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:24px;color:#111827}h1{font-size:28px}</style><h1>${title}</h1>${body}`,
  };
}

/**
 * The loopback listener's whole decision: which page to show and whether this
 * process may consume the callback at all. Only a login this process (or a
 * sibling process on this machine) started is handed to `consume`.
 */
export async function answerOAuthLoopbackCallback(
  callbackUrl: string,
  deps: {
    origin: (url: string) => 'own' | 'expired' | 'unknown';
    consume: (url: string) => Promise<string | null>;
    onError?: (error: unknown) => void;
  },
): Promise<{ status: number; html: string }> {
  let outcome: OAuthLoopbackOutcome = 'failed';
  const origin = deps.origin(callbackUrl);
  if (origin === 'unknown') {
    outcome = 'foreign';
  } else if (origin === 'own') {
    try {
      const message = await deps.consume(callbackUrl);
      if (typeof message === 'string' && message.startsWith('✅')) outcome = 'ok';
    } catch (error) {
      deps.onError?.(error);
    }
  }
  return renderOAuthLoopbackPage(outcome, callbackUrl);
}
