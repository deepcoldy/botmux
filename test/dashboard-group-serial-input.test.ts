import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupSerialInputRow } from '../src/dashboard/web/group-serial-input.js';
import { setSerialInputForGroup, type GroupsActionDeps } from '../src/dashboard/groups-action-helpers.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
it('persists the exact bot/group switch, retains the old state on failure and disables offline writes', async () => {
  let failure = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const {enabled} = JSON.parse(init.body as string);
    return new Response(JSON.stringify(failure ? {ok:false,error:'offline'} : {ok:true,enabled}),{status:failure?503:200});
  });
  vi.stubGlobal('fetch',fetcher);
  const props = {chatId:'oc_demo',appId:'app-a',botName:'Assistant',enabled:false,onSaved:vi.fn(async()=>undefined)};
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async()=>{renderer=TestRenderer.create(React.createElement(GroupSerialInputRow,props));});
  try {
    await act(async()=>renderer.root.findByType('input').props.onChange({target:{checked:true}}));
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_demo/serial-input/app-a',expect.objectContaining({method:'PUT',body:'{"enabled":true}'}));
    expect(renderer.root.findByType('input').props.checked).toBe(true);
    expect(props.onSaved).toHaveBeenCalledOnce();
    failure=true;
    await act(async()=>renderer.root.findByType('input').props.onChange({target:{checked:false}}));
    expect(renderer.root.findByType('input').props.checked).toBe(true);
    expect(renderer.root.findByProps({role:'status'}).children.join('')).toContain('offline');
    failure=false;
    await act(async()=>renderer.root.findByType('input').props.onChange({target:{checked:false}}));
    expect(renderer.root.findByType('input').props.checked).toBe(false);
    await act(async()=>renderer.update(React.createElement(GroupSerialInputRow,{...props,disabled:true})));
    await act(async()=>renderer.root.findByType('input').props.onChange({target:{checked:true}}));
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {await act(async()=>renderer.unmount());}
});
it('proxies the group switch and invalidates cache only after a successful write',async()=>{
  const proxyToDaemon=vi.fn(async()=>new Response('{"ok":true,"enabled":true}'));
  const invalidateGroups=vi.fn();
  const deps={proxyToDaemon,invalidateGroups} as unknown as GroupsActionDeps;
  expect(await setSerialInputForGroup('oc_demo','app-a','{"enabled":true}',deps)).toEqual({status:200,body:{ok:true,enabled:true}});
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a','/api/group-serial-input/oc_demo',expect.objectContaining({method:'PUT',body:'{"enabled":true}'}));
  expect(invalidateGroups).toHaveBeenCalledOnce();
  proxyToDaemon.mockResolvedValue(new Response('{"ok":false}',{status:503}));
  await setSerialInputForGroup('oc_demo','app-a','{}',deps);
  expect(invalidateGroups).toHaveBeenCalledOnce();
});
