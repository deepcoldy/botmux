import { describe, expect, it } from 'vitest';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('daemon uncaught exception policy', () => {
  it('reports the cause synchronously and exits even with a swallowing listener', () => {
    const result = spawnSyncTsEvalWithRepoImports(`
      import { installDaemonFatalErrorGuard } from './src/utils/daemon-fatal-error.js';
      process.on('uncaughtException', () => {});
      installDaemonFatalErrorGuard();
      setTimeout(() => { throw new Error('fatal-guard-probe'); }, 0);
      setTimeout(() => console.log('continued after fatal exception'), 100);
    `, { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[FATAL] uncaughtException in daemon');
    expect(result.stderr).toContain('fatal-guard-probe');
    expect(result.stdout).not.toContain('continued after fatal exception');
  });
});
