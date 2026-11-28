import { expect, it } from 'vitest';
import { once } from 'node:events';
import { spawnTsScript } from './helpers/ts-runner.js';

it.skipIf(process.platform !== 'linux').each(['installation-dependency', 'dedicated-installation', 'headless-wrapper', 'certificate'])('protects %s inputs from a real sandbox before host child execution', async mode => {
  const child = spawnTsScript('test/fixtures/bytedcli-final-integrity.ts', [mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => output += chunk);
  const [code] = await once(child, 'exit');
  expect(code, output).toBe(0);
}, 15_000);
