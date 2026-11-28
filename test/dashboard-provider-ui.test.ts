import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {SessionDetailsDrawer} from '../src/dashboard/web/sessions-page.js';
import {buildBotCards,loadGroupsSnapshot,loadWecomConnectionsSnapshot} from '../src/dashboard/web/overview.js';
import {store} from '../src/dashboard/web/store.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
vi.mock('../src/dashboard/web/modal-dialog.js',()=>({ModalDialog:({children}:any)=>React.createElement('div',{},children)}));
vi.mock('../src/dashboard/web/groups-api.js',()=>({fetchGroupsNamesSnapshot:async()=>({chats:[],bots:[{larkAppId:'legacy',botName:'飞书助理',cliId:'codex'}]})}));
let renderer:TestRenderer.ReactTestRenderer|undefined;
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;vi.unstubAllGlobals();store.replaceSnapshot([],null,undefined,{wecomSessionIds:[]});});
async function mount(node:React.ReactElement){await act(async()=>{renderer=TestRenderer.create(node);});return renderer!;}
const row={sessionId:'wecom:config:core:opaque',provider:'wecom',providerBotId:'config',botName:'企微助理',status:'working',cliId:'codex',title:'测试工作',chatType:'p2p',chatDisplayName:'企微私聊',workingDir:'/workspace/demo'};
describe('Unified Dashboard native-provider UI',()=>{
 it('uses the main session details with only advertised actions and no Lark-specific identifiers',async()=>{
  const history=vi.fn(),interrupt=vi.fn(async()=>true);
  await mount(React.createElement(SessionDetailsDrawer,{row:{...row,rootMessageId:'must-not-render',threadId:'must-not-render',feishuChatLink:'https://example.invalid',capabilities:{history:true,interrupt:true,close:true,restart:false,suspend:false,resume:false,terminal:false,takeover:false}},onClose:vi.fn(),locateSession:vi.fn(),openHistory:history,resumeSession:vi.fn(),restartSession:vi.fn(),closeSession:vi.fn(),setSessionLocked:vi.fn(),startSession:vi.fn(),onTakeover:vi.fn(),interruptSession:interrupt}));
  expect(renderer!.root.findAllByProps({id:'restart-btn'})).toHaveLength(0);expect(renderer!.root.findAllByProps({id:'takeover-btn'})).toHaveLength(0);expect(renderer!.root.findAllByProps({id:'lock-btn'})).toHaveLength(0);expect(renderer!.root.findAllByProps({id:'locate-btn'})).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('must-not-render');
  await act(async()=>renderer!.root.findByProps({id:'history-drawer-btn'}).props.onClick());expect(history).toHaveBeenCalledWith(expect.objectContaining({provider:'wecom',sessionId:row.sessionId}));
  const button=renderer!.root.findAllByType('button').find(node=>node.children.includes('停止当前任务'))!;await act(async()=>button.props.onClick({currentTarget:{disabled:false}}));expect(interrupt).toHaveBeenCalledTimes(1);
  const longId=`wecom:${'a'.repeat(64)}:${'b'.repeat(64)}:${'Zml4dHVyZQ'.repeat(5)}`;
  await act(async()=>renderer!.update(React.createElement(SessionDetailsDrawer,{row:{...row,sessionId:longId,status:'idle',terminalUrl:'/wecom-terminal/source/',capabilities:{history:true,terminal:true,takeover:true,resume:true,restart:true,suspend:true,close:true}},onClose:vi.fn(),locateSession:vi.fn(),openHistory:history,resumeSession:vi.fn(),restartSession:vi.fn(),closeSession:vi.fn(),setSessionLocked:vi.fn(),startSession:vi.fn(),onTakeover:vi.fn(),onOpenTerminal:vi.fn()})));
  const writeText=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText}});vi.stubGlobal('window',{setTimeout:vi.fn(),location:{protocol:'https:',origin:'https://fixture.invalid',hostname:'fixture.invalid'}});
  const idLine=renderer!.root.findByProps({className:'drawer-session-id'});expect(idLine.findByType('code').props.title).toBe(longId);
  await act(async()=>idLine.findByType('button').props.onClick({currentTarget:null}));expect(writeText).toHaveBeenCalledWith(longId);
  expect(renderer!.root.findAllByProps({id:'resume-btn'})).toHaveLength(0);expect(renderer!.root.findAllByProps({id:'takeover-btn'})).toHaveLength(1);expect(renderer!.root.findAllByType('button').some(node=>node.children.includes('查看终端'))).toBe(false);
 });
 it('renders the same drawer action structure for equal provider capabilities',async()=>{
  vi.stubGlobal('window',{location:{protocol:'https:',origin:'https://fixture.invalid',hostname:'fixture.invalid'}});
  const callbacks={onClose:vi.fn(),locateSession:vi.fn(),openHistory:vi.fn(),resumeSession:vi.fn(),restartSession:vi.fn(),closeSession:vi.fn(),setSessionLocked:vi.fn(),startSession:vi.fn(),onTakeover:vi.fn(),onOpenTerminal:vi.fn()};
  const capabilities=Object.fromEntries(['history','insight','terminal','takeover','restart','close','resume','rename','board','lock','locate','spawnCommand','environment','start','monitorRoom','modelPin'].map(key=>[key,true]));
  const shared={...row,terminalUrl:'/wecom-terminal/source/',webPort:12345,proxyPort:12345,capabilities};
  await mount(React.createElement(SessionDetailsDrawer,{...callbacks,row:shared}));
  const actions=()=>renderer!.root.findByProps({className:'drawer-foot'}).findAllByType('button').map(node=>({id:node.props.id,className:node.props.className,disabled:node.props.disabled}));
  const nativeActions=actions();
  await act(async()=>renderer!.update(React.createElement(SessionDetailsDrawer,{...callbacks,row:{...shared,provider:undefined}})));
  expect(actions()).toEqual(nativeActions);
 });
 it('merges native-provider snapshot rows without erasing fresh legacy SSE state',()=>{
  store.replaceSnapshot([{sessionId:'legacy-session',status:'working',title:'old'},row],null);
  store.applySse('session.update',{sessionId:'legacy-session',patch:{title:'fresh SSE'}});
  store.replaceProviderRows([{...row,status:'dormant',title:'completed'}]);
  expect(store.sessions.get('legacy-session')?.title).toBe('fresh SSE');expect(store.sessions.get(row.sessionId)?.status).toBe('dormant');
  store.replaceProviderRows([],[]);expect(store.sessions.has(row.sessionId)).toBe(false);expect(store.sessions.has('legacy-session')).toBe(true);
 });
 it('includes a configured WeCom bot in the same overview cards without a Lark app ID',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({connections:[{id:'config',label:'企微助理',connection:'connected'}]})})));
  await loadGroupsSnapshot();await loadWecomConnectionsSnapshot();const cards=buildBotCards([row]);const card=cards.find(item=>item.provider==='wecom')!;
  expect(card.providerBotId).toBe('config');expect(card.larkAppId).toBeUndefined();expect(card.sessions).toHaveLength(1);expect(cards.some(item=>item.larkAppId==='legacy')).toBe(true);
 });

});

