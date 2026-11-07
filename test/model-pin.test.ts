import { applyWorkerLaunchModel } from '../src/core/worker-launch-model.js';
import { describe, expect, it } from 'vitest';
import { clearTakeoverModelSources, modelPinText, modelPinView, validateModelPin, type ModelPin } from '../src/core/model-pin.js';
import { resolveSessionLaunchModel, resolveSessionLaunchEffort } from '../src/core/session-model.js';
import { inheritSessionLaunchConfiguration } from '../src/core/session-launch-inheritance.js';
import type { Session } from '../src/types.js';
const pin: ModelPin = { model: 'gpt-6.1-terra', effort: 'high', source: 'topic-header', setBy: 'owner', setAt: '2026-11-06T00:00:00.000Z' };
const bot = { cliId: 'codex' as const, model: 'gpt-6.1-sol' };
const subject = () => ({ session: { cliId: 'codex' as const, chatType: 'group' as const, model: 'record', modelPin: { ...pin }, groupDefaultModels: { codex: 'group' } }, spawnModelOverride: undefined as string | undefined });
describe('explicit topic launch choice', () => {
  it('orders dispatch > one-shot > pin > group > live > record, including p2p', () => {
    const ds: any = subject();
    ds.session.dispatchLaunchSpec = { effective: { model: 'dispatch' } }; ds.spawnModelOverride = 'once';
    expect(resolveSessionLaunchModel(ds, bot)).toBe('dispatch'); delete ds.session.dispatchLaunchSpec;
    expect(resolveSessionLaunchModel(ds, bot)).toBe('once'); delete ds.spawnModelOverride;
    expect(resolveSessionLaunchModel(ds, bot)).toBe(pin.model);
    ds.session.chatType = 'p2p'; expect(resolveSessionLaunchModel(ds, bot)).toBe(pin.model);
    ds.session.chatType = 'group'; delete ds.session.modelPin; expect(resolveSessionLaunchModel(ds, bot)).toBe('group');
    delete ds.session.groupDefaultModels; expect(resolveSessionLaunchModel(ds, bot)).toBe(bot.model);
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code', model: 'opus' })).toBe('record');
  });
  it('retains but deactivates a mismatched CLI pin, with a visible cause', () => {    const ds = subject(); delete (ds.session as any).groupDefaultModels;
    const changed = { cliId: 'claude-code' as const, model: 'opus' };
    expect(resolveSessionLaunchModel(ds, changed)).toBe('record');
    expect(resolveSessionLaunchEffort(ds, changed, 'record', 'low')).toBe('low');
    const view = modelPinView(ds.session, changed)!;
    expect(view.active).toBe(false); expect(view.inactiveReason).toBeTruthy();
    expect(modelPinText(view)).toContain(pin.model); expect(ds.session.modelPin).toEqual(pin);
  });
  it.each([
    [(s: any) => { s.adoptedFrom = { source: 'external' }; }, 'traditional adopt', bot.model],
    [(s: any) => { s.existingAppServerEndpoint = 'ws://app-server.example:1234'; }, 'codex --remote viewer', 'group'],
  ])('suspends a pinned choice for a shared-adopt session and reactivates it after disconnect (%s)', (mark, _label, fallbackModel: string) => {
    const ds: any = subject();
    mark(ds.session);
    expect(resolveSessionLaunchModel(ds, bot)).toBe(fallbackModel);
    expect(resolveSessionLaunchEffort(ds, bot, fallbackModel, 'low')).toBe('low');
    const view = modelPinView(ds.session, bot, { model: fallbackModel, effort: 'low' })!;
    expect(view.active).toBe(false);
    expect(view.inactiveReason).toContain('接管');
    expect(view.effortDowngradeNote).toBeUndefined();
    expect(view.pendingEffortNote).toBeUndefined();
    expect(ds.session.modelPin).toEqual(pin);
    delete ds.session.adoptedFrom; delete ds.session.existingAppServerEndpoint;
    expect(resolveSessionLaunchModel(ds, bot)).toBe(pin.model);
    expect(modelPinView(ds.session, bot)?.active).toBe(true);
  });
  it('never applies a pinned effort during adopt even when the fallback launch model equals the pin model', () => {
    // Without its own adopt gate, the model-bound effort check alone would let
    // the pin effort through whenever the bot default happens to be the same
    // model — the adopted CLI still does not consume it.
    const sameModelBot = { cliId: 'codex' as const, model: pin.model };
    const ds: any = subject();
    ds.session.adoptedFrom = { source: 'external' };
    delete ds.session.groupDefaultModels;
    expect(resolveSessionLaunchModel(ds, sameModelBot)).toBe(pin.model);
    expect(resolveSessionLaunchEffort(ds, sameModelBot, pin.model, 'low')).toBe('low');
    expect(modelPinView(ds.session, sameModelBot, { adopted: true, model: pin.model, effort: 'low' })?.active).toBe(false);
  });
  it('applies pin effort only to its matching model and gates unsupported levels', () => {
    const ds = subject();
    expect(resolveSessionLaunchEffort(ds, bot, pin.model, 'low')).toBe('high');
    expect(resolveSessionLaunchEffort(ds, bot, 'other', 'low')).toBe('low');
    ds.session.modelPin.effort = 'ultra'; ds.session.modelPin.model = 'gpt-5.2';
    expect(resolveSessionLaunchEffort(ds, bot, 'gpt-5.2', 'low')).toBe('low');
    expect(modelPinView(ds.session, bot)).toMatchObject({ active: true, effortDowngradeNote: expect.any(String) });
    expect(modelPinView(ds.session, bot)?.inactiveReason).toBeUndefined();
  });
  it.each([
    [{ cliId: 'dsh-tui' }, { model: 'm' }],
    [{ cliId: 'codex', backendType: 'riff' }, { model: 'm' }],
    [{ cliId: 'codex' }, { model: 'x y' }],
    [{ cliId: 'codex' }, { model: 'gpt-5.2', effort: 'ultra' }],
    [{ cliId: 'cursor' }, { model: 'm', effort: 'high' }],
  ] as const)('rejects unsupported explicit writes %j %j', (cfg, input) => {
    expect(validateModelPin(input, cfg)).toBeTruthy();
  });
  it('accepts model-capable CLIs without a curated model list and a second CLI effort', () => {
    expect(validateModelPin({ model: 'provider/new' }, { cliId: 'pi' })).toBeUndefined();
    expect(validateModelPin({ model: 'sonnet', effort: 'high' }, { cliId: 'claude-code' })).toBeUndefined();
  });
  it('copies explicit provenance on fork/recovery without aliasing or manufacturing a pin', () => {
    const parent = { model: 'bot-default', modelPin: { ...pin } } as Session;
    const child = {} as Session; inheritSessionLaunchConfiguration(parent, child);
    expect(child.modelPin).toEqual(pin); child.modelPin!.model = 'child-only'; expect(parent.modelPin).toEqual(pin);
    const old = {} as Session; inheritSessionLaunchConfiguration({ model: 'inherited' } as Session, old);
    expect(old.modelPin).toBeUndefined();
  });
});

