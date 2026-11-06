import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNodeExecutable } from './helpers/ts-runner.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { generateOneShotTitle } from '../src/services/session-group-title.js';

let bot: { cliId: string; cliPathOverride: string; sandbox: 'off'; plugins?: string[]; env?: Record<string, string> };
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...(await importOriginal() as object),
  getBot: () => ({ config: bot }),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const protectedConfig = {
  protectedMcpCapabilities: {
    'fixture.secret.v1': {
      enabled: true,
      allowedPluginIds: ['fixture-plugin'],
      secret: { source: 'file', path: '.secrets/title-secret' },
      containmentProfile: 'local-stdio-secret-v1',
    },
  },
};

describe.skipIf(process.platform === 'win32')('shared title generation host credential boundary', () => {
  let home: string;
  let configFile: string;
  let evidence: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-title-isolation-'));
    configFile = join(home, 'global.json');
    evidence = join(home, 'secret-read-evidence');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', configFile);
    vi.stubEnv('BOTMUX_SANDBOX', '0');
    mkdirSync(join(home, '.secrets'));
    writeFileSync(join(home, '.secrets', 'title-secret'), 'title-private-credential', { mode: 0o600 });
    writeFileSync(configFile, '{}');
    invalidateGlobalConfigCache();
    const fixture = join(home, 'title-cli.mjs');
    const node = resolveNodeExecutable();
    if (!node) throw new Error('real Node executable is required for this CLI fixture');
    // Execute the real production execFile boundary. The evidence records the
    // bytes actually read by the CLI, rather than merely its launch arguments.
    writeFileSync(fixture, `#!${node}\n
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const evidence = join(homedir(), 'secret-read-evidence');
const previousAttempt = existsSync(evidence);
const secret = readFileSync(join(homedir(), '.secrets', 'title-secret'), 'utf8');
appendFileSync(evidence, secret + '\\n');
if (process.env.TITLE_FIXTURE_RETRY === '1' && !previousAttempt) {
  writeFileSync(${JSON.stringify(configFile)}, ${JSON.stringify(JSON.stringify(protectedConfig))});
  process.stderr.write('temporary title failure');
  process.exit(1);
}
if (process.argv[2] === 'app-server') {
  process.env.FAKE_CODEX_FINAL_TEXT = JSON.stringify({ title: 'FixtureTitle' });
  await import(${JSON.stringify(join(process.cwd(), 'test/fixtures/fake-codex-app-server.mjs'))});
} else {
  console.log('FixtureTitle');
}
`, { mode: 0o700 });
    bot = { cliId: 'codex', cliPathOverride: fixture, sandbox: 'off' };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  const generate = () => generateOneShotTitle({
    larkAppId: 'cli_title_fixture', chatId: 'oc_fixture', userText: 'name this conversation',
    maxLen: 12, logTag: 'title-fixture',
  });

  it.each(['codex', 'traex'])('generates a title through the real %s CLI when the host has no mandatory isolation policy', async cliId => {
    bot.cliId = cliId;
    await expect(generate()).resolves.toBe('FixtureTitle');
    expect(readFileSync(evidence, 'utf8')).toBe('title-private-credential\n');
  });

  it.each([
    { cliId: 'codex', plugins: [] }, { cliId: 'codex', plugins: ['fixture-plugin'] },
    { cliId: 'traex', plugins: [] }, { cliId: 'traex', plugins: ['fixture-plugin'] },
  ])('prevents $cliId host secret reads with a global file binding and plugins=$plugins', async ({ cliId, plugins }) => {
    bot.cliId = cliId;
    bot.plugins = plugins;
    writeFileSync(configFile, JSON.stringify(protectedConfig));
    invalidateGlobalConfigCache();
    const title = await generate();
    expect(existsSync(evidence)).toBe(false);
    expect(title).toBeNull();
  });

  it('rechecks current isolation before retrying after the first CLI updates the protected file policy', async () => {
    bot.cliId = 'traex';
    bot.env = { TITLE_FIXTURE_RETRY: '1' };
    const title = await generate();
    expect(readFileSync(evidence, 'utf8')).toBe('title-private-credential\n');
    expect(title).toBeNull();
  }, 10_000);
});
