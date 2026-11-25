import { ONCALL_SIDEBAR_PATH_PREFIX, parseOncallSidebarPath } from '../core/host-capability-link.js';

const SELECTION_MARKER = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[0-9a-f]{24}$/;

export function isNativeOncallSelectionMarker(marker: string | null): boolean {
  return marker !== null && SELECTION_MARKER.test(marker);
}

/** The embedded page must be the same trusted, marked URL used for result lookup. */
export function oncallSidebarPage(link: string, draftId: string): URL | undefined {
  try {
    const appLink = new URL(link);
    if (appLink.protocol !== 'https:' || appLink.username || appLink.password
      || !['applink.feishu.cn', 'applink.larksuite.com'].includes(appLink.hostname)
      || appLink.pathname !== '/client/web_url/open' || appLink.searchParams.getAll('url').length !== 1) return;
    const page = new URL(appLink.searchParams.get('url')!);
    const markers = page.searchParams.getAll('bm_form');
    const marker = markers[0];
    if (page.protocol === 'https:' && !page.username && !page.password && markers.length === 1 && marker
      && (marker === draftId || (marker.startsWith(`${draftId}.`) && isNativeOncallSelectionMarker(marker)))) return page;
  } catch { /* invalid or legacy app link */ }
}

export function hostOncallSidebar(link: string, dashboardUrl: string, draft: { appId: string; id: string }, token: string): string {
  const path = `${ONCALL_SIDEBAR_PATH_PREFIX}${draft.appId}/${draft.id}/${token}`;
  const page = oncallSidebarPage(link, draft.id);
  if (!page || !parseOncallSidebarPath(path)) return link;
  try {
    const host = new URL(dashboardUrl);
    if (!['https:', 'http:'].includes(host.protocol) || host.username || host.password || host.origin === page.origin) return link;
    host.pathname = `${host.pathname.replace(/\/+$/, '')}/`;
    const appLink = new URL(link);
    appLink.searchParams.set('url', new URL(path.slice(1), host).href);
    return appLink.href;
  } catch { return link; }
}
