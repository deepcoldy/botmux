/**
 * Real end-to-end verification of default-on Claude Code UserPromptSubmit hook
 * injection:
 *  - Legacy bots.json with `envelopeInjection: "off"` / `"auto"` loads cleanly
 *    and runs hook mode by default without opt-in.
 *  - Real `installHook` -> `hasInstalledPromptHookCached` (no negative cache).
 *  - Virgin opening turn (registered in `activeSessions` with `worker: null`,
 *    `session.backendType: undefined`, resolved via `plannedOpeningBackendType`)
 *    produces bare PTY text without `<user_message>`, preserves `trustedCaller`,
 *    and moves `whiteboard` / `sender` / `mentions` / `availableBots` into a
 *    real sidecar on disk.
 *  - Post-build `<botmux_skills>` (`prepareCliPluginGeneration`) and LinkRef
 *    (`prepareLinkRefTurnPayload`) appends rekey short (<30 char) sidecars.
 *  - Real `src/cli.ts user-prompt-hook` subprocess claims via real loopback
 *    Daemon IPC `POST /api/sessions/:sid/prompt-ctx/claim` (both host HMAC and
 *    sandbox rotating capability auth), forwards `prompt_submitted` to worker,
 *    and prints valid `hookSpecificOutput.additionalContext` JSON with exit 0.
 *  - Legacy `PUT /api/bot-envelope-injection` and `GET /api/bot-default-oncall`
 *    stay backward-compatible without mutating `bots.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { config } from '../src/config.js';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { buildFollowUpCliInput, buildNewTopicCliInput } from '../src/core/session-manager.js';
import { plannedOpeningBackendType } from '../src/core/opening-backend.js';
import {
  hasInstalledPromptHookCached,
  installHook,
  invalidatePromptHookPreflightCache,
} from '../src/adapters/hook-installer.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { sanitizeClaudeInput } from '../src/adapters/cli/claude-code.js';
import { prepareCliPluginGeneration } from '../src/core/plugins/cli-generation.js';
import { installLocalSkill } from '../src/services/skill-registry-store.js';
import { createLinkRefRuntime } from '../src/services/link-ref-runtime.js';
import { initialLinkRefSources, prepareLinkRefTurnPayload } from '../src/core/link-ref-turn.js';
import {
  claimPromptContextAmongTurns,
  fingerprintPromptText,
  prefixOf,
  removePromptContextDir,
  writePromptContext,
} from '../src/services/prompt-context-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');
const HOST_SECRET = 'e2e-prompt-hook-host-secret-0123456789abcdef';
const CAPABILITY = 'abcdef01'.repeat(8);
const APP_ID = 'cli_e2e_hook_default_on';

async function runUserPromptHook(opts: {
  homeDir: string;
  dataDir: string;
  sessionId: string;
  ipcPort: number;
  prompt: string;
  relayDir?: string;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { command, prefixArgs } = tsRunnerPrefix();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.homeDir,
    SESSION_DATA_DIR: opts.dataDir,
    BOTMUX_SESSION_ID: opts.sessionId,
    BOTMUX_LARK_APP_ID: APP_ID,
    BOTMUX_DAEMON_IPC_PORT: String(opts.ipcPort),
  };
  if (opts.relayDir) env.BOTMUX_SEND_RELAY = opts.relayDir;
  else delete env.BOTMUX_SEND_RELAY;

  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(command, [...prefixArgs, CLI_ENTRY, 'user-prompt-hook'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
    }, 15_000);
    child.stdout.on('data', chunk => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', err => {
      clearTimeout(timer);
      rejectDone(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolveDone({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.stdin.end(JSON.stringify({ prompt: opts.prompt }));
  });
}

describe('prompt-hook end-to-end (real user-prompt-hook + Daemon IPC + legacy bots.json)', () => {
  let rootDir: string;
  let homeDir: string;
  let dataDir: string;
  let botsPath: string;
  let globalConfigPath: string;
  let prevHome: string | undefined;
  let prevDataDirEnv: string | undefined;
  let prevBotsConfig: string | undefined;
  let prevGlobalConfig: string | undefined;
  let prevConfigDataDir: string;
  let handle: IpcServerHandle | null = null;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-hook-e2e-'));
    homeDir = join(rootDir, 'home');
    dataDir = join(homeDir, '.botmux', 'sessions');
    botsPath = join(homeDir, '.botmux', 'bots.json');
    globalConfigPath = join(homeDir, '.botmux', 'config.json');
    mkdirSync(join(homeDir, '.botmux'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(homeDir, '.botmux', '.dashboard-secret'), HOST_SECRET, { mode: 0o600 });

    prevHome = process.env.HOME;
    prevDataDirEnv = process.env.SESSION_DATA_DIR;
    prevBotsConfig = process.env.BOTS_CONFIG;
    prevGlobalConfig = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    prevConfigDataDir = config.session.dataDir;

    process.env.HOME = homeDir;
    process.env.SESSION_DATA_DIR = dataDir;
    process.env.BOTS_CONFIG = botsPath;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = globalConfigPath;
    config.session.dataDir = dataDir;

    invalidatePromptHookPreflightCache();
    __testOnly_resetBotRegistry();
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    setIpcAuthSecret(null);
    setLarkAppId('');
    vi.restoreAllMocks();
    invalidatePromptHookPreflightCache();
    __testOnly_resetBotRegistry();

    config.session.dataDir = prevConfigDataDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDataDirEnv === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDirEnv;
    if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = prevBotsConfig;
    if (prevGlobalConfig === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prevGlobalConfig;

    rmSync(rootDir, { recursive: true, force: true });
  });

  it('runs default-on opening + skill rekey + follow-up LinkRef rekey + legacy bots.json compat end-to-end', async () => {
    // 1. Legacy bots.json with explicit `"envelopeInjection": "off"` must load
    //    without error and still use default-on hook injection.
    const claudeProfileDir = join(homeDir, '.claude');
    const settingsPath = join(claudeProfileDir, 'settings.json');
    const legacyBotsRaw = JSON.stringify([
      {
        larkAppId: APP_ID,
        larkAppSecret: 'secret-e2e',
        cliId: 'claude-code',
        cliConfigDir: claudeProfileDir,
        replyDelivery: 'send',
        envelopeInjection: 'off',
      },
      {
        larkAppId: 'cli_e2e_legacy_auto',
        larkAppSecret: 'secret-e2e-2',
        cliId: 'claude-code',
        envelopeInjection: 'auto',
      },
    ], null, 2);
    writeFileSync(botsPath, legacyBotsRaw);
    const loadedConfigs = loadBotConfigs();
    expect(loadedConfigs).toHaveLength(2);
    expect(loadedConfigs[0]).not.toHaveProperty('envelopeInjection');
    expect(loadedConfigs[1]).not.toHaveProperty('envelopeInjection');
    loadedConfigs.forEach(c => registerBot(c));
    setLarkAppId(APP_ID);

    // 2. Negative preflight is NOT cached: false before install -> immediately true after installHook.
    expect(hasInstalledPromptHookCached(settingsPath)).toBe(false);
    installHook('claude-code', {
      configPath: settingsPath,
      format: 'claude-settings',
      userPromptSubmitCommand: `node ${CLI_ENTRY} user-prompt-hook`,
    }, `node ${CLI_ENTRY} hook claude-code`);
    expect(hasInstalledPromptHookCached(settingsPath)).toBe(true);

    // 3. Virgin opening registered in activeSessions with worker=null and
    //    session.backendType=undefined (real production pre-fork state!).
    const sessionId = 'e2e-sess-opening';
    const openingTurnId = 'om_e2e_opening_1';
    const virginDs = {
      session: {
        sessionId,
        status: 'active',
        chatId: 'oc_e2e_chat',
        backendType: undefined,
      },
      larkAppId: APP_ID,
      chatId: 'oc_e2e_chat',
      worker: null,
      hasHistory: false,
    } as unknown as DaemonSession;
    const registry = new Map<string, DaemonSession>([['k', virginDs]]);
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(registry);

    const plannedBackend = plannedOpeningBackendType(virginDs, 'claude-code', loadedConfigs[0]);
    expect(plannedBackend).toBe(config.daemon.backendType);

    const rawUserMsg = '\u200B👨\u200D👩\u200D👧\u200D👦 查下登录报错';
    const trustedCaller = { openId: 'ou_caller_e2e', isBot: false };
    const opening = buildNewTopicCliInput(
      rawUserMsg,
      sessionId,
      'claude-code',
      undefined,
      undefined,
      [{ name: 'Alice', openId: 'ou_alice' }],
      [{ name: 'HelperBot', displayName: 'HelperBot', openId: 'ou_helper' }],
      undefined,
      { name: 'MainBot', openId: 'ou_main' },
      'zh',
      { openId: 'ou_sender_e2e', type: 'user', name: 'Tester' },
      {
        larkAppId: APP_ID,
        chatId: 'oc_e2e_chat',
        turnId: openingTurnId,
        sessionBackendType: plannedBackend,
        trustedCaller,
      },
    );

    expect(opening.content).toBe(rawUserMsg);
    expect(opening.content).not.toContain('<user_message>');
    expect(opening.content).not.toContain('<available_bots');
    expect(opening.trustedCaller).toEqual(trustedCaller);

    // 4. Worker appends <botmux_skills> to this short (<30 char) opening via
    //    prepareCliPluginGeneration -> sidecar rekeys transparently.
    const skillDir = join(rootDir, 'skills', 'deploy-helper');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy-helper\ndescription: Deploy checks\n---\nCheck logs.\n');
    installLocalSkill(skillDir, { link: false });
    const generation = prepareCliPluginGeneration({
      sessionId,
      bot: {
        larkAppId: APP_ID,
        skills: { include: ['skill:deploy-helper'] },
      },
      dataDir,
      cliId: 'claude-code',
      adapter: createCliAdapterSync('claude-code', undefined, { configDir: claudeProfileDir }),
      workingDir: rootDir,
      prompt: opening.content,
      turnId: openingTurnId,
      replacesPriorGeneration: false,
    });
    expect(generation.prompt).toContain('<botmux_skills');
    expect(generation.prompt).not.toBe(opening.content);

    // 5. Simulate live worker submitting sanitized prompt to Claude Code ->
    //    real `src/cli.ts user-prompt-hook` subprocess claims via real IPC!
    const workerMessages: unknown[] = [];
    const liveWorker = {
      killed: false,
      connected: true,
      send: (msg: unknown, cb?: (err?: Error | null) => void) => {
        workerMessages.push(msg);
        cb?.(null);
      },
    };
    const liveDs = {
      ...virginDs,
      worker: liveWorker,
      session: { ...virginDs.session, backendType: plannedBackend },
      initConfig: { sessionId, cliId: 'claude-code', backendType: plannedBackend, cliConfigDir: claudeProfileDir, sandbox: 'off' },
      managedTurnOrigin: { turnId: openingTurnId, capability: CAPABILITY },
    } as unknown as DaemonSession;
    registry.set('k', liveDs);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(sid => (sid === sessionId ? liveDs : undefined));

    const claudeTypedOpening = sanitizeClaudeInput(generation.prompt);
    const openingHookRes = await runUserPromptHook({
      homeDir,
      dataDir,
      sessionId,
      ipcPort: handle!.port,
      prompt: claudeTypedOpening,
    });
    expect(openingHookRes.status).toBe(0);
    const openingHookJson = JSON.parse(openingHookRes.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(openingHookJson.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(openingHookJson.hookSpecificOutput.additionalContext).toContain('<sender ');
    expect(openingHookJson.hookSpecificOutput.additionalContext).toContain('<mentions>');
    expect(openingHookJson.hookSpecificOutput.additionalContext).toContain('<available_bots');
    expect(workerMessages.some(m => (m as { type?: string }).type === 'prompt_submitted')).toBe(true);

    // Second claim for the same turn is a clean fail-open no-op (sidecar unlinked on first claim).
    const replayHookRes = await runUserPromptHook({
      homeDir,
      dataDir,
      sessionId,
      ipcPort: handle!.port,
      prompt: claudeTypedOpening,
    });
    expect(replayHookRes.status).toBe(0);
    expect(replayHookRes.stdout).toBe('');

    // 6. Follow-up turn + LinkRef companion append on short (<30 char) message,
    //    claimed via sandbox capability relay auth (`BOTMUX_SEND_RELAY`).
    const followUpTurnId = 'om_e2e_followup_2';
    liveDs.managedTurnOrigin = { turnId: followUpTurnId, capability: CAPABILITY } as DaemonSession['managedTurnOrigin'];
    const relayDir = join(rootDir, 'relay');
    mkdirSync(relayDir, { recursive: true });
    // Put live IPC port in the relay capability file while passing a stale/dead
    // BOTMUX_DAEMON_IPC_PORT to prove user-prompt-hook prefers claim.ipcPort on
    // reattached sandboxed persistent panes.
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ sessionId, capability: CAPABILITY, turnId: followUpTurnId, ipcPort: handle!.port }),
      { mode: 0o600 },
    );

    const followUp = buildFollowUpCliInput('看下这个链接', sessionId, {
      cliId: 'claude-code',
      larkAppId: APP_ID,
      chatId: 'oc_e2e_chat',
      sessionBackendType: plannedBackend,
      turnId: followUpTurnId,
      sender: { openId: 'ou_sender_e2e', type: 'user', name: 'Tester' },
      messageLocation: { messageId: followUpTurnId, rootMessageId: 'om_root' },
      linkRefMode: 'enabled',
    });
    expect(followUp.content).toBe('看下这个链接');

    const linkRefRuntime = createLinkRefRuntime(dataDir);
    try {
      const preparedFollowUp = prepareLinkRefTurnPayload({
        runtime: linkRefRuntime,
        key: { appId: APP_ID, sessionId, turnId: followUpTurnId, dispatchAttempt: 1 },
        mode: 'enabled',
        payload: {
          ...followUp,
          linkRefs: {
            mode: 'enabled',
            sources: initialLinkRefSources({ userText: '看下这个链接 https://example.test/issue/42' }),
          },
        },
      });
      expect(preparedFollowUp.content).toContain('<botmux_link_refs>');

      const followUpHookRes = await runUserPromptHook({
        homeDir,
        dataDir,
        sessionId,
        ipcPort: 1, // deliberately dead env port; live port must come from claim.ipcPort
        prompt: sanitizeClaudeInput(preparedFollowUp.content),
        relayDir,
      });
      expect(followUpHookRes.status).toBe(0);
      const followUpHookJson = JSON.parse(followUpHookRes.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(followUpHookJson.hookSpecificOutput.additionalContext).toContain('<botmux_reminder>');
      expect(followUpHookJson.hookSpecificOutput.additionalContext).toContain('<botmux_formatting>');
      expect(followUpHookJson.hookSpecificOutput.additionalContext).toContain('message_id="om_e2e_followup_2"');
      expect(followUpHookJson.hookSpecificOutput.additionalContext).toContain('<sender ');
    } finally {
      linkRefRuntime.close();
    }

    // 7. Read-only compat API routes never 404/500 and never mutate legacy bots.json.
    const putPath = '/api/bot-envelope-injection';
    const putRes = await fetch(`http://127.0.0.1:${handle!.port}${putPath}`, {
      method: 'PUT',
      headers: daemonIpcAuthHeaders({
        secret: HOST_SECRET,
        port: handle!.port,
        method: 'PUT',
        path: putPath,
        headers: { 'content-type': 'application/json' },
      }),
      body: JSON.stringify({ envelopeInjection: 'off' }),
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ ok: true, envelopeInjection: 'auto' });
    expect(readFileSync(botsPath, 'utf8')).toBe(legacyBotsRaw);

    const getPath = '/api/bot-default-oncall';
    const getRes = await fetch(`http://127.0.0.1:${handle!.port}${getPath}`, {
      method: 'GET',
      headers: daemonIpcAuthHeaders({
        secret: HOST_SECRET,
        port: handle!.port,
        method: 'GET',
        path: getPath,
      }),
    });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ envelopeInjection: 'auto' });

    // 8. HIGH-1 disambiguation: two same-base-text turns ("继续" with vs without
    //    <botmux_skills_refresh>) keep distinct exact SHA-256 keys after rekeying.
    const disambigSid = 'e2e-sess-high1';
    try {
      const t1Prompt = '继续';
      const t2Prompt = '继续\n\n<botmux_skills_refresh><botmux_skills mode="priority"></botmux_skills></botmux_skills_refresh>';
      writePromptContext(disambigSid, 't1', t1Prompt, 'ENV_1');
      writePromptContext(disambigSid, 't2', t2Prompt, 'ENV_2');
      const claimed2 = claimPromptContextAmongTurns(disambigSid, ['t1', 't2'], fingerprintPromptText(t2Prompt), prefixOf(t2Prompt));
      const claimed1 = claimPromptContextAmongTurns(disambigSid, ['t1', 't2'], fingerprintPromptText(t1Prompt), prefixOf(t1Prompt));
      expect(claimed2).toEqual({ turnId: 't2', envelope: 'ENV_2' });
      expect(claimed1).toEqual({ turnId: 't1', envelope: 'ENV_1' });
    } finally {
      removePromptContextDir(disambigSid);
      removePromptContextDir(sessionId);
    }

    expect(existsSync(join(dataDir, 'prompt-ctx', sessionId))).toBe(false);
  });
});
