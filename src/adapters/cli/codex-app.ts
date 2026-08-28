import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveCommandReal } from './registry.js';
import { parseDebugModelsJson } from './model-catalog-json.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';

function runnerPath(): string {
  // Source-level worker integration tests execute through tsx and need the
  // matching source runner rather than a possibly absent/stale ignored dist
  // tree. Keep the override strictly test-scoped so production launch
  // resolution remains canonical and cannot be redirected by ambient env.
  const testOverride = process.env.NODE_ENV === 'test'
    ? process.env.BOTMUX_TEST_CODEX_APP_RUNNER_PATH
    : undefined;
  if (testOverride) return resolve(testOverride);
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'codex-app-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'codex-app-runner.js');
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}

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

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, botName, botOpenId, locale, model, reasoningEffort, codexBrowser }) {
      const args = [
        runnerPath(),
        '--session-id', sessionId,
        // Canonical for the same reason as sandboxExtraExecPaths above — the runner
        // hands this straight to spawn().
        '--codex-bin', (cachedCodexBin ??= resolveCommandReal(rawCodexBin)),
      ];
      if (resume && resumeSessionId) args.push('--thread-id', resumeSessionId);
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      // Per-turn overrides (async trigger API). The runner injects them into the
      // app-server thread/start (model + config.model_reasoning_effort).
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
      pushOpt(args, '--reasoning-effort', reasoningEffort);
      pushOpt(args, '--browser-family', codexBrowser?.family);
      pushOpt(args, '--browser-plugin-root', codexBrowser?.pluginRoot);
      return args;
    },

    // 与 codex CLI 同一模型目录（app-server 后端就是 codex binary）：静态列表是
    // `codex debug models` visibility=list 的快照，live 探测补充目录增量。
    modelChoices: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'],
    // Live 模型枚举：直接 spawn 被 wrap 的 codex binary 跑 `debug models`
    // （resolvedBin 是 node runner 不是 codex，故这里用懒解析的 cachedCodexBin）。
    // 8s 超时、16MB maxBuffer、fail-soft → null，picker 回退上面的静态快照。
    async detectModels(): Promise<readonly string[] | null> {
      try {
        // lazy promisify：顶层 promisify(execFile) 会在部分 mock child_process
        // 的测试 import 阶段炸（mock 无 execFile 导出）；推迟到调用时，fail-soft
        // 的 try/catch 兜住（契约：任何异常 → null）。
        const execFileAsync = promisify(execFile);
        // Shares `cachedCodexBin` with the two call sites above, so it must use the
        // same resolver or whichever runs first would decide the cached value and
        // silently change what the other two get. It also execs the binary itself.
        const codexBin = (cachedCodexBin ??= resolveCommandReal(rawCodexBin));
        const { stdout } = await execFileAsync(codexBin, ['debug', 'models'], {
          timeout: 8000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const models = parseDebugModelsJson(stdout);
        return models.length > 0 ? models : null;
      } catch {
        return null;
      }
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
    readyPattern: /›/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
  };
}

export const create = createCodexAppAdapter;
