import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { startWecomManagedCore } from '../src/im/wecom/gateway/managed-core.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); await releaseWecomCorePorts(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-profile-')); roots.push(root);
  const file = join(root, 'config.json');
  const config = { botId: 'native-fixture', secretEnv: 'WECOM_SECRET', coreUrl: 'http://127.0.0.1:19441', allowedUsers: ['alice'],
    managedCore: { botId: 'local_profile', cli: 'codex', backend: 'pty' as const, workingDirectory: root, stateDir: join(root,'core'), port: 19441 } };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { root, file, config, service: new WecomDashboardConfig(root), id: wecomConfigId(file) };
}
describe('WeCom transport-neutral bot configuration', () => {
  it('merges field-scoped saves, explicitly clears optional fields and rejects stale revisions', async () => {
    const f = fixture(), first = f.service.get(f.id);
    const saved = await f.service.patch(f.id, { revision: first.revision, botConfig: { env: { MODEL_TOKEN:'fake' }, maxLiveWorkers: 3, sandbox: true } });
    await expect(f.service.patch(f.id,{ revision:first.revision, botConfig:{ sandbox:false } })).rejects.toThrow('wecom_configuration_changed');
    await f.service.patch(f.id, { revision: saved.config.revision, botConfig: { maxLiveWorkers: null, idleSuspendMinutes: 7 } });
    expect(f.service.get(f.id)).toMatchObject({ botConfig: { env: {MODEL_TOKEN:'fake'}, sandbox:true, idleSuspendMinutes:7 } });
    expect(f.service.get(f.id).botConfig).not.toHaveProperty('maxLiveWorkers');
    expect(JSON.parse(readFileSync(f.file,'utf8'))).toMatchObject({ botId:f.config.botId, allowedUsers:['alice'], secretEnv:'WECOM_SECRET' });
  });
  it.each([
    JSON.parse('{"__proto__":{"apiOnly":false}}'), JSON.parse('{"constructor":{}}'), { larkAppId:'cli_foreign' }, { larkAppSecret:'fake' }, { apiOnly:false }, { ownerOpenId:'ou_foreign' },
    { allowedUsers:['outsider'] }, { env:{ BOTMUX_OWNER_OPEN_ID:'ou_foreign' } }, { env:{ __OWNER_OPEN_ID:'ou_foreign' } },
    { env:{ WECOM_BOT_SECRET:'fake' } }, { envPolicy:{ mode:'strict',inherit:['BOTMUX_DAEMON_PORT'] } },
    { sandbox:'oops' }, { sandboxPaths:{ deny:'typo' } }, { promptCache:{ ttl:'nonsense' } },
    { maxLiveWorkers:0 }, { turnTimeoutMs:2147483648 }, { serviceTier:'invalid' },
  ])('rejects unsafe profile %j without changing the committed config', async profile => {
    const f = fixture(), before = readFileSync(f.file,'utf8');
    // envPolicy / promptCache go through the shared bot-config validator, which names the field it refused.
    const refusal = 'envPolicy' in profile ? /envPolicy\.inherit/ : 'promptCache' in profile ? /promptCache\.ttl/ : 'invalid_core_bot_profile';
    await expect(f.service.patch(f.id,{ revision:f.service.get(f.id).revision,botConfig:profile })).rejects.toThrow(refusal);
    expect(readFileSync(f.file,'utf8')).toBe(before);
  });
  it.each(['codex','claude-code'])('carries saved %s config into the real core registry, launch freeze and session environment', async cli => {
    const f = fixture(), port = await reserveWecomCorePort();
    const output = join(f.root,'probe.json');
    const botConfig = { wrapperCli: 'fixture-wrapper', launchShell:'bash', reasoningEffort:'high', startupCommands:['/model fixture'],
      env:{ MODEL_TOKEN:'fake-token' }, envPolicy:{mode:'strict'}, sandbox:true, sandboxPaths:{ deny:['/private-fixture'] },
      maxLiveWorkers:2, idleSuspendMinutes:3, archiveCodex:true, promptCache:{ttl:'5m'},
      ...(cli === 'codex' ? { serviceTier:'priority' } : { cliConfigDir:join(f.root,'claude-profile') }) };
    await f.service.patch(f.id,{ revision:f.service.get(f.id).revision, cli, model:cli==='codex'?'gpt-5.4':'opus', botConfig });
    const saved = JSON.parse(readFileSync(f.file,'utf8'));
    const source = `
      const registry = await import(${JSON.stringify(resolve('src/bot-registry.ts'))});
      const pool = await import(${JSON.stringify(resolve('src/core/worker-pool.ts'))});
      const store = await import(${JSON.stringify(resolve('src/services/session-store.ts'))});
      const envPolicy = await import(${JSON.stringify(resolve('src/core/env-policy.ts'))});
      const fs = await import('node:fs');
      const bot = registry.loadBotConfigs()[0]; registry.registerBot(bot,0);
      const readyPort = process.env.BOTMUX_API_PORT;
      const workerEnv = envPolicy.buildBotWorkerEnv(process.env,bot.envPolicy);
      process.env = workerEnv;
      const workerBot = registry.loadBotConfigs()[0];
      store.init(bot.larkAppId);
      const session = store.createSession('http_profile','profile','profile','group'); session.cliId=bot.cliId; session.larkAppId=bot.larkAppId;
      const ds = { session,larkAppId:bot.larkAppId,chatId:'http_profile',workingDir:process.cwd() };
      const launch = pool.__testOnly_sessionAgentConfig(ds,bot); pool.freezeSessionSandboxDecision(ds,bot);
      const childEnv = {...envPolicy.buildSessionChildEnv({...workerEnv,PATH:'/fixture',SENSITIVE_PARENT:'no'},bot.envPolicy),...envPolicy.botInjectedEnv(bot.env,bot.envPolicy)};
      fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({bot,workerBot,launch,session,childEnv}));
      console.log('[core-only] listening on 127.0.0.1:'+readyPort+' (bot '+bot.larkAppId+', cli '+bot.cliId+')');setInterval(()=>{},1000);
    `;
    let childErrors = '';
    const handle = await startWecomManagedCore({ ...saved, managedCore:{ ...saved.managedCore,port } }, {
      spawn:(_command,_args,options)=>{ const child=spawnTsEvalWithRepoImports(source,{...options,cwd:resolve('.')}); child.stderr?.on('data', data=>childErrors+=String(data)); return child; },
      startupTimeoutMs:10000,shutdownTimeoutMs:500,
      env:{...process.env,WECOM_SECRET:'fake-gateway-secret',BOTMUX_OWNER_OPEN_ID:'ou_parent',BOTS_CONFIG:'/foreign/fleet'},
    }).catch(error=>{ throw new Error(String(error)+' '+childErrors); });
    try {
      const result = JSON.parse(readFileSync(output,'utf8'));
      expect(result.bot).toMatchObject({ apiOnly:true,larkAppId:'local_profile',cliId:cli,maxLiveWorkers:2,idleSuspendMinutes:3,promptCache:{ttl:'5m'} });
      expect(result.bot.larkAppSecret).toBe('');
      expect(result.workerBot).toMatchObject({larkAppId:'local_profile',cliId:cli,env:{MODEL_TOKEN:'fake-token'},envPolicy:{mode:'strict'},maxLiveWorkers:2});
      expect(result.launch).toMatchObject({ cliId:cli,wrapperCli:'fixture-wrapper',reasoningEffort:'high',startupCommands:['/model fixture'],launchShell:'bash' });
      expect(result.session).toMatchObject({sandbox:true,sandboxPaths:{deny:['/private-fixture']}});
      expect(result.childEnv).toMatchObject({MODEL_TOKEN:'fake-token'}); expect(result.childEnv).not.toHaveProperty('SENSITIVE_PARENT');
      expect(result.childEnv).not.toHaveProperty('BOTMUX_OWNER_OPEN_ID');
      expect(result.childEnv).not.toHaveProperty('BOTMUX_CORE_BOT_CONFIG');
      if(cli==='codex') expect(result.launch.serviceTier).toBe('priority');
      else expect(result.launch.cliConfigDir).toBe(join(f.root,'claude-profile'));
    } finally { await handle.stop(); }
  });
});

