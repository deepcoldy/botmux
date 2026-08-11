import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkbenchHash,
  computeVirtualWindow,
  defaultWorkbenchLayout,
  deriveResponsiveWorkbenchLayout,
  flattenWorkbenchGroups,
  groupWorkbenchSessions,
  isValidPaneTree,
  paneTreeForLayout,
  parseWorkbenchHash,
  type WorkbenchSessionRow,
} from '../src/dashboard/web/agent-workbench-model.js';
import { loadWorkbenchLayout, saveWorkbenchLayout, type WorkbenchStorage } from '../src/dashboard/web/agent-workbench-storage.js';
import { buildWorkbenchWebAppLink, openWorkbenchChat, type FeishuJsApi } from '../src/dashboard/web/agent-workbench-chat.js';
import { safeDashboardH5ReturnTo } from '../src/dashboard/h5-auth.js';

const rows: WorkbenchSessionRow[] = Array.from({ length: 320 }, (_, index) => ({
  sessionId: `session-${index}`,
  status: index % 19 === 0 ? 'closed' : 'working',
  title: `Session ${index}`,
  lastMessageAt: 1_700_000_000_000 + index,
  ...(index % 23 === 0 ? { agentAttention: { reason: 'Approve change', at: 1_800_000_000_000 + index } } : {}),
}));

assert.equal(buildWorkbenchHash('main', 'a/b'), '#/agent-workbench/a%2Fb');
assert.deepEqual(parseWorkbenchHash('#/agent-workbench-dock/a%2Fb'), { surface: 'dock', sessionId: 'a/b' });
assert.equal(safeDashboardH5ReturnTo('/#/settings'), '/');
assert.equal(safeDashboardH5ReturnTo('/#/agent-workbench/a%2Fb'), '/#/agent-workbench/a%2Fb');

const requested = { ...defaultWorkbenchLayout(), paneMode: 'split' as const, chatRequested: true };
assert.equal(deriveResponsiveWorkbenchLayout(1279, requested).step, 'rail-collapsed');
assert.equal(deriveResponsiveWorkbenchLayout(1119, requested).step, 'focus');
assert.equal(deriveResponsiveWorkbenchLayout(959, requested).step, 'chat-jump');
assert.equal(deriveResponsiveWorkbenchLayout(600, requested).step, 'mobile-stack');
const tree = paneTreeForLayout(requested);
assert.equal(isValidPaneTree(tree), true);
assert.equal(JSON.stringify(tree).includes('chat'), false);
assert.equal(JSON.stringify(tree).includes('info'), false);

const items = flattenWorkbenchGroups(groupWorkbenchSessions(rows));
const virtual = computeVirtualWindow(items, 8_000, 640);
assert.equal(items.length, 323);
assert.ok(virtual.end - virtual.start < 24);
assert.ok(virtual.start > 100);

class MemoryStorage implements WorkbenchStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const storage = new MemoryStorage();
assert.equal(saveWorkbenchLayout('session-a', requested, storage), true);
assert.deepEqual(loadWorkbenchLayout('session-a', storage), requested);
assert.doesNotMatch([...storage.values.values()][0], /url|token|grant|cookie/i);

const callOrder: string[] = [];
const sdk: FeishuJsApi = {
  toggleChat(options) { callOrder.push('toggleChat'); options.fail?.(); },
  enterChat(options) { callOrder.push('enterChat'); options.success?.(); },
};
assert.deepEqual(await openWorkbenchChat({ chatId: 'oc_x', preferSplit: true, sdk }), { kind: 'native-jump', method: 'enterChat' });
assert.deepEqual(callOrder, ['toggleChat', 'enterChat']);
const dockLink = buildWorkbenchWebAppLink({ appId: 'cli_x', surface: 'dock', targetOrigin: 'https://dash.example' });
assert.match(dockLink ?? '', /mode=sidebar/);
assert.match(dockLink ?? '', /min_width=350/);

const css = readFileSync(join(process.cwd(), 'src/dashboard/web/style.css'), 'utf8');
const workbenchCss = css.slice(css.indexOf('/* Agent Workbench'));
assert.doesNotMatch(workbenchCss, /(?:linear|radial|conic)-gradient\s*\(/i);
const radii = [...workbenchCss.matchAll(/border-radius:\s*(\d+)px/g)].map(match => Number(match[1]));
assert.ok(radii.length >= 8 && Math.max(...radii) <= 4);
const routes = readFileSync(join(process.cwd(), 'src/dashboard/web/dashboard-routes.ts'), 'utf8');
assert.match(routes, /agent-workbench-dock-page/);
assert.match(routes, /agent-workbench-page/);

process.stdout.write(JSON.stringify({
  ok: true,
  sessions: rows.length,
  virtualItemsRendered: virtual.end - virtual.start,
  degradation: ['rail-collapsed', 'focus', 'chat-jump', 'mobile-stack'],
  chatFallbackOrder: callOrder,
}) + '\n');
