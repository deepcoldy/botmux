import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS,
  buildCliRuntimeUpdateCard,
  cliRuntimeUpdateStorePathIn,
  probeCodexRuntimeUpdate,
  readCliRuntimeUpdateStoreFrom,
  runCliRuntimeUpdateAudit,
  selectCodexRuntimeUpdateTargets,
  writeCliRuntimeUpdateStoreTo,
  type CliRuntimeUpdateStore,
} from '../src/core/cli-runtime-update.js';

describe('selectCodexRuntimeUpdateTargets', () => {
  it('covers every bot config, including wrappers, while excluding other CLIs and duplicates', () => {
    const resolve = vi.fn((override?: string) => override ?? '/usr/bin/codex');
    expect(selectCodexRuntimeUpdateTargets([
      { cliId: 'codex' },
      { cliId: 'codex-app', cliPathOverride: '/opt/codex' },
      { cliId: 'codex', cliPathOverride: '/opt/codex' },
      { cliId: 'codex', wrapperCli: 'npx -y @openai/codex' },
      { cliId: 'claude' },
    ], resolve)).toEqual([
      { cliId: 'codex', binPath: '/usr/bin/codex' },
      { cliId: 'codex', binPath: '/opt/codex' },
    ]);
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it('keeps valid runtimes when another configured path cannot resolve', () => {
    expect(selectCodexRuntimeUpdateTargets([
      { cliId: 'codex', cliPathOverride: '/missing/codex' },
      { cliId: 'codex', cliPathOverride: '/good/codex' },
    ], (override) => {
      if (override === '/missing/codex') throw new Error('missing');
      return override!;
    })).toEqual([{ cliId: 'codex', binPath: '/good/codex' }]);
  });
});

describe('probeCodexRuntimeUpdate', () => {
  it('uses structured doctor data for version, provenance, and update command', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'codex-cli 0.144.1';
      return JSON.stringify({
        codexVersion: '0.144.1',
        checks: {
          updates: {
            id: 'updates.status',
            details: {
              'latest version': '0.144.3',
              'cached latest version': '0.144.2',
              'update action': 'npm install -g @openai/codex',
              'npm update target': '/opt/npm/@openai/codex',
            },
          },
        },
      });
    });
    const fetchLatest = vi.fn(async () => '9.9.9');

    await expect(probeCodexRuntimeUpdate(
      { cliId: 'codex', binPath: '/usr/bin/codex' },
      { runFile, fetchLatest },
    )).resolves.toEqual({
      current: '0.144.1',
      latest: '0.144.3',
      updateCommand: 'npm install -g @openai/codex',
      installTarget: '/opt/npm/@openai/codex',
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('falls back to the registry when an older Codex has no JSON doctor', async () => {
    const runFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === '--version') return 'codex-cli 0.120.0';
      throw new Error('unexpected argument --json');
    });

    await expect(probeCodexRuntimeUpdate(
      { cliId: 'codex', binPath: 'codex' },
      { runFile, fetchLatest: async () => '0.144.3' },
    )).resolves.toEqual({
      current: '0.120.0',
      latest: '0.144.3',
      updateCommand: 'codex update',
    });
  });
});

describe('runCliRuntimeUpdateAudit', () => {
  it('checks once per day and notifies once for each latest version', async () => {
    let now = 1_000_000;
    let store: CliRuntimeUpdateStore = { entries: {} };
    let latest = '0.144.3';
    const probe = vi.fn(async () => ({
      current: '0.144.1',
      latest,
      updateCommand: 'codex update',
    }));
    const notified: string[] = [];
    const deps = () => ({
      now: () => now,
      targets: () => [
        { cliId: 'codex' as const, binPath: '/usr/bin/codex' },
        { cliId: 'codex' as const, binPath: '/usr/bin/codex' },
      ],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
      notify: async (entry: { latest: string | null }) => { notified.push(entry.latest!); },
    });

    await runCliRuntimeUpdateAudit(deps());
    expect(probe).toHaveBeenCalledTimes(1); // duplicate targets are de-duped
    expect(notified).toEqual(['0.144.3']);

    now += 60 * 60 * 1_000;
    await runCliRuntimeUpdateAudit(deps());
    expect(probe).toHaveBeenCalledTimes(1); // still inside the 24h TTL

    now += CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS;
    await runCliRuntimeUpdateAudit(deps());
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notified).toEqual(['0.144.3']); // same latest version is quiet

    latest = '0.145.0';
    now += CLI_RUNTIME_UPDATE_CHECK_INTERVAL_MS;
    await runCliRuntimeUpdateAudit(deps());
    expect(notified).toEqual(['0.144.3', '0.145.0']);
  });

  it('marks failed probes handled so an hourly tick does not retry noisily', async () => {
    let store: CliRuntimeUpdateStore = { entries: {} };
    const probe = vi.fn(async () => { throw new Error('offline'); });
    const deps = {
      now: () => 5_000,
      targets: () => [{ cliId: 'codex' as const, binPath: '/bad/codex' }],
      readStore: () => store,
      writeStore: (next: CliRuntimeUpdateStore) => { store = structuredClone(next); },
      probe,
    };
    await runCliRuntimeUpdateAudit(deps);
    await runCliRuntimeUpdateAudit(deps);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('removes persisted runtimes that are no longer configured', async () => {
    let store: CliRuntimeUpdateStore = {
      entries: {
        'codex:/old/codex': {
          cliId: 'codex',
          binPath: '/old/codex',
          current: '0.120.0',
          latest: '0.144.3',
          updateAvailable: true,
          updateCommand: 'codex update',
          lastCheckedAt: 1,
        },
      },
    };
    await runCliRuntimeUpdateAudit({
      now: () => 5_000,
      targets: () => [],
      readStore: () => store,
      writeStore: (next) => { store = structuredClone(next); },
      probe: vi.fn(),
    });
    expect(store.entries).toEqual({});
  });
});

describe('CLI runtime update store and card', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-cli-update-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists status atomically and derives updateAvailable on read', () => {
    writeCliRuntimeUpdateStoreTo(dir, {
      entries: {
        'codex:/usr/bin/codex': {
          cliId: 'codex',
          binPath: '/usr/bin/codex',
          current: '0.144.1',
          latest: '0.144.3',
          updateAvailable: false,
          updateCommand: 'codex update',
          lastCheckedAt: 123,
        },
      },
    });
    expect(cliRuntimeUpdateStorePathIn(dir)).toBe(join(dir, 'cli-runtime-updates.json'));
    expect(readCliRuntimeUpdateStoreFrom(dir).entries['codex:/usr/bin/codex'].updateAvailable).toBe(true);
  });

  it('builds an owner-only reminder with no automatic-update action', () => {
    const card = buildCliRuntimeUpdateCard({
      cliId: 'codex',
      binPath: '/usr/bin/codex',
      current: '0.144.1',
      latest: '0.144.3',
      updateAvailable: true,
      updateCommand: 'codex update',
      lastCheckedAt: 123,
    }, { dashboardUrl: 'http://dashboard', locale: 'zh' });
    expect(card).toContain('0.144.1');
    expect(card).toContain('0.144.3');
    expect(card).toContain('codex update');
    expect(card).toContain('不会自动安装');
    expect(card).not.toContain('button');
  });
});
