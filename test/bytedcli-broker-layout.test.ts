import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,closeSync,existsSync,fsyncSync,linkSync,lstatSync,mkdtempSync,mkdirSync,openSync,readFileSync,realpathSync,symlinkSync,rmSync,writeFileSync,writeSync} from 'node:fs';
import {bytedcliMinimalEnv} from '../src/core/bytedcli-broker-process.js';
import {snapshotBytedcliDbCodeCopy,snapshotBytedcliTrustedFiles} from '../src/core/bytedcli-runtime-integrity.js';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bytedcliTrustedHostLayout} from '../src/core/bytedcli-broker.js';
import {createBytedcliHostOperationPolicyReader} from '../src/core/bytedcli-host-operation-policy.js';
import {parseBytedcliBrokerConfig} from '../src/global-config.js';
const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('uses a configured dedicated CLI without admitting unrelated global hardlinks',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-dedicated-'));roots.push(root);vi.stubEnv('HOME',root);
 const global=join(root,'global/node_modules/@bytedance-dev/bytedcli/dist'),dedicated=join(root,'dedicated/node_modules/@bytedance-dev/bytedcli/dist'),bin=join(root,'bin');
 for(const dir of [global,dedicated,bin])mkdirSync(dir,{recursive:true});
 const entry=join(dedicated,'bytedcli.js');writeFileSync(entry,'reviewed code');
 writeFileSync(join(global,'bytedcli.js'),'global code');symlinkSync(join(global,'bytedcli.js'),join(bin,'bytedcli'));
 const unrelated=join(root,'global/node_modules/other-tool');mkdirSync(unrelated);writeFileSync(join(unrelated,'tool.exe'),'other tool');linkSync(join(unrelated,'tool.exe'),join(root,'external-alias'));
 vi.stubEnv('PATH',bin);
 expect(bytedcliTrustedHostLayout().runtimeStillCurrent()).toBe(false);
 const config=parseBytedcliBrokerConfig({cliEntrypoint:entry});
 const layout=bytedcliTrustedHostLayout(config);
 expect(layout.candidates).toEqual([entry]);expect(layout.runtimeStillCurrent()).toBe(true);
 writeFileSync(join(unrelated,'tool.exe'),'unrelated change');expect(layout.runtimeStillCurrent()).toBe(true);
 writeFileSync(entry,'changed reviewed code');expect(layout.runtimeStillCurrent()).toBe(false);
});
it.each(['missing','hardlink','search-root-created','alias-replaced'])('never falls back after configured CLI %s',mode=>{
 const root=mkdtempSync(join(tmpdir(),'broker-dedicated-invalid-'));roots.push(root);vi.stubEnv('HOME',root);vi.stubEnv('PATH',root);
 const dist=join(root,'install/node_modules/@bytedance-dev/bytedcli/dist');mkdirSync(dist,{recursive:true});
 const entry=join(dist,'bytedcli.js'),alias=join(root,'cli-alias');writeFileSync(entry,'reviewed');symlinkSync(entry,alias);
 if(mode==='missing')rmSync(entry);
 if(mode==='hardlink')linkSync(entry,join(root,'external-alias'));
 const config=parseBytedcliBrokerConfig({cliEntrypoint:alias});const layout=bytedcliTrustedHostLayout(config);
 if(mode==='missing'||mode==='hardlink'){expect(layout.runtimeStillCurrent()).toBe(false);return;}
 expect(layout.executableReadOnlyRoots).toContain(alias);expect(layout.runtimeStillCurrent()).toBe(true);
 if(mode==='search-root-created')mkdirSync(join(root,'install/node_modules/@bytedance-dev/bytedcli/dist/node_modules'));
 else {rmSync(alias);const next=join(root,'replacement.js');writeFileSync(next,'replacement');symlinkSync(next,alias);}
 expect(layout.runtimeStillCurrent()).toBe(false);
});
it.each(['relative/cli.js','/tmp/../cli.js','/$bunfs/root/cli.js','/','/tmp/cli\0.js',false])('rejects invalid host CLI selection %s',cliEntrypoint=>{
 expect(()=>parseBytedcliBrokerConfig({cliEntrypoint})).toThrow();
});
it.each(['home','home-parent'])('loads host operation policy when the operator uses a symlinked %s',kind=>{
 const root=mkdtempSync(join(tmpdir(),'broker-home-alias-'));roots.push(root);
 const actual=join(root,'actual'),alias=join(root,'alias');mkdirSync(actual,{mode:0o700});
 const machineHome=kind==='home'?actual:join(actual,'operator');
 if(kind==='home-parent')mkdirSync(machineHome,{mode:0o700});
 symlinkSync(actual,alias);vi.stubEnv('HOME',kind==='home'?alias:join(alias,'operator'));vi.stubEnv('PATH',root);
 const layout=bytedcliTrustedHostLayout();
 const snapshot=createBytedcliHostOperationPolicyReader(layout.privateRoot)();
 expect(snapshot.errorCode).toBeUndefined();
 expect(layout.machineHome).toBe(machineHome);
 expect(layout.privateRoot).toBe(join(machineHome,'.botmux','host-authority','bytedcli-broker'));
});
it.each(['ALL_PROXY','all_proxy'])('explicitly refuses unsupported %s host routing during frozen layout assembly',key=>{
 vi.stubEnv(key,'http://127.0.0.1:9');const layout=bytedcliTrustedHostLayout();
 expect(layout.unavailableReason).toBe('unsupported ByteCloud host proxy: '+key);expect(layout.runtimeStillCurrent()).toBe(false);
});
it('keeps the reviewed HTTP proxy allowlist identical at startup and child invocation',()=>{
 vi.stubEnv('HTTPS_PROXY','http://127.0.0.1:9');vi.stubEnv('NO_PROXY','example.test');
 const layout=bytedcliTrustedHostLayout();const env=bytedcliMinimalEnv('/tmp','/tmp','/usr/bin:/bin',layout.networkEnv);
 expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9');expect(env.NO_PROXY).toBe('example.test');
});
it.each(['target-write','alias-replace'])('invalidates frozen certificate authority after %s',mode=>{
 const root=mkdtempSync(join(tmpdir(),'broker-cert-'));roots.push(root);
 const target=join(root,'certificate'),alias=join(root,'alias');writeFileSync(target,'original');symlinkSync(target,alias);
 vi.stubEnv('PATH',root);
 vi.stubEnv('NODE_EXTRA_CA_CERTS',alias);const layout=bytedcliTrustedHostLayout();
 expect(layout.executableReadOnlyRoots).toContain(target);expect(layout.executableReadOnlyRoots).toContain(alias);
 expect(layout.runtimeStillCurrent()).toBe(true);
 if(mode==='target-write')writeFileSync(target,'replacement');
 else {rmSync(alias);const second=join(root,'second');writeFileSync(second,'second');symlinkSync(second,alias);}
 expect(layout.runtimeStillCurrent()).toBe(false);
});
it('omits absent executable mount leaves without weakening absent-root invalidation',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-absent-mounts-'));roots.push(root);vi.stubEnv('HOME',root);vi.stubEnv('PATH',root);
 const dist=join(root,'install/node_modules/@bytedance-dev/bytedcli/dist');mkdirSync(dist,{recursive:true});
 const entry=join(dist,'bytedcli.js');writeFileSync(entry,'reviewed');
 const layout=bytedcliTrustedHostLayout(parseBytedcliBrokerConfig({cliEntrypoint:entry}));
 expect(layout.executableReadOnlyRoots.length).toBeGreaterThan(0);
 expect(layout.executableReadOnlyRoots.every(path=>existsSync(path))).toBe(true);
 expect(layout.executableReadOnlyRoots).not.toContain(realpathSync(root));
 const missingDb=join(root,'.local/share/bytedcli/dependency/db/node_modules/@bytedance-dev/db-cli/bin/db-cli-linux-amd64');
 expect(existsSync(missingDb)).toBe(false);expect(layout.executableReadOnlyRoots).not.toContain(missingDb);
 const absentSearchRoot=join(dist,'node_modules');expect(layout.executableReadOnlyRoots).not.toContain(absentSearchRoot);
 expect(layout.runtimeStillCurrent()).toBe(true);mkdirSync(absentSearchRoot);expect(layout.runtimeStillCurrent()).toBe(false);
});
it('protects canonical future/profile paths reached through a lexical alias',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-layout-'));roots.push(root);const actual=join(root,'actual'),alias=join(root,'alias');mkdirSync(actual);symlinkSync(actual,alias);
 const layout=bytedcliTrustedHostLayout({protectedRoots:[join(alias,'future','profile')]});
 expect(layout.credentialRoots).toContain(join(alias,'future','profile'));expect(layout.credentialRoots).toContain(join(actual,'future','profile'));
 expect(layout.executableReadOnlyRoots).not.toContain(join(actual,'future','profile'));
});
it('rejects invalid machine profile and non-filesystem protected roots before executor assembly',()=>{
 expect(()=>bytedcliTrustedHostLayout({machineProfile:'../escape'})).toThrow();
 expect(()=>bytedcliTrustedHostLayout({protectedRoots:['https://caller.invalid']})).toThrow();
});
it('freezes only the preinstalled DB binary and rejects replacement without reading credential trees',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-db-runtime-'));roots.push(root);const binary=join(root,'db-cli');writeFileSync(binary,'fixture binary');chmodSync(binary,0o700);
 vi.stubEnv('DB_CLI_BINARY',binary);const layout=bytedcliTrustedHostLayout();
 expect(layout.dbRuntime?.executable).toBe(binary);expect(layout.dbRuntime?.stillCurrent()).toBe(true);
 expect(layout.executableReadOnlyRoots).toContain(binary);expect(layout.dbRuntime?.protectedPaths).not.toContain(root);
 writeFileSync(binary,'changed fixture binary');expect(layout.dbRuntime?.stillCurrent()).toBe(false);
});
it('copies a hardlinked DB binary into private independent code and invalidates both source aliases and copy',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-db-linked-'));roots.push(root);vi.stubEnv('HOME',root);
 const binary=join(root,'db-cli'),alias=join(root,'package-cache-alias');writeFileSync(binary,'trusted fixture binary');chmodSync(binary,0o700);linkSync(binary,alias);
 vi.stubEnv('DB_CLI_BINARY',binary);
 expect(()=>snapshotBytedcliTrustedFiles([binary])).toThrow();
 const layout=bytedcliTrustedHostLayout(),runtime=layout.dbRuntime;
 expect(runtime).toBeDefined();expect(runtime!.executable).not.toBe(binary);
 expect(readFileSync(runtime!.executable,'utf8')).toBe('trusted fixture binary');expect(lstatSync(runtime!.executable).nlink).toBe(1);
 expect(lstatSync(runtime!.executable).mode&0o777).toBe(0o500);expect(runtime!.stillCurrent()).toBe(true);
 expect(layout.executableReadOnlyRoots).toContain(binary);expect(layout.executableReadOnlyRoots).toContain(runtime!.executable);
 writeFileSync(alias,'changed through package cache');expect(runtime!.stillCurrent()).toBe(false);
 const next=bytedcliTrustedHostLayout().dbRuntime;expect(next?.stillCurrent()).toBe(true);
 chmodSync(next!.executable,0o700);writeFileSync(next!.executable,'changed private code');expect(next!.stillCurrent()).toBe(false);
});
it.each(['partial-final','linked-final','partial-pending','recoverable-linked-final','external-linked-final'])('handles interrupted DB code cache publication: %s',mode=>{
 const root=mkdtempSync(join(tmpdir(),'broker-db-publish-'));roots.push(root);vi.stubEnv('HOME',root);
 const binary=join(root,'db-cli'),alias=join(root,'package-cache-alias'),code='complete reviewed fixture code';
 writeFileSync(binary,code,{mode:0o700});linkSync(binary,alias);vi.stubEnv('DB_CLI_BINARY',binary);
 const cache=join(root,'.botmux','host-authority','bytedcli-broker','db-code');mkdirSync(cache,{recursive:true,mode:0o700});
 const hash=createHash('sha256').update(code).digest('hex'),target=join(cache,`db-cli-${hash}`),pending=join(cache,['recoverable-linked-final','external-linked-final'].includes(mode)?`.pending-${randomUUID()}`:'.pending-abandoned');
 if(mode==='partial-final')writeFileSync(target,'partial',{mode:0o500});
 else if(mode.endsWith('linked-final')){const fd=openSync(pending,'wx',0o500);writeFileSync(fd,code);fsyncSync(fd);closeSync(fd);linkSync(pending,target);}
 else writeFileSync(pending,'partial',{mode:0o500});
 if(mode==='external-linked-final')linkSync(target,join(root,'unproven-external-alias'));
 const runtime=bytedcliTrustedHostLayout().dbRuntime;
 if(mode==='partial-pending'||mode==='recoverable-linked-final'){
  expect(runtime?.stillCurrent()).toBe(true);
  if(mode==='recoverable-linked-final'){expect(existsSync(pending)).toBe(false);expect(lstatSync(target).nlink).toBe(1);expect(bytedcliTrustedHostLayout().dbRuntime?.executable).toBe(target);expect(runtime?.stillCurrent()).toBe(true);}
 }
 else {expect(runtime).toBeUndefined();expect(readFileSync(target,'utf8')).toBe(mode==='partial-final'?'partial':code);}
 if(mode==='external-linked-final')expect(existsSync(pending)).toBe(true);
 expect(readFileSync(binary,'utf8')).toBe(code);
});
it('never publishes a DB executable when copying fails after a partial write',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-db-short-write-'));roots.push(root);vi.stubEnv('HOME',root);
 const binary=join(root,'db-cli'),code='complete reviewed executable';writeFileSync(binary,code,{mode:0o700});linkSync(binary,join(root,'cache-alias'));vi.stubEnv('DB_CLI_BINARY',binary);
 const cache=join(root,'.botmux','host-authority','bytedcli-broker','db-code');
 const target=join(cache,`db-cli-${createHash('sha256').update(code).digest('hex')}`);
 expect(()=>snapshotBytedcliDbCodeCopy(binary,cache,fd=>{writeSync(fd,'partial');throw new Error('simulated copy interruption');})).toThrow('simulated copy interruption');
 expect(existsSync(target)).toBe(false);
 expect(bytedcliTrustedHostLayout().dbRuntime?.stillCurrent()).toBe(true);expect(readFileSync(target,'utf8')).toBe(code);
});
