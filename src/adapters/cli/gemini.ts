import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { writeTextThenEnter } from './tui-input.js';
import { TMUX_INITIAL_PROMPT_ARG_BUDGET, type CliAdapter } from './types.js';
import { findGeminiSessionFile, findGeminiPromptSubmission, isGeminiSessionId, snapGeminiSubmitBaseline } from './gemini-session.js';


export function createGeminiAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'gemini';
  let cachedBin: string | undefined;
  return {
    id: 'gemini',
    // Whole ~/.gemini, like antigravity (which shares it). Under the oncall
    // sandbox a single-file grant left settings.json (selected auth method)
    // and trustedFolders.json out, so every sandboxed start stopped on the
    // auth / folder-trust dialogs; trustedFolders.json is also saved via
    // tmp + rename, which needs the directory writable.
    authPaths: ['~/.gemini'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, workingDir, env, initialPrompt, model, disableCliBypass }) {
      const args = disableCliBypass ? [] : ['--yolo'];
      // The botmux session id names the Gemini session (gemini-session.ts):
      // resume it when Gemini has a resumable file for it in this project,
      // otherwise start it under that id. An existing file that cannot be
      // resumed (no user message yet) would make --session-id exit 42, so the
      // session then starts without one.
      if (isGeminiSessionId(sessionId)) {
        const file = workingDir ? findGeminiSessionFile(sessionId, workingDir, { ...process.env, ...env }) : undefined;
        if (resume && file?.resumable) args.push('--resume', sessionId);
        else if (!file) args.push('--session-id', sessionId);
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // Use -i (prompt-interactive) for the initial prompt.  Gemini's Ink TUI
      // has a startup phase where the TextInput component isn't mounted yet
      // (auth, model loading, extensions).  Writing to stdin during this phase
      // is silently lost.  -i injects the prompt inside the session so Gemini
      // processes it once the TUI is fully ready.
      if (initialPrompt) {
        args.push('-i', initialPrompt);
      }
      return args;
    },

    // Resume only what Gemini will accept; else the worker starts fresh and
    // says so once, instead of a `--resume` that exits 42 in a restart loop.
    resumeFindsOwnSession: true,
    checkResumeTargetExists({ sessionId, workingDir, env }) {
      if (!isGeminiSessionId(sessionId) || !workingDir) return undefined;
      return findGeminiSessionFile(sessionId, workingDir, env ?? process.env)?.resumable === true;
    },

    passesInitialPromptViaArgs: true,
    // -i bakes the full first prompt (routing envelope included) into argv.
    // Same tmux command-string ceiling as OpenCode/Cursor.
    maxInitialPromptArgBytes: TMUX_INITIAL_PROMPT_ARG_BUDGET,

    // Submit verification via Gemini's own session jsonl. The Ink TextInput
    // silently drops a prompt written while it is unmounted (startup/redraw),
    // so after writing we check that a resumable user row carrying the prompt's
    // ACK marker landed. Baseline is sampled BEFORE the write; the send itself
    // keeps the existing writeTextThenEnter sequence unchanged.
    async writeInput(pty, content) {
      // Slash commands drive the TUI command palette, not a conversation turn:
      // they produce no user message row, so do not verify (and never resend).
      const verify = !content.startsWith('/');
      const baseline = verify ? snapGeminiSubmitBaseline() : null;

      await writeTextThenEnter(pty, content);

      // No store handle (unreadable home) → preserve historical "assume
      // delivered": never warn or resend on absent evidence.
      if (baseline === null) return undefined;

      const recheck = (): boolean | { submitted: boolean; cliSessionId?: string } => {
        const r = findGeminiPromptSubmission(baseline, content);
        if (r.submitted) {
          return r.cliSessionId ? { submitted: true, cliSessionId: r.cliSessionId } : { submitted: true };
        }
        // unreadable = no evidence (meta-only / store not flushed / no marker
        // yet / model turn absent): treat as "not failed" so the worker keeps
        // waiting instead of warning on a possibly-still-landing submit. Only
        // a positive marker match or authoritative absence settles it.
        return r.unreadable ? true : { submitted: false };
      };

      const found = findGeminiPromptSubmission(baseline, content);
      if (found.submitted) {
        return found.cliSessionId
          ? { submitted: true, cliSessionId: found.cliSessionId }
          : { submitted: true };
      }
      // unreadable right after the write: no verdict — keep the old "assume OK"
      // semantics, but attach a recheck so a late landing suppresses a warning.
      if (found.unreadable) return { submitted: true, recheck };
      // Authoritative absence (a model turn ran without this user row): report
      // failed submit; recheck still rescues a late-but-real flush.
      return { submitted: false, recheck };
    },

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Ink TUI — '>' is too generic; rely on quiescence + spinner guard
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Ink renders in alternate screen buffer by default
    skillsDir: '~/.gemini/skills',
    modelChoices: CLI_MODEL_CHOICES['gemini'],
  };
}
