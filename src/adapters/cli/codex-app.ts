import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommandReal } from './registry.js';
import { capabilitySlugs, type DebugModelCapabilities } from './model-catalog-json.js';
import { loadCodexServiceTierCatalog } from '../../services/codex-service-tier-catalog.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createCodexAppAdapter(pathOverride?: string): CliAdapter {
  // Resolve the wrapped `codex` binary lazily, on first buildArgs (spawn time),
  // so constructing the adapter during `botmux setup` doesn't shell out via
  // resolveCommand. resolvedBin is the node runner, not codex itself.
  const rawCodexBin = pathOverride ?? 'codex';
  let cachedCodexBin: string | undefined;
  const detectModelCapabilities = async (
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<readonly DebugModelCapabilities[] | null> => {
    try {
      // Shares `cachedCodexBin` with the launch call sites, so discovery and
      // the app-server always use the same resolved binary.
      const codexBin = (cachedCodexBin ??= resolveCommandReal(rawCodexBin));
      return await loadCodexServiceTierCatalog({ cliBin: codexBin, env: options?.env });
    } catch {
      return null;
    }
  };
  return {
    id: 'codex-app',
    // Whole ~/.codex kept REAL (see codex.ts): under the deny-by-default file
    // sandbox a path not in authPaths doesn't exist, so codex can't open its
    // SQLite state/log DBs and hangs ~57s then exits 1. Binding the dir real
    // gives working fcntl locks.
    authPaths: ['~/.codex'],
    resolvedBin: process.execPath,

    // resolvedBin is node-running-the-runner; the REAL codex is spawned later for
    // the app-server (codex-app-runner.ts). Declare it so the file sandbox can
    // re-expose its bin dir when it lives under /run (fnm/nvm) — else --tmpfs /run
    // masks it and the in-sandbox app-server spawn ENOENTs into a crash-loop. Same
    // lazy resolve+cache as buildArgs; only an executable path, never the cwd.
    //
    // CANONICAL (resolveCommandReal), and it must stay identical to the path handed
    // to `--codex-bin` below: the sandbox authorizes `dirname(canonical(p))`, while
    // codex-app-runner.ts spawns `--codex-bin` verbatim. `codex` on PATH is commonly
    // a symlink chain (`~/.local/bin/codex` → `…/standalone/current/bin/codex` → a
    // versioned release dir), so a raw path would be authorized-as-canonical yet
    // spawned-as-symlink and ENOENT inside the sandbox.
    sandboxExtraExecPaths() {
      return [(cachedCodexBin ??= resolveCommandReal(rawCodexBin))];
    },

    buildArgs({ sessionId, resume, resumeSessionId, quietResume, workingDir, botName, botOpenId, locale, model, reasoningEffort, serviceTier, codexBrowser }) {
      const args = [
        runnerArgv0('codex-app-runner', resolveRunnerPath('codex-app-runner.js', { testOverrideEnv: 'BOTMUX_TEST_CODEX_APP_RUNNER_PATH' })),
        '--session-id', sessionId,
        // Canonical for the same reason as sandboxExtraExecPaths above — the runner
        // hands this straight to spawn().
        '--codex-bin', (cachedCodexBin ??= resolveCommandReal(rawCodexBin)),
      ];
      if (resume && resumeSessionId) args.push('--thread-id', resumeSessionId);
      if (quietResume) args.push('--strict-resume');
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      // Per-turn overrides (async trigger API). The runner injects them into the
      // app-server thread/start (model + config.model_reasoning_effort).
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
      pushOpt(args, '--reasoning-effort', reasoningEffort);
      pushOpt(args, '--service-tier', serviceTier);
      pushOpt(args, '--browser-family', codexBrowser?.family);
      pushOpt(args, '--browser-plugin-root', codexBrowser?.pluginRoot);
      return args;
    },

    // 与 codex CLI 同一模型目录（app-server 后端就是 codex binary）：静态列表是
    // `codex debug models` visibility=list 的快照；live 成功时只使用 live 目录。
    modelChoices: CLI_MODEL_CHOICES['codex-app'],
    // resolvedBin 是 runner；能力探测使用其实际启动的 Codex binary。
    detectModelCapabilities,

    async detectModels(): Promise<readonly string[] | null> {
      return capabilitySlugs(await detectModelCapabilities());
    },

    buildResumeCommand() {
      // Codex App threads are resumed through the app-server protocol by
      // botmux. There is not yet a stable user-facing CLI deeplink for a
      // precise desktop thread.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string, context) {
      // Chunked + throttled stdin injection — a single send-keys of the whole
      // (potentially ~20KB) control line overruns the pane pty input buffer and
      // gets dropped. See runner-input.ts.
      return writeRunnerInput(
        pty,
        '::botmux-codex-app:',
        content,
        undefined,
        context?.turnId,
        context?.codexAppSteerable,
        context?.trustedCaller,
      );
    },

    async writeStructuredInput(pty, content, codexAppInput, context) {
      // The legacy prompt remains in the control payload as a compatibility
      // fallback. The runner uses the sidecar only on supported app-server
      // versions and never reverse-parses the XML-ish legacy envelope.
      return writeRunnerInput(
        pty,
        '::botmux-codex-app:',
        content,
        codexAppInput,
        context?.turnId,
        context?.codexAppSteerable,
        context?.trustedCaller,
      );
    },

    supportsTypeAhead: true,
    completionPattern: undefined,
    readyPattern: /[›»]/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
  };
}
