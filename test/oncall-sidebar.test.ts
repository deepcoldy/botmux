import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isHostCapabilityLink } from '../src/core/host-capability-link.js';
import { config } from '../src/config.js';
import { localHttpOrigin } from '../src/core/dashboard-url.js';
import { sendableCardLink } from '../src/im/lark/local-address-context.js';
import { setHideLocalAddressesResolver } from '../src/im/lark/local-address-switch.js';
import { hostOncallSidebar, nativeSelectionSourceType } from '../src/services/oncall-sidebar-link.js';
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
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function fixture(oldMarker = false, question = 'private question') {
  const forms = new OncallFormStore(dataDir);
  const draft = forms.open({
    appId, ownerOpenId: owner, region: 'cn', priority: 'P2', description: 'private question', typeId: 2,
    source: { appId, messageId: 'om_answer', questionId: 'om_question', chatId: 'oc_source', answer: '' },
    choices: { regions: { cn: [] } }, visibility: 'thread', targetFingerprint: JSON.stringify(target),
  });
  const nativePage = new URL('/chat', origin);
  nativePage.searchParams.set('bm_form', oldMarker ? draft.id : `${draft.id}.0123456789abcdef01234567`);
  nativePage.searchParams.set('directly', 'true');
  nativePage.searchParams.set('type', '2');
  nativePage.searchParams.set('region', draft.region);
  nativePage.searchParams.set('query', question);
  const appLink = new URL('https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&width=430');
  appLink.searchParams.set('url', nativePage.href);
  await forms.use(appId, draft.id, owner, async draft => {
    draft.nativeFormLink = appLink.href;
    draft.nativeSubmission = { attempts: [{ sourceLocation: nativePage.href, username: 'actor', typeId: 2, region: 'cn',
      policyFingerprint: JSON.stringify(policy), preparedAtMs: Date.now(), forwardMode: 'merge',
      sidebarLink: { href: appLink.href, token, hostedHref: hostOncallSidebar(appLink.href, host, draft, token) } }] };
  });
  const read = await forms.use(appId, draft.id, owner, async draft => ({ ...draft }));
  const button = JSON.parse(buildOncallFormCard(read)).body.elements.at(-1).columns[0].elements[0];
  return { forms, draft: read, nativePage, button, page: new URL(new URL(button.behaviors[0].default_url).searchParams.get('url')!) };
}

function visit(url: URL, method = 'GET', currentPolicy = policy) {
  const res = { setHeader: vi.fn(), writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
  expect(handleOncallSidebar({ method } as IncomingMessage, res as unknown as ServerResponse, url, dataDir, () => currentPolicy)).toBe(true);
  return { status: res.writeHead.mock.calls[0]?.[0], body: res.end.mock.calls[0]?.[0] as string, res };
}

it.each([false, true])('redirects an issued card to its exact native form at the top level (legacy draft marker: %s)', async oldMarker => {
  const { button, page, nativePage } = await fixture(oldMarker);
  expect(new URL(button.behaviors[0].default_url).searchParams.get('mode')).toBe('sidebar-semi');
  expect(page.origin).toBe(host);
  expect(page.href).not.toContain('private');
  expect(isHostCapabilityLink(page.href, { hosts: [page.hostname], dashboardPorts: [page.port] })).toBe(true);
  const { status, res, body } = visit(page);
  const tag = nativeSelectionSourceType(nativePage.searchParams.get('bm_form'));
  expect(tag).toMatch(/^botmux_[a-f0-9]{24}$/);
  nativePage.searchParams.set('bizFrom', tag!);
  expect(status).toBe(302);
  expect(res.writeHead).toHaveBeenCalledWith(302, { Location: nativePage.href });
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(body).toBeUndefined();
});

it('opens an already issued blank private selection with the same category and correlation marker', async () => {
  const { page, nativePage } = await fixture(false, '');
  const { res } = visit(page);
  const destination = new URL(res.writeHead.mock.calls[0][1].Location);
  expect(destination.searchParams.get('query')).toBe('申请人工 Oncall');
  for (const key of ['type', 'region', 'directly', 'bm_form']) {
    expect(destination.searchParams.get(key)).toBe(nativePage.searchParams.get(key));
  }
});

it('accepts only the configured local reverse-proxy path prefix for hosted cards', async () => {
  const { draft } = await fixture();
  const base = localHttpOrigin(config.dashboard.externalHost, config.dashboard.port);
  vi.stubEnv('BOTMUX_PUBLIC_URL', `${base}/botmux/`);
  const restore = setHideLocalAddressesResolver(() => true);
  try {
    const hosted = hostOncallSidebar(draft.nativeFormLink!, `${base}/botmux`, draft, token);
    const page = new URL(new URL(hosted).searchParams.get('url')!);
    expect(page.pathname).toBe(`/botmux/oncall/sidebar/${appId}/${draft.id}/${token}`);
    expect(sendableCardLink(hosted, appId)).toBe(true);
    expect(sendableCardLink(page.href, appId)).toBe(true);
    const otherPrefix = new URL(page);
    otherPrefix.pathname = page.pathname.replace(/^\/botmux\//, '/other/');
    expect(sendableCardLink(otherPrefix.href, appId)).toBe(false);
  } finally { restore(); }
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
  expect(old.status).toBe(302);
  expect(old.res.writeHead.mock.calls[0][1].Location).toContain(draft.id);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(draft.createdAtMs + 25 * 60 * 60_000);
  expect(visit(page).status).toBe(404);
});

it('revokes the issued page after a policy or target change or an existing handoff', async () => {
  const { draft, page } = await fixture();
  expect(visit(page).status).toBe(302);
  expect(visit(page, 'GET', { ...policy, button: { minTurns: 3 }, chatIds: ['oc_other', 'oc_source'] }).status).toBe(302);
  expect(visit(page, 'GET', { ...policy, chatIds: ['oc_other'] }).status).toBe(404);
  expect(visit(page, 'GET', { ...policy, enabled: false }).status).toBe(404);
  expect(visit(page, 'GET', { ...policy, forwardMode: 'none' }).status).toBe(404);
  const targetFile = join(dataDir, 'oncall-group-targets.json');
  writeFileSync(targetFile, JSON.stringify({ [appId]: { ...target, tenantId: 13 } }));
  expect(visit(page).status).toBe(404);
  writeFileSync(targetFile, JSON.stringify({ [appId]: target }));
  expect(new OncallGroupStore(dataDir).claim(draft.source, owner)).toBe(true);
  expect(visit(page).status).toBe(404);
});
