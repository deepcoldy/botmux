import { createHash } from 'node:crypto';

import type { BotConfig } from '../bot-registry.js';
import { config } from '../config.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';
import { resolveCliRuntime, snapshotCliRuntime } from '../adapters/cli/runtime.js';
import { resolvePairedSpawnBackendType } from './persistent-backend.js';
import { dispatchLaunchPolicyDigest, type DispatchLaunchIdentityV1 } from './dispatch-launch-contract.js';

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** Freeze exactly the target-controlled launch inputs supported by dispatch launch v1. */
export function resolveDispatchLaunchIdentity(bot: BotConfig): DispatchLaunchIdentityV1 {
  const policy = bot.dispatchLaunchPolicy;
  if (!policy) throw new Error('dispatch launch policy is unavailable');
  if (bot.cliId !== 'codex' || bot.codexRpcInput === true || bot.existingAppServer !== undefined) {
    throw new Error('dispatch launch v1 supports only the official Codex TUI');
  }
  const runtime = resolveCliRuntime({
    cliId: bot.cliId, cliRuntime: bot.cliRuntime, cliPathOverride: bot.cliPathOverride,
    context: 'dispatch launch target',
  });
  const backendType = resolvePairedSpawnBackendType(
    bot.cliId, undefined, bot.backendType, config.daemon.backendType,
  );
  if (!['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(backendType)) {
    throw new Error('dispatch launch v1 requires a supported local session backend');
  }
  return {
    cliId: 'codex',
    cliRuntimeDigest: digest(snapshotCliRuntime(runtime)),
    executable: runtime?.executable ?? bot.cliPathOverride ?? 'codex',
    ...(bot.wrapperCli ? { wrapperCli: bot.wrapperCli } : {}),
    backendType: backendType as DispatchLaunchIdentityV1['backendType'],
    codexRpcInput: false,
    existingAppServer: false,
    botConfigDigest: digest({
      cliId: bot.cliId, cliRuntime: snapshotCliRuntime(runtime), wrapperCli: bot.wrapperCli ?? null,
      backendType, model: bot.model ?? null, reasoningEffort: bot.reasoningEffort ?? null,
      workingDir: bot.defaultWorkingDir ?? bot.workingDir ?? null,
    }),
    policyDigest: dispatchLaunchPolicyDigest(policy),
  };
}
