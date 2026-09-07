import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/**
 * MiniMax CLI (`mmx`, package `mmx-cli`) adapter.
 *
 * `mmx` is MiniMax's multimodal generation CLI. Its ONLY interactive,
 * multi-turn surface is `mmx text repl` — a readline-style chat prompt
 * (banner "MiniMax Chat REPL", a boxed `> ` input line, streamed model
 * output, `/exit` to quit). It hard-requires a TTY (`repl requires an
 * interactive terminal`), which the PTY/tmux backend provides.
 *
 * IMPORTANT — capability envelope: `text repl` is a pure chat/generation
 * loop with NO shell or file-tool surface, so this bot CANNOT run the
 * `botmux send` wrapper the way agentic CLIs do. botmux relays its answers
 * the same way it does for other tool-less TUIs: quiescence detection +
 * headless screen capture of the streamed reply. Hence no `skillsDir`
 * (nothing to install into) and no shell routing hints (it can't act on
 * them). The first user prompt is written to stdin after idle detection —
 * `mmx text repl` has no launch-time `-i`/prompt flag.
 *
 * Auth: `mmx auth login` writes `~/.mmx/config.json` (the whole `~/.mmx`
 * dir is the authPath so a sandboxed first login persists). The `--api-key`
 * flag and `MMX_CONFIG_DIR` env are alternative resolution paths; we do not
 * bake a key into argv.
 *
 * Region (CN vs. global) — supported, resolved by mmx itself:
 *   `mmx` picks the API host by precedence `--base-url` > `--region` >
 *   the `region` field in `~/.mmx/config.json` (written at login, default
 *   `global`). `cn` → api.minimaxi.com, `global` → api.minimax.io. This
 *   adapter does NOT pass `--region`, so a bot follows whichever region you
 *   chose at `mmx auth login`:
 *     mmx auth login --api-key sk-... --region cn        # China
 *     mmx auth login --api-key sk-... --region global    # international
 *
 *   Running a CN bot and a global bot on the SAME host: `~/.mmx` holds one
 *   region, so give each bot its own credential dir via the per-bot `env`
 *   field in bots.json (`MMX_CONFIG_DIR`), each logged into its own region:
 *     bot-cn:      env: { "MMX_CONFIG_DIR": "~/.mmx-cn" }
 *     bot-global:  env: { "MMX_CONFIG_DIR": "~/.mmx-global" }
 *   Prepare each once, e.g.
 *     MMX_CONFIG_DIR=~/.mmx-cn mmx auth login --api-key sk-... --region cn
 *   (Under the file sandbox, `authPaths` is the static `~/.mmx`; a
 *   redirected MMX_CONFIG_DIR would additionally need that dir exposed —
 *   irrelevant to the default non-sandboxed setup.)
 */
export function createMinimaxAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary
  // path is a spawn-time concern.
  const rawBin = pathOverride ?? 'mmx';
  let cachedBin: string | undefined;
  return {
    id: 'minimax',
    // Whole dir, not just config.json: the file may not exist yet on a fresh
    // login inside the sandbox, and a single-file carve-out would be skipped
    // (bwrap can't bind a missing source) — see CLAUDE.md sandbox note (3).
    authPaths: ['~/.mmx'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ model }) {
      // `mmx text repl` keeps no daemon-resumable session state, so we always
      // start fresh (like gemini). Auth comes from `mmx auth login` (persisted
      // in ~/.mmx) or the MMX_CONFIG_DIR / --api-key escape hatches.
      const args = ['text', 'repl'];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      return args;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // mmx's repl is a readline-style prompt (not an Ink bracketed-paste
      // widget): it echoes typed characters and submits on Enter. Prefer the
      // tmux literal-send + Enter path; fall back to raw write + CR.
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,   // quiescence only — no explicit marker
    readyPattern: undefined,        // rely on quiescence; '> ' prompt is too generic
    // Tool-less chat loop: it has no shell/file surface to act on botmux's
    // routing hints, so inject none (same as mira / riff / mojo).
    systemHints: [],
    // mmx repl redraws its input line in place (cursor hide + line clears)
    // but does NOT switch into the alternate screen buffer.
    altScreen: false,
    modelChoices: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
    ],
  };
}

export const create = createMinimaxAdapter;
