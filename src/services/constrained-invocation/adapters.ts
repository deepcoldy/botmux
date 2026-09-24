import { join } from 'node:path';
import { ALL_CLI_IDS } from '../../adapters/cli/registry.js';
import type { CliId } from '../../adapters/cli/types.js';
import type { BotConfig } from '../../bot-registry.js';
import type { InvocationRequest } from './contract.js';
import type { ModelOnlyRuntime, NativeInvocationOutput } from './runtime.js';
import { runCodexInvocation } from './codex-runtime.js';
import { runClaudeInvocation } from './claude-runtime.js';
import { runMinimaxInvocation } from './minimax-runtime.js';
import { runPiInvocation } from './pi-runtime.js';
import { runGeminiInvocation } from './gemini-runtime.js';
import { runOpenCodeInvocation } from './opencode-runtime.js';
import { modelOnlyAssessments } from './support-status.js';

/** Each CLI implements its own native inference/auth contract. Interactive CLI
 * arguments and agent loops must never be reused as a model-only fallback. */
export interface ModelOnlyAdapter {
  cli: CliId;
  authSubdir: string;
  nativeProtocol: string;
  modelPolicy: string;
  acceptsIdentity(bot: BotConfig): boolean;
  run(request: InvocationRequest, runtime: ModelOnlyRuntime, signal: AbortSignal): Promise<NativeInvocationOutput>;
}

function codexAdapter(cli: 'codex' | 'codex-app'): ModelOnlyAdapter {
  return {
    cli, authSubdir: 'codex', nativeProtocol: 'app-server', modelPolicy: 'caller_selected_native_catalog',
    acceptsIdentity: bot => bot.codexAuthSync === 'isolated',
    run: (request, runtime, signal) => runCodexInvocation(request, { ...runtime, catalogPath: join(runtime.authHome, 'models_cache.json') }, signal),
  };
}

const adapters: ReadonlyMap<string, ModelOnlyAdapter> = new Map<string, ModelOnlyAdapter>([
  ['codex', codexAdapter('codex')],
  // Both identities resolve to the same native executable. Model-only calls
  // start a private app-server; the daemon gate rejects attached/shared servers.
  ['codex-app', codexAdapter('codex-app')],
  ['claude-code', {
    cli: 'claude-code', authSubdir: 'claude', nativeProtocol: 'print-stream-json', modelPolicy: 'caller_selected',
    acceptsIdentity: () => true,
    run: runClaudeInvocation,
  }],
  ['minimax', {
    cli: 'minimax', authSubdir: 'minimax', nativeProtocol: 'text-chat-json', modelPolicy: 'caller_selected',
    acceptsIdentity: () => true, run: runMinimaxInvocation,
  }],
  ['pi', {
    cli: 'pi', authSubdir: 'pi', nativeProtocol: 'print-json', modelPolicy: 'caller_selected_native_catalog',
    acceptsIdentity: () => true, run: runPiInvocation,
  }],
  ['gemini', {
    cli: 'gemini', authSubdir: 'gemini', nativeProtocol: 'headless-stream-json-policy', modelPolicy: 'caller_selected_native_catalog',
    acceptsIdentity: () => true, run: runGeminiInvocation,
  }],
  ['opencode', {
    cli: 'opencode', authSubdir: 'opencode', nativeProtocol: 'run-json-policy', modelPolicy: 'caller_selected_native_catalog',
    acceptsIdentity: () => true, run: runOpenCodeInvocation,
  }],
]);

export function modelOnlyAdapter(cliId: string): ModelOnlyAdapter | undefined { return adapters.get(cliId); }

/** All registered CLI identities are discoverable, including unsupported ones.
 * A shared ancestry or similar command line is not evidence of compatibility. */
export function modelOnlyAdapterCapabilities() {
  return ALL_CLI_IDS.map(cli => {
    const adapter = modelOnlyAdapter(cli);
    return {
      cli, supported: !!adapter, runtimeVerified: false,
      nativeProtocol: adapter?.nativeProtocol ?? null,
      reason: adapter ? null : modelOnlyAssessments[cli].reason,
      assessment: modelOnlyAssessments[cli],
    };
  });
}

export const modelOnlyCapabilities = {
  schemaVersion: 1,
  mode: 'model_only',
  loopOwner: 'caller',
  versionPolicy: 'runtime_capabilities',
  platforms: ['darwin', 'linux'],
  hostTools: 'disabled',
  customization: 'isolated_home_no_project_no_skills_no_history',
  processReuse: false,
  deadlineCancels: true,
  waitTimeoutCancels: false,
  schemaSubset: ['type', 'properties', 'required', 'additionalProperties:false', 'items', 'enum', 'description'],
} as const;
