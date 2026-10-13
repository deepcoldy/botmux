import { getBot, getBotClient } from '../bot-registry.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';

export interface ListenerDocumentLink { url: string; kind: 'docx' | 'wiki'; token: string; }

const MAX_DOCUMENT_LINKS_PER_MESSAGE = 5;
const DOCUMENT_PATH = /^\/(docx|wiki)\/([A-Za-z0-9]+)(?:\/|$)/;
const TRAILING_URL_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？', ')', ']', '}']);

function trustedDocumentHost(hostname: string, brand: 'feishu' | 'lark'): boolean {
  const suffixes = brand === 'lark' ? ['larksuite.com', 'larkoffice.com'] : ['feishu.cn', 'larkoffice.com'];
  return suffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Only parses strictly validated URLs; message content never selects a host
 * for API traffic and is never fetched directly. */
export function extractListenerDocumentLinks(text: string, brand: 'feishu' | 'lark'): ListenerDocumentLink[] {
  const links: ListenerDocumentLink[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/https:\/\/[^\s<>'"）】]+/g) ?? []) {
    // A URL can be rendered from post `a.text` as `label (URL)` or occur at
    // the end of normal prose.  Trim only terminal punctuation; the parsed
    // pathname still has to satisfy the strict document path/token grammar.
    let candidate = raw;
    let parsed: URL | undefined;
    let match: RegExpMatchArray | null = null;
    while (candidate) {
      try { parsed = new URL(candidate); } catch { parsed = undefined; }
      match = parsed?.pathname.match(DOCUMENT_PATH) ?? null;
      if (parsed && match) break;
      if (!TRAILING_URL_PUNCTUATION.has(candidate.at(-1) ?? '')) break;
      candidate = candidate.slice(0, -1);
    }
    if (!parsed || !match || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !trustedDocumentHost(parsed.hostname, brand)) continue;
    const kind = match[1] as 'docx' | 'wiki';
    const token = match[2];
    if (seen.has(`${kind}:${token}`)) continue;
    seen.add(`${kind}:${token}`);
    links.push({ url: parsed.toString(), kind, token });
    if (links.length >= MAX_DOCUMENT_LINKS_PER_MESSAGE) break;
  }
  return links;
}

async function fileTitle(larkAppId: string, token: string, type: string): Promise<string | undefined> {
  const response = await getBotClient(larkAppId).request({
    method: 'POST',
    url: '/open-apis/drive/v1/metas/batch_query',
    data: { request_docs: [{ doc_token: token, doc_type: type }] },
  });
  const title = response?.data?.metas?.[0]?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

async function wikiTitle(larkAppId: string, token: string): Promise<string | undefined> {
  const response = await getBotClient(larkAppId).request({
    method: 'GET', url: '/open-apis/wiki/v2/spaces/get_node', params: { token, obj_type: 'wiki' },
  });
  const node = response?.data?.node;
  if (typeof node?.obj_token !== 'string' || typeof node?.obj_type !== 'string') return undefined;
  return fileTitle(larkAppId, node.obj_token, node.obj_type);
}

/** Tenant-only metadata lookup. Do not reuse doc-comment's user-first flow:
 * sender/user credentials are intentionally not an authority source here. */
export async function resolveListenerDocumentTitles(larkAppId: string, text: string): Promise<string[]> {
  const bot = getBot(larkAppId);
  const links = extractListenerDocumentLinks(text, normalizeBrand(bot.config.brand));
  const titles: string[] = [];
  for (const link of links) {
    try {
      const title = link.kind === 'docx'
        ? await fileTitle(larkAppId, link.token, 'docx')
        : await wikiTitle(larkAppId, link.token);
      if (title) titles.push(title);
    } catch { /* permission, quota and network errors preserve local matching */ }
  }
  return titles;
}
