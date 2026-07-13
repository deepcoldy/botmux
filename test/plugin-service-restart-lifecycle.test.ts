import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const pluginPage = readFileSync(new URL('../src/dashboard/web/plugin-page.tsx', import.meta.url), 'utf-8');

function restartFunctionSource(): string {
  const start = cliSource.indexOf('async function cmdRestart()');
  const end = cliSource.indexOf('\n/**', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return cliSource.slice(start, end);
}

describe('plugin service restart lifecycle', () => {
  it('preserves auto services by default and always ensures them after core starts', () => {
    const source = restartFunctionSource();
    const stop = 'if (includePluginServices) await stopPluginServicesForCli(undefined, { autoOnly: true });';
    const coreStart = "runPm2(['start', cfg]);";
    const ensure = 'await reconcilePluginServicesForCli(undefined, { autoOnly: true });';

    expect(source).toContain(stop);
    expect(source).toContain(coreStart);
    expect(source).toContain(ensure);
    expect(source).not.toContain(`if (includePluginServices) ${ensure}`);
    expect(source.indexOf(stop)).toBeLessThan(source.indexOf(coreStart));
    expect(source.indexOf(coreStart)).toBeLessThan(source.indexOf(ensure));
  });

  it('explains the no-stop ensure behavior in Dashboard service metadata', () => {
    expect(pluginPage).toContain('botmux start/restart 后自动确保运行');
    expect(pluginPage).toContain('默认 restart 不先停止');
    expect(pluginPage).toContain("if (service.mode === 'auto') return '启动后确保运行'");
  });
});
