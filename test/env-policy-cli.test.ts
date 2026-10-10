import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvPolicyArgs } from '../src/cli/env-policy.js';
import { inheritBotEnv } from '../src/core/env-policy.js';
import { spawnTsScript } from './helpers/ts-runner.js';

it('parses strict, get and unset commands and never echoes malformed input', () => {
  expect(parseEnvPolicyArgs(['set', '{"mode":"strict","inherit":["HTTPS_PROXY"]}', '--bot', 'probe'])).toEqual({ action: 'set', policy: { mode: 'strict', inherit: ['HTTPS_PROXY'] }, bot: 'probe' });
  expect(parseEnvPolicyArgs(['get'])).toEqual({ action: 'get', bot: undefined });
  expect(parseEnvPolicyArgs(['unset', '--bot', 'probe'])).toEqual({ action: 'unset', bot: 'probe' });
  let error = '';
  try { parseEnvPolicyArgs(['set', '{"mode":"strict","inherit":["SECRET=value-sentinel"]}']); } catch (e) { error = String(e); }
  expect(Boolean(error)).toBe(true);
  expect(error.includes('sentinel')).toBe(false);
});

describe('env-policy standalone CLI isolated file round-trip', () => {
  it('sets, reads and unsets the selected bot without changing sibling env or exposing values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-policy-cli-'));
    const path = join(dir, 'bots.json');
    const env = { ...inheritBotEnv(process.env, { mode: 'strict' }), HOME: dir, BOTS_CONFIG: path, SESSION_DATA_DIR: join(dir, 'data'), BOTMUX_NO_CLAIM: '1' };
    writeFileSync(path, JSON.stringify([
      { larkAppId: 'app_probe', larkAppSecret: '', apiOnly: true, name: 'probe', cliId: 'codex', env: { OPENAI_API_KEY: 'private-sentinel' } },
      { larkAppId: 'app_sibling', larkAppSecret: '', apiOnly: true, cliId: 'claude-code' },
    ]));
    async function run(args: string[]) {
      const child = spawnTsScript('src/cli.ts', ['env-policy', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout?.on('data', c => output += c); child.stderr?.on('data', c => output += c);
      const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
      expect(output.includes('private-sentinel')).toBe(false);
      expect(code).toBe(0);
      return output;
    }
    try {
      await run(['set', '{"mode":"strict","inherit":["HTTPS_PROXY"]}', '--bot', 'probe']);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved[0].envPolicy).toEqual({ mode: 'strict', inherit: ['HTTPS_PROXY'] });
      expect(saved[0].env.OPENAI_API_KEY === 'private-sentinel').toBe(true);
      expect(saved[1].envPolicy).toBeUndefined();
      const result = await run(['get', '--bot', 'probe']);
      expect(result.includes('"mode":"strict"')).toBe(true);
      await run(['unset', '--bot', 'probe']);
      expect(JSON.parse(readFileSync(path, 'utf8'))[0].envPolicy).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
