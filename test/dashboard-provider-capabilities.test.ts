import {describe,it,expect} from 'vitest';
import {isWecomSource,providerBotKey,sessionSupports} from '../src/dashboard/web/providers/registry.js';
import {sessionTerminalHref} from '../src/dashboard/web/session-terminal.js';
import {filterSessionRows,canRestartSession,sessionLocationText} from '../src/dashboard/web/sessions.js';
import {t} from '../src/dashboard/web/ui.js';

describe('Dashboard provider-aware session behavior',()=>{
 it('keeps legacy capabilities while new provider operations require explicit server evidence',()=>{
  expect(sessionSupports({sessionId:'legacy'} as any,'history')).toBe(true);
  expect(sessionSupports({provider:'wecom'},'history')).toBe(false);
  expect(sessionSupports({provider:'wecom',capabilities:{history:true}},'history')).toBe(true);
  expect(sessionSupports({provider:'wecom',capabilities:{history:'true'}},'history')).toBe(false);
  expect(canRestartSession({provider:'wecom',status:'working',cliId:'codex',capabilities:{restart:false}})).toBe(false);
  expect(canRestartSession({provider:'wecom',status:'working',cliId:'codex',capabilities:{restart:true}})).toBe(true);
 });
 it('honors explicit capability decisions for every provider and only defaults legacy payloads',()=>{
  for(const provider of [undefined,'lark','feishu','wecom','other']){
   expect(sessionSupports({provider,capabilities:{history:false}},'history')).toBe(false);
   expect(sessionSupports({provider,capabilities:{history:true}},'history')).toBe(true);
  }
  expect(sessionSupports({provider:'other'},'history')).toBe(false);
  expect(sessionSupports({provider:'lark'},'history')).toBe(true);
 });
 it('filters each provider by its source-bound bot key without needing a fake Lark app ID',()=>{
  const wecom={provider:'wecom',providerBotId:'connection',sessionId:'wecom:source-a:sid',status:'working',chatType:'single',chatDisplayName:'私聊'},lark={sessionId:'legacy',status:'working',larkAppId:'connection'};
  expect(providerBotKey(wecom)).not.toBe(providerBotKey(lark));expect(isWecomSource(wecom)).toBe(true);
  const filters={q:'',status:'',adopt:'',bot:providerBotKey(wecom),chat:'',cli:'',showUnknownChats:true};
  expect(filterSessionRows([wecom,lark],filters,{keepClosed:false})).toEqual([wecom]);
  expect(sessionLocationText(wecom)).toContain(t('provider.wecom'));expect(sessionLocationText(wecom)).toContain(t('sessions.wecomDirectChat'));
 });
 it('only exposes a same-origin controlled terminal when the provider advertises it',()=>{
  const loc={origin:'https://dashboard.example',protocol:'https:',hostname:'dashboard.example'};
  const row={provider:'wecom',sessionId:'source:sid',webPort:54321,proxyPort:7891,terminalUrl:'http://127.0.0.1:54321',capabilities:{terminal:true}};
  expect(sessionTerminalHref(row,loc)).toBeNull();
  expect(sessionTerminalHref({...row,terminalUrl:'//foreign.example/s/sid'},loc)).toBeNull();
  expect(sessionTerminalHref({...row,terminalUrl:'/wecom-terminal/source/',capabilities:{}},loc)).toBeNull();
  expect(sessionTerminalHref({...row,terminalUrl:'/wecom-terminal/source/'},loc)).toBe('https://dashboard.example/wecom-terminal/source/');
 });
});
