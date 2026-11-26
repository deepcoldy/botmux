import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bytedcliTrustedHostLayout} from '../src/core/bytedcli-broker.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
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
