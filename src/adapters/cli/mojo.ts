/**
 * MojoCliAdapter — minimal pass-through adapter for mojo-backed sessions.
 *
 * mojo (@byted/mojo) is NOT driven as an interactive TUI here, and that is a
 * deliberate, empirically forced choice:
 *
 *   1. `--yolo` / `-r` / `-c` / `--output-format` / `--timeout` / `--idle-timeout`
 *      are all documented AND observed as "仅 -p" (print/headless mode only).
 *      Passing them without `-p` does not start a TUI — the process just waits
 *      on stdin until EOF. So there is no way to inject them into a long-lived
 *      interactive process the way the kimi/grok adapters do.
 *   2. mojo keeps NO local per-session transcript. `~/.mojo` holds only
 *      credentials/ memory/ skills/ — session state lives server-side. So the
 *      grok-style "tail updates.jsonl to detect turn end" bridge is impossible,
 *      leaving only screen-scraping, which is unreliable under long output.
 *
 * Instead mojo exposes a clean headless control plane
 * (`-p --background` + `mojo session get|respond|confirm|cancel`, all emitting
 * one uniform single-line JSON envelope), which maps almost 1:1 onto the
 * riff-style API-backed backend. All real work therefore happens in
 * MojoBackend, which translates write() into mojo CLI invocations.
 *
 * Empirically verified against @byted/mojo 1.0.10 (linux-x64).
 */
import type { CliAdapter, PtyHandle } from './types.js';

export function createMojoAdapter(_pathOverride?: string): CliAdapter {
    return {
        id: 'mojo',
        // DIRECTORY-level on purpose (see src/adapters/cli/CLAUDE.md §文件沙盒 item 3):
        // a single-file carve-out is skipped entirely while the file does not yet
        // exist, and would miss sibling state anyway. `~/.mojo` holds credentials/
        // (login), memory/ and skills/ — all of which must survive sandbox teardown.
        // When the bot injects X_JWT_TOKEN instead, `mojo auth status --json`
        // reports mode=jwt/source=env and credentials/ may be absent.
        authPaths: ['~/.mojo'],
        // No binary is spawned by the worker — MojoBackend shells out per turn.
        resolvedBin: '',
        buildArgs(): string[] {
            return [];
        },
        async writeInput(pty: PtyHandle, content: string): Promise<void> {
            // Direct passthrough — no PTY paste-burst detection or bracketed paste.
            // MojoBackend.write() performs the actual CLI call.
            pty.write(content);
        },
        // MojoBackend prepends its own routing/identity prompt, mirroring riff:
        // the shared <botmux_routing> block recommends --mention-back, which is
        // wrong for a sandboxed remote session whose sender is frozen at creation.
        injectsSessionContext: true,
        systemHints: [],
        altScreen: false,
        // mojo serializes turns server-side per session; botmux's input gate
        // additionally serializes writes.
        supportsTypeAhead: false,
        // Verified via `mojo -p --model <bad>` → exit code 2, with the full list
        // printed to stderr. Kept static here for synchronous UI enumeration;
        // MojoBackend.probeModels() can refresh it from that stderr at runtime.
        modelChoices: [
            'doubao-seed-2.0-dogfooding',
            'glm-5-turbo',
            'gpt-5.4-2026-03-05',
            'gpt-5.5-2026-04-24',
            'gpt-5.5-ptu',
        ],
    };
}

export const create = createMojoAdapter;