it('App takeover clears every model source together', () => {
  const ds = { session: { model: 'record', modelPin: { ...pin } }, spawnModelOverride: 'one-shot' };
  clearTakeoverModelSources(ds);
  expect(ds.session.model).toBeUndefined(); expect(ds.session.modelPin).toBeUndefined(); expect(ds.spawnModelOverride).toBeUndefined();
});

it('the worker applies restart/message launch fields and clears flags without changing an absent legacy payload', () => {
  const cfg = { model: 'old', reasoningEffort: 'low' as import('../src/services/codex-reasoning-effort.js').CodexReasoningEffort | undefined };
  applyWorkerLaunchModel(cfg, {}); expect(cfg).toEqual({ model: 'old', reasoningEffort: 'low' });
  applyWorkerLaunchModel(cfg, { model: pin.model, reasoningEffort: pin.effort }); expect(cfg).toEqual({ model: pin.model, reasoningEffort: pin.effort });
  applyWorkerLaunchModel(cfg, { model: null, reasoningEffort: null }); expect(cfg.model).toBeUndefined(); expect(cfg.reasoningEffort).toBeUndefined();
});

it('exposes pin model/source and inactive reason on the real session card payload', async () => {
  const { buildSessionCard } = await import('../src/im/lark/card-builder.js');
  const view = modelPinView({ cliId: 'codex', modelPin: pin }, { cliId: 'claude-code' });
  const card = JSON.parse(buildSessionCard('id', 'root', '', 'topic', 'codex', false, false, 'zh', false, undefined, undefined, view));
  const labels = card.elements.filter((e: any) => e.tag === 'div').map((e: any) => e.text?.content ?? '');
  expect(labels.some((label: string) => label.includes(pin.model) && label.includes(pin.source))).toBe(true);
  expect(labels.some((label: string) => label.includes(view!.inactiveReason!))).toBe(true);
});

it.each([
  ['gpt-6-astra', 'low'],
  ['gpt-6.1-terra', 'high'],
])('launch presentation carries spawn override %s and actual effort %s without changing priority', async (override, effort) => {
  const { resolveSessionModelPinView } = await import('../src/core/session-model.js');
  const ds: any = { session: { cliId: 'codex', reasoningEffort: 'low', modelPin: { ...pin } }, spawnModelOverride: override };
  const view = resolveSessionModelPinView(ds, bot)!;
  expect(view).toMatchObject({ active: false, shadowedBy: 'spawn-override', launchModel: override, launchEffort: effort });
  expect(view.inactiveReason).toBeUndefined(); expect(ds.spawnModelOverride).toBe(override);
  expect(modelPinText(view)).toContain(override);
});
it('a dispatch choice for the same model keeps its own effort above a persisted pin', async () => {
  const { resolveSessionModelPinView } = await import('../src/core/session-model.js');
  const ds: any = { session: { cliId: 'codex', reasoningEffort: 'high', modelPin: { ...pin }, dispatchLaunchSpec: { effective: { model: pin.model, reasoningEffort: 'low' } } } };
  expect(resolveSessionModelPinView(ds, bot)).toMatchObject({ active: false, shadowedBy: 'dispatch', launchModel: pin.model, launchEffort: 'low' });
  expect(resolveSessionLaunchEffort(ds, bot, pin.model, 'high')).toBe('low');
});