describe('Provider history and deletion lifecycle in the real Dashboard store',()=>{
 it('does not treat an incomplete provider refresh as deletion',()=>{
  store.replaceSnapshot([row],null,undefined,{wecomSessionIds:[row.sessionId]});
  store.replaceProviderRows([]);expect(store.sessions.has(row.sessionId)).toBe(true);
 });

 it('keeps closed rows across history pages, then removes deleted sessions and removed sources without ghosts',async()=>{
  const old={...row,sessionId:'wecom:old-source:core:history',status:'closed'};
  store.replaceSnapshot([row],null,undefined,{closedCursor:'first-history',closedTotal:1,wecomSessionIds:[row.sessionId,old.sessionId]});
  store.replaceProviderRows([{...row,status:'closed'}],[row.sessionId,old.sessionId]);
  const response={ok:true,json:async()=>({sessions:[old],closedCursor:null,closedTotal:2,wecomSessionIds:[row.sessionId,old.sessionId]})};vi.stubGlobal('fetch',vi.fn(async()=>response));
  await store.loadMoreClosedSessions();expect(store.sessions.has(old.sessionId)).toBe(true);
  store.replaceProviderRows([], [row.sessionId]);
  expect(store.sessions.has(old.sessionId)).toBe(false);expect(store.sessions.has(row.sessionId)).toBe(true);
  store.replaceProviderRows([], []);expect([...store.sessions.values()].some(value=>value.provider==='wecom')).toBe(false);
 });
 it('does not resurrect a deleted native session when an older history response arrives late',async()=>{
  const old={...row,sessionId:'wecom:old:core:history',status:'closed'};
  store.replaceSnapshot([],null,undefined,{closedCursor:'next',wecomSessionIds:[old.sessionId]});
  let resolve!:(value:any)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(done=>resolve=done)));
  const pending=store.loadMoreClosedSessions();store.replaceProviderRows([],[]);
  resolve({ok:true,json:async()=>({sessions:[old],closedCursor:null,wecomSessionIds:[old.sessionId]})});await pending;expect(store.sessions.has(old.sessionId)).toBe(false);
 });
});
