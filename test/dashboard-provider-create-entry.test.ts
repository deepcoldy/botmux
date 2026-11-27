import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {afterEach, expect, it, vi} from 'vitest';
import {useSessionCreateEntry} from '../src/dashboard/web/sessions-page.js';
import {requestOpenCreateSession,consumePendingCreateSession} from '../src/dashboard/web/create-session-entry.js';
import {ui} from '../src/dashboard/web/ui.js';
import {publishProviderRoster,useProviderRoster} from '../src/dashboard/web/provider-roster.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const originalAuthed=ui.authed;
let renderer: TestRenderer.ReactTestRenderer | undefined;
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;consumePendingCreateSession();ui.authed=originalAuthed;vi.unstubAllGlobals();});
it('guards current provider context across global entry events and filter changes',async()=>{
 const events=new EventTarget();
 vi.stubGlobal('window',{location:{hash:'#/sessions'},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
 ui.authed=true;
 const open=vi.fn(async()=>{});
 function Entry({blocked}:{blocked:boolean}){useSessionCreateEntry(open,blocked);return null;}
 await act(async()=>{renderer=TestRenderer.create(React.createElement(Entry,{blocked:true}));});
 await act(async()=>requestOpenCreateSession());expect(open).not.toHaveBeenCalled();
 await act(async()=>renderer!.update(React.createElement(Entry,{blocked:false})));
 expect(open).not.toHaveBeenCalled(); // A blocked request must not reappear after changing filters.
 await act(async()=>requestOpenCreateSession());expect(open).toHaveBeenCalledTimes(1);
 await act(async()=>renderer!.update(React.createElement(Entry,{blocked:true})));
 await act(async()=>requestOpenCreateSession());expect(open).toHaveBeenCalledTimes(1);
});

it('blocks global creation for a confirmed WeCom-only roster and restores mixed deployment creation',async()=>{
 const events=new EventTarget();
 vi.stubGlobal('window',{location:{hash:'#/sessions'},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)});
 ui.authed=true;
 const open=vi.fn(async()=>{});
 function Entry(){const {onlyWecom}=useProviderRoster();useSessionCreateEntry(open,onlyWecom);return null;}
 publishProviderRoster('lark',0);publishProviderRoster('wecom',1);
 await act(async()=>{renderer=TestRenderer.create(React.createElement(Entry));});
 await act(async()=>requestOpenCreateSession());expect(open).not.toHaveBeenCalled();
 await act(async()=>publishProviderRoster('lark',1));
 await act(async()=>requestOpenCreateSession());expect(open).toHaveBeenCalledTimes(1);
 await act(async()=>publishProviderRoster('lark',0));
 await act(async()=>requestOpenCreateSession());expect(open).toHaveBeenCalledTimes(1);
 publishProviderRoster('wecom',0);
});
