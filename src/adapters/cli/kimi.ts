import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { findKimiSessionForBotmuxSession, isKimiSessionId } from './kimi-session.js';

import { delay } from '../../utils/timing.js';
import { wrapBracketedPaste } from './tui-input.js';

const KIMI_FIRST_WRITE_SETTLE_MS = 250;
const kimiFirstWriteSeen = new WeakSet<PtyHandle>();

export function createKimiAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'kimi';
  let cachedBin: string | undefined;
  return {
    id: 'kimi',
    // Kimi's whole data dir: under the oncall sandbox its sessions,
    // session_index.jsonl and config.toml must persist on the host, or every
    // restart starts over and the resume lookup below finds nothing. The
    // binaries next to them stay read-only (sandboxReadonlyPaths, deeper wins).
    authPaths: ['~/.kimi-code'],
    sandboxReadonlyPaths: () => ['~/.kimi-code/bin'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, env, model, disableCliBypass }) {
      const args: string[] = [];
      if (!disableCliBypass) {
        args.push('--yolo');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (!resume) return args;
      // Kimi resumes only a session it minted itself (`--session <id>`, see
      // kimi-session.ts), so find it by the botmux session id. Never
      // `--continue`: it resumes the most recent session of this working dir,
      // which may be a sibling botmux session's.
      const kimiSessionId = isKimiSessionId(resumeSessionId)
        ? resumeSessionId
        : findKimiSessionForBotmuxSession(sessionId, workingDir, { ...process.env, ...env });
      return kimiSessionId ? [...args, '--session', kimiSessionId] : args;
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      const id = isKimiSessionId(cliSessionId) ? cliSessionId : findKimiSessionForBotmuxSession(sessionId, undefined);
      return id ? `kimi --session ${id}` : null;
    },

    // No session found for this botmux session → the worker starts fresh and
    // says so once, instead of `--session` exiting on "Session … not found".
    resumeFindsOwnSession: true,
    checkResumeTargetExists({ sessionId, cliSessionId, workingDir, env }) {
      if (isKimiSessionId(cliSessionId)) return undefined;
      return findKimiSessionForBotmuxSession(sessionId, workingDir, env ?? process.env) !== undefined;
    },

    async writeInput(pty: PtyHandle, content: string) {
      try {
        if (!kimiFirstWriteSeen.has(pty)) {
          kimiFirstWriteSeen.add(pty);
          await delay(KIMI_FIRST_WRITE_SETTLE_MS);
        }
        if (pty.pasteText && pty.sendSpecialKeys) {
          pty.pasteText(content);
          await delay(200);
          pty.sendSpecialKeys('Enter');
        } else {
          const pasted = wrapBracketedPaste(content);
          pty.write(pasted);
          await delay(1000);
          pty.write('\r');
        }
      } catch {
        return;
      }
    },

    // Kimi Code reports its turn state over OSC 7501 (working / blocked on a
    // permission or question / done), but under tmux it skips the support
    // probe and stays silent unless PI_PROGRAM_STATUS=1. Without these reports
    // the only completion signal is 2s of screen quiet, which a static approval
    // dialog satisfies — the turn was marked done while Kimi was still waiting.
    // Under tmux the reports arrive in a passthrough envelope, which
    // ProgramStatusFramingStream unwraps. A Kimi build that never reports keeps
    // the screen fallback: authority engages only on the first accepted report.
    supportsProgramStatus: true,
    spawnEnv: { PI_PROGRAM_STATUS: '1' },
    // The first prompt of a fresh Kimi process resets its session runtime,
    // which reports `clear` + `idle` before `working`; that idle must not
    // complete the turn just submitted.
    programStatusSubmitAwaitsBusy: true,
    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    modelChoices: CLI_MODEL_CHOICES['kimi'],
  };
}
