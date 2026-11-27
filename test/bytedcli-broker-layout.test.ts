import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from 'node:fs';
import {bytedcliMinimalEnv} from '../src/core/bytedcli-broker-process.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bytedcliTrustedHostLayout} from '../src/core/bytedcli-broker.js';
const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
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
