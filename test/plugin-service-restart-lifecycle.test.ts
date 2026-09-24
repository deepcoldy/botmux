import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const pluginPage = readFileSync(new URL('../src/dashboard/web/plugin-page.tsx', import.meta.url), 'utf-8');

function restartFunctionSource(): string {
  const start = cliSource.indexOf('async function cmdRestart()');
  // cmdRestart is immediately followed by the StartBotLiveResult type export.
  const end = cliSource.indexOf('\nexport type StartBotLiveResult', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return cliSource.slice(start, end);
}

describe('plugin service restart lifecycle', () => {
  it('preserves auto services by default and always ensures them after core starts', () => {
    const source = restartFunctionSource();
    const stop = 'if (includePluginServices) await stopPluginServicesForCli(undefined, { autoOnly: true });';
    // Post-pm2: the "core start" step is the supervisor restart, not a pm2 start
    // transaction. The lifecycle invariant is unchanged — auto plugin services are
    // (optionally) stopped before the core comes up, and ALWAYS reconciled after.
    const coreStart = 'restartFleet({ refreshPersistedEnv, readFailureFallback })';
    const ensure = 'await reconcilePluginServicesForCli(undefined, { autoOnly: true });';

    expect(source).toContain(stop);
    expect(source).toContain(coreStart);
    expect(source).toContain(ensure);
    expect(source).not.toContain(`if (includePluginServices) ${ensure}`);
    expect(source.indexOf(stop)).toBeLessThan(source.indexOf(coreStart));
    expect(source.indexOf(coreStart)).toBeLessThan(source.indexOf(ensure));
    // The pm2 start transaction is gone from the restart path.
    expect(source).not.toContain('runBoundedPm2StartTransaction(');
    expect(source).not.toContain("runPm2(['start', cfg]");
  });

  it('explains the no-stop ensure behavior in Dashboard service metadata', () => {
    expect(pluginPage).toContain('botmux start/restart 后自动确保运行');
    expect(pluginPage).toContain('默认 restart 不先停止');
    expect(pluginPage).toContain("if (service.mode === 'auto') return '启动后确保运行'");
  });
});
