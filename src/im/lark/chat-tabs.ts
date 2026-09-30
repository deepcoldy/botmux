import { getBotClient } from '../../bot-registry.js';

export type ChatTabType = 'message' | 'doc_list' | 'doc' | 'pin' | 'meeting_minute'
  | 'chat_announcement' | 'url' | 'file' | 'files_resources' | 'images_videos' | 'task';

export interface ChatTab {
  tab_id?: string;
  tab_name?: string;
  tab_type: ChatTabType;
  tab_content?: { url?: string; doc?: string; meeting_minute?: string; task?: string };
  tab_config?: { icon_key?: string; is_built_in?: boolean };
}

function api(larkAppId: string): any {
  return (getBotClient(larkAppId) as any).im.v1.chatTab;
}

function assertOk(result: any): void {
  if (typeof result?.code === 'number' && result.code !== 0) {
    throw new Error(`${result.code}: ${result.msg || 'Lark API error'}`);
  }
}

export async function listChatTabs(larkAppId: string, chatId: string): Promise<ChatTab[]> {
  const result = await api(larkAppId).listTabs({ path: { chat_id: chatId } });
  assertOk(result);
  return Array.isArray(result?.data?.chat_tabs) ? result.data.chat_tabs : [];
}

export async function addUrlChatTab(
  larkAppId: string,
  chatId: string,
  url: string,
  name?: string,
): Promise<ChatTab[]> {
  const result = await api(larkAppId).create({
    path: { chat_id: chatId },
    data: {
      chat_tabs: [{
        tab_type: 'url',
        tab_content: { url },
        ...(name ? { tab_name: name } : {}),
      }],
    },
  });
  assertOk(result);
  return Array.isArray(result?.data?.chat_tabs) ? result.data.chat_tabs : [];
}

function comparableUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw;
  }
}

/** Idempotently create a URL tab. Re-running an automation hook reuses the
 * existing tab and only refreshes its display name. */
export async function ensureUrlChatTab(
  larkAppId: string,
  chatId: string,
  url: string,
  name?: string,
): Promise<{ created: boolean; tab: ChatTab }> {
  const existing = (await listChatTabs(larkAppId, chatId)).find(tab =>
    tab.tab_type === 'url'
    && !!tab.tab_content?.url
    && comparableUrl(tab.tab_content.url) === comparableUrl(url));
  if (!existing) {
    const created = await addUrlChatTab(larkAppId, chatId, url, name);
    const tab = created[0];
    if (!tab) throw new Error('create_returned_no_tab');
    return { created: true, tab };
  }
  if (name && existing.tab_name !== name && existing.tab_id) {
    const updated = await updateChatTab(larkAppId, chatId, existing.tab_id, { name, url });
    return { created: false, tab: updated[0] ?? { ...existing, tab_name: name, tab_content: { url } } };
  }
  return { created: false, tab: existing };
}

export async function updateChatTab(
  larkAppId: string,
  chatId: string,
  tabId: string,
  update: { name?: string; url?: string },
): Promise<ChatTab[]> {
  const existing = (await listChatTabs(larkAppId, chatId)).find(tab => tab.tab_id === tabId);
  if (!existing) throw new Error(`tab_not_found: ${tabId}`);
  if (existing.tab_type !== 'url' && existing.tab_type !== 'doc') {
    throw new Error(`tab_type_not_editable: ${existing.tab_type}`);
  }
  if (update.url && existing.tab_type !== 'url') throw new Error('url_only_supported_for_url_tabs');
  const next: ChatTab = {
    ...existing,
    tab_id: tabId,
    ...(update.name ? { tab_name: update.name } : {}),
    ...(update.url ? { tab_content: { ...existing.tab_content, url: update.url } } : {}),
  };
  const result = await api(larkAppId).updateTabs({
    path: { chat_id: chatId },
    data: { chat_tabs: [next] },
  });
  assertOk(result);
  return Array.isArray(result?.data?.chat_tabs) ? result.data.chat_tabs : [];
}

export async function renameChatTab(
  larkAppId: string,
  chatId: string,
  tabId: string,
  name: string,
): Promise<ChatTab[]> {
  return updateChatTab(larkAppId, chatId, tabId, { name });
}

export async function deleteChatTab(larkAppId: string, chatId: string, tabId: string): Promise<void> {
  const result = await api(larkAppId).deleteTabs({
    path: { chat_id: chatId },
    data: { tab_ids: [tabId] },
  });
  assertOk(result);
}

/** Return true only when requested IDs are a duplicate-free permutation of
 * every current tab ID. Tabs without an ID make a complete order impossible. */
export function isCompleteChatTabOrder(current: ChatTab[], requested: string[]): boolean {
  const currentIds = current.map(tab => tab.tab_id);
  if (currentIds.some((id): id is undefined => !id)) return false;
  const known = new Set(currentIds as string[]);
  const ordered = new Set(requested);
  return requested.length === ordered.size
    && ordered.size === known.size
    && requested.every(id => known.has(id));
}

export async function sortChatTabs(larkAppId: string, chatId: string, tabIds: string[]): Promise<ChatTab[]> {
  const result = await api(larkAppId).sortTabs({
    path: { chat_id: chatId },
    data: { tab_ids: tabIds },
  });
  assertOk(result);
  return Array.isArray(result?.data?.chat_tabs) ? result.data.chat_tabs : [];
}
