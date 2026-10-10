import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupDefaultModelsRow } from '../src/dashboard/web/group-default-models.js';
import { ModelPickerField, DropdownField } from '../src/dashboard/web/bot-defaults-page.js';
import { setDefaultModelsForGroup, type GroupsActionDeps } from '../src/dashboard/groups-action-helpers.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
function mockRequests(fail = false) {
  const writes: Array<{url: string; body: any}> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string); writes.push({url,body});
      return new Response(JSON.stringify(fail ? {ok:false,error:'offline'} : {ok:true,models:body}), {status:fail ? 503 : 200});
    }
    return new Response(JSON.stringify(url.includes('/models?')
      ? {models:['gpt-5.6-sol','custom-live'],source:'live'}
      : {options:[{id:'codex',label:'Codex',modelChoices:['static-model']}]}));
  }));
  return writes;
}
const props = {chatId:'oc_demo',appId:'app-a',botName:'Assistant',cliId:'codex',onSaved:async()=>undefined};
it('uses Agent CLI model candidates, saves effort, and never writes the CLI', async () => {
  const writes=mockRequests();let renderer!: TestRenderer.ReactTestRenderer;
  await act(async()=>{renderer=TestRenderer.create(React.createElement(GroupDefaultModelsRow,{...props,models:{'claude-code':'sonnet'}}));});
  expect(renderer.root.findByType(ModelPickerField).props.options).toContain('custom-live');
  expect(renderer.root.findAllByType(ModelPickerField)).toHaveLength(1);
  await act(async()=>renderer.root.findByType(ModelPickerField).props.onChange('gpt-5.6-sol'));
  expect(renderer.root.findByType(DropdownField).props.options.map((o:any)=>o.value)).toContain('ultra');
  await act(async()=>renderer.root.findByType(DropdownField).props.onChange('ultra'));
  await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
  expect(writes[0]).toEqual({url:'/api/groups/oc_demo/default-models/app-a',body:{'claude-code':'sonnet',codex:{model:'gpt-5.6-sol',reasoningEffort:'ultra'}}});
  await act(async()=>renderer.root.findByType(ModelPickerField).props.onChange(''));
  expect(renderer.root.findByType(DropdownField).props.value).toBe('');
  await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
  expect(writes[1].body.codex).toEqual({model:''});
  await act(async()=>renderer.unmount());
});
it('preserves drafts across refresh/failure and follows a changed Agent CLI', async()=>{
  const writes=mockRequests(true);let renderer!: TestRenderer.ReactTestRenderer;
  await act(async()=>{renderer=TestRenderer.create(React.createElement(GroupDefaultModelsRow,props));});
  await act(async()=>renderer.root.findByType(ModelPickerField).props.onChange('draft'));
  await act(async()=>renderer.update(React.createElement(GroupDefaultModelsRow,{...props,models:{codex:'remote'}})));
  expect(renderer.root.findByType(ModelPickerField).props.value).toBe('draft');
  await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
  expect(renderer.root.findByProps({role:'status'}).children.join('')).toContain('offline');
  await act(async()=>renderer.update(React.createElement(GroupDefaultModelsRow,{...props,cliId:'claude-code',models:{'claude-code':'haiku'},disabled:true})));
  expect(renderer.root.findByType(ModelPickerField).props.value).toBe('haiku');
  expect(renderer.root.findByType(DropdownField).props.disabled).toBe(true);
  await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
  expect(writes).toHaveLength(1);
  await act(async()=>renderer.unmount());
});

it('proxies exact group/bot settings and invalidates the group cache only on success', async () => {
  const proxyToDaemon = vi.fn(async () => new Response(JSON.stringify({ ok: true, models: { codex: 'custom' } })));
  const invalidateGroups = vi.fn();
  const deps = { proxyToDaemon, invalidateGroups } as unknown as GroupsActionDeps;
  expect(await setDefaultModelsForGroup('oc_demo', 'app-a', '{"codex":"custom"}', deps)).toEqual({ status: 200, body: { ok: true, models: { codex: 'custom' } } });
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a', '/api/group-default-models/oc_demo', expect.objectContaining({ method: 'PUT', body: '{"codex":"custom"}' }));
  expect(invalidateGroups).toHaveBeenCalledOnce();
  proxyToDaemon.mockResolvedValue(new Response('{"ok":false}', { status: 503 }));
  await setDefaultModelsForGroup('oc_demo', 'app-a', '{}', deps);
  expect(invalidateGroups).toHaveBeenCalledOnce();
});
