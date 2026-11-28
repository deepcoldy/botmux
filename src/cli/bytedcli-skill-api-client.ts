import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
/** Routing hint conveys zero execution authority and is emitted by the frozen
 * strict wrapper even if the daemon is temporarily unavailable. */
export function hasManagedSkillApi(run: typeof spawnSync = spawnSync): boolean {
  const result = run('bytedcli', ['--botmux-skill-api-contract'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 && String(result.stdout).trim() === 'botmux.skill-api.v1';
}
export function callManagedSkillApi(operationId: string, request: unknown, run: typeof spawnSync = spawnSync): unknown {
  const body=JSON.stringify(request);
  if(Buffer.byteLength(body)>2*1024*1024)throw new Error('Managed request exceeds 2 MiB input limit');
  const root=Buffer.byteLength(body)>48000?mkdtempSync(join(tmpdir(),'managed-skill-')):undefined;
  try {
  const file=root&&join(root,'request.json');if(file)writeFileSync(file,body,{mode:0o600});
  const result = run('bytedcli', ['--json', 'skill-api', operationId, ...(file?['--body-file',file]:['--request',body])], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let payload: any; try { payload = JSON.parse(String(result.stdout)); } catch { /* fixed error, never echo raw output */ }
  if (result.status !== 0 || payload?.status !== 'success') throw new Error('Managed Skill API failed; no credential-export fallback or automatic retry');
  return payload.data;
  } finally {if(root)rmSync(root,{recursive:true,force:true});}
}
