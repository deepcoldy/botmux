/**
 * Regression: `botmux bots list` must register the calling bot from its own
 * send-cred file before touching the Lark client, exactly like cmdSend /
 * cmdHistory / cmdQuoted do.
 *
 * Under read isolation bots.json is Seatbelt-denied, so the bot registry starts
 * empty and getBotClient() throws `Bot not registered: <appId>`. listChatBotMembers()
 * swallows that into a legacy-discovery fallback whose `configured` rows also come
 * from bots.json — so the command answered `total: 0` instead of erroring. The
 * failure mode is SILENT: a sandboxed bot reads an empty roster as "nobody here to
 * @-mention" and multi-bot collaboration simply never happens.
 *
 * The assertion is deliberately negative (no `Bot not registered`) rather than an
 * exact roster: with a throwaway app secret the API call fails either way, so
 * this stays offline-safe while still failing when the registration is missing.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP_ID = 'cli_isolated_roster';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, args, {
      env: { ...process.env, ...env, BOTMUX_WORKFLOW: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

/** Read-isolated layout: per-bot session store + send-cred inside BOT_HOME, NO bots.json. */
function seedIsolatedBot(): { home: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-bots-list-cred-'));
  tempDirs.push(root);
  const home = join(root, 'home');
  const dataDir = join(home, '.botmux', 'data');
  const botHome = join(home, '.botmux', 'bots', APP_ID);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(botHome, { recursive: true });

  // The bot's real session store: `session-stores/<appId>/sessions.db`, the only
  // engine the CLI reads at runtime.
  seedPersistedSessionRows(dataDir, APP_ID, {
    [SESSION_ID]: {
      sessionId: SESSION_ID,
      chatId: 'oc_isolated_roster_chat',
      chatType: 'group',
      rootMessageId: '',
      sessionScope: 'chat',
      title: 'roster regression',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      larkAppId: APP_ID,
    },
  });

  // The only credential source available to an isolated bot.
  writeFileSync(join(botHome, 'send-cred.json'), JSON.stringify({
    larkAppSecret: 'throwaway-secret-for-registration-only',
    brand: 'feishu',
  }));

  return { home, dataDir };
}

describe('botmux bots list under read isolation', () => {
  it('registers self from send-cred instead of failing with "Bot not registered"', async () => {
    const { home, dataDir } = seedIsolatedBot();

    const { stdout, stderr } = await runCli(['bots', 'list', '--session-id', SESSION_ID], {
      HOME: home,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_LARK_APP_ID: APP_ID,
      // Pin the members/bots discovery path ON. Without this the child inherits
      // the flag from the parent/CI env; if it happens to be 'false', the code
      // skips listChatBotsViaMembersBots() entirely — so the pre-fix version
      // never reaches getBotClient() and this regression would falsely pass.
      BOTMUX_LARK_LIST_BOTS_API_ENABLED: 'true',
    });

    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toContain('Bot not registered');
    // Still answers with a well-formed roster payload for the right session.
    const payload = JSON.parse(stdout);
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(Array.isArray(payload.bots)).toBe(true);
  }, 30_000);
});
