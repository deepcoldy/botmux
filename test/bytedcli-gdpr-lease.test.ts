import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bytedcliTrustedHostLayout } from '../src/core/bytedcli-host-layout.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it('protects the frozen GDPR machine file as credential, never executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'gdpr-lease-')); roots.push(root); const file = join(root, 'gdpr');
  vi.stubEnv('BOTMUX_BYTEDCLI_GDPR_MACHINE_FILE', file);
  const layout = bytedcliTrustedHostLayout();
  expect(layout.credentialRoots).toContain(file); expect(layout.executableReadOnlyRoots).not.toContain(file);
  expect((layout as any).gdprMachineFile).toBe(file);
});
it.each(['fresh','expired','string-expiry','public','hardlink','actor','changed'])('GDPR realm binds protected actual source and refuses unsafe %s',async mode=>{
 const {createBytedcliGdprLeaseResolver}=await import('../src/core/bytedcli-gdpr-lease.js');
 const root=mkdtempSync(join(tmpdir(),'gdpr-source-'));roots.push(root);const file=join(root,'gdpr');
 const jwt='e30.'+Buffer.from(JSON.stringify({exp:mode==='string-expiry'?String(Math.floor(Date.now()/1000)+3600):Math.floor(Date.now()/1000)+(mode==='expired'?30:3600)})).toString('base64url')+'.fixture';
 writeFileSync(file,jwt,{mode:0o600});if(mode==='public')chmodSync(file,0o644);if(mode==='hardlink')linkSync(file,join(root,'alias'));
 const resolve=createBytedcliGdprLeaseResolver(file),request:any={region:'cn',signal:new AbortController().signal,recheck:async()=>undefined};
 if(['expired','string-expiry','public','hardlink','actor'].includes(mode))await expect(resolve('gdpr',mode==='actor'?'actor':'machine',request)).rejects.toThrow();
 else {const lease=await resolve('gdpr','machine',request);expect(lease).toMatchObject({realm:'gdpr',kind:'machine',source:'machine',jwt});
  expect(await lease.stillCurrent()).toBeUndefined();
  const different=join(root,'second');writeFileSync(different,jwt,{mode:0o600});expect((await createBytedcliGdprLeaseResolver(different)('gdpr','machine',request)).accountFingerprint).not.toBe(lease.accountFingerprint);
  if(mode==='changed'){writeFileSync(file,jwt+'x');expect(await lease.stillCurrent()).toBe('region_auth_required');}
 }
});
