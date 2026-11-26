import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { resolveSandboxMode, resolveSpawnNetworkShape } from '../adapters/cli/sandbox-mode.js';
import { hasInstalledPromptHookCached } from '../adapters/hook-installer.js';
import { credentialSourceForcesBotHome } from '../services/cli-credential-source.js';
import { writePromptContext } from '../services/prompt-context-store.js';
import { assistantUserHome, isValidAssistantOpenId } from './assistant-mode.js';
import { cliSupportsConfigDir } from './cli-config-dir.js';
import type { DaemonSession } from './types.js';

const LOCAL_BACKENDS = new Set(['pty', 'tmux', 'herdr', 'zellij', 'zmx', 'hc']);

/**
 * Whether an active live worker on `ds` can receive a replayed turn's
 * `hookEnvelope` via `UserPromptSubmit` hook IPC. Dormant / dead workers fail
 * closed so the caller inlines the envelope instead of writing a sidecar that
 * a reforked/non-hook generation might never claim.
 */
export function canReplayViaLivePromptHook(ds: DaemonSession): boolean {
  if (!ds.worker || ds.worker.killed || ds.worker.connected === false || !ds.initConfig) return false;
  if (ds.adoptedFrom || ds.session.adoptedFrom || ds.initConfig.adoptMode === true) return false;
  if (ds.reportedIdentityModel?.loopbackShared === false) return false;
  const init = ds.initConfig;
  if (init.promptInjection === 'none') return false;
  if (!init.backendType || !LOCAL_BACKENDS.has(init.backendType)) return false;

  const cliId = init.cliId as CliId;
  const configDir = cliSupportsConfigDir(cliId) ? init.cliConfigDir : undefined;
  let adapter;
  try {
    adapter = createCliAdapterSync(cliId, init.cliPathOverride, configDir ? { configDir } : undefined);
  } catch {
    return false;
  }
  if (!adapter.supportsInvisiblePromptHook || !adapter.hookInstall?.userPromptSubmitCommand) return false;
  const base = adapter.hookInstall.configPath;
  if (!base) return false;

  let sandboxMode: ReturnType<typeof resolveSandboxMode>;
  try {
    sandboxMode = resolveSandboxMode({
      configSandbox: init.sandbox,
      readIsolation: init.readIsolation === true,
      envValue: process.env.BOTMUX_SANDBOX,
    });
  } catch {
    return false;
  }
  if (!resolveSpawnNetworkShape({
    mode: sandboxMode,
    sandboxNetwork: init.sandboxNetwork,
    sandboxNetworkPolicy: init.sandboxNetworkPolicy ?? init.protectedHttpEgressPolicy,
  }).loopbackShared) {
    return false;
  }

  const credentialSourceHome = credentialSourceForcesBotHome({
    sourceDir: init.credentialsSourceDir,
    cliId: adapter.id,
    sandboxRequested: sandboxMode !== 'off',
  });
  const needsRedirect = (sandboxMode === 'oncall' || credentialSourceHome)
    && adapter.supportsReadIsolation === true
    && !init.wrapperCli
    && init.backendType !== 'riff';
  const dataDir = process.env.SESSION_DATA_DIR?.trim() || config.session.dataDir?.trim() || '';

  let effectivePath: string;
  if (init.assistantOwnerOpenId !== undefined) {
    if (!isValidAssistantOpenId(init.assistantOwnerOpenId) || sandboxMode !== 'oncall' || !needsRedirect || !dataDir) {
      return false;
    }
    const botHome = botHomePath(dirname(dataDir), ds.larkAppId);
    effectivePath = join(assistantUserHome(botHome, init.assistantOwnerOpenId), 'claude', 'settings.json');
  } else if (needsRedirect) {
    if (!dataDir) return false;
    effectivePath = join(botHomePath(dirname(dataDir), ds.larkAppId), 'claude', 'settings.json');
  } else {
    effectivePath = base;
  }
  return hasInstalledPromptHookCached(effectivePath);
}

/**
 * Re-bind a hook-stripped turn's saved `hookEnvelope` onto a newly minted
 * replay `turnId` (failed-turn recovery, `/retry`, `retry_last_task`,
 * `retry_turn`, ordinary-recovery retry, automatic recovery continuation).
 *
 * - If the target live worker passes live hook preflight, write a fresh
 *   sidecar under `(sessionId, turnId, content)` and preserve `hookEnvelope`
 *   so subsequent retries of this retry retain it too.
 * - Otherwise (e.g. dormant `forkWorker` or preflight unavailable), fail
 *   closed by inlining the envelope ahead of `content` so `<botmux_reminder>`,
 *   `<whiteboard>`, `<sender>`, `<mentions>`, etc. are never silently dropped.
 */
export function prepareHookEnvelopeForReplay(input: {
  ds: DaemonSession;
  content: string;
  turnId: string;
  hookEnvelope?: string;
  willUseLiveWorker: boolean;
}): { content: string; hookEnvelope?: string } {
  const { ds, content, turnId, hookEnvelope, willUseLiveWorker } = input;
  if (!hookEnvelope) return { content };
  if (willUseLiveWorker && canReplayViaLivePromptHook(ds)) {
    writePromptContext(ds.session.sessionId, turnId, content, hookEnvelope);
    return { content, hookEnvelope };
  }
  return { content: `${hookEnvelope}\n\n${content}` };
}
