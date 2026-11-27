import { createHash } from 'node:crypto';
import { ONCALL_SIDEBAR_PATH_PREFIX, parseOncallSidebarPath } from '../core/host-capability-link.js';

const SELECTION_MARKER = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[0-9a-f]{24}$/;

export function isNativeOncallSelectionMarker(marker: string | null): boolean {
  return marker !== null && SELECTION_MARKER.test(marker);
}

// The native SDK copies bizFrom to the ticket's source_type independently of
// the webview's referrer. Only accept the tag issued for this exact selection.
export function nativeSelectionSourceType(formId: string | null): string | undefined {
  if (!formId || !(isNativeOncallSelectionMarker(formId) || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(formId))) return;
  return `botmux_${createHash('sha256').update(formId).digest('hex').slice(0, 24)}`;
}

/** A selected category may require a current question before opening its form.
 * The user has already requested handoff; no private transcript is needed. */
export function ensureSelectedOncallQuery(page: URL): void {
  const params = page.searchParams;
  if (params.get('directly') === 'true' && params.get('type') && params.get('region') && !params.get('query')?.trim()) {
    params.set('query', '申请人工 Oncall');
  }
}

/** Canonical source used by previously embedded forms. */
export function oncallSidebarSource(page: URL): string {
  const source = new URL(page.origin + page.pathname);
  source.searchParams.set('bm_form', page.searchParams.get('bm_form')!);
  return source.href;
}

/** The native page must be the same trusted, marked URL used for result lookup. */
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
