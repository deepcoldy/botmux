import type { CliAdapter, PtyHandle } from './types.js';

/**
 * RiffCliAdapter — minimal pass-through adapter for riff-backed sessions.
 *
 * Since riff runs remotely (not a local CLI binary), this adapter provides:
 * - An empty resolvedBin (no binary to spawn)
 * - Empty buildArgs (riff backend ignores bin/args)
 * - Direct writeInput (no PTY throttling/bracketed paste needed)
 *
 * The real work happens in RiffBackend, which translates write() calls into
 * riff HTTP API calls.
 */
export function createRiffAdapter(_pathOverride?: string): CliAdapter {
  return {
    id: 'riff',
    resolvedBin: '',

    buildArgs() {
      return [];
    },

    async writeInput(pty: PtyHandle, content: string): Promise<void> {
      // Direct passthrough — no PTY paste-burst detection or bracketed paste needed.
      // RiffBackend.write() handles the actual API call.
      pty.write(content);
    },

    // riff 的路由/身份/@ 规则由 RiffBackend 统一前置到 userPrompt（见
    // DEFAULT_RIFF_SYSTEM_PROMPT）。置位后 session-manager 不再往消息里塞共用
    // <botmux_routing>——那份规则推荐 --mention-back，与 riff 的禁用规则互相矛盾。
    injectsSessionContext: true,
    systemHints: [],

    altScreen: false,

    // Riff handles queuing server-side; botmux's input gate serializes writes.
    supportsTypeAhead: false,

    // No local binary to version-check.
  };
}
