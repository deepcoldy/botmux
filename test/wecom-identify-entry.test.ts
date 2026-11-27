/**
 * `botmux wecom identify` runs from src/cli/wecom/identify.ts without loading
 * any module of the WeCom gateway (src/im/wecom/gateway/): neither the identify
 * module itself nor the CLI's `wecom identify` dispatch evaluates one.
 *
 * Each child records the modules it resolves (helpers/resolved-modules.ts). The
 * same observer on the gateway command module, and on a `botmux wecom` form
 * that still is the gateway, does list gateway modules, so an empty list is not
 * a blind observer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readResolvedModules, resolvedModulesPrelude, runRepoSnippet } from './helpers/resolved-modules.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'wecom-identify-entry-'));
  dirs.push(home);
  return { home, output: join(home, 'resolved.json') };
}

const gatewayModules = (output: string) =>
  readResolvedModules(output).filter(item => item.includes('/src/im/wecom/gateway/'));

describe('botmux wecom identify loads no gateway module', () => {
  it('imports identify without resolving any module under im/wecom/gateway', async () => {
    const f = fixture();
    const result = await runRepoSnippet(`${resolvedModulesPrelude(f.output)}
      const identify = await import(${JSON.stringify(resolve('src/cli/wecom/identify.ts'))});
      console.log(typeof identify.runWecomIdentifyCommand);
      process.exit(0);
    `, f.home);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function');
    expect(readResolvedModules(f.output).length).toBeGreaterThan(1);
    expect(gatewayModules(f.output)).toEqual([]);
  }, 120_000);

  it('the same observer lists gateway modules for the gateway command', async () => {
    const f = fixture();
    const result = await runRepoSnippet(`${resolvedModulesPrelude(f.output)}
      await import(${JSON.stringify(resolve('src/im/wecom/gateway/command.ts'))});
      process.exit(0);
    `, f.home);
    expect(result.code, result.stderr).toBe(0);
    expect(gatewayModules(f.output).length).toBeGreaterThan(1);
  }, 120_000);

  it.each([
    { args: ['wecom', 'identify', '--help'], loadsGateway: false },
    { args: ['wecom', '--help'], loadsGateway: true },
  ])('botmux $args.0 $args.1 through the CLI entry (gateway loaded: $loadsGateway)', async ({ args, loadsGateway }) => {
    const f = fixture();
    const result = await runRepoSnippet(`${resolvedModulesPrelude(f.output)}
      process.argv = [process.argv[0], ${JSON.stringify(resolve('src/cli.ts'))}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(resolve('src/cli.ts'))});
    `, f.home);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe('');
    expect(gatewayModules(f.output).length > 0).toBe(loadsGateway);
  }, 120_000);
});
