import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const PROJECT_ROOT = join(__dirname, '..');

let home: string;

function runCli(args: string[]) {
  return spawnSyncTsScript(CLI_PATH, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: join(home, '.botmux', 'data'),
      BOTS_CONFIG: join(home, '.botmux', 'bots.json'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('worker-budget CLI', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-worker-budget-cli-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('sets, reports, and clears explicit memory admission disablement', () => {
    const set = runCli(['worker-budget', 'set', '--memory-admission-enabled', 'false']);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('"memoryAdmissionEnabled": false');
    expect(JSON.parse(readFileSync(join(home, '.botmux', 'config.json'), 'utf8')).worker).toEqual({
      memoryAdmissionEnabled: false,
    });

    const status = runCli(['worker-budget', 'status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('memory admission: disabled (config)');
    expect(status.stdout).toContain('effective total memory:');
    expect(status.stdout).toMatch(/available memory: .*\((host|cgroup-v2|cgroup-v1|unavailable)\)/);
    expect(status.stdout).toMatch(/memory full PSI avg10: .*\((host|cgroup-v2|cgroup-v1|unavailable)\)/);
    expect(status.stdout).toContain('admission: disabled');

    const unset = runCli(['worker-budget', 'unset']);
    expect(unset.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, '.botmux', 'config.json'), 'utf8'))).not.toHaveProperty('worker');
  });

  it('rejects invalid boolean values without writing config', () => {
    const result = runCli(['worker-budget', 'set', '--memory-admission-enabled', 'no']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--memory-admission-enabled must be true or false');
  });

  // Split each invalid-argument CLI cold start into its own test case so 7 sequential
  // `tsx src/cli.ts` launches (~2.8-3.3s each on CI) never stack inside one 30s timeout.
  it.each([
    ['unknown set flag', ['worker-budget', 'set', '--memory-admission-enabled', 'false', '--unknown', '1']],
    ['duplicate set flag', ['worker-budget', 'set', '--min-available-mib', '1', '--min-available-mib', '2']],
    ['missing flag value', ['worker-budget', 'set', '--memory-admission-enabled']],
    ['overflow MiB value', ['worker-budget', 'set', '--min-available-mib', '1e300']],
    ['sub-byte MiB value', ['worker-budget', 'set', '--session-memory-max-mib', '0.0000001']],
    ['trailing status arg', ['worker-budget', 'status', '--unknown']],
    ['trailing unset arg', ['worker-budget', 'unset', '--unknown']],
  ])('rejects invalid arguments (%s)', (_label, args) => {
    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(existsSync(join(home, '.botmux', 'config.json'))).toBe(false);
  });
});
