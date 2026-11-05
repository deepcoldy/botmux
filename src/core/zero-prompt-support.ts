/**
 * 零注入的能力判断（纯函数，浏览器与服务端共用：Dashboard 的 Bot 配置页按当前
 * CLI / 后端 / 沙盒实时计算开关是否可用，不依赖 daemon 下发的快照）。
 * 不得 import bot-registry 等 node 模块；core/prompt-injection.ts 重新导出。
 */
import { supportsTranscriptReplyDelivery, supportsZeroPromptStructuredBridge } from '../services/structured-bridge-clis.js';

export type ZeroPromptSandboxValue = boolean | 'off' | 'oncall' | 'scratch';

/** Whether a spawn runs in the full-root COW scratch sandbox (as opposed to
 *  the deny-by-default oncall bwrap). Scratch bind-mounts a merged overlay as
 *  the container root and does NOT honor the adapter authPaths directory
 *  binds, so transcripts written under it live in the upper/merged tree. */
export function isScratchSandbox(opts?: {
  sandbox?: ZeroPromptSandboxValue;
  readIsolation?: boolean;
}): boolean {
  return opts?.sandbox === 'scratch';
}

/** Reuse the final-reply capability, rather than maintaining a second CLI
 * allowlist. Remote backends have their own prompt/decorate contracts.
 *
 * Two harvest channels qualify:
 *  - the ordinary transcript-reply CLIs (claude-code via its own bridge + the
 *    structured ALWAYS set), which deliver finals in every injection mode;
 *  - the zero-prompt-only structured CLI (antigravity), whose bridge activates
 *    ONLY while promptInjection:'none' — in default mode it answers via
 *    `botmux send` instead. (cursor used to be listed here; since #932 its
 *    bridge is part of the ALWAYS set — default mode harvests send-less turns
 *    with the send-marker gate, though it is still suppressed under scratch.)
 *
 * Sandbox: cursor/antigravity/doubao are supported under the oncall bwrap
 * sandbox (and read isolation / the BOTMUX_SANDBOX switch) — their adapters
 * declare the whole `~/.cursor` / `~/.gemini` /
 * `~/.local/share/doubao_cli` tree as readWrite authPaths, which bind-mount
 * the REAL host directories, so the daemon tails the same files the CLI
 * writes (this also keeps cursor's store.db fcntl locks working).
 *
 * The full-root COW `sandbox: 'scratch'` mode is rejected for these three for
 * now: it bind-mounts a merged overlay as / and ignores authPaths, so their
 * transcripts land in the upper tree the host-side structured bridge does not
 * resolve yet (the existing structured bridges codex/grok have the same open
 * gap). Fail loudly here rather than silently dropping every reply.
 *
 * doubao is rejected under scratch despite being an ALWAYS-bridge CLI:
 * #2828 made transcript its DEFAULT reply mode, and its
 * `agent_mode/<uid>/workspace/.sessions` tree has no scratch host-view
 * mapping (only codex/trae get an env redirect and claude a data-dir remap),
 * so under scratch both the first-turn id capture and transcript harvest
 * resolve nothing — the reply-delivery capability gate rejects the same
 * combination independently.
 *
 * This capability predicate only sees the CONFIG/session value, so the
 * machine-wide `BOTMUX_SANDBOX=scratch` switch (which is not materialised into
 * cfg) is enforced separately by an authoritative throw in spawnCli after it
 * resolves the real mode via resolveSandboxMode.
 *
 * Backend: antigravity additionally rejects the `zmx` backend. Its held
 * provisional final is released only by the quiet-tick viewport gate, and
 * screen evidence is deliberately non-authoritative under zmx
 * (backendScreenEvidenceIsAuthoritativeForMutation) — the final would then be
 * held until the next user turn at best. cursor is unaffected (it emits the
 * final immediately rather than through that gate). */
const ZERO_PROMPT_LOCAL_BACKENDS = ['pty', 'tmux', 'herdr', 'zellij', 'zmx'] as const;

export type ZeroPromptUnsupportedReason =
  | 'cli_unsupported'
  | 'backend_unsupported'
  | 'scratch_unsupported_for_cli'
  | 'zmx_unsupported_for_antigravity';

export interface ZeroPromptSupportOpts {
  backendType?: string; codexRpcInput?: boolean;
  sandbox?: ZeroPromptSandboxValue;
  readIsolation?: boolean;
}

/** Why zero injection is unavailable for this CLI / backend / sandbox combo,
 *  checked in the order below; null = supported. The Dashboard uses the reason
 *  to say WHAT to change instead of one generic "unsupported" line. */
export function zeroPromptInjectionUnsupportedReason(
  cliId: string | undefined,
  opts?: ZeroPromptSupportOpts,
): ZeroPromptUnsupportedReason | null {
  const localTranscript = supportsTranscriptReplyDelivery(cliId)
    || supportsZeroPromptStructuredBridge(cliId);
  if (!localTranscript) return 'cli_unsupported';
  if (opts?.backendType
    && !ZERO_PROMPT_LOCAL_BACKENDS.includes(opts.backendType as typeof ZERO_PROMPT_LOCAL_BACKENDS[number])) {
    return 'backend_unsupported';
  }
  if ((cliId === 'cursor' || cliId === 'antigravity' || cliId === 'doubao') && isScratchSandbox(opts)) {
    return 'scratch_unsupported_for_cli';
  }
  if (cliId === 'antigravity' && opts?.backendType === 'zmx') {
    return 'zmx_unsupported_for_antigravity';
  }
  return null;
}

export function supportsZeroPromptInjection(cliId: string | undefined, opts?: ZeroPromptSupportOpts): boolean {
  return zeroPromptInjectionUnsupportedReason(cliId, opts) === null;
}

/** Per-bot options that can make transcript delivery unusable even when the
 *  CLI itself harvests transcripts. Lives in this leaf module (no
 *  bot-registry/config-store deps) so config-write invariants can reuse the
 *  exact same predicate without closing an import cycle back through
 *  core/reply-delivery → bot-registry (a cycle bun rejects at module link
 *  time: "Export named 'resolveReplyDelivery' not found"). */
export interface TranscriptDeliveryCapabilityOpts {
  sandbox?: ZeroPromptSandboxValue;
}

/** Whether `replyDelivery: transcript` works for this CLI under its sandbox
 *  configuration.
 *
 *  Full-root COW scratch: cursor's agent-transcript mirror and doubao's
 *  `agent_mode/<uid>/workspace/.sessions` tree both live in the merged
 *  overlay, which the host-side bridge cannot read (doubao has no scratch
 *  path mapping — only codex/trae get an env redirect and claude a data-dir
 *  remap — and neither writeInput's first-turn id capture nor
 *  locate.bySessionId resolve the merged tree). Enabling the transcript
 *  envelope there would strip the `botmux send` instructions while harvest
 *  produced nothing — a fully silent turn. The deny-by-default oncall bwrap
 *  is fine for both: their adapters declare the data directories as
 *  authPaths, directory-bind mounted from the real host fs. */
export function supportsTranscriptReplyDeliveryForBot(
  cliId: string | undefined,
  opts?: TranscriptDeliveryCapabilityOpts,
): boolean {
  if (!supportsTranscriptReplyDelivery(cliId)) return false;
  if ((cliId === 'cursor' || cliId === 'doubao') && isScratchSandbox(opts)) return false;
  return true;
}