describe('WeCom profile canonical writes',()=>{
 it('creates and clears the legacy executable shadow when the shared editor saves a structured runtime',async()=>{
  const f=fixture(),runtime={id:'fixture-runtime',executable:'/fixture/runtime'};
  await f.service.patch(f.id,{revision:f.service.get(f.id).revision,botConfig:{cliRuntime:runtime}});
  expect(f.service.get(f.id).botConfig).toMatchObject({cliRuntime:runtime,cliPathOverride:runtime.executable});
  await f.service.patch(f.id,{revision:f.service.get(f.id).revision,botConfig:{cliRuntime:null}});
  expect(f.service.get(f.id).botConfig).not.toHaveProperty('cliPathOverride');
 });

 it('stores the worker-normalized representation and drops CLI-specific values that do not apply to the selected CLI',async()=>{
  const f=fixture();
  await f.service.patch(f.id,{revision:f.service.get(f.id).revision,cli:'claude-code',model:'opus',botConfig:{sandbox:'oncall',startupCommands:[' model opus ','/model opus'],serviceTier:'priority',dshRuntime:'tui'}});
  expect(f.service.get(f.id).botConfig).toMatchObject({sandbox:true,startupCommands:['/model opus']});
  expect(f.service.get(f.id).botConfig).not.toHaveProperty('serviceTier');expect(f.service.get(f.id).botConfig).not.toHaveProperty('dshRuntime');
  expect(JSON.parse(readFileSync(f.file,'utf8')).managedCore.botConfig).toMatchObject({sandbox:true,startupCommands:['/model opus']});
 });
 it.each(['pty','tmux','herdr','zellij','zmx','riff','mojo','remote-runner','orca'])('persists backend %s without altering a platform identity',async backend=>{
  const f=fixture();await f.service.patch(f.id,{revision:f.service.get(f.id).revision,backend});
  expect(f.service.get(f.id).backend).toBe(backend);expect(JSON.parse(readFileSync(f.file,'utf8')).botId).toBe(f.config.botId);
 });
});

