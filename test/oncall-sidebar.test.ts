import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isHostCapabilityLink } from '../src/core/host-capability-link.js';
import { hostOncallSidebar } from '../src/services/oncall-sidebar-link.js';
import { handleOncallSidebar } from '../src/dashboard/oncall-sidebar.js';
import { buildOncallFormCard } from '../src/im/lark/oncall-form-card.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { OncallGroupStore } from '../src/services/oncall-group-store.js';
import type { OncallGroupPolicy } from '../src/services/oncall-group-policy.js';

const appId = 'cli_example';
const owner = 'ou_owner';
const origin = 'https://oncall.example.test';
const host = 'http://dashboard.example.test:7891';
const target = { tenantId: 12, endpoint: `${origin}/api/inf/v1/chat/`, emailDomain: 'example.test' };
const policy: OncallGroupPolicy = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'thread_card' };
const token = 'a'.repeat(32);
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'oncall-sidebar-'));
  writeFileSync(join(dataDir, 'oncall-group-targets.json'), JSON.stringify({ [appId]: target }));
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); vi.useRealTimers(); });

async function fixture(oldMarker = false) {
  const forms = new OncallFormStore(dataDir);
  const draft = forms.open({
    appId, ownerOpenId: owner, region: 'cn', priority: 'P2', description: 'private question', typeId: 2,
    source: { appId, messageId: 'om_answer', questionId: 'om_question', chatId: 'oc_source', answer: '' },
    choices: { regions: { cn: [] } }, visibility: 'thread', targetFingerprint: JSON.stringify(target),
  });
  const nativePage = new URL('/chat', origin);
  nativePage.searchParams.set('bm_form', oldMarker ? draft.id : `${draft.id}.0123456789abcdef01234567`);
  nativePage.searchParams.set('query', draft.description);
  const appLink = new URL('https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&width=430');
  appLink.searchParams.set('url', nativePage.href);
  await forms.use(appId, draft.id, owner, async draft => {
    draft.nativeFormLink = appLink.href;
    draft.nativeSubmission = { attempts: [{ sourceLocation: nativePage.href, username: 'actor', typeId: 2, region: 'cn',
      policyFingerprint: JSON.stringify(policy), preparedAtMs: Date.now(), forwardMode: 'merge',
      sidebarLink: { href: appLink.href, token, hostedHref: hostOncallSidebar(appLink.href, host, draft, token) } }] };
  });
  const read = await forms.use(appId, draft.id, owner, async draft => ({ ...draft }));
  const button = JSON.parse(buildOncallFormCard(read)).elements.at(-1).actions[0];
  return { forms, draft: read, nativePage, button, page: new URL(new URL(button.url).searchParams.get('url')!) };
}

function visit(url: URL, method = 'GET', currentPolicy = policy) {
  const res = { setHeader: vi.fn(), writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
  expect(handleOncallSidebar({ method } as IncomingMessage, res as unknown as ServerResponse, url, dataDir, () => currentPolicy)).toBe(true);
  return { status: res.writeHead.mock.calls[0]?.[0], body: res.end.mock.calls[0]?.[0] as string, res };
}

it('opens the native form in place and answers only its origin and frame with a marked source', async () => {
  const { button, page, nativePage, draft } = await fixture();
  expect(new URL(button.url).searchParams.get('mode')).toBe('sidebar-semi');
  expect(page.origin).toBe(host);
  expect(page.href).not.toContain('private');
  const behindProxy = hostOncallSidebar(draft.nativeFormLink!, 'https://dashboard.example.test/botmux', draft, token);
  expect(new URL(new URL(behindProxy).searchParams.get('url')!).pathname).toBe(`/botmux${page.pathname}`);
  expect(isHostCapabilityLink(page.href, { hosts: [page.hostname], dashboardPorts: [page.port] })).toBe(true);
  const { status, res, body } = visit(page);
  expect(status).toBe(200);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  const contentWindow = { postMessage: vi.fn() };
  const frame = { src: '', contentWindow };
  const window = { addEventListener: vi.fn() };
  const script = body.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  runInNewContext(script!, { window, document: { getElementById: () => frame } });
  expect(frame.src).toBe(nativePage.href);
  const receive = window.addEventListener.mock.calls[0]?.[1];
  const data = { eventName: 'getParentUrl' };
  receive({ origin: 'https://unrelated.example.test', source: contentWindow, data });
  receive({ origin, source: {}, data });
  receive({ origin, source: contentWindow, data: { eventName: 'other' } });
  expect(contentWindow.postMessage).not.toHaveBeenCalled();
  receive({ origin, source: contentWindow, data });
  const source = contentWindow.postMessage.mock.calls[0]?.[0].url;
  expect(source).toBe(`${origin}/chat?bm_form=${nativePage.searchParams.get('bm_form')}`);
  expect(contentWindow.postMessage).toHaveBeenCalledExactlyOnceWith({ url: source }, origin);
});

it('keeps the displayed selection usable while a new card is being published', async () => {
  const { draft, forms, page } = await fixture(true);
  expect(visit(new URL('?url=https://unrelated.example.test', page)).status).toBe(404);
  expect(visit(page, 'POST').status).toBe(405);
  expect(visit(new URL(page.href.replace(token, 'b'.repeat(32)))).status).toBe(404);
  await forms.use(appId, draft.id, owner, async live => {
    live.version++;
    live.typeId = 3;
    delete live.nativeFormLink;
  });
  const old = visit(page);
  expect(old.status).toBe(200);
  expect(old.body).toContain(draft.id);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(draft.createdAtMs + 25 * 60 * 60_000);
  expect(visit(page).status).toBe(404);
});

it('revokes the issued page after a policy or target change or an existing handoff', async () => {
  const { draft, page } = await fixture();
  expect(visit(page).status).toBe(200);
  expect(visit(page, 'GET', { ...policy, enabled: false }).status).toBe(404);
  expect(visit(page, 'GET', { ...policy, forwardMode: 'none' }).status).toBe(404);
  const targetFile = join(dataDir, 'oncall-group-targets.json');
  writeFileSync(targetFile, JSON.stringify({ [appId]: { ...target, tenantId: 13 } }));
  expect(visit(page).status).toBe(404);
  writeFileSync(targetFile, JSON.stringify({ [appId]: target }));
  expect(new OncallGroupStore(dataDir).claim(draft.source, owner)).toBe(true);
  expect(visit(page).status).toBe(404);
});
