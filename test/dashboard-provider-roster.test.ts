import {describe,it,expect,vi} from 'vitest';
import {publishProviderRoster,providerRosterSnapshot,providerNavigationItems} from '../src/dashboard/web/provider-roster.js';
import {buildBotDefaultsTabItems,buildBotDefaultsSectionItems,buildActionItems} from '../src/dashboard/web/command-palette-sources.js';
import {ui} from '../src/dashboard/web/ui.js';
import {requestOpenCreateSession,consumePendingCreateSession} from '../src/dashboard/web/create-session-entry.js';
describe('complete provider roster gates unsupported Lark workflows',()=>{
 it('keeps unknown/mixed legacy entries and hides only Lark-specific creation/groups for proven WeCom-only rosters',()=>{
  const entries=[{id:'groups'},{id:'monitoring'},{id:'sessions'},{id:'bot-defaults'}];
  expect(providerNavigationItems(entries,{loaded:false,wecomKnown:true,hasLarkBots:false,hasWecomBots:true,onlyWecom:false})).toEqual(entries);
  publishProviderRoster('lark',0);publishProviderRoster('wecom',1);expect(providerRosterSnapshot()).toMatchObject({loaded:true,onlyWecom:true});expect(providerNavigationItems(entries).map(item=>item.id)).toEqual(['monitoring','sessions','bot-defaults']);
  publishProviderRoster('lark',1);expect(providerRosterSnapshot().onlyWecom).toBe(false);expect(providerNavigationItems(entries)).toEqual(entries);
 });
 it('indexes only rendered common bot configuration tabs, sections and fields in a pure WeCom deployment',()=>{
  const previous=ui.authed;ui.authed=true;try{publishProviderRoster('lark',0);publishProviderRoster('wecom',1);
   expect(buildBotDefaultsTabItems().map(item=>item.primary.href)).toEqual(['#/bot-defaults?tab=common','#/bot-defaults?tab=sessions','#/bot-defaults?tab=security','#/bot-defaults?tab=cards','#/bot-defaults?tab=advanced']);
   const items=buildBotDefaultsSectionItems();expect(items.filter(item=>!new URL(item.primary.href!,'http://localhost').hash.includes('field=')).map(item=>new URLSearchParams(item.primary.href!.split('?')[1]).get('section'))).toEqual(expect.arrayContaining(['agent','working-dir','role','session-mode','command-trigger','sandbox','card-behavior','backend','runtime-env']));expect(items.some(item=>item.primary.href?.includes('section=steward'))).toBe(false);
   expect(items.some(item=>item.primary.href?.includes('field=botDefaults.agentCli'))).toBe(true);expect(items.some(item=>item.primary.href?.includes('field=botDefaults.agentModel'))).toBe(true);expect(items.some(item=>item.primary.href?.includes('field=botDefaults.autoWorktree'))).toBe(true);
  }finally{ui.authed=previous;publishProviderRoster('lark',1);}
 });
 it('uses the same capability decision for palette items and the global creation entry',()=>{
  const previous=ui.authed;ui.authed=true;const open=vi.fn();const window={dispatchEvent:vi.fn(),location:{hash:'#/overview'}};vi.stubGlobal('window',window);
  try{
   publishProviderRoster('lark',0);publishProviderRoster('wecom',1);
   expect(buildActionItems({openCreateSession:open,openCreateBot:open,larkCreateSupported:!providerRosterSnapshot().onlyWecom}).filter(item=>item.key.startsWith('action:create-')).map(item=>item.key)).toEqual(['action:create-bot']);requestOpenCreateSession();expect(window.dispatchEvent).not.toHaveBeenCalled();expect(consumePendingCreateSession()).toBe(false);
   publishProviderRoster('lark',1);expect(buildActionItems({openCreateSession:open,openCreateBot:open,larkCreateSupported:true}).filter(item=>item.key.startsWith('action:create-'))).toHaveLength(2);requestOpenCreateSession();expect(window.dispatchEvent).toHaveBeenCalledTimes(1);expect(consumePendingCreateSession()).toBe(true);
  }finally{ui.authed=previous;vi.unstubAllGlobals();}
 });
});