describe('hidden reply-card buttons through the Dashboard save',()=>{
 it('saves hiding the read-only terminal and the write link, and reads both back',async()=>{
  const f=fixture();
  await f.service.patch(f.id,{revision:f.service.get(f.id).revision,botConfig:{hiddenStreamingCardButtons:['terminal','writeLink']}});
  expect(f.service.get(f.id).botConfig).toMatchObject({hiddenStreamingCardButtons:['terminal','writeLink']});
  expect(JSON.parse(readFileSync(f.file,'utf8')).message).toEqual({hiddenStreamingCardButtons:['terminal','writeLink']});
  const before=readFileSync(f.file,'utf8');
  await expect(f.service.patch(f.id,{revision:f.service.get(f.id).revision,botConfig:{hiddenStreamingCardButtons:['terminal','not-a-button']}})).rejects.toThrow('invalid_wecom_hidden_buttons');
  expect(readFileSync(f.file,'utf8')).toBe(before);
 });
 it('loads a file that still hides the retired reply-draft button, and the next save does not write it back',async()=>{
  const f=fixture();
  writeFileSync(f.file,JSON.stringify({...f.config,message:{hiddenStreamingCardButtons:['substitute','stop']}}),{mode:0o600});
  expect(f.service.get(f.id).botConfig).toMatchObject({hiddenStreamingCardButtons:['stop']});
  await f.service.patch(f.id,{revision:f.service.get(f.id).revision,displayName:'Renamed'});
  expect(JSON.parse(readFileSync(f.file,'utf8')).message).toEqual({hiddenStreamingCardButtons:['stop']});
 });
});
