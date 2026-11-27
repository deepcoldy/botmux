import { expect, it } from 'vitest';
import { once } from 'node:events';
import { spawnTsScript } from './helpers/ts-runner.js';

it('bounds sequential same-ID HTTP authority waits and joins real underlying settlement', async () => {
  const child=spawnTsScript('test/fixtures/bytedcli-final-lifecycle.ts',['broker-pre-admission'],{stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>output+=chunk);
  try { const [code]=await once(child,'exit');expect(code,output).toBe(0); }
  finally { child.kill('SIGKILL'); }
},15_000);
