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

    systemHints: [
      'You are running inside riff (agent-services platform), not a local terminal.',
      'Your output is streamed to Lark/Feishu cards.',
    ],

    altScreen: false,

    // Riff handles queuing server-side; botmux's input gate serializes writes.
    supportsTypeAhead: false,

    // No local binary to version-check.
  };
}
