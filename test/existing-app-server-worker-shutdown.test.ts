import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('existing App Server shared-adopt worker shutdown', () => {
  it('preserves only the BotMux remote TUI when its parent daemon exits', () => {
    const start = source.indexOf('function shutdownWorkerForParentExit(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(start, source.indexOf("\nprocess.on('SIGTERM'", start));

    expect(body).toContain('lastInitConfig?.existingAppServerEndpoint');
    expect(body).toContain('Preserving existing-App-Server remote TUI');
    expect(body).toContain('cleanup();');
    expect(body).toContain('process.exit(0);');
    // The guarded branch returns before the ordinary killCli teardown, keeping
    // the bmx-* remote client for the replacement daemon to reattach.
    expect(body).toMatch(/existingAppServerEndpoint[\s\S]*?cleanup\(\);[\s\S]*?process\.exit\(0\);[\s\S]*?return;[\s\S]*?killCli\(\);/);
  });

  it('routes SIGTERM, IPC disconnect, and parent-watchdog exit through the shared guard', () => {
    expect(source).toContain("process.on('SIGTERM', () => shutdownWorkerForParentExit('SIGTERM'));");
    expect(source).toContain("shutdownWorkerForParentExit('IPC disconnect')");
    expect(source).toContain("shutdownWorkerForParentExit('parent watchdog')");
  });
});
