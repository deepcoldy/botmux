import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));
const cliPath = join(repoRoot, 'src/cli.ts');

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function makeFixture(options?: { herdrSessions?: Array<{ name: string; running: boolean }>; failHerdrList?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-cli-herdr-'));
  const home = join(root, 'home');
  const configDir = join(home, '.botmux');
  const dataDir = join(root, 'data');
  const binDir = join(root, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const appId = 'app-herdr';
  const sessionId = '12345678-aaaa-bbbb-cccc-123456789abc';
  writeJson(join(configDir, 'bots.json'), [
    { larkAppId: appId, cliId: 'codex', backendType: 'herdr' },
  ]);
  writeJson(join(dataDir, `sessions-${appId}.json`), {
    [sessionId]: {
      sessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_test',
      title: 'Herdr session',
      status: 'active',
      createdAt: '2026-06-29T00:00:00.000Z',
      workingDir: '/work/repo',
      larkAppId: appId,
      cliId: 'codex',
      lastCliInput: 'hello',
    },
  });

  const herdrLog = join(root, 'herdr.log');
  const herdrSessionsPath = join(root, 'herdr-sessions.json');
  writeJson(herdrSessionsPath, { sessions: options?.herdrSessions ?? [{ name: 'bmx-12345678', running: true }] });
  writeFileSync(join(binDir, 'herdr'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HERDR_LOG"
if [[ "$HERDR_FAIL_LIST" == "1" && "$1 $2 $3" == "session list --json" ]]; then
  exit 2
fi
if [[ "$1 $2 $3" == "session list --json" ]]; then
  cat "$HERDR_SESSIONS_JSON"
  exit 0
fi
if [[ "$1" == "session" && ( "$2" == "stop" || "$2" == "delete" ) ]]; then
  exit 0
fi
echo "unexpected herdr args: $*" >&2
exit 1
`, 'utf-8');
  chmodSync(join(binDir, 'herdr'), 0o755);

  writeFileSync(join(binDir, 'tmux'), `#!/usr/bin/env bash
if [[ "$1" == "has-session" ]]; then exit 1; fi
exit 0
`, 'utf-8');
  chmodSync(join(binDir, 'tmux'), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    SESSION_DATA_DIR: dataDir,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HERDR_LOG: herdrLog,
    HERDR_SESSIONS_JSON: herdrSessionsPath,
    ...(options?.failHerdrList ? { HERDR_FAIL_LIST: '1' } : {}),
  };

  return { root, dataDir, appId, sessionId, herdrLog, env };
}

function runBotmux(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
  });
}

describe('botmux CLI Herdr persistent backend', () => {
  it('lists Herdr sessions when the owning bot has backendType=herdr', () => {
    const fx = makeFixture();

    const result = runBotmux(['list', '--plain'], fx.env);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Herdr session');
    expect(result.stdout).toContain('herdr: bmx-12345678');
    expect(readFileSync(fx.herdrLog, 'utf-8')).toContain('session list --json');
  });

  it('uses herdr stop/delete when deleting a Herdr-backed session', () => {
    const fx = makeFixture();

    const result = runBotmux(['delete', '12345678'], fx.env);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('killed herdr bmx-12345678');
    const log = readFileSync(fx.herdrLog, 'utf-8');
    expect(log).toContain('session stop bmx-12345678 --json');
    expect(log).toContain('session delete bmx-12345678 --json');

    const sessions = JSON.parse(readFileSync(join(fx.dataDir, `sessions-${fx.appId}.json`), 'utf-8'));
    expect(sessions[fx.sessionId].status).toBe('closed');
  });

  it('does not auto-prune when the Herdr probe is unknown', () => {
    const fx = makeFixture({ failHerdrList: true });

    const result = runBotmux(['list', '--plain'], fx.env);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Herdr session');
    expect(result.stdout).toContain('herdr: 未知');
    const sessions = JSON.parse(readFileSync(join(fx.dataDir, `sessions-${fx.appId}.json`), 'utf-8'));
    expect(sessions[fx.sessionId].status).toBe('active');
  });
});
