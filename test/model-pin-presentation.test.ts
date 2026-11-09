import * as store from '../src/services/session-store.js';
import { afterEach, expect, it, vi } from 'vitest';
import * as registry from '../src/bot-registry.js';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { getDaemonStreamingCardUsageSnapshot, __testOnly_sessionAgentConfig } from '../src/core/worker-pool.js';
import { resolveSessionModelPinView } from '../src/core/session-model.js';
import { buildSessionCard } from '../src/im/lark/card-builder.js';
const bot = { cliId: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: 'low' as const, apiOnly: true };
afterEach(() => vi.restoreAllMocks());
it.each(['gpt-6-astra', 'gpt-6.1-terra'])('dashboard and card snapshots match actual spawn choice under override %s', override => {
  vi.spyOn(store, 'updateSession').mockImplementation(() => {});
  vi.spyOn(registry, 'getBotBrand').mockReturnValue('feishu');
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: bot } as any);
  const ds: any = { session: { sessionId: 'presentation-pin', cliId: 'codex', agentFrozen: true, reasoningEffort: 'low',
    modelPin: { model: 'gpt-6.1-terra', effort: 'high', source: 'command', setBy: 'owner', setAt: 'now' },
    larkAppId: 'presentation-app', chatId: 'virtual_pin', rootMessageId: 'root', chatType: 'p2p', scope: 'thread', status: 'active', createdAt: new Date().toISOString() },
    larkAppId: 'presentation-app', chatId: 'virtual_pin', chatType: 'p2p', scope: 'thread', worker: { killed: false }, workerReady: true, hasHistory: true,
    spawnedAt: Date.now(), lastMessageAt: Date.now(), spawnModelOverride: override };
  const launch = __testOnly_sessionAgentConfig(ds, bot);
  const view = resolveSessionModelPinView(ds, bot)!;
  expect(view).toMatchObject({ active: false, shadowedBy: 'spawn-override', launchModel: launch.model, launchEffort: launch.reasoningEffort });
  expect(composeRowFromActive(ds, { includeTokenUsage: false }).modelPin).toEqual(view);
  expect(getDaemonStreamingCardUsageSnapshot(ds).modelPin).toEqual(view);
  const card = JSON.parse(buildSessionCard('id','root','','topic','codex',false,false,'zh',false,undefined,undefined,view));
  expect(JSON.stringify(card.elements)).toContain('spawn-override');
  expect(ds.spawnModelOverride).toBe(override);
});

it('explains the current model effort separately from the waiting pin on every existing presentation path', async () => {
  vi.spyOn(store, 'updateSession').mockImplementation(() => {});
  vi.spyOn(registry, 'getBotBrand').mockReturnValue('feishu');
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: bot } as any);
  const ds: any = { session: { sessionId: 'waiting-pin', cliId: 'codex', agentFrozen: true, reasoningEffort: 'low',
    modelPin: { model: 'gpt-6.1-terra', effort: 'high', source: 'command', setBy: 'owner', setAt: 'now' },
    larkAppId: 'presentation-app', chatId: 'virtual_pin', rootMessageId: 'root', status: 'active', createdAt: new Date().toISOString() },
    activeModel: 'gpt-6-astra', activeReasoningEffort: 'low', larkAppId: 'presentation-app', chatId: 'virtual_pin',
    worker: { killed: false }, workerReady: true, hasHistory: true, spawnedAt: Date.now(), lastMessageAt: Date.now() };
  const view = resolveSessionModelPinView(ds, bot)!;
  expect(view.launchEffort).toBe('high');
  // Check the two actual values/models, not the surrounding wording.
  for (const value of ['gpt-6-astra', 'low', 'gpt-6.1-terra', 'high']) expect(view.pendingEffortNote).toContain(value);
  expect(composeRowFromActive(ds, { includeTokenUsage: false }).modelPin?.pendingEffortNote).toBe(view.pendingEffortNote);
  expect(getDaemonStreamingCardUsageSnapshot(ds).modelPin?.pendingEffortNote).toBe(view.pendingEffortNote);
  const { modelPinText } = await import('../src/core/model-pin.js');
  expect(modelPinText(view)).toContain(view.pendingEffortNote);
  const card = JSON.parse(buildSessionCard('id','root','','topic','codex',false,false,'zh',false,undefined,undefined,view));
  expect(JSON.stringify(card.elements)).toContain(view.pendingEffortNote);
});

it('does not promise an unsupported waiting pin effort will apply', () => {
  const view = resolveSessionModelPinView({ session: { cliId: 'codex', reasoningEffort: 'low',
    modelPin: { model: 'gpt-5.2', effort: 'ultra', source: 'command', setBy: 'owner', setAt: 'now' } },
    activeModel: 'gpt-6-astra', activeReasoningEffort: 'low' }, bot)!;
  expect(view.effortDowngradeNote).toBeTruthy(); expect(view.pendingEffortNote).toBeUndefined();
  expect(view.launchEffort).toBe('low');
});
